# 妥协

-   请求头和 form entry 中的 `Content-Type` 被直接使用 `node:util` 的 `MIMEType` 解析，不一定完全符合标准。
-   本软件不考虑健壮性，不按规定使用可能会导致不可恢复的异常和静默异常。
