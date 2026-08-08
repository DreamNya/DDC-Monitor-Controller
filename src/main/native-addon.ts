import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface NativeMonitor {
    id: string;
    name: string;
    index: number;
}

export interface VcpValue {
    current: number;
    maximum: number;
}

interface MonitorNativeAddon {
    refreshMonitors(): NativeMonitor[];
    getVcpValue(index: number, code: number): VcpValue;
    setVcpValue(index: number, code: number, value: number): void;
    shutdown(): void;
}

let cachedAddon: MonitorNativeAddon | undefined;

export function getNativeAddon(): MonitorNativeAddon {
    if (cachedAddon) {
        return cachedAddon;
    }

    if (process.platform !== 'win32') {
        throw new Error('MonitorNative.node 仅支持 Windows');
    }

    const addonPath = resolveNativeAddonPath();

    if (!fs.existsSync(addonPath)) {
        throw new Error(
            [
                `找不到原生模块：${addonPath}`,
                '请先执行 npm run build:native，然后重新执行 npm run build',
            ].join('\n'),
        );
    }

    try {
        const require = createRequire(import.meta.url);
        cachedAddon = require(addonPath) as MonitorNativeAddon;
        return cachedAddon;
    } catch (error) {
        throw new Error(
            [
                `无法加载 MonitorNative.node：${addonPath}`,
                '请确认原生模块架构与 Node.js 一致，并且文件未被安全软件拦截',
                `底层错误：${toErrorMessage(error)}`,
            ].join('\n'),
            { cause: error },
        );
    }
}

export function shutdownNativeAddon(): void {
    if (!cachedAddon) {
        return;
    }

    cachedAddon.shutdown();
}

function resolveNativeAddonPath(): string {
    const override = process.env.MONITOR_NATIVE_ADDON;

    if (override) {
        return path.resolve(override);
    }

    const mainDirectory = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(mainDirectory, './native/MonitorNative.node');
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
