# form-stream

## Examples

### Read text and file entries

```ts
import { parse, type Entry } from '@zimtsui/form-stream';
import { text } from 'node:stream/consumers';

async function readEntry(entry: Entry): Promise<void> {
    let name: string | undefined;
    let filename: string | undefined;

    for await (const part of entry) {
        switch (part.type) {
            case 'name':
                name = await text(part.chunks);
                break;
            case 'filename':
                filename = await text(part.chunks);
                break;
            case 'body': {
                if (name === 'message') {
                    const value = await text(part.chunks);
                    console.log({ name, value });
                    break;
                }

                let byteLength = 0;
                for await (const chunk of part.chunks) {
                    byteLength += chunk.byteLength;
                }
                console.log({ name, filename, byteLength });
                break;
            }
        }
    }
}

const form = new FormData();
form.append('message', 'Hello!');
form.append('attachment', new Blob([Uint8Array.of(0x00, 0xff, 0x0a)]), 'example.bin');

const request = new Request('https://example.com/upload', { method: 'POST', body: form });
const contentType = request.headers.get('content-type');
const body = request.body;
if (!contentType || !body) throw new TypeError('Expected a Content-Type and request body');

for await (const entry of parse(contentType, body)) {
    await readEntry(entry);
}

// { name: 'message', value: 'Hello!' }
// { name: 'attachment', filename: 'example.bin', byteLength: 3 }
```

Each entry yields a `name` part and an optional `filename` part in parameter order, followed by its `body` part. Read or cancel each part's `chunks` before requesting the next part. Here, `text()` decodes the metadata and the `message` body as UTF-8. The attachment body is read in chunks of raw bytes.

### Skip the first entry

Use this outer loop with a fresh request and the same `readEntry()` helper. Awaiting `return()` skips the entry even before the first `next()`.

```ts
let skipFirst = true;
for await (const entry of parse(contentType, body)) {
    if (skipFirst) {
        skipFirst = false;
        const iterator = entry[Symbol.asyncIterator]();
        await iterator.return?.();
        continue;
    }
    await readEntry(entry);
}

// { name: 'attachment', filename: 'example.bin', byteLength: 3 }
```

You can call `return()` or break out of the inner loop to skip the rest of an entry after reading the current part to completion or awaiting its cancellation. If the current part is still unfinished, `return()` rejects with a `TypeError` and terminates parsing. A `break` calls the same `return()` method.

Before advancing the outer iterator, read the entry's body to completion or await `return()` on its part iterator. Breaking out of the outer loop cancels the input stream.
