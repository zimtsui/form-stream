import { addAbortListener } from 'node:events';


const empty = new Uint8Array(0);

export const CR = 0x0d;
export const LF = 0x0a;
export const outputChunkSize = 16 * 1024;

export function isSpace(byte: number | undefined): boolean {
    return byte === 0x20 || byte === 0x09;
}

export class StreamInput implements Disposable {
    protected chunk: Uint8Array = empty;
    protected offset = 0;
    protected reader?: ReadableStreamDefaultReader<Uint8Array>;
    protected abortListener?: Disposable;

    public constructor(source: ReadableStream<Uint8Array>, signal?: AbortSignal) {
        this.reader = source.getReader();
        if (!signal) return;
        if (signal.aborted) this.close(signal.reason);
        else this.abortListener = addAbortListener(signal, () => this.close(signal.reason));
    }

    public getChunk(): Uint8Array {
        return this.chunk;
    }

    public getOffset(): number {
        return this.offset;
    }

    public advance(length = 1): void {
        this.offset += length;
    }

    public getByte(): number | undefined {
        return this.chunk[this.offset];
    }

    public async fill(): Promise<boolean> {
        this.chunk = empty;
        this.offset = 0;
        while (this.reader) {
            const reader = this.reader;
            const { value, done } = await reader.read();
            if (reader !== this.reader || done) break;
            if (value.byteLength) {
                this.chunk = value;
                return true;
            }
        }
        return false;
    }

    public async peek(): Promise<number | undefined> {
        if (this.getByte() === undefined) await this.fill();
        return this.getByte();
    }

    protected close(reason?: unknown): void {
        const reader = this.reader;
        const abortListener = this.abortListener;
        this.reader = undefined;
        this.abortListener = undefined;
        this.chunk = empty;
        this.offset = 0;
        abortListener?.[Symbol.dispose]();
        if (!reader) return;
        reader.cancel(reason).catch(() => { });
        reader.releaseLock();
    }

    public [Symbol.dispose](): void {
        this.close();
    }
}
