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

Each entry yields a `name` part and an optional `filename` part in parameter order, followed by its `body` part. Read each part's `chunks` to EOF before requesting the next part. Read the body stream to EOF before requesting the next entry. Here, `text()` decodes the metadata and the `message` body as UTF-8. The attachment body is read in chunks of raw bytes.

### Discard the first entry

Use this outer loop with a fresh request and the same `readEntry()` helper. To discard an entry, consume the streams of all its parts and discard the chunks.

```ts
let discardFirst = true;
for await (const entry of parse(contentType, body)) {
    if (discardFirst) {
        discardFirst = false;
        for await (const { chunks } of entry) {
            for await (const _ of chunks) { }
        }
        continue;
    }
    await readEntry(entry);
}

// { name: 'attachment', filename: 'example.bin', byteLength: 3 }
```

Canceling `part.chunks` ends that stream. Calling `entry.return()` or breaking out of the inner loop ends that entry's iteration. If a read fails or you stop reading an entry before its body stream reaches EOF, close the outer parser. An error that escapes the body of the outer `for await` loop closes the parser automatically.

The request body must supply `Uint8Array` chunks. The outer parser owns the body reader until the parser finishes or is closed. Leaving the outer `for await` loop early closes the parser. When iterating manually, close it with `await parser.return()` in a `finally` block or use `await using`. Normal completion reads to EOF. Closing the parser early waits for the request body's cancellation to settle and then releases the reader lock. The parser ignores cancellation failures.

If `parser.next()` is waiting for input, a concurrent `parser.return()` waits for that call to settle.
