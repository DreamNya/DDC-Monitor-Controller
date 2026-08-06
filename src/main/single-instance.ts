import net, { type Server } from 'node:net';

const DEFAULT_INSTANCE_PIPE = String.raw`\\.\pipe\DreamNya.DDCMonitorController`;

export class SingleInstanceLock {
    readonly #pipeName: string;

    #server: Server | undefined;
    #openRequestHandler: (() => void) | undefined;

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
     * 尝试占用应用实例命名管道
     * @returns {Promise<boolean>}
     * - `true`：当前进程成功成为主实例
     * - `false`：已存在主实例并成功发送打开请求
     */
    async acquire(): Promise<boolean> {
        if (this.#server) {
            return true;
        }

        const server = net.createServer((socket) => {
            socket.setEncoding('utf8');

            socket.on('data', (message) => {
                if (message.includes('open')) {
                    this.#openRequestHandler?.();
                }
            });
        });

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

                const client = net.createConnection(this.#pipeName);

                client.once('connect', () => {
                    client.end('open');
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

    close(): Promise<void> {
        const server = this.#server;

        this.#server = undefined;
        this.#openRequestHandler = undefined;

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
}
