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
            if (part.type === 'name') {
                const name = await StreamConsumers.text(part.chunks);
                console.log(name);
            } else if (part.type === 'filename') {
                const filename = await StreamConsumers.text(part.chunks);
                console.log(filename);
            } else if (part.type === 'body') {
                const blob = await StreamConsumers.blob(part.chunks);
                console.log(part.contentType.essence, part.contentType.params.get('charset'), blob.size);
            } else throw new Error();
}
```

Each entry yields a `name` part and an optional `filename` part in raw header order, followed by its `body` part. Read each part's `chunks` to EOF before requesting the next part. Read the body stream to EOF before requesting the next entry.

## Compromises

-   本软件不考虑健壮性，不按契约使用可能会导致不可恢复的异常和静默异常。
-   请求头和 form entry 中的 `Content-Type` 被直接使用 `node:util` 的 `MIMEType` 解析，不一定完全符合标准。
-   部件的 `Content-Type` 为 `multipart/mixed` 时抛出 `MultipartMixedError`。
-   遇到 `Content-Disposition` 中 `name` 或 `filename` parameter continuation 时抛出 `ParameterContinuationError`。
