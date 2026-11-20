export type Entry = AsyncGenerator<Entry.Part, void, void>;

export namespace Entry {

    export type Part = Part.Name | Part.Filename | Part.Body;
    export namespace Part {
        export interface Name {
            type: 'name';
            chunks: ReadableStream<Uint8Array>;
        }
        export interface Filename {
            type: 'filename';
            chunks: ReadableStream<Uint8Array>;
        }
        export interface Body {
            type: 'body';
            chunks: ReadableStream<Uint8Array>;
        }
    }

}
