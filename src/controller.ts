import { EventEmitter } from "node:events";
import consola from "consola";
import * as pcsc from "pcsc-mini";
import {
    isCardGoneError,
    writeToDisplay,
    type Framebuffer,
    type WriteOptions
} from "./panel.js";

const { CardDisposition, CardMode, ReaderStatus } = pcsc;

interface PanelControllerEvents {
    present: [];
    absent: [];
    "flash:start": [];
    "flash:done": [];
    "flash:error": [unknown];
    [event: string]: unknown[];
}

/**
 * Owns the PC/SC lifecycle and a single-slot flash queue.
 *
 * - Tracks whether the e-ink tag is physically on a reader.
 * - {@link enqueue} stores the *most recent* framebuffer and flashes it as soon
 *   as the tag is present and no other flash is running. If the tag is absent,
 *   the image waits; if a newer image arrives first, it replaces the pending one.
 * - Recoverable failures (tag removed / brownout) keep the pending image so it
 *   retries automatically when the tag returns.
 */
export class PanelController extends EventEmitter<PanelControllerEvents> {
    #client?: pcsc.Client;
    #reader?: pcsc.Reader;
    #card?: pcsc.Card;
    #present = false;
    #flashing = false;
    #pending: Framebuffer | null = null;
    readonly #writeOptions: WriteOptions;

    constructor(writeOptions: WriteOptions) {
        super();
        this.#writeOptions = writeOptions;
    }

    get present(): boolean {
        return this.#present;
    }
    get flashing(): boolean {
        return this.#flashing;
    }

    start(): void {
        this.#client = new pcsc.Client()
            .on("reader", (reader) => this.#onReader(reader))
            .on("error", (err) => {
                // Background-thread error. If it lands mid-flash, dropping the card makes
                // the in-flight transmit reject so #flush handles it on one path.
                if (this.#flashing) void this.#dropCard();
                else consola.warn("PCSC:", (err as Error)?.message ?? err);
            })
            .start();
    }

    stop(): void {
        try {
            this.#client?.stop();
        } catch {
            /* ignore */
        }
    }

    /** Queue the most recent framebuffer for flashing (replaces any pending one). */
    enqueue(codes: Framebuffer): void {
        this.#pending = codes;
        void this.#flush();
    }

    /** Resolves immediately if idle, otherwise once the current flash settles. */
    async waitWhileFlashing(): Promise<void> {
        if (!this.#flashing) return;
        await new Promise<void>((resolve) => {
            const done = () => {
                this.off("flash:done", done);
                this.off("flash:error", done);
                resolve();
            };
            this.once("flash:done", done);
            this.once("flash:error", done);
        });
    }

    #onReader(reader: pcsc.Reader): void {
        consola.info(`Reader: ${reader}`);

        reader.on("change", (status: pcsc.ReaderStatusFlags) => {
            if (status.hasAny(ReaderStatus.MUTE, ReaderStatus.IN_USE)) return;

            if (status.has(ReaderStatus.PRESENT)) {
                if (this.#present) return;
                this.#present = true;
                this.#reader = reader;
                this.emit("present");
                void this.#flush(); // a tag just arrived — flush anything pending
            } else if (status.has(ReaderStatus.EMPTY)) {
                if (!this.#present) return;
                this.#present = false;
                void this.#dropCard();
                this.emit("absent");
            }
            // Otherwise the status is an ambiguous transient (e.g. powering up, UNKNOWN,
            // UNAVAILABLE) reported during startup — neither PRESENT nor EMPTY. Ignore
            // it so a card already on the reader isn't briefly misread as "removed".
        });

        reader.on("disconnect", () => {
            if (this.#reader === reader) {
                this.#reader = undefined;
                if (this.#present) {
                    this.#present = false;
                    this.emit("absent");
                }
            }
            void this.#dropCard();
        });
    }

    async #flush(): Promise<void> {
        if (this.#flashing || !this.#present || !this.#pending) return;

        this.#flashing = true;
        const codes = this.#pending;
        this.emit("flash:start");

        try {
            const card = await this.#ensureCard();
            await writeToDisplay(card, codes, this.#writeOptions);
            if (this.#pending === codes) this.#pending = null;
            this.emit("flash:done");
        } catch (err) {
            // Recoverable (tag removed / brownout): keep the image and retry when the
            // tag next becomes present. Hard errors (bad data, etc.) drop it.
            if (!isCardGoneError(err) && this.#pending === codes) this.#pending = null;
            this.emit("flash:error", err);
        } finally {
            await this.#dropCard();
            this.#flashing = false;
            // Re-flush only for a strictly newer image queued during this flash; a
            // kept-for-retry image waits for the next 'present' transition so we don't
            // hot-loop a brownout.
            if (this.#pending && this.#pending !== codes && this.#present)
                void this.#flush();
        }
    }

    async #ensureCard(): Promise<pcsc.Card> {
        if (this.#card) return this.#card;
        if (!this.#reader) throw new Error("No reader with a present card");
        this.#card = await this.#reader.connect(CardMode.SHARED);
        return this.#card;
    }

    async #dropCard(): Promise<void> {
        const card = this.#card;
        this.#card = undefined;
        if (card) await card.disconnect(CardDisposition.RESET).catch(() => undefined);
    }
}
