import consola from "consola";
import sharp from "sharp";
import { Colour, HEIGHT, PIXELS, WIDTH, type Framebuffer } from "./panel.js";

// ── Colour palette ─────────────────────────────────────────────────────────────

interface PaletteEntry {
    code: Colour;
    r: number;
    g: number;
    b: number;
}

const BLACK: PaletteEntry = { code: Colour.Black, r: 0, g: 0, b: 0 };
const WHITE: PaletteEntry = { code: Colour.White, r: 255, g: 255, b: 255 };
const YELLOW: PaletteEntry = { code: Colour.Yellow, r: 255, g: 255, b: 0 };
const RED: PaletteEntry = { code: Colour.Red, r: 255, g: 0, b: 0 };

export type PaletteMode = "bwry" | "bwr" | "bw";

/**
 * Returns the active palette for a given mode.
 *
 * Yellow and (to a lesser extent) red require the longest, highest-voltage
 * e-ink waveforms, so they dominate the power and duration of a refresh. On a
 * passively-powered NFC panel, an image heavy in those colours can exceed the
 * harvested-power budget and brown the chip out mid-refresh. Dropping them
 * trades colour fidelity for a gentler, more reliable update:
 *   - `bwry` full colour (default)
 *   - `bwr`  drops yellow (the worst offender); keeps red
 *   - `bw`   black & white only — the safest, lowest-power refresh
 */
export function getPalette(mode: PaletteMode): PaletteEntry[] {
    switch (mode) {
        case "bw":
            return [BLACK, WHITE];
        case "bwr":
            return [BLACK, WHITE, RED];
        case "bwry":
        default:
            return [BLACK, WHITE, YELLOW, RED];
    }
}

// ── Dithering ──────────────────────────────────────────────────────────────────

/** Maps a flat RGB pixel buffer (width × height × 3 bytes) to palette code indices. */
export interface DitherStrategy {
    quantize(
        rgb: Uint8Array,
        width: number,
        height: number,
        palette: readonly PaletteEntry[]
    ): Framebuffer;
}

function nearest(
    r: number,
    g: number,
    b: number,
    palette: readonly PaletteEntry[]
): PaletteEntry {
    let best = palette[0];
    let bestDist = Infinity;
    for (const col of palette) {
        const d = (r - col.r) ** 2 + (g - col.g) ** 2 + (b - col.b) ** 2;
        if (d < bestDist) {
            bestDist = d;
            best = col;
        }
    }
    return best;
}

/** Flat nearest-colour mapping — no error diffusion (fewer high-frequency transitions). */
export class NearestColorDither implements DitherStrategy {
    quantize(
        rgb: Uint8Array,
        width: number,
        height: number,
        palette: readonly PaletteEntry[]
    ): Framebuffer {
        const result = new Uint8Array(width * height);
        for (let i = 0; i < width * height; i++) {
            result[i] = nearest(
                rgb[i * 3],
                rgb[i * 3 + 1],
                rgb[i * 3 + 2],
                palette
            ).code;
        }
        return result;
    }
}

/** Floyd-Steinberg error-diffusion dithering over the active palette. */
export class FloydSteinbergDither implements DitherStrategy {
    quantize(
        rgb: Uint8Array,
        width: number,
        height: number,
        palette: readonly PaletteEntry[]
    ): Framebuffer {
        const result = new Uint8Array(width * height);
        // Working copies accumulate diffused error as float32
        const r = new Float32Array(width * height);
        const g = new Float32Array(width * height);
        const b = new Float32Array(width * height);

        for (let i = 0; i < width * height; i++) {
            r[i] = rgb[i * 3];
            g[i] = rgb[i * 3 + 1];
            b[i] = rgb[i * 3 + 2];
        }

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = y * width + x;
                const cr = Math.max(0, Math.min(255, r[i]));
                const cg = Math.max(0, Math.min(255, g[i]));
                const cb = Math.max(0, Math.min(255, b[i]));

                const best = nearest(cr, cg, cb, palette);
                result[i] = best.code;

                const er = cr - best.r;
                const eg = cg - best.g;
                const eb = cb - best.b;

                const spread = (dx: number, dy: number, f: number) => {
                    const nx = x + dx,
                        ny = y + dy;
                    if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                        const ni = ny * width + nx;
                        r[ni] += er * f;
                        g[ni] += eg * f;
                        b[ni] += eb * f;
                    }
                };

                spread(1, 0, 7 / 16);
                spread(-1, 1, 3 / 16);
                spread(0, 1, 5 / 16);
                spread(1, 1, 1 / 16);
            }
        }

        return result;
    }
}

// ── Image loading & quantisation ───────────────────────────────────────────────

export async function loadAndQuantize(
    imagePath: string,
    palette: readonly PaletteEntry[],
    dither: DitherStrategy
): Promise<Framebuffer> {
    const { data, info } = await sharp(imagePath)
        .resize(WIDTH, HEIGHT, {
            fit: "contain",
            background: { r: 255, g: 255, b: 255 } // white letterbox / pillarbox
        })
        .flatten({ background: { r: 255, g: 255, b: 255 } }) // composite α over white
        .toColorspace("srgb")
        .raw()
        .toBuffer({ resolveWithObject: true });

    let rgb: Uint8Array;

    if (info.channels === 3) {
        rgb = new Uint8Array(data.buffer, data.byteOffset, data.length);
    } else if (info.channels === 1) {
        // Grayscale input — expand each luma value to RGB
        rgb = new Uint8Array(PIXELS * 3);
        for (let i = 0; i < PIXELS; i++) {
            const v = data[i];
            rgb[i * 3] = v;
            rgb[i * 3 + 1] = v;
            rgb[i * 3 + 2] = v;
        }
    } else {
        throw new Error(`Unexpected channel count ${info.channels} after flatten`);
    }

    const codes = dither.quantize(rgb, WIDTH, HEIGHT, palette);

    // Report colour usage — large yellow/red areas are the prime brownout suspects.
    const counts = new Map<number, number>();
    for (const c of codes) counts.set(c, (counts.get(c) ?? 0) + 1);
    const pct = (code: number) => (((counts.get(code) ?? 0) / PIXELS) * 100).toFixed(1);
    consola.info(
        `Colour mix — black ${pct(0)}%  white ${pct(1)}%  yellow ${pct(2)}%  red ${pct(3)}%`
    );

    return codes;
}
