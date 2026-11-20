import type { MIMEType } from 'node:util';
import { Boundary, type Delimiter } from './boundary.ts';
import { decodeBody } from './encoding.ts';
import { StreamInput } from './input.ts';
import { readBoundary, readMetadata } from './mime.ts';
import type { Entry } from './types.ts';

export async function* parse(contentType: MIMEType, body: ReadableStream<Uint8Array>): AsyncGenerator<Entry, void, void> {
    const boundaryValue = readBoundary(contentType);
    await using input = new StreamInput(body);
    const boundary = new Boundary(boundaryValue, input);
    let nextDelimiter: Delimiter | undefined = await boundary.first();

    async function* readBody(): AsyncGenerator<Uint8Array, void, void> {
        nextDelimiter = yield* boundary.body();
    }

    async function* readEntry(): Entry {
        const { contentType, encoding } = yield* readMetadata(input);
        yield { type: 'body', contentType, chunks: ReadableStream.from(decodeBody(readBody(), encoding)) };
    }

    while (nextDelimiter === 'next') {
        nextDelimiter = undefined;
        yield readEntry();
    }
    if (nextDelimiter === 'close') {
        while (await input.fill()) { }
    }
}
