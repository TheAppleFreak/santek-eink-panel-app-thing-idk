import path from "node:path";
import consola from "consola";
import { PanelController } from "./controller.js";
import {
    FloydSteinbergDither,
    getPalette,
    loadAndQuantize,
    NearestColorDither,
    type DitherStrategy,
    type PaletteMode
} from "./image.js";
import { OpenDisplayClient, DEFAULT_PORT } from "./opendisplay.js";
import {
    DEFAULT_WAVEFORM,
    isCardGoneError,
    printBrownoutHelp,
    type WriteOptions
} from "./panel.js";

// ── CLI options ────────────────────────────────────────────────────────────────

type Mode = "image" | "opendisplay";

interface ImageOptions {
    imagePath: string;
    palette: PaletteMode;
    dither: boolean;
    waveform: [number, number];
}

interface CliOptions {
    mode?: Mode;
    image: ImageOptions;
    server?: { host: string; port: number };
    /** True if any image-only flag was supplied, for cross-mode validation. */
    imageFlagsUsed: boolean;
}

function defaultImageOptions(): ImageOptions {
    return {
        imagePath: "",
        palette: "bwry",
        dither: true,
        waveform: [...DEFAULT_WAVEFORM]
    };
}

/**
 * Normalises a user-supplied path. Dragging a file into a terminal (especially
 * on Windows) wraps the path in single or double quotes and may add trailing
 * whitespace; strip a single surrounding quote pair so the path resolves.
 */
function cleanPath(value: string): string {
    const trimmed = value.trim();
    const quoted = /^"(.*)"$/.exec(trimmed) ?? /^'(.*)'$/.exec(trimmed);
    return quoted ? quoted[1] : trimmed;
}

function parseServer(value: string): { host: string; port: number } {
    // Accept "host", "host:port", and IPv6 "[::1]:port".
    const m = /^\[(.+)\]:(\d+)$/.exec(value) ?? /^([^:]+):(\d+)$/.exec(value);
    if (m) return { host: m[1], port: Number(m[2]) };
    return { host: value, port: DEFAULT_PORT };
}

function parseArgs(argv: string[]): CliOptions {
    const opts: CliOptions = { image: defaultImageOptions(), imageFlagsUsed: false };
    const positional: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case "-i":
            case "--image": {
                opts.mode = "image";
                const next = argv[i + 1];
                if (next && !next.startsWith("-")) {
                    opts.image.imagePath = next;
                    i++;
                }
                break;
            }
            case "-od":
            case "--opendisplay":
                opts.mode = "opendisplay";
                break;
            case "--server": {
                const v = argv[++i];
                if (!v) throw new Error("--server requires a host or host:port");
                opts.server = parseServer(v);
                break;
            }
            case "--palette": {
                const v = argv[++i];
                if (v !== "bwry" && v !== "bwr" && v !== "bw") {
                    throw new Error(
                        `Invalid --palette "${v}" (expected bwry | bwr | bw)`
                    );
                }
                opts.image.palette = v;
                opts.imageFlagsUsed = true;
                break;
            }
            case "--no-dither":
                opts.image.dither = false;
                opts.imageFlagsUsed = true;
                break;
            case "--waveform": {
                const a1 = parseInt(argv[++i], 16);
                const a2 = parseInt(argv[++i], 16);
                if (Number.isNaN(a1) || Number.isNaN(a2)) {
                    throw new Error(
                        "--waveform expects two hex bytes, e.g. --waveform 85 80"
                    );
                }
                opts.image.waveform = [a1 & 0xff, a2 & 0xff];
                opts.imageFlagsUsed = true;
                break;
            }
            case "-h":
            case "--help":
                printUsage();
                process.exit(0);
            default:
                positional.push(a);
        }
    }

    // A bare positional (no -i) is treated as the image path for convenience.
    if (!opts.image.imagePath && positional.length > 0) {
        opts.image.imagePath = positional[0];
        if (!opts.mode) opts.mode = "image";
    }

    // Image-only flags must not be combined with OpenDisplay mode.
    if (opts.mode === "opendisplay" && opts.imageFlagsUsed) {
        throw new Error(
            "--palette, --no-dither and --waveform only apply in image mode"
        );
    }

    return opts;
}

function printUsage(): void {
    consola.log(
        [
            "Usage:",
            "  node build/index.js --image <path> [image options]   Flash a local image once",
            "  node build/index.js --opendisplay [--server host:port] Run as an OpenDisplay device",
            "  node build/index.js                                   Interactive mode",
            "",
            "Modes:",
            "  -i, --image <path>       Flash a single local image, then exit.",
            "  -od, --opendisplay       Present as a 400×300 BWRY OpenDisplay device and",
            "                           flash images pushed over the network. Stays running.",
            "      --server <host[:port]>  Skip mDNS and connect to this server",
            `                              (default port ${DEFAULT_PORT}).`,
            "",
            "Image-mode options (ignored in OpenDisplay mode):",
            "  --palette <bwry|bwr|bw>  Color set. Drop yellow (bwr) or all color (bw)",
            "                           to lower refresh power and avoid brownouts. [bwry]",
            "  --no-dither              Flat nearest-color mapping instead of dithering.",
            "  --waveform <P1> <P2>     Override the refresh waveform selector bytes (hex).",
            `                           [default: ${DEFAULT_WAVEFORM.map((b) => b.toString(16)).join(" ")}]`,
            "  -h, --help               Show this help."
        ].join("\n")
    );
}

// ── Interactive mode ────────────────────────────────────────────────────────────

async function runInteractive(): Promise<CliOptions> {
    const mode = (await consola.prompt("What would you like to do?", {
        type: "select",
        options: [
            {
                label: "Flash a local image",
                value: "image",
                hint: "process and push one image, then exit"
            },
            {
                label: "Run as an OpenDisplay device",
                value: "opendisplay",
                hint: "receive images over the network"
            }
        ],
        cancel: "reject"
    })) as Mode;

    const opts: CliOptions = {
        mode,
        image: defaultImageOptions(),
        imageFlagsUsed: false
    };

    if (mode === "image") {
        opts.image.imagePath = (await consola.prompt("Path to the image file:", {
            type: "text",
            cancel: "reject"
        })) as string;

        opts.image.palette = (await consola.prompt("Color palette:", {
            type: "select",
            options: [
                { label: "Black/White/Red/Yellow (full color)", value: "bwry" },
                { label: "Black/White/Red (drops yellow — lower power)", value: "bwr" },
                { label: "Black/White only (safest — lowest power)", value: "bw" }
            ],
            initial: "bwry",
            cancel: "reject"
        })) as PaletteMode;

        opts.image.dither = (await consola.prompt("Use Floyd-Steinberg dithering?", {
            type: "confirm",
            initial: true,
            cancel: "reject"
        })) as boolean;
    } else {
        // Note: a blank submission is valid here (auto-discover), so this prompt must
        // not use `cancel: 'reject'` — consola treats an empty text entry as a cancel.
        const server = (await consola.prompt(
            "OpenDisplay server (blank to auto-discover via mDNS):",
            { type: "text", placeholder: "auto-discover", default: "" }
        )) as string | undefined;
        if (server && server.trim()) opts.server = parseServer(server.trim());
    }

    return opts;
}

// ── Mode runners ─────────────────────────────────────────────────────────────

async function runImageMode(image: ImageOptions): Promise<never> {
    if (!image.imagePath) {
        consola.error("No image path provided.");
        printUsage();
        process.exit(1);
    }

    const resolvedPath = path.resolve(cleanPath(image.imagePath));
    const ditherStrategy: DitherStrategy = image.dither
        ? new FloydSteinbergDither()
        : new NearestColorDither();

    consola.info(`Image:   ${resolvedPath}`);
    consola.info(
        `Palette: ${image.palette}   Dither: ${image.dither ? "Floyd-Steinberg" : "none"}`
    );

    consola.start("Processing image…");
    const codes = await loadAndQuantize(
        resolvedPath,
        getPalette(image.palette),
        ditherStrategy
    );

    const writeOptions: WriteOptions = { waveform: image.waveform };
    const controller = new PanelController(writeOptions);
    controller.start();

    consola.info("Waiting for the display to be placed on the reader…");

    try {
        await new Promise<void>((resolve, reject) => {
            controller.once("flash:done", () => resolve());
            controller.once("flash:error", (err) => reject(err));
            controller.enqueue(codes);
        });
        consola.success("Done.");
        controller.stop();
        process.exit(0);
    } catch (err) {
        controller.stop();
        if (isCardGoneError(err)) {
            consola.error(
                "Card reset / went away during the operation — almost certainly a brownout."
            );
            printBrownoutHelp();
        } else {
            consola.error(err);
        }
        process.exit(1);
    }
}

function runOpenDisplayMode(opts: CliOptions): void {
    // OpenDisplay images arrive pre-quantised to BWRY; no palette/dither applies.
    const controller = new PanelController({ waveform: [...DEFAULT_WAVEFORM] });
    controller.start();

    controller.on("present", () => consola.info("Display present on reader."));
    controller.on("absent", () =>
        consola.info("Display removed — images will be buffered.")
    );
    controller.on("flash:start", () => consola.start("Flashing image to panel…"));
    controller.on("flash:done", () =>
        consola.success("Panel updated. Idle, waiting for the next image.")
    );
    controller.on("flash:error", (err) => {
        if (isCardGoneError(err)) {
            consola.warn(
                "Flash interrupted (display unavailable / brownout); will retry when it returns."
            );
        } else {
            consola.error(err);
        }
    });

    const client = new OpenDisplayClient({ controller, server: opts.server });
    client.start();

    consola.success("OpenDisplay device ready. Press Ctrl+C to exit.");

    const shutdown = () => {
        consola.info("Shutting down…");
        client.stop();
        controller.stop();
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

// ── Entry point ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    let opts: CliOptions;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (err) {
        consola.error(err instanceof Error ? err.message : err);
        printUsage();
        process.exit(1);
    }

    if (!opts.mode) {
        try {
            opts = await runInteractive();
        } catch {
            consola.info("Cancelled.");
            process.exit(0);
        }
    }

    if (opts.mode === "image") {
        await runImageMode(opts.image);
    } else {
        runOpenDisplayMode(opts);
    }
}

void main();
