const empty = new Uint8Array(0);

export const CR = 0x0d;
export const LF = 0x0a;
export const outputChunkSize = 16 * 1024;

export function isSpace(byte: number | undefined): boolean {
    return byte === 0x20 || byte === 0x09;
}

export class Input implements AsyncDisposable {
    protected reader?: ReadableStreamDefaultReader<Uint8Array>;
    protected chunk: Uint8Array;
    protected offset = 0;

    public constructor(stream?: ReadableStream<Uint8Array>, initial = empty) {
        this.reader = stream?.getReader();
        this.chunk = initial;
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
                this.chunk = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
                return true;
            }
        }
        return false;
    }

    public async peek(): Promise<number | undefined> {
        if (this.getByte() === undefined) await this.fill();
        return this.getByte();
    }

    public async [Symbol.asyncDispose](): Promise<void> {
        const reader = this.reader;
        this.reader = undefined;
        this.chunk = empty;
        this.offset = 0;
        if (!reader) return;
        await reader.cancel().catch(() => { });
        reader.releaseLock();
    }
}
