import type { MIMEType } from 'node:util';


export interface Entry {
    name: string;
    filename?: string;
    contentType?: MIMEType;
    chunks: ReadableStream<Uint8Array>;
}

export class MultipartMixedError extends TypeError {}
export class ParameterContinuationError extends TypeError {}
