import { Boundary, type Delimiter } from './boundary.ts';
import { StreamInput } from './input.ts';
import { readBoundary, readMetadata } from './mime.ts';
import type { Entry } from './types.ts';

declare const ReadableStream: typeof globalThis.ReadableStream & {
    from<T>(source: AsyncIterable<T>): ReadableStream<T>;
};

export async function* parse(contentType: string, body: ReadableStream<Uint8Array>): AsyncGenerator<Entry, void, void> {
    const boundaryValue = await readBoundary(contentType);
    await using input = new StreamInput(body);
    const boundary = new Boundary(boundaryValue, input);
    let nextDelimiter: Delimiter | undefined = await boundary.first();

    async function* readBody(): AsyncGenerator<Uint8Array, void, void> {
        nextDelimiter = yield* boundary.body();
    }

    async function* readEntry(): Entry {
        for await (const { name, source } of readMetadata(input)) {
            yield { type: name, chunks: ReadableStream.from(source) };
        }
        yield { type: 'body', chunks: ReadableStream.from(readBody()) };
    }

    while (nextDelimiter === 'next') {
        nextDelimiter = undefined;
        yield readEntry();
    }
    if (nextDelimiter === 'close') {
        while (await input.fill()) { }
    }
}
