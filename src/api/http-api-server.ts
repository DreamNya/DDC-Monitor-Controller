import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ExternalApiConfiguration } from './external-api-config.ts';
import { assertExternalApiConfiguration } from './external-api-config.ts';
import type { PublicApiResponse } from './public-api.ts';

export const HTTP_API_HOST = '127.0.0.1';
export const HTTP_API_PATH = '/api/v1';
export const HTTP_API_MAX_BODY_BYTES = 64 * 1024;

export interface PublicApiExecutor {
    execute(request: unknown): Promise<PublicApiResponse>;
}

export interface HttpApiServerOptions {
    executor: PublicApiExecutor;
    maxBodyBytes?: number;
}

export class HttpApiServer {
    readonly #executor: PublicApiExecutor;
    readonly #maxBodyBytes: number;
    #server: http.Server | undefined;

    constructor(options: HttpApiServerOptions) {
        this.#executor = options.executor;
        this.#maxBodyBytes = options.maxBodyBytes ?? HTTP_API_MAX_BODY_BYTES;
    }

    get listening(): boolean {
        return this.#server?.listening === true;
    }

    get port(): number | undefined {
        const address = this.#server?.address();
        return typeof address === 'object' && address !== null ? (address as AddressInfo).port : undefined;
    }

    async start(port: number): Promise<void> {
        if (this.#server) {
            throw new Error('HTTP API Server 已经启动');
        }

        assertBindablePort(port);
        const server = this.#createServer();

        await listen(server, port);
        this.#server = server;
    }

    async configure(configuration: ExternalApiConfiguration): Promise<void> {
        assertExternalApiConfiguration(configuration);

        if (!configuration.enabled) {
            await this.stop();
            return;
        }

        if (this.listening && this.port === configuration.port) {
            return;
        }

        const replacement = this.#createServer();
        await listen(replacement, configuration.port);

        const previous = this.#server;
        this.#server = replacement;

        if (previous) {
            await closeServer(previous);
        }
    }

    async stop(): Promise<void> {
        const server = this.#server;
        this.#server = undefined;

        if (!server) {
            return;
        }

        await closeServer(server);
    }

    #createServer(): http.Server {
        return http.createServer((request, response) => {
            void this.#handleRequest(request, response);
        });
    }

    async #handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
        applyCorsHeaders(response);

        try {
            const pathname = getPathname(request);

            if (pathname !== HTTP_API_PATH) {
                respondJson(response, 404, transportError('INVALID_REQUEST', 'HTTP API 路径不存在'));
                return;
            }

            if (request.method === 'OPTIONS') {
                response.statusCode = 204;
                response.end();
                return;
            }

            if (request.method !== 'POST') {
                response.setHeader('Allow', 'POST, OPTIONS');
                respondJson(response, 405, transportError('INVALID_REQUEST', 'HTTP API 仅支持 POST'));
                return;
            }

            if (!isJsonContentType(request.headers['content-type'])) {
                respondJson(
                    response,
                    415,
                    transportError('INVALID_REQUEST', 'Content-Type 必须是 application/json'),
                );
                return;
            }

            const payload = await readJsonBody(request, this.#maxBodyBytes);
            const apiResponse = await this.#executor.execute(payload);
            respondJson(response, 200, apiResponse);
        } catch (error) {
            if (error instanceof HttpApiRequestError) {
                respondJson(response, error.statusCode, transportError('INVALID_REQUEST', error.message));
                return;
            }

            respondJson(response, 500, transportError('EXECUTION_FAILED', toErrorMessage(error)));
        }
    }
}

function assertBindablePort(port: number): void {
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error('HTTP API 端口必须是 0 到 65535 的整数');
    }
}

function listen(server: http.Server, port: number): Promise<void> {
    return new Promise<void>((resolvePromise, rejectPromise) => {
        const onError = (error: Error) => {
            server.off('listening', onListening);
            rejectPromise(error);
        };
        const onListening = () => {
            server.off('error', onError);
            resolvePromise();
        };

        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, HTTP_API_HOST);
    });
}

function closeServer(server: http.Server): Promise<void> {
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

function getPathname(request: IncomingMessage): string {
    return new URL(request.url ?? '/', `http://${HTTP_API_HOST}`).pathname;
}

function isJsonContentType(value: string | undefined): boolean {
    if (!value) {
        return false;
    }

    return value.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

async function readJsonBody(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;

    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        receivedBytes += buffer.length;

        if (receivedBytes > maxBodyBytes) {
            throw new HttpApiRequestError(413, `HTTP API 请求体不能超过 ${maxBodyBytes} 字节`);
        }

        chunks.push(buffer);
    }

    if (receivedBytes === 0) {
        throw new HttpApiRequestError(400, 'HTTP API 请求体不能为空');
    }

    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch (error) {
        throw new HttpApiRequestError(400, `HTTP API 请求体不是有效 JSON：${toErrorMessage(error)}`);
    }
}

function applyCorsHeaders(response: ServerResponse): void {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function respondJson(response: ServerResponse, statusCode: number, payload: unknown): void {
    response.statusCode = statusCode;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(payload));
}

function transportError(code: 'INVALID_REQUEST' | 'EXECUTION_FAILED', message: string): PublicApiResponse {
    return {
        ok: false,
        error: {
            code,
            message,
        },
    };
}

class HttpApiRequestError extends Error {
    readonly statusCode: number;

    constructor(statusCode: number, message: string) {
        super(message);
        this.statusCode = statusCode;
    }
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
