import consola from "consola";
import * as pcsc from "pcsc-mini";
import { lzo1xCompress } from "lzo1x";

const { CardDisposition, CardMode } = pcsc;

// ── Panel constants ────────────────────────────────────────────────────────────

export const WIDTH = 400;
export const HEIGHT = 300;
export const PIXELS = WIDTH * HEIGHT;

const STRIP_COUNT = 15;
const ROWS_PER_STRIP = 20;
const BYTES_PER_ROW = WIDTH / 4; // 100 bytes (4 × 2 bpp per byte)
const BYTES_PER_STRIP = BYTES_PER_ROW * ROWS_PER_STRIP; // 2000 bytes
const MAX_FRAGMENT = 250; // max payload bytes per fragment APDU

// Color codes (shared with protocol.md and OpenDisplay scheme 3):
//   0 = black  1 = white  2 = yellow  3 = red
export const enum Color {
    Black = 0,
    White = 1,
    Yellow = 2,
    Red = 3
}

/** A full-panel framebuffer: one byte per pixel (value 0–3), row-major. */
export type Framebuffer = Uint8Array;

export interface WriteOptions {
    waveform: [number, number]; // P1, P2 of the F0 D4 refresh command
}

export const DEFAULT_WAVEFORM: [number, number] = [0x85, 0x80];

// ── Helpers ────────────────────────────────────────────────────────────────────

export const delay = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

function checkSW(res: Uint8Array, context: string): void {
    const sw1 = res[res.length - 2];
    const sw2 = res[res.length - 1];
    if (sw1 !== 0x90 || sw2 !== 0x00) {
        throw new Error(
            `${context}: unexpected SW ${sw1.toString(16).padStart(2, "0")} ` +
                `${sw2.toString(16).padStart(2, "0")}`
        );
    }
}

/**
 * Heuristic: does this error mean the card reset / vanished / went busy?
 * On a refresh brownout the chip resets and re-enumerates, and the failure can
 * surface as a rejected transmit, a `reconnect` failure, or a background
 * `"error"` event — all with varying PCSC codes. Match them broadly.
 */
export function isCardGoneError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const e = err as { code?: unknown; message?: unknown };
    const hay = `${e.code ?? ""} ${e.message ?? ""}`.toLowerCase();
    return /busy|removed|reset|unpower|unavailable|no.?smart.?card|sharing|not.?transacted|comm.?data|disappear|dead|proto/.test(
        hay
    );
}

export function printBrownoutHelp(): void {
    consola.box(
        [
            "The card lost power during the panel refresh (a brownout).",
            "This is a hardware-margin issue, not a bug — the refresh of this image",
            "draws more power than the NFC field can supply. Things to try:",
            "",
            "  • In image mode, use a lower-power palette:  --palette bwr   (drops yellow)",
            "                                              --palette bw    (safest)",
            "  • --no-dither may also reduce refresh stress.",
            "  • Improve coupling: lay the tag flat & centred on the reader, remove",
            "    any case/metal, and keep it perfectly still during the refresh.",
            "  • If you have a powered/active reader, prefer it over a phone.",
            "",
            "If even --palette bw fails, the panel itself is likely faulty."
        ].join("\n")
    );
}

/**
 * Transmits an APDU, tolerating a transient card reset.
 *
 * A heavy refresh can momentarily brown the chip out; the card then re-appears
 * and the previously-reset connection can sometimes be restored with
 * `reconnect`. We retry a few times before giving up.
 */
async function transmitResilient(
    card: pcsc.Card,
    apdu: Uint8Array,
    context: string,
    retries = 4
): Promise<Uint8Array> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await card.transmit(apdu);
        } catch (err) {
            lastErr = err;
            if (attempt < retries) {
                consola.warn(
                    `${context}: card unresponsive (attempt ${attempt + 1}); reconnecting…`
                );
                await delay(400);
                try {
                    // LEAVE: do not reset the card state — the refresh may still be running.
                    await card.reconnect(CardMode.SHARED, CardDisposition.LEAVE);
                } catch {
                    /* card not back yet; next attempt retries the transmit */
                }
            }
        }
    }
    throw lastErr;
}

// ── Strip packing ──────────────────────────────────────────────────────────────

/**
 * Packs strip `stripIndex` (ROWS_PER_STRIP rows × WIDTH pixels) into the
 * 2000-byte wire format.
 *
 * Protocol: rows stored right-to-left → for each row, flip it horizontally
 * then pack 4 pixels per byte, MSB-first.
 *
 * Byte k of row r = packed pixels at original columns:
 *   (WIDTH-1-4k), (WIDTH-2-4k), (WIDTH-3-4k), (WIDTH-4-4k)
 */
function packStrip(codes: Framebuffer, stripIndex: number): Uint8Array {
    const packed = new Uint8Array(BYTES_PER_STRIP);
    const rowBase = stripIndex * ROWS_PER_STRIP;

    for (let row = 0; row < ROWS_PER_STRIP; row++) {
        const srcBase = (rowBase + row) * WIDTH;
        const dstBase = row * BYTES_PER_ROW;

        for (let k = 0; k < BYTES_PER_ROW; k++) {
            const p0 = codes[srcBase + WIDTH - 1 - k * 4];
            const p1 = codes[srcBase + WIDTH - 2 - k * 4];
            const p2 = codes[srcBase + WIDTH - 3 - k * 4];
            const p3 = codes[srcBase + WIDTH - 4 - k * 4];
            packed[dstBase + k] = (p0 << 6) | (p1 << 4) | (p2 << 2) | p3;
        }
    }

    return packed;
}

// ── APDU commands ──────────────────────────────────────────────────────────────

const CMD_VERIFY = Uint8Array.of(0x00, 0x20, 0x00, 0x01, 0x04, 0x20, 0x09, 0x12, 0x10);
const CMD_SELECT = Uint8Array.of(
    0x00,
    0xa4,
    0x04,
    0x00,
    0x07,
    0xd2,
    0x76,
    0x00,
    0x00,
    0x85,
    0x01,
    0x01
);
const CMD_POLL = Uint8Array.of(0xf0, 0xde, 0x00, 0x00, 0x01);

// ── Display write ──────────────────────────────────────────────────────────────

/**
 * Writes a full framebuffer to the e-ink panel and waits for the refresh to
 * complete. Throws on protocol error, timeout, or an unrecoverable card reset
 * (use {@link isCardGoneError} to classify the latter as a brownout).
 */
export async function writeToDisplay(
    card: pcsc.Card,
    codes: Framebuffer,
    opts: WriteOptions
): Promise<void> {
    checkSW(await card.transmit(CMD_VERIFY), "VERIFY");
    checkSW(await card.transmit(CMD_SELECT), "SELECT");

    for (let block = 0; block < STRIP_COUNT; block++) {
        const strip = packStrip(codes, block);
        const compressed = lzo1xCompress(strip);

        let sub = 0;
        for (
            let offset = 0;
            offset < compressed.length;
            offset += MAX_FRAGMENT, sub++
        ) {
            const end = Math.min(offset + MAX_FRAGMENT, compressed.length);
            const fragment = compressed.subarray(offset, end);
            const isLast = end >= compressed.length;

            // F0 D3 00 P2 Lc [block] [sub] <fragment>
            const apdu = new Uint8Array(7 + fragment.length);
            apdu[0] = 0xf0;
            apdu[1] = 0xd3;
            apdu[2] = 0x00;
            apdu[3] = isLast ? 0x01 : 0x00; // P2: 0x01 = last fragment of this block
            apdu[4] = 2 + fragment.length; // Lc
            apdu[5] = block;
            apdu[6] = sub;
            apdu.set(fragment, 7);

            checkSW(await card.transmit(apdu), `block ${block} sub ${sub}`);
        }

        consola.info(
            `  strip ${block + 1}/${STRIP_COUNT} (${compressed.length} B compressed)`
        );
    }

    // ── Refresh ──────────────────────────────────────────────────────────────────
    const [p1, p2] = opts.waveform;
    const cmdRefresh = Uint8Array.of(0xf0, 0xd4, p1, p2, 0x00);
    consola.start(
        `Triggering panel refresh (waveform ${p1.toString(16)} ${p2.toString(16)})…`
    );
    checkSW(await transmitResilient(card, cmdRefresh, "REFRESH"), "REFRESH");

    // Poll until the e-ink panel finishes updating.
    // Response format: [statusByte, 0x90, 0x00]; assume 0x00 = idle/done.
    consola.start("Waiting for panel refresh (~30–90 s for BWRY)…");
    const MAX_POLLS = 360; // 180 s at 500 ms / poll
    for (let i = 0; i < MAX_POLLS; i++) {
        const res = await transmitResilient(card, CMD_POLL, "POLL");
        checkSW(res, "POLL");
        if (res[0] === 0x00) return;
        await delay(500);
    }

    throw new Error("Panel refresh timed out after 180 s");
}
