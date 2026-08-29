import net from 'node:net';

export const LAUNCHER_RESULT_PIPE_ENV = 'DDCMC_LAUNCHER_RESULT_PIPE';

const LAUNCHER_RESULT_MAGIC = 0x31434d44;
const LAUNCHER_RESULT_HEADER_BYTES = 16;

export type LauncherResultStream = 'stdout' | 'stderr';

export interface LauncherCliResult {
    exitCode: number;
    stream: LauncherResultStream;
    text: string;
}

/**
 * 将一次 CLI 调用结果回传给原生 Launcher。
 *
 * 非 --silent CLI 在冷启动桌面实例后 Node 会继续常驻，因此 Launcher 不能等待
 * Node 进程退出。Launcher 通过环境变量提供一次性 Named Pipe；这里写入结果后关闭
 * 连接，让 Launcher 可以立即输出结果并退出，而桌面 Node 进程继续运行。
 *
 * @returns true 表示存在 Launcher 结果通道且已经成功写入；false 表示当前并非由
 * Launcher 结果通道启动，调用方应回退到 process.stdout / process.stderr。
 */
export async function sendLauncherCliResult(result: LauncherCliResult): Promise<boolean> {
    const pipeName = process.env[LAUNCHER_RESULT_PIPE_ENV];

    if (!pipeName) {
        return false;
    }

    // 结果通道只属于当前这次启动，避免桌面进程未来创建的子进程意外继承。
    delete process.env[LAUNCHER_RESULT_PIPE_ENV];

    const payload = encodeLauncherCliResult(result);

    return new Promise<boolean>((resolvePromise) => {
        const socket = net.createConnection(pipeName);
        let settled = false;

        const settle = (value: boolean): void => {
            if (settled) {
                return;
            }
            settled = true;
            resolvePromise(value);
        };

        socket.once('connect', () => {
            socket.end(payload);
        });

        socket.once('error', () => {
            settle(false);
        });

        socket.once('close', (hadError) => {
            settle(!hadError);
        });
    });
}

export function encodeLauncherCliResult(result: LauncherCliResult): Buffer {
    const payload = Buffer.from(result.text, 'utf8');
    const header = Buffer.allocUnsafe(LAUNCHER_RESULT_HEADER_BYTES);

    header.writeUInt32LE(LAUNCHER_RESULT_MAGIC, 0);
    header.writeUInt32LE(result.exitCode >>> 0, 4);
    header.writeUInt32LE(result.stream === 'stderr' ? 2 : 1, 8);
    header.writeUInt32LE(payload.length, 12);

    return Buffer.concat([header, payload]);
}
