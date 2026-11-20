import { CR, LF, Input, isSpace, outputChunkSize } from './input.ts';

export type Delimiter = 'next' | 'close';

const dash = 0x2d;

export class Boundary {
    protected pattern: Uint8Array;
    protected prefix: Uint8Array;

    public constructor(boundary: string, protected input: Input) {
        const pattern = new TextEncoder().encode(`\r\n--${boundary}`);
        const prefix = new Uint8Array(pattern.length);
        for (let i = 1, matched = 0; i < pattern.length; i++) {
            while (matched && pattern[i] !== pattern[matched]) matched = prefix[matched - 1]!;
            if (pattern[i] === pattern[matched]) matched++;
            prefix[i] = matched;
        }
        this.pattern = pattern;
        this.prefix = prefix;
    }

    protected scan(end: number, matched: number): number {
        const { chunk } = this.input;
        const pattern = this.pattern;
        while (this.input.offset < end) {
            const byte = chunk[this.input.offset++];
            while (matched && byte !== pattern[matched]) matched = this.prefix[matched - 1]!;
            if (byte === pattern[matched]) {
                matched++;
                if (matched === pattern.length) break;
            }
        }
        return matched;
    }

    protected async suffix(): Promise<Delimiter | undefined> {
        let byte = this.input.getByte() ?? await this.input.peek();
        let closing = false;
        if (byte === dash) {
            this.input.offset++;
            if ((this.input.getByte() ?? await this.input.peek()) !== dash) return;
            this.input.offset++;
            closing = true;
            byte = this.input.getByte() ?? await this.input.peek();
        }
        while (isSpace(byte)) {
            this.input.offset++;
            byte = this.input.getByte() ?? await this.input.peek();
        }
        if (byte === undefined && closing) return 'close';
        if (byte !== CR) return;
        this.input.offset++;
        if ((this.input.getByte() ?? await this.input.peek()) !== LF) return;
        this.input.offset++;
        return closing ? 'close' : 'next';
    }

    public async first(): Promise<Delimiter> {
        // A delimiter at byte zero has an implicit leading CRLF.
        let matched = 2;
        while (this.input.getByte() !== undefined || await this.input.fill()) {
            matched = this.scan(this.input.chunk.length, matched);
            if (matched === this.pattern.length) {
                const delimiter = await this.suffix();
                if (delimiter !== undefined) return delimiter;
                matched = 0;
            }
        }
        throw new SyntaxError('Missing first multipart delimiter');
    }

    public async *body(): AsyncGenerator<Uint8Array, Delimiter, void> {
        let matched = 0;
        while (this.input.getByte() !== undefined || await this.input.fill()) {
            const { offset } = this.input;
            const previous = matched;
            matched = this.scan(Math.min(this.input.chunk.length, offset + outputChunkSize), matched);

            // The uncommitted bytes consist of the old prefix and the bytes
            // just scanned. Only the new matching suffix needs to be held back.
            const length = previous + this.input.offset - offset - matched;
            if (length > 0) {
                const prefixLength = Math.min(previous, length);
                const output = new Uint8Array(length);
                output.set(this.pattern.subarray(0, prefixLength));
                output.set(this.input.chunk.subarray(offset, offset + length - prefixLength), prefixLength);
                yield output;
            }
            if (matched === this.pattern.length) {
                // RFC 2046 reserves the boundary prefix at the start of a body line.
                const delimiter = await this.suffix();
                if (delimiter === undefined) throw new SyntaxError('Invalid multipart delimiter suffix');
                return delimiter;
            }
        }
        throw new SyntaxError('Unexpected end of multipart body');
    }
}
