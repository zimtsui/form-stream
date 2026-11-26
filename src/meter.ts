export function meter(limit: number): TransformStream<Uint8Array> {
    let size = 0;
    return new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            size += chunk.byteLength;
            if (size <= limit)
                controller.enqueue(chunk);
            else
                throw new SizeOutOfRangeError(`Stream is required to be at most ${limit} bytes.`);
        },
    });
}

export class SizeOutOfRangeError extends RangeError {}
