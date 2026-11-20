import { Buffer } from 'node:buffer';
import { MIMEType } from 'node:util';
import type { TransferEncoding } from './encoding.ts';
import { CR, LF, type Input, isSpace, outputChunkSize } from './input.ts';
import type { Entry } from './types.ts';

const quote = 0x22;
const backslash = 0x5c;
const openParen = 0x28;
const closeParen = 0x29;
const tspecials = '()<>@,;:\\"/[]?=';
const disposition = 'content-disposition';
const transferEncoding = 'content-transfer-encoding';

interface DispositionParameter {
    name: 'name' | 'filename';
    source: AsyncGenerator<Uint8Array, void, void>;
}

interface BodyMetadata {
    contentType: MIMEType;
    encoding: TransferEncoding;
}

function isToken(byte: number): boolean {
    return byte > 0x20 && byte < 0x7f && !tspecials.includes(String.fromCharCode(byte));
}

function isQuotedText(byte: number): boolean {
    return byte !== quote && byte !== backslash && byte !== CR && byte !== LF;
}

function isHeaderName(byte: number): boolean {
    return byte > 0x20 && byte < 0x7f && byte !== 0x3a;
}

async function readWord(input: Input, accepts: (byte: number) => boolean, limit: number): Promise<string> {
    let word = '';
    let tooLong = false;
    for (;;) {
        const byte = input.getByte() ?? await input.peek();
        if (byte === undefined || !accepts(byte)) break;
        if (word.length < limit) word += String.fromCharCode(byte);
        else tooLong = true;
        input.advance();
    }
    if (!word) throw new SyntaxError('Expected a MIME token');
    return tooLong ? '' : word.toLowerCase();
}

class MimeValue {
    protected input: Input;
    protected ended = false;

    public constructor(input: Input) {
        this.input = input;
    }

    protected async fold(): Promise<boolean> {
        const input = this.input;
        input.advance();
        if ((input.getByte() ?? await input.peek()) !== LF)
            throw new SyntaxError('Expected CRLF in MIME header');
        input.advance();
        if (isSpace(input.getByte() ?? await input.peek())) return true;
        this.ended = true;
        return false;
    }

    protected async peek(): Promise<number | undefined> {
        if (this.ended) return;
        const byte = this.input.getByte() ?? await this.input.peek();
        if (byte === CR) return await this.fold() ? this.input.getByte() : undefined;
        if (byte === LF) throw new SyntaxError('Unexpected LF in MIME header');
        if (byte === undefined) throw new SyntaxError('Unexpected end of MIME headers');
        return byte;
    }

    protected async quotedPair(): Promise<number> {
        const input = this.input;
        input.advance();
        let byte = input.getByte() ?? await input.peek();
        if (byte === CR) {
            if (!await this.fold()) throw new SyntaxError('Expected a continuation after quoted CRLF');
            byte = input.getByte();
        }
        if (byte === undefined || byte === LF) throw new SyntaxError('Invalid MIME quoted pair');
        input.advance();
        return byte;
    }

    protected async skipComment(): Promise<void> {
        let depth = 1;
        this.input.advance();
        while (depth) {
            const byte = this.input.getByte();
            const current = byte === undefined || byte === CR || byte === LF ? await this.peek() : byte;
            if (current === undefined || current > 0x7f) throw new SyntaxError('Invalid MIME comment');
            if (current === backslash) {
                if (await this.quotedPair() > 0x7f) throw new SyntaxError('Invalid MIME comment');
                continue;
            }
            if (current === openParen) depth++;
            if (current === closeParen) depth--;
            this.input.advance();
        }
    }

    public async skipSpace(): Promise<number | undefined> {
        let byte = await this.peek();
        while (isSpace(byte) || byte === openParen) {
            if (byte === openParen) await this.skipComment();
            else this.input.advance();
            byte = this.input.getByte();
            if (byte === undefined || byte === CR || byte === LF) byte = await this.peek();
        }
        return byte;
    }

    public async token(limit: number): Promise<string> {
        if (await this.skipSpace() === undefined) throw new SyntaxError('Expected a MIME token');
        return readWord(this.input, isToken, limit);
    }

    public async *dispositionParameters(): AsyncGenerator<DispositionParameter, void, void> {
        for (;;) {
            const byte = await this.skipSpace();
            if (byte === undefined) return;
            if (byte !== 0x3b) throw new SyntaxError('Expected ";" before a MIME parameter');
            this.input.advance();
            const name = await this.token('filename'.length);
            if (await this.skipSpace() !== 0x3d) throw new SyntaxError('Expected "=" after a MIME parameter name');
            this.input.advance();

            const source = this.parameterValue();
            if (name === 'name' || name === 'filename') {
                yield { name, source };
            } else {
                for await (const _ of source) { }
            }
        }
    }

    protected takeRun(accepts: (byte: number) => boolean): Uint8Array {
        const input = this.input;
        const chunk = input.getChunk();
        const offset = input.getOffset();
        const limit = Math.min(chunk.length, offset + outputChunkSize);
        let end = offset;
        while (end < limit && accepts(chunk[end]!)) end++;
        input.advance(end - offset);
        return chunk.slice(offset, end);
    }

    protected async *parameterValue(): AsyncGenerator<Uint8Array, void, void> {
        const input = this.input;
        let byte = await this.skipSpace();
        if (byte === quote) {
            input.advance();
            yield* this.quotedString();
            return;
        }
        if (byte === undefined || !isToken(byte)) throw new SyntaxError('Expected a MIME parameter value');
        do {
            yield this.takeRun(isToken);
            byte = input.getByte() ?? await input.peek();
        } while (byte !== undefined && isToken(byte));
    }

    protected async *quotedString(): AsyncGenerator<Uint8Array, void, void> {
        const input = this.input;
        for (;;) {
            const byte = input.getByte() ?? await input.peek();
            if (byte === quote) {
                input.advance();
                return;
            }
            if (byte === backslash) {
                const escaped = await this.quotedPair();
                yield Uint8Array.of(escaped);
                continue;
            }
            if (byte === CR) {
                if (!await this.fold()) throw new SyntaxError('Unterminated MIME quoted string');
                continue;
            }
            if (byte === undefined || byte === LF) throw new SyntaxError('Unterminated MIME quoted string');
            yield this.takeRun(isQuotedText);
        }
    }

    public async *line(): AsyncGenerator<Uint8Array, void, void> {
        while (await this.peek() !== undefined) {
            const chunk = this.input.getChunk();
            const offset = this.input.getOffset();
            let end = offset + 1;
            while (end < chunk.length && chunk[end] !== CR && chunk[end] !== LF) end++;
            this.input.advance(end - offset);
            yield chunk.subarray(offset, end);
        }
    }
}

export function readBoundary(contentType: MIMEType): string {
    if (contentType.essence !== 'multipart/form-data')
        throw new SyntaxError('Expected a multipart/form-data Content-Type');
    const boundary = contentType.params.get('boundary');
    if (!boundary || boundary.length > 70 || boundary.endsWith(' ') || /[^0-9A-Za-z'()+_,.\/:=? -]/.test(boundary))
        throw new SyntaxError('Missing or invalid multipart boundary');
    return boundary;
}

async function readContentType(header: MimeValue): Promise<MIMEType> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of header.line()) chunks.push(chunk);
    const value = Buffer.concat(chunks).toString('latin1');
    try {
        return new MIMEType(value);
    } catch (error) {
        if (error instanceof TypeError) return new MIMEType('text/plain');
        throw error;
    }
}

export async function* readMetadata(input: Input): AsyncGenerator<Entry.Part.Name | Entry.Part.Filename, BodyMetadata, void> {
    let hasDisposition = false;
    let contentType: MIMEType | undefined;
    let encoding: string | undefined;
    const seen = { name: false, filename: false };
    while ((input.getByte() ?? await input.peek()) !== CR) {
        const header = await readWord(input, isHeaderName, transferEncoding.length);
        if ((input.getByte() ?? await input.peek()) !== 0x3a) throw new SyntaxError('Expected ":" after a MIME header name');
        input.advance();
        const value = new MimeValue(input);
        switch (header) {
            case disposition:
                if (hasDisposition) throw new SyntaxError('Duplicate Content-Disposition');
                hasDisposition = true;
                if (await value.token(9) !== 'form-data') throw new SyntaxError('Expected Content-Disposition: form-data');
                for await (const { name, source } of value.dispositionParameters()) {
                    if (seen[name]) throw new SyntaxError(`Duplicate ${name} parameter`);
                    seen[name] = true;
                    yield { type: name, chunks: ReadableStream.from(source) };
                }
                break;
            case 'content-type':
                if (contentType) throw new SyntaxError('Duplicate Content-Type');
                contentType = await readContentType(value);
                break;
            case transferEncoding:
                if (encoding !== undefined) throw new SyntaxError('Duplicate Content-Transfer-Encoding');
                encoding = await value.token('quoted-printable'.length);
                if (await value.skipSpace() !== undefined) throw new SyntaxError('Invalid Content-Transfer-Encoding');
                break;
            default:
                for await (const _ of value.line()) { }
        }
    }
    input.advance();
    if ((input.getByte() ?? await input.peek()) !== LF) throw new SyntaxError('Expected CRLF after MIME headers');
    input.advance();
    if (!seen.name) throw new SyntaxError('Expected a Content-Disposition name parameter');
    switch (encoding) {
        case 'base64':
        case 'quoted-printable':
            if (contentType?.type === 'multipart') throw new SyntaxError('Invalid transfer encoding for a multipart entity');
            return { contentType: contentType ?? new MIMEType('text/plain'), encoding };
        case undefined:
        case 'binary':
        case '7bit':
        case '8bit':
            return { contentType: contentType ?? new MIMEType('text/plain'), encoding: 'identity' };
        default:
            return { contentType: new MIMEType('application/octet-stream'), encoding: 'identity' };
    }
}
