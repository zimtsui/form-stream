# form-stream

[![NPM Version](https://img.shields.io/npm/v/@zimtsui/form-stream?style=flat-square)](https://www.npmjs.com/package/@zimtsui/form-stream)

## Examples

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
-   每个表单条目的 MIME 头字段有 16 KiB 的预算，从字段名算到终止该字段的 `CRLF` 之前。`Content-Disposition` 中 `name` 和 `filename` 实际输出到 `chunks` 的值字节享受豁免。超出预算时抛出 `RangeError`。
-   [RFC 7578 §2](https://www.rfc-editor.org/rfc/rfc7578.html#section-2) 允许对文件名中的特殊字符使用百分号编码。[HTML §4.10.22.8](https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#multipart-form-data) 的 `multipart/form-data` 序列化会把 `name` 和 `filename` 中的 CR、LF 和双引号分别编码为 `%0D`、`%0A` 和 `%22`，并保留字面 `%`。例如，`a"b` 和 `a%22b` 在请求中都表示为 `a%22b`，接收端无法唯一恢复原值。本软件原样输出参数值中的百分号序列。
