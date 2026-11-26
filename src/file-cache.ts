import { openAsBlob, unlinkSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import type { MIMEType } from 'node:util';


export class FileCache extends File implements Disposable {
    protected ds: DisposableStack;

    protected constructor(
        ds: DisposableStack,
        blob: Blob,
        name: string,
    ) {
        super([blob], name, { type: blob.type });
        this.ds = ds.move();
    }

    public static async save({
        fileReadableStream,
        fileName,
        mimeType,
        tempDirPath,
        signal,
    }: FileCache.Params): Promise<FileCache> {
        using ds = new DisposableStack();
        const tempFilePath = execFileSync('mktemp', ['-p', resolve(tempDirPath)], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
        ds.defer(() => unlinkSync(tempFilePath));
        await using fd = await open(tempFilePath, 'w');
        await fileReadableStream.pipeTo(Writable.toWeb(fd.createWriteStream()), { signal });
        return new FileCache(ds, await openAsBlob(tempFilePath, { type: mimeType?.toString() }), fileName);
    }

    public [Symbol.dispose](): void {
        this.ds.dispose();
    }
}

export namespace FileCache {
    export interface Params {
        fileReadableStream: ReadableStream;
        fileName: string;
        mimeType?: MIMEType;
        tempDirPath: string;
        signal?: AbortSignal;
    }
}
