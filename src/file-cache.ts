import { existsSync, openAsBlob, statSync, unlinkSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import type { MIMEType } from 'node:util';
import assert from 'node:assert';


export class FileCache extends File implements Disposable {
    protected ds: DisposableStack;

    protected constructor(
        ds: DisposableStack,
        protected tempFilePath: string,
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
        assert(existsSync(tempDirPath) && statSync(tempDirPath).isDirectory());
        using ds = new DisposableStack();
        const tempFilePath = execFileSync('mktemp', ['-p', tempDirPath], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
        ds.defer(() => unlinkSync(tempFilePath));
        await using fd = await open(tempFilePath, 'w');
        await fileReadableStream.pipeTo(Writable.toWeb(fd.createWriteStream()), { signal });
        return new FileCache(ds, tempFilePath, await openAsBlob(tempFilePath, { type: mimeType?.toString() }), fileName);
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
