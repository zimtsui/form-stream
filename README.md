# form-stream

## Examples

The request must have a `multipart/form-data` Content-Type and a body.

```ts
import * as FormStream from '@zimtsui/form-stream';
import * as StreamConsumers from 'node:stream/consumers';
import { MIMEType } from 'node:util';

async function parseRequest(request: Request): Promise<void> {
    const contentType = new MIMEType(request.headers.get('content-type')!);
    const entries = FormStream.parse(contentType, request.body!);
    for await (const entry of entries)
        for await (const part of entry)
            if (part.type === 'name')
                await StreamConsumers.text(part.chunks);
            else if (part.type === 'filename')
                await StreamConsumers.text(part.chunks);
            else if (part.type === 'body') {
                const bytes = await StreamConsumers.bytes(part.chunks);
                console.log(part.contentType.essence, part.contentType.params.get('charset'), bytes.byteLength);
            } else throw new Error();
}
```

Each entry yields a `name` part and an optional `filename` part in raw header order, followed by its `body` part. Read each part's `chunks` to EOF before requesting the next part. Read the body stream to EOF before requesting the next entry.

Each body stream yields bytes after `Content-Transfer-Encoding` decoding. Decode those bytes separately if you need text in the declared charset. An unrecognized transfer encoding yields the original transmitted bytes with `application/octet-stream` as the content type.
