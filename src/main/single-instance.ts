import net, { type Server, type Socket } from 'node:net';
import { PUBLIC_API_REQUEST_METHOD, type PublicApiResponse } from '../api/public-api.ts';

const DEFAULT_INSTANCE_PIPE = String.raw`\\.\pipe\DreamNya.DDCMonitorController`;

export interface SingleInstanceAcquireOptions {
    /**
     * 检测到已有实例时是否通知主实例打开控制面板
     * CLI 会传 false，仅探测实例是否存在，避免产生 UI 副作用
     */
    notifyExistingInstance?: boolean;
}

type ApiRequestHandler = (request: unknown) => Promise<PublicApiResponse>;

type InstanceMessage =
    | {
          type: 'open';
      }
    | {
          type: 'api';
          request: unknown;
      };

export class SingleInstanceLock {
    readonly #pipeName: string;

    #server: Server | undefined;
    #openRequestHandler: (() => void) | undefined;
    #apiRequestHandler: ApiRequestHandler | undefined;

    constructor(pipeName = DEFAULT_INSTANCE_PIPE) {
        this.#pipeName = pipeName;
    }

    /**
     * 注册多个实例请求打开控制面板时的处理函数
     */
    setOpenRequestHandler(handler: () => void): void {
        this.#openRequestHandler = handler;
    }

    /**
     * 注册内部 IPC API 请求处理函数
     * Named Pipe 仅作为 CLI 与已运行实例之间的内部传输层，实际业务仍由 PublicApiDispatcher 处理
     */
    setApiRequestHandler(handler: ApiRequestHandler): void {
        this.#apiRequestHandler = handler;
    }

    /**
     * 尝试占用应用实例命名管道
     * @returns {Promise<boolean>}
     * - `true`：当前进程成功成为主实例
     * - `false`：已存在主实例
     */
    async acquire(options: SingleInstanceAcquireOptions = {}): Promise<boolean> {
        if (this.#server) {
            return true;
        }

        const { notifyExistingInstance = true } = options;
        const server = net.createServer((socket) => this.#handleConnection(socket));

        const acquired = await new Promise<boolean>((resolvePromise, rejectPromise) => {
            server.once('listening', () => {
                this.#server = server;
                resolvePromise(true);
            });

            server.once('error', (error: NodeJS.ErrnoException) => {
                if (error.code !== 'EADDRINUSE') {
                    rejectPromise(error);
                    return;
                }

                if (!notifyExistingInstance) {
                    resolvePromise(false);
                    return;
                }

                const client = net.createConnection(this.#pipeName);

                client.once('connect', () => {
                    // JSON 中仍包含 "open"，旧版本主实例使用 message.includes('open') 时也能兼容
                    client.end(`${JSON.stringify({ type: 'open' } satisfies InstanceMessage)}\n`);
                    resolvePromise(false);
                });

                client.once('error', () => {
                    // 重复运行时让无法连接主实例的实例退出，避免竞态
                    resolvePromise(false);
                });
            });

            server.listen(this.#pipeName);
        });

        return acquired;
    }

    /**
     * 向已经运行的主实例发送一条 Public API 请求并等待结果
     */
    requestApi(request: unknown): Promise<PublicApiResponse> {
        return new Promise((resolvePromise, rejectPromise) => {
            const client = net.createConnection(this.#pipeName);
            let buffer = '';
            let settled = false;

            const rejectOnce = (error: Error): void => {
                if (settled) {
                    return;
                }
                settled = true;
                rejectPromise(error);
            };

            client.setEncoding('utf8');

            client.once('connect', () => {
                const message: InstanceMessage = {
                    type: 'api',
                    request,
                };
                client.write(`${JSON.stringify(message)}\n`);
            });

            client.on('data', (chunk) => {
                buffer += chunk;

                const newlineIndex = buffer.indexOf('\n');
                if (newlineIndex < 0 || settled) {
                    return;
                }

                const responseText = buffer.slice(0, newlineIndex).trim();

                try {
                    const response = JSON.parse(responseText) as PublicApiResponse;
                    settled = true;
                    resolvePromise(response);
                    client.end();
                } catch (error) {
                    rejectOnce(toError(error, '主实例返回了无效的 API 响应'));
                    client.destroy();
                }
            });

            client.once('error', (error) => {
                rejectOnce(error);
            });

            client.once('end', () => {
                if (!settled) {
                    rejectOnce(new Error('主实例在返回 API 响应前关闭了连接'));
                }
            });
        });
    }

    close(): Promise<void> {
        const server = this.#server;

        this.#server = undefined;
        this.#openRequestHandler = undefined;
        this.#apiRequestHandler = undefined;

        if (!server) {
            return Promise.resolve();
        }

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

    #handleConnection(socket: Socket): void {
        socket.setEncoding('utf8');
        let buffer = '';

        socket.on('data', (chunk) => {
            buffer += chunk;

            // 兼容旧版本客户端发送的纯文本 open
            if (buffer === 'open') {
                this.#openRequestHandler?.();
                buffer = '';
                return;
            }

            while (true) {
                const newlineIndex = buffer.indexOf('\n');
                if (newlineIndex < 0) {
                    return;
                }

                const messageText = buffer.slice(0, newlineIndex).trim();
                buffer = buffer.slice(newlineIndex + 1);

                if (messageText.length === 0) {
                    continue;
                }

                void this.#handleMessage(socket, messageText);
            }
        });
    }

    async #handleMessage(socket: Socket, messageText: string): Promise<void> {
        let message: InstanceMessage;

        try {
            message = JSON.parse(messageText) as InstanceMessage;
        } catch {
            // 继续兼容旧版 open 文本即使它被换行终止
            if (messageText.includes('open')) {
                this.#openRequestHandler?.();
            }
            return;
        }

        if (message.type === 'open') {
            this.#openRequestHandler?.();
            return;
        }

        if (message.type !== 'api') {
            return;
        }

        const response: PublicApiResponse = this.#apiRequestHandler
            ? await this.#apiRequestHandler(message.request)
            : [
                  {
                      method: PUBLIC_API_REQUEST_METHOD,
                      ok: false,
                      error: {
                          code: 'EXECUTION_FAILED',
                          message: '主实例 Public API 尚未准备完成',
                      },
                  },
              ];

        socket.end(`${JSON.stringify(response)}\n`);
    }
}

function toError(error: unknown, fallbackMessage: string): Error {
    return error instanceof Error ? error : new Error(fallbackMessage);
}
