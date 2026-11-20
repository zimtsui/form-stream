import { Boundary, type Delimiter } from './boundary.ts';
import { Input } from './input.ts';
import { readBoundary, readMetadata } from './mime.ts';
import type { Entry } from './types.ts';

type PartSource = {
    type: Entry.Part['type'];
    source: (shouldEmit: () => boolean) => AsyncGenerator<Uint8Array, Delimiter | void, void>;
};

function createPart({ type, source }: PartSource, onEnd: (value: Delimiter | void) => void) {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let pending: Promise<void> | undefined;
    let skipping = false;
    let ended = false;
    const output = source(() => !skipping);

    async function read(): Promise<void> {
        const result = await output.next();
        if (result.done) {
            ended = true;
            onEnd(result.value);
            if (!skipping) controller.close();
        } else if (!skipping) {
            controller.enqueue(result.value);
        }
    }

    async function skip(): Promise<void> {
        skipping = true;
        if (pending) await pending;
        if (!ended) await read();
    }

    const chunks = new ReadableStream<Uint8Array>({
        start: value => { controller = value; },
        pull: () => pending = read(),
        cancel: skip,
    }, { highWaterMark: 0 });
    const part: Entry.Part = { type, chunks };
    return {
        part,
        async finish(): Promise<boolean> {
            if (!pending && !skipping) {
                controller.close();
                await skip();
            }
            return ended;
        },
    };
}

async function* readPartSources(input: Input, boundary: Boundary): AsyncGenerator<PartSource, void, void> {
    yield* readMetadata(input);
    yield { type: 'body', source: boundary.body.bind(boundary) };
}

function createEntry(input: Input, boundary: Boundary) {
    let started = false;
    let initialSkip: Promise<void> | undefined;
    let delimiter: Delimiter | undefined;

    function saveDelimiter(value: Delimiter | void): void {
        if (value !== undefined) delimiter = value;
    }

    async function* read(): AsyncGenerator<Entry.Part, void, Promise<void> | void> {
        started = true;
        let skip: Promise<void> | void = initialSkip;
        if (skip) await skip;
        for await (const definition of readPartSources(input, boundary)) {
            if (skip) {
                const result = await definition.source(() => false).next();
                if (result.done) saveDelimiter(result.value);
                continue;
            }
            const { part, finish } = createPart(definition, saveDelimiter);
            skip = yield part;
            if (skip) await skip;
            // A failed read or cancellation leaves the part unfinished.
            if (!await finish()) return;
        }
    }

    const parts = read();
    const entry = Object.assign(parts, {
        async return(value?: void | PromiseLike<void>): Promise<IteratorReturnResult<void>> {
            const skip = Promise.resolve(value);
            // The first next() argument is ignored by a native generator.
            if (!started) initialSkip = skip;
            await parts.next(skip);
            // A completed generator also ignores the argument.
            await skip;
            return { done: true, value: undefined };
        },
    }) satisfies Entry;
    return {
        entry,
        skipUntouched: () => started ? undefined : entry.return(),
        getDelimiter: () => delimiter,
    };
}

export async function* parse(contentType: string, body: ReadableStream<Uint8Array>): AsyncGenerator<Entry, void, void> {
    const boundaryValue = await readBoundary(contentType);
    await using input = new Input(body);
    const boundary = new Boundary(boundaryValue, input);
    let delimiter: Delimiter | undefined = await boundary.first();
    while (delimiter === 'next') {
        const { entry, skipUntouched, getDelimiter } = createEntry(input, boundary);
        yield entry;
        await skipUntouched();
        delimiter = getDelimiter();
    }
    if (delimiter === 'close') {
        while (await input.fill()) { }
    }
}
