import { CR, LF, isSpace } from './input.ts';

const latin1Decoder = new TextDecoder('latin1');

export type TransferEncoding = 'identity' | 'base64' | 'quoted-printable';

export function decodeBody(body: AsyncIterable<Uint8Array>, encoding: TransferEncoding): AsyncIterable<Uint8Array> {
    switch (encoding) {
        case 'identity': return body;
        case 'base64': return decodeBase64(body);
        case 'quoted-printable': return decodeQuotedPrintable(body);
    }
}

async function* decodeBase64(body: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array, void, void> {
    let remainder = '';
    let padded = false;
    for await (const chunk of body) {
        const encoded = remainder + latin1Decoder.decode(chunk).replace(/[^A-Za-z0-9+/=]/g, '');
        if (padded && encoded) throw new SyntaxError('Unexpected data after base64 padding');
        const end = encoded.length - encoded.length % 4;
        remainder = encoded.slice(end);
        if (!end) continue;

        const groups = encoded.slice(0, end);
        if (groups.includes('=')) {
            if (remainder) throw new SyntaxError('Invalid base64 padding');
            padded = true;
        }
        yield Uint8Array.fromBase64(groups, { lastChunkHandling: 'strict' });
    }
    if (remainder) throw new SyntaxError('Incomplete base64 group');
}

const equals = 0x3d;

function hexDigit(byte: number | undefined): number {
    if (byte !== undefined) {
        if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
        if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
    }
    throw new SyntaxError('Invalid quoted-printable escape');
}

function decodeQuotedPrintableLine(line: Uint8Array, length: number, terminated: boolean): Uint8Array {
    const softBreak = terminated && line[length - 1] === equals;
    const end = length - Number(softBreak);
    const hardBreak = terminated && !softBreak;
    const output = new Uint8Array(end + (hardBreak ? 2 : 0));
    let offset = 0;
    for (let index = 0; index < end; index++) {
        const byte = line[index]!;
        if (byte === equals) {
            if (index + 2 >= end) throw new SyntaxError('Incomplete quoted-printable escape');
            output[offset++] = hexDigit(line[++index]) * 16 + hexDigit(line[++index]);
        } else {
            if (!isSpace(byte) && (byte < 0x21 || byte > 0x7e)) throw new SyntaxError('Invalid quoted-printable byte');
            output[offset++] = byte;
        }
    }
    if (hardBreak) {
        output[offset++] = CR;
        output[offset++] = LF;
    }
    return output.subarray(0, offset);
}

async function* decodeQuotedPrintable(body: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array, void, void> {
    const line = new Uint8Array(76);
    let length = 0;
    let contentLength = 0;
    let afterCR = false;
    for await (const chunk of body) {
        for (const byte of chunk) {
            if (afterCR) {
                if (byte !== LF) throw new SyntaxError('Expected CRLF in quoted-printable body');
                const output = decodeQuotedPrintableLine(line, contentLength, true);
                length = 0;
                contentLength = 0;
                afterCR = false;
                if (output.length) yield output;
            } else if (byte === CR) {
                afterCR = true;
            } else if (byte === LF) {
                throw new SyntaxError('Expected CRLF in quoted-printable body');
            } else {
                // Allow transport padding of any length at the end of the line.
                if (length < line.length) line[length++] = byte;
                else if (!isSpace(byte)) throw new SyntaxError('Quoted-printable line exceeds 76 characters');
                if (!isSpace(byte)) contentLength = length;
            }
        }
    }
    if (afterCR) throw new SyntaxError('Incomplete quoted-printable line break');
    if (contentLength) yield decodeQuotedPrintableLine(line, contentLength, false);
}
