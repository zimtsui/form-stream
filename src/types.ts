import type { MIMEType } from 'node:util';


export interface Entry {
    name: string;
    filename?: string;
    contentType?: MIMEType;
    chunks: ReadableStream<Uint8Array>;
}

export class RequestSyntaxError extends SyntaxError {}
export class RequestRangeError extends RangeError {}
export class RequestTypeError extends TypeError {}
