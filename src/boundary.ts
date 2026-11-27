import { CR, LF, isSpace, outputChunkSize, type StreamInput } from './input.ts';
import { RequestSyntaxError } from './types.ts';

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

    protected async suffix(): Promise<Delimiter | 'missing' | 'invalid'> {
        const input = this.input;
        let byte = input.getByte() ?? await input.peek();
        let closing = false;
        if (byte === dash) {
            input.advance();
            byte = input.getByte() ?? await input.peek();
            if (byte !== dash) return byte === undefined ? 'missing' : 'invalid';
            input.advance();
            closing = true;
            byte = input.getByte() ?? await input.peek();
        }
        while (isSpace(byte)) {
            input.advance();
            byte = input.getByte() ?? await input.peek();
        }
        if (byte === undefined) return closing ? 'close' : 'missing';
        if (byte !== CR) return 'invalid';
        input.advance();
        byte = input.getByte() ?? await input.peek();
        if (byte !== LF) return byte === undefined ? 'missing' : 'invalid';
        input.advance();
        return closing ? 'close' : 'next';
    }

    public async first(): Promise<Delimiter> {
        const input = this.input;
        // A delimiter at byte zero has an implicit leading CRLF.
        let matched = 2;
        let startsAtByteZero = true;
        while (input.getByte() !== undefined || await input.fill()) {
            const previous = matched;
            const offset = input.getOffset();
            matched = this.scan(input.getChunk().length, matched);
            startsAtByteZero &&= matched === previous + input.getOffset() - offset;
            if (matched === this.pattern.length) {
                const delimiter = await this.suffix();
                if (delimiter === 'next') return delimiter;
                // FormData can serialize an empty form as a standalone closing delimiter.
                if (startsAtByteZero && delimiter === 'close' && await input.peek() === undefined)
                    return delimiter;
                startsAtByteZero = false;
                matched = delimiter === 'close' ? 2 : 0;
            }
        }
        throw new RequestSyntaxError('Missing first multipart delimiter');
    }

    public body(): () => Promise<Uint8Array | Delimiter> {
        const input = this.input;
        // In a header-only part, the CRLF consumed after the headers is
        // already the leading CRLF of the delimiter.
        let matched = 2;
        let consumedPrefix = matched;
        return async () => {
            while (matched !== this.pattern.length) {
                if (input.getByte() === undefined && !await input.fill()) {
                    const ErrorType = input.reachedEOF ? RequestSyntaxError : SyntaxError;
                    throw new ErrorType('Unexpected end of multipart body');
                }
                const chunk = input.getChunk();
                const offset = input.getOffset();
                const previous = matched;
                matched = this.scan(Math.min(chunk.length, offset + outputChunkSize), matched);

                // The uncommitted bytes consist of the old prefix and the bytes
                // just scanned. Only the new matching suffix needs to be held back.
                const length = previous + input.getOffset() - offset - matched;
                if (length <= 0) continue;
                const prefixLength = Math.min(previous, length);
                const prefixStart = Math.min(consumedPrefix, prefixLength);
                consumedPrefix -= prefixStart;
                if (length === prefixStart) continue;
                const end = offset + length - prefixLength;
                if (prefixLength === prefixStart) return chunk.slice(offset, end);
                const output = new Uint8Array(length - prefixStart);
                output.set(this.pattern.subarray(prefixStart, prefixLength));
                output.set(chunk.subarray(offset, end), prefixLength - prefixStart);
                return output;
            }
            // RFC 2046 reserves the boundary prefix at the start of a body line.
            const delimiter = await this.suffix();
            if (delimiter === 'invalid' || delimiter === 'missing') {
                const ErrorType = delimiter === 'missing' && !input.reachedEOF ? SyntaxError : RequestSyntaxError;
                throw new ErrorType('Invalid multipart delimiter suffix');
            }
            return delimiter;
        };
    }
}
