const empty = new Uint8Array(0);

export const CR = 0x0d;
export const LF = 0x0a;
export const outputChunkSize = 16 * 1024;

export function isSpace(byte: number | undefined): boolean {
    return byte === 0x20 || byte === 0x09;
}

function asUint8Array(source: Uint8Array): Uint8Array {
    // Use Uint8Array.prototype.slice even when the source is a Buffer.
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
}

export class StreamInput implements Disposable {
    protected chunk: Uint8Array = empty;
    protected offset = 0;
    protected reader?: ReadableStreamDefaultReader<Uint8Array>;

    public constructor(source: ReadableStream<Uint8Array>) {
        this.reader = source.getReader();
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
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value.byteLength) {
                this.chunk = asUint8Array(value);
                return true;
            }
        }
        return false;
    }

    public async peek(): Promise<number | undefined> {
        if (this.getByte() === undefined) await this.fill();
        return this.getByte();
    }

    public [Symbol.dispose](): void {
        const reader = this.reader;
        this.reader = undefined;
        this.chunk = empty;
        this.offset = 0;
        if (!reader) return;
        reader.cancel().catch(() => { });
        reader.releaseLock();
    }
}
