import { isAscii } from 'node:buffer';
import { MIMEType } from 'node:util';
import type { TransferEncoding } from './encoding.ts';
import { CR, LF, type StreamInput } from './input.ts';
import { MultipartMixedError, ParameterContinuationError, type Entry } from './types.ts';

const tspecials = '()<>@,;:\\"/[]?=';
const headerDecoder = new TextDecoder();

type DispositionMetadata = Pick<Entry, 'name' | 'filename'>;
type BodyMetadata = Omit<Entry, 'chunks'> & { encoding: TransferEncoding };

async function readHeaderBlock(input: StreamInput, maxHeaderSize: number): Promise<string> {
    const chunks: Uint8Array[] = [];
    let remaining = maxHeaderSize;
    let atLineStart = true;
    let afterCR = false;
    while (input.getByte() !== undefined || await input.fill()) {
        const chunk = input.getChunk();
        const start = input.getOffset();
        let end = start;
        for (; end < chunk.length; end++) {
            const byte = chunk[end];
            // The CRLF of the empty separator line is outside the budget.
            if (atLineStart && byte === CR) break;
            if (remaining === 0) throw new RangeError('MIME headers exceed ' + maxHeaderSize + ' bytes');
            if (afterCR ? byte !== LF : byte === LF) throw new SyntaxError('Expected CRLF in MIME headers');
            remaining--;
            atLineStart = byte === LF;
            afterCR = byte === CR;
        }
        if (end > start) {
            chunks.push(chunk.slice(start, end));
            input.advance(end - start);
        }
        if (end < chunk.length) {
            input.advance();
            if ((input.getByte() ?? await input.peek()) !== LF)
                throw new SyntaxError('Expected CRLF after MIME headers');
            input.advance();
            const headers = await new Blob(chunks).bytes();
            if (!isAscii(headers)) throw new SyntaxError('Expected ASCII MIME headers');
            return headerDecoder.decode(headers);
        }
    }
    throw new SyntaxError('Unexpected end of MIME headers');
}

function isToken(char: string | undefined): boolean {
    return char !== undefined && char > ' ' && char < '\x7f' && !tspecials.includes(char);
}

class MimeValue {
    protected offset = 0;

    public constructor(protected value: string) { }

    protected skipComment(): void {
        let depth = 1;
        this.offset++;
        while (this.offset < this.value.length) {
            switch (this.value[this.offset++]) {
                case '\\':
                    this.offset++;
                    break;
                case '(':
                    depth++;
                    break;
                case ')':
                    if (--depth === 0) return;
                    break;
            }
        }
        throw new SyntaxError('Invalid MIME comment');
    }

    protected skipSpace(): string | undefined {
        let char = this.value[this.offset];
        while (char === ' ' || char === '\t' || char === '(') {
            if (char === '(') this.skipComment();
            else this.offset++;
            char = this.value[this.offset];
        }
        return char;
    }

    protected readToken(): string {
        const start = this.offset;
        while (isToken(this.value[this.offset])) this.offset++;
        if (this.offset === start) throw new SyntaxError('Expected a MIME token');
        return this.value.slice(start, this.offset);
    }

    protected parameterValue(): string {
        if (this.skipSpace() !== '"') return this.readToken();
        const start = this.offset + 1;
        const end = this.value.indexOf('"', start);
        if (end < 0) throw new SyntaxError('Unterminated MIME quoted string');
        this.offset = end + 1;
        return this.value.slice(start, end);
    }

    public disposition(): DispositionMetadata {
        this.skipSpace();
        if (this.readToken().toLowerCase() !== 'form-data')
            throw new SyntaxError('Expected Content-Disposition: form-data');
        const parameters: Partial<DispositionMetadata> = {};
        for (let char = this.skipSpace(); char !== undefined; char = this.skipSpace()) {
            if (char !== ';') throw new SyntaxError('Expected ";" before a MIME parameter');
            this.offset++;
            this.skipSpace();
            const name = this.readToken().toLowerCase();
            if (/^(?:name|filename)\*(?:0|[1-9][0-9]*)\*?$/.test(name))
                throw new ParameterContinuationError('Unsupported Content-Disposition parameter continuation: ' + name);
            if (this.skipSpace() !== '=') throw new SyntaxError('Expected "=" after a MIME parameter name');
            this.offset++;
            const value = this.parameterValue();
            if (name === 'name' || name === 'filename') {
                if (parameters[name] !== undefined) throw new SyntaxError('Duplicate ' + name + ' parameter');
                parameters[name] = value;
            }
        }
        if (parameters.name === undefined) throw new SyntaxError('Expected a Content-Disposition name parameter');
        return { name: parameters.name, filename: parameters.filename };
    }

    public transferEncoding(): string {
        this.skipSpace();
        const encoding = this.readToken().toLowerCase();
        if (this.skipSpace() !== undefined) throw new SyntaxError('Invalid Content-Transfer-Encoding');
        return encoding;
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

function readContentType(value: string): MIMEType {
    try {
        return new MIMEType(value);
    } catch (error) {
        if (error instanceof TypeError) return new MIMEType('text/plain');
        throw error;
    }
}

export async function readMetadata(input: StreamInput, maxHeaderSize: number): Promise<BodyMetadata> {
    const headers = await readHeaderBlock(input, maxHeaderSize);
    const fields = headers.replace(/\r\n(?=[ \t])/g, '').split('\r\n');
    fields.pop();
    let disposition: DispositionMetadata | undefined;
    let contentType: MIMEType | undefined;
    let encoding: string | undefined;
    for (const field of fields) {
        const colon = field.indexOf(':');
        if (colon <= 0) throw new SyntaxError('Expected ":" after a MIME header name');
        const name = field.slice(0, colon);
        if (/[^!-~]/.test(name)) throw new SyntaxError('Invalid MIME header name');
        const value = field.slice(colon + 1);
        switch (name.toLowerCase()) {
            case 'content-disposition':
                if (disposition) throw new SyntaxError('Duplicate Content-Disposition');
                disposition = new MimeValue(value).disposition();
                break;
            case 'content-type':
                if (contentType) throw new SyntaxError('Duplicate Content-Type');
                contentType = readContentType(value);
                if (contentType.essence === 'multipart/mixed')
                    throw new MultipartMixedError('Unsupported multipart/mixed form entry');
                break;
            case 'content-transfer-encoding':
                if (encoding !== undefined) throw new SyntaxError('Duplicate Content-Transfer-Encoding');
                encoding = new MimeValue(value).transferEncoding();
                break;
        }
    }
    if (!disposition) throw new SyntaxError('Expected a Content-Disposition name parameter');
    switch (encoding) {
        case 'base64':
        case 'quoted-printable':
            if (contentType?.type === 'multipart') throw new SyntaxError('Invalid transfer encoding for a multipart entity');
            return { ...disposition, contentType, encoding };
        case undefined:
        case 'binary':
        case '7bit':
        case '8bit':
            return { ...disposition, contentType, encoding: 'identity' };
        default:
            return { ...disposition, contentType: new MIMEType('application/octet-stream'), encoding: 'identity' };
    }
}
