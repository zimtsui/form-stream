const empty = new Uint8Array(0);
// Use the intrinsic typed-array name to recognize chunks from other realms.
const getTypedArrayName = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Uint8Array.prototype),
    Symbol.toStringTag,
)!.get!;

export const CR = 0x0d;
export const LF = 0x0a;
export const outputChunkSize = 16 * 1024;

export function isSpace(byte: number | undefined): boolean {
    return byte === 0x20 || byte === 0x09;
}

export class Input {
    protected reader?: ReadableStreamDefaultReader<Uint8Array>;
    protected chunk: Uint8Array;
    protected offset = 0;
    protected ended = false;
    protected disposal?: Promise<void>;

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
        if (!Number.isInteger(length) || length < 0 || length > this.chunk.length - this.offset)
            throw new RangeError('Cannot advance beyond the remaining input chunk');
        this.offset += length;
    }

    public getByte(): number | undefined {
        return this.chunk[this.offset];
    }

    public async fill(): Promise<boolean> {
        if (this.disposal) throw new TypeError('The multipart parser is closed');
        this.chunk = empty;
        this.offset = 0;
        while (this.reader && !this.ended) {
            let result: ReadableStreamReadResult<Uint8Array>;
            try {
                result = await this.reader.read();
            } catch (reason) {
                this.ended = true;
                throw reason;
            }
            if (this.disposal) throw new TypeError('The multipart parser is closed');
            const { value, done } = result;
            if (done) {
                this.ended = true;
                break;
            }
            if (getTypedArrayName.call(value) !== 'Uint8Array')
                throw new TypeError('Expected a Uint8Array chunk in the multipart body');
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

    protected async dispose(): Promise<void> {
        const reader = this.reader;
        if (!reader) return;
        this.reader = undefined;
        try {
            if (!this.ended) await reader.cancel();
        } finally {
            reader.releaseLock();
        }
    }

    public [Symbol.asyncDispose](): Promise<void> {
        if (this.disposal) return this.disposal;
        this.chunk = empty;
        this.offset = 0;
        // Cache disposal before invoking the stream's cancellation callback.
        return this.disposal = Promise.resolve().then(() => this.dispose());
    }
}
