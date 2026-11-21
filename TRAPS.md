
## 相关文档

-   RFC 7578 关于 `multipart/form-data`
-   RFC 2183 关于 `Content-Disposition`
-   RFC 2046 关于 MIME Types
-   RFC 5322 关于 ASCII Quoted Strings 转义问题

## 编码问题

### 请求体的编码

-   请求头 `Content-Type` 未定义 `charset` 参数。Entry 头中除了 `name` 值和 `filename` 值外的部分都必须是 ASCII 编码。

### 表单 Entry 头参数的编码

-   RFC 7578 允许 Entry 头参数 `name` 值和 `filename` 值采用非 ASCII 编码，这脱离了 RFC 5322 的适用范围。
-   RFC 7578 规定 Entry 头中 `name` 值和 `filename` 值*可以*采用该表单的**表单编码**。
-   RFC 7578 并推荐在无法避免非 ASCII 字段名的场景下，表单编码使用 UTF-8。
-   RFC 7578 没有规定表单编码的默认值。
-   RFC 7578 规定发送方可以用名为 `_charset_` 的 Entry 描述表单编码。
-   Fetch API 固定采用 UTF-8 作为表单编码。HTML 原生表单不一定采用 UTF-8 编码作为表单编码，也不会自动添加 `_charset_` Entry。
-   HTML 魔改了 RFC 7578 的编码规则，规定 Entry 头中 `name` 值和 `filename` 值编码后转义以下字节

    | 转义前字节 | 转义后字节 |
    | --- | --- |
    | CR | ASCII `%0D` |
    | LF | ASCII `%0A` |
    | ASCII 双引号 | ASCII `%22` |

这导致以下问题

-   即使接收方知道表单编码，也无法保证 `name` 值和 `filename` 值采用了表单编码。
-   在流式接收表单的过程中，当接收方尚未获知表单编码时，无法解码已收到的 `name` 值和 `filename` 值。例如 `_charset_` 不是第一个 Entry，且接收方也没有其他方式获知表单编码。
-   发送方如果不以任何方式将表单编码告知接收方也是合规的，这会导致接收方完全无法获知表单编码。
-   解码时，遇到 ASCII `%22` 会产生歧义

    -   按 RFC 7578 规则，可能被从转义后的字符串 `%22` 编码而来。
    -   按 HTML 规则，可能是被从字符串 `%22` 编码而来。
    -   按 HTML 规则，还可能是被从字符串 `"` 编码而来。

### 表单 Entry body 的编码

-   RFC 7578 规定 Entry body 的 `Content-Type` 默认为 `text/plain`。
-   RFC 7578 规定 Entry body 的 `Content-Type` 为 `text/plain` 且表单编码被显式指定时，Entry body 默认采用该表单的**表单编码**。
-   RFC 7578 规定 Entry body 的 `Content-Type` 为 `text/plain` 且未被显式指定时，Entry body 默认采用 `text/plain` 的默认编码 ASCII。

## 转义问题

-   HTML 规定将 `name` 的换行符统一为 CRLF，但 `filename` 的换行符不做处理。
-   RFC 7578 规定，`filename` 值*可以*将一些特殊字符用 `%` 转义为 ASCII 字符。
-   HTML 魔改了 RFC 5322 的转义规则。

    -   按 HTML 规则，所有字符在编码前全都无需转义。
    -   按 RFC 5322 规则，字符串 `\` 必须转义为 `\\`。

这会导致以下问题

-   在编码前的转义阶段，`filename` 值

    -   按 RFC 7578 规则，`%20` 无需转义保持 `%20`。
    -   按 RFC 7578 规则，空格被转义为 `%20`。

-   在编码前的转义阶段，`name` 和 `filename` 值

    -   按 HTML 规则，`\"` 无需转义保持 `\"`。
    -   按 RFC 5322 规则， `"` 转义成 `\"`。

-   用 ASCII 解码时，如果收到 `name="\"` 或 `filename="\"` 那么

    -   按 HTML 规则，可能由字符串 `\` 编码而来。
    -   按 RFC 5322 规则，不可能由任何字符串编码而来。
