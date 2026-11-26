import * as StreamConsumers from 'node:stream/consumers';
import { FormData, FormDataEntryValue } from 'undici';
import { parse } from './form-stream.ts';
import { meter, type SizeOutOfRangeError } from './meter.ts';
import { FileCache } from './file-cache.ts';
import { MIMEType, TextDecoder } from 'node:util';



export class FormCache extends FormData implements Disposable {
    protected ds: DisposableStack;

    protected constructor(
        ds: DisposableStack,
        entries: [string, FormDataEntryValue][],
    ) {
        super();
        for (const [name, value] of entries)
            if (typeof value === 'string')
                this.append(name, value);
            else
                this.append(name, value, value.name);
        this.ds = ds.move();
    }

    /**
     * @throws {@link TypeError}
     * @throws {@link RangeError}
     * @throws {@link SyntaxError}
     * @throws {@link SizeOutOfRangeError}
     */
    public static async save({
        bodyReadableStream,
        contentType,
        tempDirPath,
        maxTextEntrySizeByte = 1024 * 1024,
        signal,
    }: FormCache.Params): Promise<FormCache> {
        using ds = new DisposableStack();
        const entries: [string, FormDataEntryValue][] = [];
        const entryStream = parse(new MIMEType(contentType), bodyReadableStream, { signal });
        for await (const { name, filename, contentType: entryType, chunks } of entryStream) {
            if (filename !== undefined) {
                const file = ds.use(await FileCache.save({
                    fileReadableStream: chunks,
                    tempDirPath,
                    fileName: filename,
                    mimeType: entryType ?? new MIMEType('text/plain'),
                    signal,
                }));
                entries.push([name, file]);
            } else {
                const charset = entryType?.params.get('charset') ?? 'utf-8';
                const decoder = (() => {
                    try {
                        return new TextDecoder(charset, { ignoreBOM: true });
                    } catch (error) {
                        if (error instanceof RangeError)
                            throw new SyntaxError(`Unsupported charset for multipart field ${name}.`, { cause: error });
                        throw error;
                    }
                })();
                const bytes = await StreamConsumers.arrayBuffer(chunks.pipeThrough(meter(maxTextEntrySizeByte)));
                entries.push([name, decoder.decode(bytes)]);
            }
        }
        return new FormCache(ds, entries);
    }

    public [Symbol.dispose]() {
        this.ds.dispose();
    }
}

export namespace FormCache {
    export interface Params {
        bodyReadableStream: ReadableStream<Uint8Array>;
        contentType: string;
        tempDirPath: string;
        maxTextEntrySizeByte?: number;
        signal?: AbortSignal;
    }
}
