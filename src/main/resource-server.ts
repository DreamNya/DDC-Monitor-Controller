import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml; charset=utf-8',
});

export interface ResourceServer {
    readonly origin: string;
    readonly entryUrl: string;
    getUrl(pathname: string): string;
    close(): Promise<void>;
}

const NO_CACHE_SECURITY_HEADERS: http.OutgoingHttpHeaders = {
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'",
};

const TEXT_NO_CACHE_HEADERS: http.OutgoingHttpHeaders = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
};

/**
 * 在 127.0.0.1 的随机端口提供前端资源
 */
export async function createResourceServer(rendererRoot: string): Promise<ResourceServer> {
    const root = path.resolve(rendererRoot);
    const prefix = `/`;

    const server = http.createServer((request, response) => {
        void handleRequest(request.method, request.url, response).catch((error) => {
            console.error('读取前端资源失败：', error);

            if (!response.headersSent) {
                writeText(response, 500, 'Internal Server Error');
            } else {
                response.destroy();
            }
        });
    });

    await new Promise<void>((resolvePromise, rejectPromise) => {
        server.once('error', rejectPromise);
        server.listen(0, '127.0.0.1', () => resolvePromise());
    });

    const address = server.address();

    if (!address || typeof address === 'string') {
        server.close();
        throw new Error('无法取得前端资源服务器端口');
    }

    const origin = `http://127.0.0.1:${address.port}`;

    return {
        origin,
        entryUrl: `${origin}${prefix}control.html`,
        getUrl: (pathname: string) => {
            const normalized = pathname.replace(/^\/+/, '');
            return `${origin}${prefix}${encodeURI(normalized)}`;
        },
        close: () => closeServer(server),
    };

    async function handleRequest(
        method: string | undefined,
        requestUrl: string | undefined,
        response: http.ServerResponse,
    ): Promise<void> {
        if (method !== 'GET' && method !== 'HEAD') {
            response.setHeader('Allow', 'GET, HEAD');
            writeText(response, 405, 'Method Not Allowed');
            return;
        }

        const url = new URL(requestUrl ?? '/', origin);

        if (!url.pathname.startsWith(prefix)) {
            writeText(response, 404, 'Not Found');
            return;
        }

        const encodedPath = url.pathname.slice(prefix.length);
        const pathname = decodeURIComponent(encodedPath) || 'control.html';
        const filePath = path.resolve(root, pathname);
        const relativePath = path.relative(root, filePath);

        if (
            relativePath === '..' ||
            relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
            path.resolve(root, relativePath) !== filePath
        ) {
            writeText(response, 403, 'Forbidden');
            return;
        }

        let body: Buffer;

        try {
            body = await fs.readFile(filePath);
        } catch {
            writeText(response, 404, 'Not Found');
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';

        response.writeHead(200, {
            ...NO_CACHE_SECURITY_HEADERS,
            'Content-Type': contentType,
            'Content-Length': body.byteLength,
        });

        response.end(method === 'HEAD' ? undefined : body);
    }
}

function writeText(response: http.ServerResponse, status: number, body: string): void {
    // 仅计算 UTF-8 字节长度，不分配 Buffer 内存
    const byteLength = Buffer.byteLength(body, 'utf8');
    response.writeHead(status, {
        ...TEXT_NO_CACHE_HEADERS,
        'Content-Length': byteLength,
    });
    response.end(body);
}

function closeServer(server: http.Server): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
        server.close((error) => {
            if (error) {
                rejectPromise(error);
            } else {
                resolvePromise();
            }
        });
    });
}
