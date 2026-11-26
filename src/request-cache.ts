import { FileCache } from './file-cache.ts';
import { Request } from 'undici';


export class RequestCache extends Request implements Disposable {
    protected ds: DisposableStack;

    /**
     * @param request undici.Request
     */
    protected constructor(
        ds: DisposableStack,
        request: Request,
        body: FileCache | null,
    ) {
        super(request, { body });
        this.ds = ds.move();
    }

    public static async save(request: Request, tempDirPath: string): Promise<RequestCache> {
        using ds = new DisposableStack();
        const body = request.body
            ? ds.use(await FileCache.save({
                fileReadableStream: request.body,
                fileName: 'request-body',
                tempDirPath,
                signal: request.signal,
            }))
            : null;
        return new RequestCache(ds, request, body);
    }

    public [Symbol.dispose](): void {
        this.ds.dispose();
    }
}
