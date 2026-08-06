import fs from 'node:fs';
import path from 'node:path';
import { formatWithOptions } from 'node:util';

type LogLevel = 'INFO' | 'WARN' | 'ERROR';

export class FileLogger {
    readonly #filePath: string;
    readonly #originalConsole = {
        log: console.log.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
    };

    #enabled = false;
    #installed = false;

    constructor(runtimeRoot: string) {
        this.#filePath = path.resolve(runtimeRoot, 'log', `${Date.now()}.log`);
    }

    install(): void {
        if (this.#installed) {
            return;
        }

        this.#installed = true;

        console.log = (...args: unknown[]) => {
            this.#originalConsole.log(...args);
            this.#append('INFO', args);
        };

        console.warn = (...args: unknown[]) => {
            this.#originalConsole.warn(...args);
            this.#append('WARN', args);
        };

        console.error = (...args: unknown[]) => {
            this.#originalConsole.error(...args);
            this.#append('ERROR', args);
        };
    }

    setEnabled(enabled: boolean): void {
        if (this.#enabled === enabled) {
            return;
        }

        if (enabled) {
            this.#enabled = true;
            this.#append('INFO', ['文件日志已开启']);
            return;
        }

        this.#append('INFO', ['文件日志已关闭']);
        this.#enabled = false;
    }

    #append(level: LogLevel, args: unknown[]): void {
        if (!this.#enabled) {
            return;
        }

        try {
            fs.mkdirSync(path.dirname(this.#filePath), { recursive: true });

            const message = formatWithOptions(
                {
                    colors: false,
                    depth: 6,
                },
                ...args,
            );

            fs.appendFileSync(this.#filePath, `[${new Date().toLocaleString()}] [${level}] ${message}\n`, 'utf8');
        } catch (error) {
            this.#originalConsole.error('写入日志文件失败：', error);
        }
    }
}
