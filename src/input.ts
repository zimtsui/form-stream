const empty = new Uint8Array(0);

export const CR = 0x0d;
export const LF = 0x0a;
export const outputChunkSize = 16 * 1024;

export function isSpace(byte: number | undefined): boolean {
    return byte === 0x20 || byte === 0x09;
}

export class Input {
    public chunk: Uint8Array;
    public offset = 0;
    public ended = false;
    protected stopped = false;

    public constructor(
        protected reader?: ReadableStreamDefaultReader<Uint8Array>,
        initial = empty,
    ) {
        this.chunk = initial;
    }

    public getByte(): number | undefined {
        return this.chunk[this.offset];
    }

    public async fill(): Promise<boolean> {
        if (this.stopped) throw new TypeError('The multipart parser is closed');
        this.chunk = empty;
        this.offset = 0;
        while (this.reader && !this.ended) {
            const { value, done } = await this.reader.read();
            if (this.stopped) throw new TypeError('The multipart parser is closed');
            if (done) {
                this.ended = true;
                break;
            }
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

    public stop(): void {
        this.stopped = true;
        this.chunk = empty;
        this.offset = 0;
    }
}
