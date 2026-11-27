import { maxHeaderSize as defaultMaxHeaderSize } from 'node:http';
import type { MIMEType } from 'node:util';
import { Boundary, type Delimiter } from './boundary.ts';
import { createBodyDecoder } from './encoding.ts';
import { StreamInput } from './input.ts';
import { readBoundary, readMetadata } from './mime.ts';
import type { Entry, RequestRangeError, RequestSyntaxError, RequestTypeError } from './types.ts';


/**
 * @throws {@link RequestSyntaxError}
 * @throws {@link RequestRangeError}
 * @throws {@link RequestTypeError}
 */
export type ParsingAsyncGenerator = AsyncGenerator<Entry, void, void>;

/**
 * @param body ownership NOT transferred
 */
export async function* parse(
    contentType: MIMEType,
    body: ReadableStream<Uint8Array>,
    { maxHeaderSize = defaultMaxHeaderSize, signal }: Options = {},
): ParsingAsyncGenerator {
    if (!Number.isSafeInteger(maxHeaderSize) || maxHeaderSize < 0)
        throw new RangeError('maxHeaderSize must be a non-negative safe integer');
    const boundaryValue = readBoundary(contentType);
    using input = new StreamInput(body, signal);
    const boundary = new Boundary(boundaryValue, input);
    let nextDelimiter: Delimiter | undefined = await boundary.first();

    while (nextDelimiter === 'next') {
        nextDelimiter = undefined;
        const { encoding, ...metadata } = await readMetadata(input, maxHeaderSize);
        const readBody = boundary.body();
        const decoder = createBodyDecoder(encoding);
        let cancelled = false;
        let bodyFailure: { reason: unknown } | undefined;
        const chunks = new ReadableStream<Uint8Array>({
            async pull(controller) {
                let emitted = false;
                const enqueue = (chunk: Uint8Array) => {
                    controller.enqueue(chunk);
                    emitted = true;
                };
                try {
                    while (!emitted) {
                        const result = await readBody();
                        if (cancelled) return;
                        if (typeof result === 'string') {
                            decoder?.finish(enqueue);
                            nextDelimiter = result;
                            controller.close();
                            return;
                        }
                        if (decoder) decoder.write(result, enqueue);
                        else enqueue(result);
                    }
                } catch (reason) {
                    if (!cancelled) bodyFailure = { reason };
                    throw reason;
                }
            },
            cancel(reason) {
                cancelled = true;
                nextDelimiter = undefined;
                input.close(reason);
            },
        }, { highWaterMark: 0 });
        yield { ...metadata, chunks };
        if (bodyFailure) throw bodyFailure.reason;
    }
    if (nextDelimiter === 'close') {
        while (await input.fill()) { }
    }
}


export interface Options {
    maxHeaderSize?: number;
    signal?: AbortSignal;
}
