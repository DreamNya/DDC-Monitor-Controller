import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { HttpApiServer, HTTP_API_HOST, HTTP_API_PATH } from './http-api-server.ts';

interface TestResponse {
    statusCode: number;
    headers: http.IncomingHttpHeaders;
    body: string;
}

test('HttpApiServer accepts POST JSON and forwards the same Public API request', async () => {
    const requests: unknown[] = [];
    const server = new HttpApiServer({
        executor: {
            execute: async (request) => {
                requests.push(request);
                return {
                    ok: true,
                    result: { apiVersion: 1 },
                };
            },
        },
    });

    try {
        await server.start(0);
        const port = getListeningPort(server);
        const response = await requestHttp(port, {
            method: 'POST',
            path: HTTP_API_PATH,
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ method: 'system.ping' }),
        });

        assert.equal(response.statusCode, 200);
        assert.deepEqual(JSON.parse(response.body), {
            ok: true,
            result: { apiVersion: 1 },
        });
        assert.deepEqual(requests, [{ method: 'system.ping' }]);
        assert.equal(response.headers['access-control-allow-origin'], '*');
    } finally {
        await server.stop();
    }
});

test('HttpApiServer handles browser CORS preflight without executing the API', async () => {
    let executions = 0;
    const server = new HttpApiServer({
        executor: {
            execute: async () => {
                executions += 1;
                return { ok: true, result: null };
            },
        },
    });

    try {
        await server.start(0);
        const response = await requestHttp(getListeningPort(server), {
            method: 'OPTIONS',
            path: HTTP_API_PATH,
            headers: {
                Origin: 'https://example.com',
                'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': 'content-type',
            },
        });

        assert.equal(response.statusCode, 204);
        assert.equal(response.body, '');
        assert.equal(response.headers['access-control-allow-origin'], '*');
        assert.equal(response.headers['access-control-allow-methods'], 'POST, OPTIONS');
        assert.equal(response.headers['access-control-allow-headers'], 'Content-Type');
        assert.equal(executions, 0);
    } finally {
        await server.stop();
    }
});

test('HttpApiServer rejects non-JSON POST requests before dispatch', async () => {
    let executions = 0;
    const server = new HttpApiServer({
        executor: {
            execute: async () => {
                executions += 1;
                return { ok: true, result: null };
            },
        },
    });

    try {
        await server.start(0);
        const response = await requestHttp(getListeningPort(server), {
            method: 'POST',
            path: HTTP_API_PATH,
            headers: {
                'Content-Type': 'text/plain',
            },
            body: '{}',
        });

        assert.equal(response.statusCode, 415);
        assert.equal(executions, 0);
        assert.deepEqual(JSON.parse(response.body), {
            ok: false,
            error: {
                code: 'INVALID_REQUEST',
                message: 'Content-Type 必须是 application/json',
            },
        });
    } finally {
        await server.stop();
    }
});

test('HttpApiServer rejects oversized JSON bodies', async () => {
    const server = new HttpApiServer({
        maxBodyBytes: 16,
        executor: {
            execute: async () => ({ ok: true, result: null }),
        },
    });

    try {
        await server.start(0);
        const response = await requestHttp(getListeningPort(server), {
            method: 'POST',
            path: HTTP_API_PATH,
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ method: 'system.ping' }),
        });

        assert.equal(response.statusCode, 413);
        assert.match(response.body, /不能超过 16 字节/);
    } finally {
        await server.stop();
    }
});

test('HttpApiServer binds only to the IPv4 loopback address', async () => {
    const server = new HttpApiServer({
        executor: {
            execute: async () => ({ ok: true, result: null }),
        },
    });

    try {
        await server.start(0);
        const response = await requestHttp(getListeningPort(server), {
            method: 'POST',
            path: HTTP_API_PATH,
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ method: 'system.ping' }),
        });

        assert.equal(response.statusCode, 200);
        assert.equal(HTTP_API_HOST, '127.0.0.1');
    } finally {
        await server.stop();
    }
});

function getListeningPort(server: HttpApiServer): number {
    const port = server.port;

    if (port === undefined) {
        throw new Error('HTTP API test server is not listening');
    }

    return port;
}

async function requestHttp(
    port: number,
    options: {
        method: string;
        path: string;
        headers?: http.OutgoingHttpHeaders;
        body?: string;
    },
): Promise<TestResponse> {
    return new Promise<TestResponse>((resolvePromise, rejectPromise) => {
        const request = http.request(
            {
                host: HTTP_API_HOST,
                port,
                method: options.method,
                path: options.path,
                ...(options.headers ? { headers: options.headers } : {}),
            },
            (response) => {
                const chunks: Buffer[] = [];

                response.on('data', (chunk: Buffer) => {
                    chunks.push(chunk);
                });
                response.once('error', rejectPromise);
                response.once('end', () => {
                    resolvePromise({
                        statusCode: response.statusCode ?? 0,
                        headers: response.headers,
                        body: Buffer.concat(chunks).toString('utf8'),
                    });
                });
            },
        );

        request.once('error', rejectPromise);

        if (options.body !== undefined) {
            request.write(options.body);
        }

        request.end();
    });
}

test('HttpApiServer configure can enable, rebind, and disable the local API', async () => {
    const server = new HttpApiServer({
        executor: {
            execute: async () => ({ ok: true, result: { apiVersion: 1 } }),
        },
    });
    const firstPort = await reserveFreePort();
    const secondPort = await reserveFreePort();

    try {
        await server.configure({ enabled: true, port: firstPort });
        assert.equal(server.listening, true);
        assert.equal(server.port, firstPort);

        await server.configure({ enabled: true, port: secondPort });
        assert.equal(server.listening, true);
        assert.equal(server.port, secondPort);

        await assert.rejects(
            requestHttp(firstPort, {
                method: 'POST',
                path: HTTP_API_PATH,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ method: 'system.ping' }),
            }),
        );

        const response = await requestHttp(secondPort, {
            method: 'POST',
            path: HTTP_API_PATH,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ method: 'system.ping' }),
        });
        assert.equal(response.statusCode, 200);

        await server.configure({ enabled: false, port: secondPort });
        assert.equal(server.listening, false);
        assert.equal(server.port, undefined);
    } finally {
        await server.stop();
    }
});

test('HttpApiServer keeps the previous listener when rebinding to an occupied port fails', async () => {
    const server = new HttpApiServer({
        executor: {
            execute: async () => ({ ok: true, result: { apiVersion: 1 } }),
        },
    });
    const currentPort = await reserveFreePort();
    const occupied = http.createServer();
    const occupiedPort = await listenTestServer(occupied);

    try {
        await server.configure({ enabled: true, port: currentPort });
        await assert.rejects(server.configure({ enabled: true, port: occupiedPort }), /EADDRINUSE/);

        assert.equal(server.listening, true);
        assert.equal(server.port, currentPort);
        const response = await requestHttp(currentPort, {
            method: 'POST',
            path: HTTP_API_PATH,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ method: 'system.ping' }),
        });
        assert.equal(response.statusCode, 200);
    } finally {
        await server.stop();
        await closeTestServer(occupied);
    }
});

async function reserveFreePort(): Promise<number> {
    const server = http.createServer();
    const port = await listenTestServer(server);
    await closeTestServer(server);
    return port;
}

function listenTestServer(server: http.Server): Promise<number> {
    return new Promise<number>((resolvePromise, rejectPromise) => {
        server.once('error', rejectPromise);
        server.listen(0, HTTP_API_HOST, () => {
            server.off('error', rejectPromise);
            const address = server.address();

            if (typeof address !== 'object' || address === null) {
                rejectPromise(new Error('Test server did not expose an address'));
                return;
            }

            resolvePromise(address.port);
        });
    });
}

function closeTestServer(server: http.Server): Promise<void> {
    return new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => {
            if (error) {
                rejectPromise(error);
            } else {
                resolvePromise();
            }
        });
    });
}
