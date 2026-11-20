import { Boundary, type Delimiter } from './boundary.ts';
import { Input } from './input.ts';
import { readBoundary, readMetadata } from './mime.ts';
import type { Entry } from './types.ts';

type PartSource = {
    type: Entry.Part['type'];
    source: (shouldEmit: () => boolean) => AsyncGenerator<Uint8Array, Delimiter | void, void>;
};

class PartStream {
    public part: Entry.Part;
    #source: ReturnType<PartSource['source']>;
    #controller!: ReadableStreamDefaultController<Uint8Array>;
    #pending?: Promise<void>;
    #skipping?: Promise<void>;
    #sourceResult?: IteratorReturnResult<Delimiter | void>;
    #failure?: { reason: unknown };
    #closed = false;

    public constructor({ type, source }: PartSource) {
        this.#source = source(() => !this.#closed);
        const chunks = new ReadableStream<Uint8Array>({
            start: controller => { this.#controller = controller; },
            pull: () => this.#pending = this.#read(),
            cancel: () => {
                this.#closed = true;
                return this.skip();
            },
        }, { highWaterMark: 0 });
        this.part = { type, chunks };
    }

    public hasStarted(): boolean {
        return this.#pending !== undefined || this.#skipping !== undefined;
    }

    public getResult(): IteratorReturnResult<Delimiter | void> | undefined {
        if (this.#failure) throw this.#failure.reason;
        return this.#sourceResult;
    }

    public getReachedDelimiter(): boolean {
        return this.#sourceResult?.value !== undefined;
    }

    #close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#controller.close();
    }

    async #read(): Promise<void> {
        try {
            const result = await this.#source.next();
            if (this.#failure) throw this.#failure.reason;
            if (result.done) {
                this.#sourceResult = result;
                this.#close();
            } else if (!this.#closed) {
                this.#controller.enqueue(result.value);
            }
        } catch (reason) {
            this.abort(reason);
            throw this.#failure ? this.#failure.reason : reason;
        }
    }

    public skip(): Promise<void> {
        return this.#skipping ??= this.#drain();
    }

    async #drain(): Promise<void> {
        this.#close();
        await this.#pending;
        while (!this.getResult()) await this.#read();
    }

    public abort(reason: unknown): void {
        if (this.#sourceResult || this.#failure) return;
        this.#failure = { reason };
        if (this.#closed) return;
        this.#closed = true;
        this.#controller.error(reason);
    }
}

class EntryParts implements Entry {
    #metadata: ReturnType<typeof readMetadata>;
    #boundary: Boundary;
    #onAbort: (reason: unknown) => void;
    #current?: PartStream;
    #failure?: { reason: unknown };
    #pending?: Promise<void>;

    public constructor(metadata: ReturnType<typeof readMetadata>, boundary: Boundary, onAbort: (reason: unknown) => void) {
        this.#metadata = metadata;
        this.#boundary = boundary;
        this.#onAbort = onAbort;
    }

    public [Symbol.asyncIterator](): this {
        return this;
    }

    public hasStarted(): boolean {
        return this.#pending !== undefined;
    }

    public getDelimiter(): Delimiter | void {
        if (this.#failure) throw this.#failure.reason;
        return this.#current?.getResult()?.value;
    }

    #enqueue<T>(operation: () => Promise<T>): Promise<T> {
        // Serialize iterator calls while allowing return() before the first next().
        const result = (this.#pending ?? Promise.resolve()).then(operation);
        this.#pending = result.then(() => { }, () => { });
        return result;
    }

    async #nextPart(): Promise<PartStream> {
        try {
            const metadata = await this.#metadata.next();
            if (this.#failure) throw this.#failure.reason;
            return this.#current = new PartStream(metadata.done
                ? { type: 'body', source: this.#boundary.body.bind(this.#boundary) }
                : metadata.value);
        } catch (reason) {
            this.#failure ??= { reason };
            throw this.#failure.reason;
        }
    }

    async #finishCurrentPart(): Promise<boolean> {
        if (!this.#current || this.#current.getResult()) return true;
        if (this.#current.hasStarted()) return false;
        await this.#current.skip();
        return true;
    }

    public next(): Promise<IteratorResult<Entry.Part, void>> {
        return this.#enqueue(async () => {
            if (!await this.#finishCurrentPart())
                throw new TypeError('Consume or cancel the current part before requesting the next part');
            if (this.getDelimiter() !== undefined) return { done: true, value: undefined };
            const part = await this.#nextPart();
            return { done: false, value: part.part };
        });
    }

    public return(value?: void | PromiseLike<void>): Promise<IteratorReturnResult<void>> {
        return this.#enqueue(async () => {
            if (value !== undefined) {
                try {
                    await value;
                } catch (reason) {
                    this.#throw(reason);
                }
            }
            if (!await this.#finishCurrentPart())
                this.#throw(new TypeError('Consume or cancel the current part before skipping the entry'));
            while (this.getDelimiter() === undefined) {
                const part = await this.#nextPart();
                await part.skip();
            }
            return { done: true, value: undefined };
        });
    }

    public throw(reason: unknown): Promise<never> {
        return this.#enqueue(async () => this.#throw(reason));
    }

    #throw(reason: unknown): never {
        if (this.abort(reason)) this.#onAbort(reason);
        throw reason;
    }

    public async [Symbol.asyncDispose](): Promise<void> {
        await this.return();
    }

    public abort(reason: unknown): boolean {
        if (this.#current?.getReachedDelimiter()) return false;
        this.#failure ??= { reason };
        this.#current?.abort(this.#failure.reason);
        return true;
    }
}

export async function* parse(contentType: string, body: ReadableStream<Uint8Array>): AsyncGenerator<Entry, void, void> {
    const boundaryValue = await readBoundary(contentType);
    const reader = body.getReader();
    const input = new Input(reader);
    const boundary = new Boundary(boundaryValue, input);
    let entryParts: EntryParts | undefined;
    let failure: { reason: unknown } | undefined;
    let cleanup: Promise<void> | undefined;
    const closeInput = () => cleanup ??= Promise.resolve().then(async () => {
        input[Symbol.dispose]();
        try {
            if (!input.hasEnded()) await reader.cancel();
        } finally {
            reader.releaseLock();
        }
    });
    const onAbort = (reason: unknown) => {
        failure ??= { reason };
        // EntryParts reports the error immediately while input cleanup runs.
        void closeInput().catch(() => { });
    };
    try {
        let delimiter = await boundary.first();
        while (delimiter === 'next') {
            entryParts = new EntryParts(readMetadata(input), boundary, onAbort);
            yield entryParts;
            if (!entryParts.hasStarted()) await entryParts.return();
            const next = entryParts.getDelimiter();
            if (next === undefined)
                throw new TypeError('Consume the current entry or await its iterator return() before advancing');
            delimiter = next;
            entryParts = undefined;
        }
        while (await input.fill()) { }
    } catch (reason) {
        failure = { reason };
        throw reason;
    } finally {
        entryParts?.abort(failure ? failure.reason : new TypeError('The multipart parser is closed'));
        try {
            await closeInput();
        } catch (reason) {
            if (!failure) throw reason;
        }
    }
}
