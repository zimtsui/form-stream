import { CR, LF, isSpace, outputChunkSize, type StreamInput } from './input.ts';

export type Delimiter = 'next' | 'close';

const dash = 0x2d;

export class Boundary {
    protected input: StreamInput;
    protected pattern: Uint8Array;

    public constructor(boundary: string, input: StreamInput) {
        this.input = input;
        this.pattern = new TextEncoder().encode(`\r\n--${boundary}`);
    }

    protected scan(end: number, matched: number): number {
        const chunk = this.input.getChunk();
        const offset = this.input.getOffset();
        const pattern = this.pattern;
        let cursor = offset;
        while (cursor < end) {
            const byte = chunk[cursor++];
            if (byte === pattern[matched]) {
                matched++;
                if (matched === pattern.length) break;
            } else {
                // The leading CR is the only CR in a validated boundary pattern.
                matched = byte === CR ? 1 : 0;
            }
        }
        this.input.advance(cursor - offset);
        return matched;
    }

    protected async suffix(): Promise<Delimiter | undefined> {
        const input = this.input;
        let byte = input.getByte() ?? await input.peek();
        let closing = false;
        if (byte === dash) {
            input.advance();
            if ((input.getByte() ?? await input.peek()) !== dash) return;
            input.advance();
            closing = true;
            byte = input.getByte() ?? await input.peek();
        }
        while (isSpace(byte)) {
            input.advance();
            byte = input.getByte() ?? await input.peek();
        }
        if (byte === undefined && closing) return 'close';
        if (byte !== CR) return;
        input.advance();
        if ((input.getByte() ?? await input.peek()) !== LF) return;
        input.advance();
        return closing ? 'close' : 'next';
    }

    public async first(): Promise<Delimiter> {
        const input = this.input;
        // A delimiter at byte zero has an implicit leading CRLF.
        let matched = 2;
        while (input.getByte() !== undefined || await input.fill()) {
            matched = this.scan(input.getChunk().length, matched);
            if (matched === this.pattern.length) {
                const delimiter = await this.suffix();
                if (delimiter === 'next') return delimiter;
                matched = delimiter === 'close' ? 2 : 0;
            }
        }
        throw new SyntaxError('Missing first multipart delimiter');
    }

    public async *body(): AsyncGenerator<Uint8Array, Delimiter, void> {
        const input = this.input;
        // In a header-only part, the CRLF consumed after the headers is
        // already the leading CRLF of the delimiter.
        let matched = 2;
        let consumedPrefix = matched;
        while (input.getByte() !== undefined || await input.fill()) {
            const chunk = input.getChunk();
            const offset = input.getOffset();
            const previous = matched;
            matched = this.scan(Math.min(chunk.length, offset + outputChunkSize), matched);

            // The uncommitted bytes consist of the old prefix and the bytes
            // just scanned. Only the new matching suffix needs to be held back.
            const length = previous + input.getOffset() - offset - matched;
            if (length > 0) {
                const prefixLength = Math.min(previous, length);
                const prefixStart = Math.min(consumedPrefix, prefixLength);
                consumedPrefix -= prefixStart;
                const end = offset + length - prefixLength;
                if (length > prefixStart) {
                    if (prefixLength === prefixStart) {
                        yield chunk.slice(offset, end);
                    } else {
                        const output = new Uint8Array(length - prefixStart);
                        output.set(this.pattern.subarray(prefixStart, prefixLength));
                        output.set(chunk.subarray(offset, end), prefixLength - prefixStart);
                        yield output;
                    }
                }
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
