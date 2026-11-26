import * as StreamConsumers from 'node:stream/consumers';
import type { FormData, FormDataEntryValue } from 'undici';
import { parse } from './form-stream.ts';
import { meter } from './meter.ts';
import { FileCache } from './file-cache.ts';
import { MIMEType, TextDecoder } from 'node:util';



export class FormCache implements Disposable, FormData {
    protected ds: DisposableStack;

    protected constructor(
        ds: DisposableStack,
        protected pairs: [string, string | FileCache][],
    ) {
        this.ds = ds.move();
    }

    /**
     * @throws {@link TypeError}
     * @throws {@link RangeError}
     * @throws {@link SyntaxError}
     */
    public static async save({
        bodyReadableStream,
        contentType,
        tempDirPath,
        maxTextEntrySizeByte = 1024 * 1024,
        signal,
    }: FormCache.Params): Promise<FormCache> {
        using ds = new DisposableStack();
        const pairs: [string, string | FileCache][] = [];
        for await (const { name, filename, contentType: entryType, chunks } of parse(new MIMEType(contentType), bodyReadableStream, { signal })) {
            if (filename !== undefined || entryType?.essence === 'application/octet-stream') {
                const file = ds.use(await FileCache.save({
                    fileReadableStream: chunks,
                    tempDirPath,
                    fileName: filename ?? '',
                    mimeType: entryType ?? new MIMEType('text/plain'),
                    signal,
                }));
                pairs.push([name, file]);
            } else {
                const charset = entryType?.params.get('charset') ?? 'utf-8';
                const decoder = await Promise.try(() => new TextDecoder(charset, { ignoreBOM: true }))
                    .catch(e => Promise.reject(e instanceof RangeError ? new SyntaxError(`Unsupported charset for multipart field ${name}.`, { cause: e }) : e));
                const bytes = await StreamConsumers.arrayBuffer(chunks.pipeThrough(meter(maxTextEntrySizeByte)))
                    .catch(e => Promise.reject(e instanceof RangeError ? new RangeError(`Multipart field ${name} is required to be at most ${maxTextEntrySizeByte} bytes.`, { cause: e }) : e))
                pairs.push([name, decoder.decode(bytes)]);
            }
        }
        return new FormCache(ds, pairs);
    }

    public [Symbol.dispose]() {
        this.ds.dispose();
    }

    public [Symbol.toStringTag] = 'FormCache';

    public toString(): never {
        // https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch#setting_a_body
        throw new TypeError('FormCache cannot be converted to string');
    }

    public set(): never {
        throw new Error('FormCache is read-only');
    }

    public keys() {
        return this.pairs.map(([key]) => key)[Symbol.iterator]();
    }

    public values() {
        return this.pairs.map(([, value]) => value)[Symbol.iterator]();
    }

    public entries() {
        return this.pairs[Symbol.iterator]();
    }

    public rawEntries() {
        return this.entries();
    }

    public [Symbol.iterator]() {
        return this.entries();
    }

    public forEach(callbackfn: (value: FormDataEntryValue, key: string, iterable: FormData) => void, thisArg?: unknown) {
        for (const [key, value] of this) callbackfn.call(thisArg, value, key, this);
    }

    public has(name: string): boolean {
        return this.pairs.some(([key]) => key === name);
    }

    public append(): never {
        throw new Error('FormCache is read-only');
    }

    public delete(): never {
        throw new Error('FormCache is read-only');
    }

    public getAll(name: string): FormDataEntryValue[] {
        return this.pairs.filter(([key]) => key === name).map(([, value]) => value);
    }

    public get(name: string): FormDataEntryValue | null {
        const values = this.getAll(name);
        return values.length ? values[0]! : null;
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
