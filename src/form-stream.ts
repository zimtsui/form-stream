import { maxHeaderSize as defaultMaxHeaderSize } from 'node:http';
import type { MIMEType } from 'node:util';
import { Boundary, type Delimiter } from './boundary.ts';
import { decodeBody } from './encoding.ts';
import { StreamInput } from './input.ts';
import { readBoundary, readMetadata } from './mime.ts';
import type { Entry, Options } from './types.ts';



/**
 * @param body ownership NOT transferred
 */
export async function* parse(
    contentType: MIMEType,
    body: ReadableStream<Uint8Array>,
    { maxHeaderSize = defaultMaxHeaderSize }: Options = {},
): AsyncGenerator<Entry, void, void> {
    if (!Number.isSafeInteger(maxHeaderSize) || maxHeaderSize < 0)
        throw new RangeError('maxHeaderSize must be a non-negative safe integer');
    const boundaryValue = readBoundary(contentType);
    using input = new StreamInput(body);
    const boundary = new Boundary(boundaryValue, input);
    let nextDelimiter: Delimiter | undefined = await boundary.first();

    async function* readBody(): AsyncGenerator<Uint8Array, void, void> {
        nextDelimiter = yield* boundary.body();
    }

    while (nextDelimiter === 'next') {
        nextDelimiter = undefined;
        const { encoding, ...metadata } = await readMetadata(input, maxHeaderSize);
        yield { ...metadata, chunks: ReadableStream.from(decodeBody(readBody(), encoding)) };
    }
    if (nextDelimiter === 'close') {
        while (await input.fill()) { }
    }
}
