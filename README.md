# form-stream

[![NPM Version](https://img.shields.io/npm/v/@zimtsui/form-stream?style=flat-square)](https://www.npmjs.com/package/@zimtsui/form-stream)

## Examples

```ts
import * as FormStream from '@zimtsui/form-stream';
import * as StreamConsumers from 'node:stream/consumers';
import { MIMEType } from 'node:util';
import http from 'node:http';

export async function receive(request: Request): Promise<void> {
    const contentType = new MIMEType(request.headers.get('content-type')!);
    const options: FormStream.Options = { maxHeaderSize: http.maxHeaderSize };
    const entries = FormStream.parse(contentType, request.body!, options);
    for await (const entry of entries) {
        console.log(entry.name);
        if (entry.filename !== undefined) console.log(entry.filename);
        if (entry.contentType) console.log(entry.contentType);
        const blob = await StreamConsumers.blob(entry.chunks);
        console.log(blob.size);
    }
}
```

## Compromises

-   本软件不考虑健壮性，不按契约使用可能会导致不可恢复的异常和静默的异常。
-   请求头和 Form entry 中的 `Content-Type` 被直接使用 `node:util` 的 `MIMEType` 解析，不一定完全符合标准。
-   Form entry 的 `Content-Type` 为 `multipart/mixed` 时抛出 `MultipartMixedError`。
-   遇到 `Content-Disposition` 中 `name` 或 `filename` parameter continuation 时抛出 `ParameterContinuationError`。
-   由于 [`multipart/form-data` 的坑](./TRAPS.md)太多了，本软件仅支持 ASCII 作为 form charset，解码和解转义按照 HTML 规则而非 RFC 7578/5322 规则。
