import koffi from 'koffi';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEXT_BUFFER_SIZE = 1024;

interface NativeLibrary {
    func(signature: string): unknown;
    unload(): void;
}

interface NativeBindings {
    library: NativeLibrary;
    refresh(count: [number]): number;
    getMonitorId(index: number, buffer: Buffer, bufferSize: number): number;
    getMonitorName(index: number, buffer: Buffer, bufferSize: number): number;
    getVcpValue(index: number, code: number, current: [number], maximum: [number]): number;
    setVcpValue(index: number, code: number, value: number): number;
    formatError(code: number, buffer: Buffer, bufferSize: number): number;
    shutdown(): void;
}

export interface NativeMonitor {
    id: string;
    name: string;
    index: number;
}

export interface VcpValue {
    current: number;
    maximum: number;
}

let cachedBindings: NativeBindings | undefined;

/** 封装 MonitorDdc.dll 的加载、原生调用和 Win32 错误格式化 */
export class NativeDdcClient {
    refreshMonitors(): NativeMonitor[] {
        const native = loadNativeBindings();
        const count: [number] = [0];
        assertSuccess(native.refresh(count), '刷新物理显示器列表');

        return Array.from({ length: count[0] ?? 0 }, (_, index) => ({
            id: readNativeString(native.getMonitorId, index),
            name: readNativeString(native.getMonitorName, index),
            index,
        }));
    }

    readVcpValue(index: number, code: number): VcpValue {
        const native = loadNativeBindings();
        const current: [number] = [0];
        const maximum: [number] = [0];

        assertSuccess(native.getVcpValue(index, code, current, maximum), `读取 VCP ${formatVcpCode(code)}`);

        return {
            current: current[0] ?? 0,
            maximum: maximum[0] ?? 0,
        };
    }

    writeVcpValue(index: number, code: number, value: number): void {
        assertSuccess(loadNativeBindings().setVcpValue(index, code, value), `设置 VCP ${formatVcpCode(code)}`);
    }

    dispose(): void {
        if (!cachedBindings) {
            return;
        }

        try {
            cachedBindings.shutdown();
        } finally {
            cachedBindings.library.unload();
            cachedBindings = undefined;
        }
    }
}

function readNativeString(fn: NativeBindings['getMonitorId'], index: number): string {
    const buffer = Buffer.alloc(TEXT_BUFFER_SIZE);
    assertSuccess(fn(index, buffer, buffer.length), '读取显示器标识');
    const terminator = buffer.indexOf(0);

    return buffer.subarray(0, terminator >= 0 ? terminator : buffer.length).toString('utf8');
}

function loadNativeBindings(): NativeBindings {
    if (cachedBindings) {
        return cachedBindings;
    }

    if (process.platform !== 'win32') {
        throw new Error('MonitorDdc.dll 仅支持 Windows');
    }

    const dllPath = resolveDllPath();

    if (!fs.existsSync(dllPath)) {
        throw new Error(
            [
                `找不到 DDC/CI 桥接库：${dllPath}`,
                '请先在 Visual Studio Developer PowerShell 中执行 npm run build:native',
                '然后重新执行 npm run build',
            ].join('\n'),
        );
    }

    try {
        const library = koffi.load(dllPath) as unknown as NativeLibrary;

        cachedBindings = {
            library,
            refresh: library.func('uint32_t mc_refresh(_Out_ uint32_t *count)') as NativeBindings['refresh'],
            getMonitorId: library.func(
                'uint32_t mc_get_monitor_id(uint32_t index, _Out_ char *buffer, uint32_t buffer_size)',
            ) as NativeBindings['getMonitorId'],
            getMonitorName: library.func(
                'uint32_t mc_get_monitor_name(uint32_t index, _Out_ char *buffer, uint32_t buffer_size)',
            ) as NativeBindings['getMonitorName'],
            getVcpValue: library.func(
                'uint32_t mc_get_vcp_value(uint32_t index, uint8_t code, _Out_ uint32_t *current, _Out_ uint32_t *maximum)',
            ) as NativeBindings['getVcpValue'],
            setVcpValue: library.func(
                'uint32_t mc_set_vcp_value(uint32_t index, uint8_t code, uint32_t value)',
            ) as NativeBindings['setVcpValue'],
            formatError: library.func(
                'uint32_t mc_format_error(uint32_t code, _Out_ char *buffer, uint32_t buffer_size)',
            ) as NativeBindings['formatError'],
            shutdown: library.func('void mc_shutdown(void)') as NativeBindings['shutdown'],
        };

        return cachedBindings;
    } catch (error) {
        throw new Error(
            [
                `无法加载 MonitorDdc.dll：${dllPath}`,
                '请确认 DLL 架构与 Node.js 一致，并且文件未被安全软件拦截',
                `底层错误：${toErrorMessage(error)}`,
            ].join('\n'),
            { cause: error },
        );
    }
}

function resolveDllPath(): string {
    const override = process.env.MONITOR_DDC_DLL;

    if (override) {
        return path.resolve(override);
    }

    const mainDirectory = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(mainDirectory, './native/MonitorDdc.dll');
}

function assertSuccess(code: number, operation: string): void {
    if (code === 0) {
        return;
    }

    throw new Error(`${operation}失败（错误码 ${code}）：${formatNativeError(code)}`);
}

function formatNativeError(code: number): string {
    const native = cachedBindings;

    if (!native) {
        return '未知原生错误';
    }

    const buffer = Buffer.alloc(TEXT_BUFFER_SIZE);
    const result = native.formatError(code, buffer, buffer.length);

    if (result !== 0) {
        return '无法格式化 Win32 错误信息';
    }

    const terminator = buffer.indexOf(0);
    return buffer.subarray(0, terminator >= 0 ? terminator : buffer.length).toString('utf8');
}

function formatVcpCode(code: number): string {
    return `0x${code.toString(16).padStart(2, '0')}`;
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
