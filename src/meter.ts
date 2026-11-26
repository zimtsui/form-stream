import type { Transformer } from 'node:stream/web';


class Transformeter implements Transformer<Uint8Array, Uint8Array> {
    public constructor(protected limit: number) {}

    protected size = 0;

    public transform(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>): void {
        if ((this.size += chunk.byteLength) <= this.limit) {} else return controller.error(new RangeError());
        return controller.enqueue(chunk);
    }
}


export function meter(limit: number): TransformStream<Uint8Array> {
    const transformeter = new Transformeter(limit);
    return new TransformStream<Uint8Array, Uint8Array>(transformeter);
}
