import { Boundary, type Delimiter } from './boundary.ts';
import { Input } from './input.ts';
import { readBoundary, readMetadata } from './mime.ts';
import type { Entry } from './types.ts';

declare const ReadableStream: typeof globalThis.ReadableStream & {
    from<T>(source: AsyncIterable<T>): ReadableStream<T>;
};

export async function* parse(contentType: string, body: ReadableStream<Uint8Array>): AsyncGenerator<Entry, void, void> {
    const boundaryValue = await readBoundary(contentType);
    await using input = new Input(body);
    const boundary = new Boundary(boundaryValue, input);
    let delimiter: Delimiter | undefined = await boundary.first();

    async function* readBody(): AsyncGenerator<Uint8Array, void, void> {
        delimiter = yield* boundary.body();
    }

    async function* readEntry(): Entry {
        for await (const { type, source } of readMetadata(input)) {
            yield { type, chunks: ReadableStream.from(source) };
        }
        yield { type: 'body', chunks: ReadableStream.from(readBody()) };
    }

    while (delimiter === 'next') {
        delimiter = undefined;
        yield readEntry();
    }
    if (delimiter === 'close') {
        while (await input.fill()) { }
    }
}
