import net from "node:net";
import zlib from "node:zlib";
import consola from "consola";
import { Bonjour, type Service } from "bonjour-service";
import { Colour, delay, HEIGHT, PIXELS, WIDTH, type Framebuffer } from "./panel.js";
import type { PanelController } from "./controller.js";

// ── Protocol constants ───────────────────────────────────────────────────────
// Wire format (OpenDisplay Basic Standard, WiFi/LAN variant), per the reference
// server (balloob/py-opendisplay @ wifi-server):
//
//   frame  := [length: u32 LE][version: u8][packets...][crc16: u16 LE]
//   packet := [number: u8][id: u8][payload...]
//
// `length` counts the whole frame (including itself). The CRC-16/CCITT-FALSE
// (poly 0x1021, init 0xFFFF, no reflection) covers the version byte + packets,
// i.e. bytes [4, length-3], and is appended little-endian. Each packet is
// prefixed with a `number` byte (a packet index the server ignores; we send 0)
// followed by the packet `id`.

const PROTOCOL_VERSION = 0x01;
export const DEFAULT_PORT = 2446;
const DEFAULT_POLL_SECONDS = 60;
const RECONNECT_DELAY_MS = 5000;

// Packet types
const PKT_DISPLAY_ANNOUNCEMENT = 0x01; // display → server
const PKT_IMAGE_REQUEST = 0x02; // display → server
const PKT_NO_IMAGE = 0x81; // server → display
const PKT_NEW_IMAGE = 0x82; // server → display
const PKT_REQUEST_CONFIG = 0x83; // server → display

// We announce the panel as BWRY (ColorScheme.BWRY == 3 in epaper_dithering).
// NOTE: some servers (e.g. the Home Assistant opendisplay-wifi add-on) ignore
// the announced scheme and always send 1-bit monochrome, so the decoder below
// adapts to whatever size actually arrives rather than assuming 2 bpp.
const COLOUR_SCHEME_BWRY = 0x03; // 2 bpp: 0=black 1=white 2=yellow 3=red

const MONO_BYTES = Math.ceil(WIDTH / 8) * HEIGHT; // 1 bpp  → 15000
const BWRY_BYTES = (WIDTH / 4) * HEIGHT; // 2 bpp  → 30000
const SIXCOLOR_BYTES = (WIDTH / 2) * HEIGHT; // 4 bpp  → 60000

// ── CRC-16/CCITT-FALSE ───────────────────────────────────────────────────────

function crc16(data: Buffer): number {
    let crc = 0xffff;
    for (const byte of data) {
        crc ^= byte << 8;
        for (let i = 0; i < 8; i++) {
            crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
            crc &= 0xffff;
        }
    }
    return crc;
}

// ── Encoding (display → server) ──────────────────────────────────────────────

/** Wraps one or more packet payloads in a length-prefixed, CRC'd frame. */
function buildFrame(...packets: Buffer[]): Buffer {
    const body = Buffer.concat([Buffer.from([PROTOCOL_VERSION]), ...packets]);
    const length = 4 + body.length + 2;
    const frame = Buffer.alloc(length);
    frame.writeUInt32LE(length, 0);
    body.copy(frame, 4);
    frame.writeUInt16LE(crc16(body), length - 2);
    return frame;
}

const PACKET_NUMBER = 0x00; // packet index; ignored by the server

/** 0x01 — advertise this device as a 400×300 BWRY panel. */
function buildAnnouncement(): Buffer {
    const p = Buffer.alloc(18);
    p.writeUInt8(PACKET_NUMBER, 0);
    p.writeUInt8(PKT_DISPLAY_ANNOUNCEMENT, 1);
    p.writeUInt16LE(WIDTH, 2);
    p.writeUInt16LE(HEIGHT, 4);
    p.writeUInt8(COLOUR_SCHEME_BWRY, 6);
    p.writeUInt16LE(0x0000, 7); // firmware_id
    p.writeUInt16LE(0x0001, 9); // firmware_version
    p.writeUInt16LE(0x0000, 11); // manufacturer_id
    p.writeUInt16LE(0x0000, 13); // model_id
    p.writeUInt16LE(0x0000, 15); // max_compressed_size: 0 = no compression
    p.writeUInt8(0x00, 17); // rotation: 0°
    return p;
}

/** 0x02 — request the latest image. We report AC power and no RSSI. */
function buildImageRequest(): Buffer {
    return Buffer.from([
        PACKET_NUMBER,
        PKT_IMAGE_REQUEST,
        0xff /* AC powered */,
        0x00 /* rssi */
    ]);
}

// ── Decoding (server → display) ──────────────────────────────────────────────

type Packet =
    | { type: typeof PKT_REQUEST_CONFIG }
    | { type: typeof PKT_NO_IMAGE; pollInterval: number }
    | {
          type: typeof PKT_NEW_IMAGE;
          pollInterval: number;
          refreshType: number;
          image: Buffer;
      };

/**
 * Parses the packet region of a frame (version and CRC already stripped). Each
 * packet is `[number:1][id:1][payload...]`; the server emits one packet per
 * frame, but we loop defensively.
 */
function parsePackets(body: Buffer): Packet[] {
    const packets: Packet[] = [];
    let i = 0;
    while (i + 1 < body.length) {
        const type = body[i + 1]; // body[i] is the ignored packet `number`
        const at = i + 2; // start of this packet's payload
        switch (type) {
            case PKT_REQUEST_CONFIG:
                packets.push({ type });
                i = at;
                break;
            case PKT_NO_IMAGE:
                packets.push({ type, pollInterval: body.readUInt32LE(at) });
                i = at + 4;
                break;
            case PKT_NEW_IMAGE: {
                const imageLength = body.readUInt32LE(at);
                const pollInterval = body.readUInt32LE(at + 4);
                const refreshType = body.readUInt8(at + 8);
                const dataStart = at + 9;
                const image = body.subarray(dataStart, dataStart + imageLength);
                packets.push({ type, pollInterval, refreshType, image });
                i = dataStart + imageLength;
                break;
            }
            default:
                // Unknown/unsupported packet — we can't know its length, so stop.
                consola.warn(
                    `OpenDisplay: unknown packet id 0x${type.toString(16)}; ignoring rest of frame`
                );
                return packets;
        }
    }
    return packets;
}

/** 1 bpp monochrome (PIL mode "1"): MSB = leftmost pixel, 1 = white, 0 = black. */
function decodeMono(data: Buffer): Framebuffer {
    const rowBytes = Math.ceil(WIDTH / 8);
    const fb: Framebuffer = new Uint8Array(PIXELS);
    for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
            const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
            fb[y * WIDTH + x] = bit ? Colour.White : Colour.Black;
        }
    }
    return fb;
}

/** 2 bpp BWRY: 4 px/byte, leftmost pixel in bits 7–6; codes already 0–3. */
function decodeBWRY(data: Buffer): Framebuffer {
    const fb: Framebuffer = new Uint8Array(PIXELS);
    for (let p = 0; p < PIXELS; p++) {
        fb[p] = (data[p >> 2] >> ((3 - (p & 3)) * 2)) & 0x3;
    }
    return fb;
}

/** 4 bpp 6-colour: 2 px/byte, left pixel in the high nibble. Blue/green (5/6) are
 *  clamped to the nearest BWRY colour the panel can show. */
function decodeSixColor(data: Buffer): Framebuffer {
    const map = (v: number): number =>
        v <= 3 ? v : v === 6 ? Colour.Black : Colour.White;
    const fb: Framebuffer = new Uint8Array(PIXELS);
    for (let p = 0; p < PIXELS; p++) {
        const byte = data[p >> 1];
        fb[p] = map(p & 1 ? byte & 0x0f : byte >> 4);
    }
    return fb;
}

/**
 * Decodes an OpenDisplay image payload into a framebuffer, adapting to whatever
 * encoding the server actually sent (identified by size). The colour codes match
 * our internal {@link Framebuffer} numbering (0=black 1=white 2=yellow 3=red).
 */
function decodeImage(raw: Buffer): Framebuffer {
    let data = raw;
    const known = (n: number) =>
        n === MONO_BYTES || n === BWRY_BYTES || n === SIXCOLOR_BYTES;
    if (!known(data.length)) {
        // Unexpected size — server may have zlib-compressed it; try to inflate.
        try {
            data = zlib.inflateSync(raw);
        } catch {
            /* fall through to error */
        }
    }

    switch (data.length) {
        case MONO_BYTES:
            return decodeMono(data);
        case BWRY_BYTES:
            return decodeBWRY(data);
        case SIXCOLOR_BYTES:
            return decodeSixColor(data);
        default:
            throw new Error(
                `OpenDisplay: unrecognised image size ${data.length} B ` +
                    `(expected ${MONO_BYTES}, ${BWRY_BYTES} or ${SIXCOLOR_BYTES})`
            );
    }
}

// ── Frame reader over a TCP stream ────────────────────────────────────────────

class FrameStream {
    #buf = Buffer.alloc(0);
    #wake: (() => void)[] = [];
    #closed = false;

    constructor(sock: net.Socket) {
        sock.on("data", (d: Buffer) => {
            this.#buf = Buffer.concat([this.#buf, d]);
            this.#flush();
        });
        sock.on("close", () => {
            this.#closed = true;
            this.#flush();
        });
        sock.on("error", () => {
            this.#closed = true;
            this.#flush();
        });
    }

    #flush(): void {
        const wake = this.#wake;
        this.#wake = [];
        for (const w of wake) w();
    }

    /** Reads and parses the next complete frame, or throws if the stream ends. */
    async readFrame(): Promise<Packet[]> {
        for (;;) {
            if (this.#buf.length >= 4) {
                const length = this.#buf.readUInt32LE(0);
                if (length < 7 || length > 1_000_000) {
                    throw new Error(`OpenDisplay: invalid frame length ${length}`);
                }
                if (this.#buf.length >= length) {
                    const frame = this.#buf.subarray(0, length);
                    this.#buf = this.#buf.subarray(length);

                    const body = frame.subarray(4, length - 2); // version + packets
                    const expected = frame.readUInt16LE(length - 2);
                    if (crc16(body) !== expected) {
                        consola.warn(
                            "OpenDisplay: frame CRC mismatch; attempting to parse anyway"
                        );
                    }
                    return parsePackets(frame.subarray(5, length - 2)); // skip version byte
                }
            }
            if (this.#closed) throw new Error("OpenDisplay: connection closed");
            await new Promise<void>((resolve) => this.#wake.push(resolve));
        }
    }
}

// ── Client ────────────────────────────────────────────────────────────────────

export interface OpenDisplayOptions {
    controller: PanelController;
    /** Explicit server to connect to; when omitted, discover via mDNS. */
    server?: { host: string; port: number };
}

/**
 * OpenDisplay client (the "display" side): connects out to OpenDisplay servers,
 * announces this device as a 400×300 BWRY panel, and feeds received images to
 * the {@link PanelController}. Polling pauses while a flash is in progress.
 */
export class OpenDisplayClient {
    readonly #controller: PanelController;
    readonly #explicit?: { host: string; port: number };
    readonly #connections = new Set<string>();
    #bonjour?: Bonjour;
    #running = false;

    constructor(opts: OpenDisplayOptions) {
        this.#controller = opts.controller;
        this.#explicit = opts.server;
    }

    start(): void {
        this.#running = true;

        if (this.#explicit) {
            consola.info(
                `OpenDisplay: connecting to ${this.#explicit.host}:${this.#explicit.port}`
            );
            void this.#connectLoop(this.#explicit.host, this.#explicit.port);
            return;
        }

        consola.info("OpenDisplay: discovering servers via mDNS (_opendisplay._tcp)…");
        this.#bonjour = new Bonjour();
        this.#bonjour.find({ type: "opendisplay", protocol: "tcp" }, (service) => {
            const host = pickAddress(service);
            if (!host) return;
            void this.#connectLoop(host, service.port);
        });
    }

    stop(): void {
        this.#running = false;
        this.#bonjour?.destroy();
    }

    async #connectLoop(host: string, port: number): Promise<void> {
        const key = `${host}:${port}`;
        if (this.#connections.has(key)) return; // already handling this server
        this.#connections.add(key);

        try {
            while (this.#running) {
                try {
                    await this.#session(host, port);
                } catch (err) {
                    consola.warn(`OpenDisplay [${key}]: ${(err as Error).message}`);
                }
                if (!this.#running) break;
                await delay(RECONNECT_DELAY_MS);
            }
        } finally {
            this.#connections.delete(key);
        }
    }

    async #session(host: string, port: number): Promise<void> {
        const sock = net.createConnection({ host, port });
        sock.setKeepAlive(true);
        try {
            await new Promise<void>((resolve, reject) => {
                sock.once("connect", resolve);
                sock.once("error", reject);
            });
            consola.success(`OpenDisplay: connected to ${host}:${port}`);

            const frames = new FrameStream(sock);

            while (this.#running && !sock.closed) {
                // Pause the polling exchange entirely while a flash is in progress.
                await this.#controller.waitWhileFlashing();

                sock.write(buildFrame(buildImageRequest()));
                const packets = await frames.readFrame();

                let immediate = false;
                let sleepSec = DEFAULT_POLL_SECONDS;

                for (const pkt of packets) {
                    switch (pkt.type) {
                        case PKT_REQUEST_CONFIG:
                            sock.write(buildFrame(buildAnnouncement()));
                            immediate = true; // re-request right away, like the reference client
                            break;
                        case PKT_NO_IMAGE:
                            sleepSec = pkt.pollInterval || DEFAULT_POLL_SECONDS;
                            break;
                        case PKT_NEW_IMAGE:
                            sleepSec = pkt.pollInterval || DEFAULT_POLL_SECONDS;
                            try {
                                const fb = decodeImage(pkt.image);
                                consola.info(
                                    `OpenDisplay: received image (${pkt.image.length} B, refresh ${pkt.refreshType})`
                                );
                                this.#controller.enqueue(fb);
                            } catch (err) {
                                consola.error(err);
                            }
                            break;
                    }
                }

                if (!immediate) await delay(sleepSec * 1000);
            }
        } finally {
            sock.destroy();
        }
    }
}

/** Prefer an IPv4 address; fall back to the advertised hostname. */
function pickAddress(service: Service): string | undefined {
    const ipv4 = service.addresses?.find((a) => net.isIPv4(a));
    return ipv4 ?? service.addresses?.[0] ?? service.host;
}
