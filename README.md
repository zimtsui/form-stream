# form-stream

## Examples

```ts
import * as FormStream from '@zimtsui/form-stream';
import * as StreamConsumers from 'node:stream/consumers';

async function parseRequest(request: Request): Promise<void> {
    const contentType = request.headers.get('content-type')!;
    const entries = FormStream.parse(contentType, request.body!);
    for await (const entry of entries)
        for await (const part of entry)
            if (part.type === 'name')
                await StreamConsumers.text(part.chunks);
            else if (part.type === 'filename')
                await StreamConsumers.text(part.chunks);
            else if (part.type === 'body')
                await StreamConsumers.bytes(part.chunks);
            else throw new Error();
}
```

Each entry yields a `name` part and an optional `filename` part in raw header order, followed by its `body` part. Read each part's `chunks` to EOF before requesting the next part. Read the body stream to EOF before requesting the next entry.
