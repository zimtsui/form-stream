import { CR, LF, Input, isSpace, outputChunkSize } from './input.ts';

const quote = 0x22;
const backslash = 0x5c;
const openParen = 0x28;
const closeParen = 0x29;
const tspecials = '()<>@,;:\\"/[]?=';
const disposition = 'content-disposition';

type Metadata = {
    type: 'name' | 'filename';
    source: AsyncGenerator<Uint8Array, void, void>;
};

function isToken(byte: number): boolean {
    return byte > 0x20 && byte < 0x7f && !tspecials.includes(String.fromCharCode(byte));
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
        input.offset++;
    }
    if (!word) throw new SyntaxError('Expected a MIME token');
    return tooLong ? '' : word.toLowerCase();
}

class MimeValue {
    protected ended = false;

    public constructor(
        protected input: Input,
        protected headerLine: boolean,
    ) { }

    protected async fold(): Promise<boolean> {
        this.input.offset++;
        if ((this.input.getByte() ?? await this.input.peek()) !== LF)
            throw new SyntaxError('Expected CRLF in MIME header');
        this.input.offset++;
        if (isSpace(this.input.getByte() ?? await this.input.peek())) return true;
        if (!this.headerLine) throw new SyntaxError('Unexpected CRLF in Content-Type');
        this.ended = true;
        return false;
    }

    protected async peek(): Promise<number | undefined> {
        if (this.ended) return;
        const byte = this.input.getByte() ?? await this.input.peek();
        if (byte === CR) return await this.fold() ? this.input.getByte() : undefined;
        if (byte === LF) throw new SyntaxError('Unexpected LF in MIME header');
        if (byte === undefined && this.headerLine) throw new SyntaxError('Unexpected end of MIME headers');
        return byte;
    }

    protected async quotedPair(): Promise<number> {
        this.input.offset++;
        const byte = this.input.getByte() ?? await this.input.peek();
        if (byte === undefined || byte === LF) throw new SyntaxError('Invalid MIME quoted pair');
        if (byte === CR && !await this.fold())
            throw new SyntaxError('Expected a continuation after quoted CRLF');
        this.input.offset++;
        return byte;
    }

    protected async skipComment(): Promise<void> {
        let depth = 1;
        this.input.offset++;
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
            this.input.offset++;
        }
    }

    public async skipSpace(): Promise<number | undefined> {
        let byte = await this.peek();
        while (isSpace(byte) || byte === openParen) {
            if (byte === openParen) await this.skipComment();
            else this.input.offset++;
            byte = this.input.getByte();
            if (byte === undefined || byte === CR || byte === LF) byte = await this.peek();
        }
        return byte;
    }

    public async token(limit: number): Promise<string> {
        if (await this.skipSpace() === undefined) throw new SyntaxError('Expected a MIME token');
        return readWord(this.input, isToken, limit);
    }

    public async parameter(): Promise<string | undefined> {
        const byte = await this.skipSpace();
        if (byte === undefined) return;
        if (byte !== 0x3b) throw new SyntaxError('Expected ";" before a MIME parameter');
        this.input.offset++;
        const attribute = await this.token(8);
        if (await this.skipSpace() !== 0x3d) throw new SyntaxError('Expected "=" after a MIME parameter name');
        this.input.offset++;
        return attribute;
    }

    public async *parameterValue(): AsyncGenerator<Uint8Array, void, void> {
        let byte = await this.skipSpace();
        if (byte === quote) {
            this.input.offset++;
            yield* this.quotedString();
            return;
        }
        if (byte === undefined || !isToken(byte)) throw new SyntaxError('Expected a MIME parameter value');
        do {
            const start = this.input.offset;
            const limit = Math.min(this.input.chunk.length, start + outputChunkSize);
            while (this.input.offset < limit && isToken(this.input.getByte()!)) this.input.offset++;
            yield this.input.chunk.slice(start, this.input.offset);
            byte = this.input.getByte() ?? await this.input.peek();
        } while (byte !== undefined && isToken(byte));
    }

    protected async *quotedString(): AsyncGenerator<Uint8Array, void, void> {
        for (;;) {
            const byte = this.input.getByte() ?? await this.input.peek();
            if (byte === quote) {
                this.input.offset++;
                return;
            }
            if (byte === backslash) {
                const escaped = await this.quotedPair();
                yield escaped === CR ? Uint8Array.of(CR, LF) : Uint8Array.of(escaped);
                continue;
            }
            if (byte === CR) {
                if (!await this.fold()) throw new SyntaxError('Unterminated MIME quoted string');
                continue;
            }
            if (byte === undefined || byte === LF) throw new SyntaxError('Unterminated MIME quoted string');

            const start = this.input.offset;
            const limit = Math.min(this.input.chunk.length, start + outputChunkSize);
            while (this.input.offset < limit) {
                const current = this.input.getByte();
                if (current === quote || current === backslash || current === CR || current === LF) break;
                this.input.offset++;
            }
            yield this.input.chunk.slice(start, this.input.offset);
        }
    }

    public async skipLine(): Promise<void> {
        while (await this.peek() !== undefined) {
            do this.input.offset++;
            while (this.input.getByte() !== undefined && this.input.getByte() !== CR && this.input.getByte() !== LF);
        }
    }
}

export async function readBoundary(contentType: string): Promise<string> {
    const input = new Input(undefined, new TextEncoder().encode(contentType));
    const value = new MimeValue(input, false);
    if (await value.token(9) !== 'multipart' || await value.skipSpace() !== 0x2f)
        throw new SyntaxError('Expected a multipart/form-data Content-Type');
    input.offset++;
    if (await value.token(9) !== 'form-data') throw new SyntaxError('Expected a multipart/form-data Content-Type');

    let boundary: string | undefined;
    for (let parameter = await value.parameter(); parameter !== undefined; parameter = await value.parameter()) {
        const source = value.parameterValue();
        if (parameter === 'boundary') {
            if (boundary !== undefined) throw new SyntaxError('Duplicate multipart boundary');
            boundary = '';
            for await (const chunk of source) {
                if (boundary.length + chunk.length > 70) throw new SyntaxError('Multipart boundary exceeds 70 bytes');
                boundary += String.fromCharCode(...chunk);
            }
        } else {
            for await (const _ of source) { }
        }
    }
    if (!boundary || boundary.endsWith(' ') || /[^0-9A-Za-z'()+_,.\/:=? -]/.test(boundary))
        throw new SyntaxError('Missing or invalid multipart boundary');
    return boundary;
}

export async function* readMetadata(input: Input): AsyncGenerator<Metadata, void, void> {
    let hasDisposition = false;
    let hasName = false;
    let hasFilename = false;
    while ((input.getByte() ?? await input.peek()) !== CR) {
        const header = await readWord(input, isHeaderName, disposition.length);
        if ((input.getByte() ?? await input.peek()) !== 0x3a) throw new SyntaxError('Expected ":" after a MIME header name');
        input.offset++;
        const value = new MimeValue(input, true);
        if (header !== disposition) {
            await value.skipLine();
            continue;
        }
        if (hasDisposition) throw new SyntaxError('Duplicate Content-Disposition');
        hasDisposition = true;
        if (await value.token(9) !== 'form-data') throw new SyntaxError('Expected Content-Disposition: form-data');
        for (let parameter = await value.parameter(); parameter !== undefined; parameter = await value.parameter()) {
            const source = value.parameterValue();
            if (parameter === 'name') {
                if (hasName) throw new SyntaxError('Duplicate name parameter');
                hasName = true;
                yield { type: 'name', source };
            } else if (parameter === 'filename') {
                if (hasFilename) throw new SyntaxError('Duplicate filename parameter');
                hasFilename = true;
                yield { type: 'filename', source };
            } else {
                for await (const _ of source) { }
            }
        }
    }
    input.offset++;
    if ((input.getByte() ?? await input.peek()) !== LF) throw new SyntaxError('Expected CRLF after MIME headers');
    input.offset++;
    if (!hasName) throw new SyntaxError('Expected a Content-Disposition name parameter');
}
