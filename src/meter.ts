

/**
 * @throws {@link StreamSizeError}
 */
export type MeterTransformStream = TransformStream<Uint8Array, Uint8Array>;

export function meter(limit: number): MeterTransformStream {
    let size = 0;
    return new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            size += chunk.byteLength;
            if (size <= limit)
                controller.enqueue(chunk);
            else
                throw new StreamSizeError(`Stream is required to be at most ${limit} bytes.`);
        },
    });
}

export class StreamSizeError extends RangeError {}
