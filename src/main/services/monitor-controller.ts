import { validateAdvancedVcpAction } from '../../shared/advanced-vcp.ts';
import type {
    AdvancedVcpAction,
    AdvancedVcpExecutionResult,
    LiveApplyRequest,
    ManualApplyRequest,
    MonitorCapabilities,
    MonitorSnapshot,
    MonitorTarget,
    MonitorVcpReadResult,
} from '../../shared/model';
import { parseVcpCapabilities } from './monitor/capabilities-parser.ts';
import { NativeDdcClient, type NativeMonitor, type VcpValue } from './monitor/native-ddc-client.ts';

const VCP_BRIGHTNESS = 0x10;
const VCP_CONTRAST = 0x12;

export interface DdcClient {
    refreshMonitors(): NativeMonitor[];
    readVcpValue(index: number, code: number): VcpValue;
    getCapabilities(index: number): string;
    writeVcpValue(index: number, code: number, value: number): void;
    dispose(): void;
}

export interface MonitorApplyResult {
    brightness: number;
    contrast: number;
}

export interface MonitorLiveApplyResult {
    brightness?: number;
    contrast?: number;
}

/**
 * DDC/CI 缓存层
 *
 * 原生调用保持同步执行；应用级并发统一由 AppController 串行化
 * 此处只维护显示器拓扑、VCP 最大值和最近一次确认的百分比缓存
 */
export class DDCMonitorController {
    readonly #client: DdcClient;
    readonly #maximumValues = new Map<string, number>();
    readonly #percentageValues = new Map<string, number>();

    #monitors: NativeMonitor[] = [];
    #snapshots: MonitorSnapshot[] = [];

    constructor(client: DdcClient = new NativeDdcClient()) {
        this.#client = client;
    }

    async getSnapshots(): Promise<MonitorSnapshot[]> {
        return this.#refreshSnapshots();
    }

    /** 返回内存中的最后一份快照，不触发任何 DDC/CI 通信 */
    getCachedSnapshots(): MonitorSnapshot[] {
        return structuredClone(this.#snapshots);
    }

    /** 按需读取单台显示器的 MCCS Capabilities String，并解析其中声明的 VCP Code */
    getCapabilities(monitorId: string): MonitorCapabilities {
        const monitor = resolveSingleMonitor(this.#monitors, monitorId);
        const raw = this.#client.getCapabilities(monitor.index);

        return {
            monitorId: monitor.id,
            monitorName: monitor.name,
            raw,
            vcpCodes: parseVcpCapabilities(raw),
        };
    }

    /**
     * 尽力批量读取 VCP Code
     *
     * Capabilities 中出现某个 Code 并不保证显示器实现了通用 Get VCP Feature；
     * 因此单项失败只记录到结果中，不中断其余 Code 的读取
     */
    getVcpValues(monitorId: string, codes: readonly number[]): MonitorVcpReadResult[] {
        const monitor = resolveSingleMonitor(this.#monitors, monitorId);
        const uniqueCodes = [...new Set(codes)];

        for (const code of uniqueCodes) {
            if (!Number.isInteger(code) || code < 0 || code > 0xff) {
                throw new RangeError(`VCP Code 必须位于 0x00 到 0xFF：${String(code)}`);
            }
        }

        return uniqueCodes.map((code) => {
            try {
                const value = this.#client.readVcpValue(monitor.index, code);

                return {
                    code,
                    current: value.current,
                    maximum: value.maximum,
                } satisfies MonitorVcpReadResult;
            } catch (error) {
                return {
                    code,
                    current: null,
                    maximum: null,
                    error: toErrorMessage(error),
                } satisfies MonitorVcpReadResult;
            }
        });
    }

    /**
     * 执行高级 VCP 原子操作
     *
     * 普通写入只做协议层数值校验；相对百分比调节会限制到 0～maximum
     */
    executeVcpAction(monitorId: string, requestedAction: AdvancedVcpAction): AdvancedVcpExecutionResult {
        const monitor = resolveSingleMonitor(this.#monitors, monitorId);
        const action = validateAdvancedVcpAction(requestedAction);

        if (action.type === 'read') {
            const result = this.#client.readVcpValue(monitor.index, action.code);
            return {
                monitorId: monitor.id,
                code: action.code,
                operation: 'read',
                current: result.current,
                maximum: result.maximum,
            };
        }

        if (action.type === 'write') {
            this.#client.writeVcpValue(monitor.index, action.code, action.value);
            return {
                monitorId: monitor.id,
                code: action.code,
                operation: 'write',
                value: action.value,
            };
        }

        const current = this.#client.readVcpValue(monitor.index, action.code);
        const delta = Math.round((current.maximum * action.percent) / 100);
        const requestedValue = action.direction === 'increase' ? current.current + delta : current.current - delta;
        const value = Math.min(current.maximum, Math.max(0, requestedValue));

        // 相对调节始终执行一次写入，包括已经处于 0 / maximum 边界时
        this.#client.writeVcpValue(monitor.index, action.code, value);

        return {
            monitorId: monitor.id,
            code: action.code,
            operation: 'write',
            previous: current.current,
            maximum: current.maximum,
            value,
        };
    }

    /**
     * 完整设置亮度和对比度，用于手动设置和已经完成刷新后的自动设置
     *
     * 此方法本身不刷新显示器；调用方可在低频边界先调用 getSnapshots()
     */
    async apply(request: ManualApplyRequest): Promise<MonitorApplyResult> {
        const targets = resolveTargets(this.#monitors, request.monitorId);
        const brightness = clamp(request.brightness);
        const contrast = clamp(request.contrast);

        for (const monitor of targets) {
            this.#writePercentage(monitor, VCP_BRIGHTNESS, brightness);
            this.#updateSnapshotValue(monitor.id, { brightness });

            this.#writePercentage(monitor, VCP_CONTRAST, contrast);
            this.#updateSnapshotValue(monitor.id, { contrast });
            this.#clearSnapshotError(monitor.id);
        }

        return {
            brightness,
            contrast,
        };
    }

    /**
     * 实时调节只写入本次变化的属性，并始终复用缓存
     *
     * 只有某个 VCP 的最大值尚未缓存时，才会额外读取一次以完成百分比换算
     */
    async applyLive(request: LiveApplyRequest): Promise<MonitorLiveApplyResult> {
        const requestedBrightness = request.brightness;
        const requestedContrast = request.contrast;
        const hasBrightness = requestedBrightness !== undefined;
        const hasContrast = requestedContrast !== undefined;

        if (!hasBrightness && !hasContrast) {
            throw new Error('实时调节请求至少需要包含亮度或对比度');
        }

        const targets = resolveTargets(this.#monitors, request.monitorId);
        const brightness = requestedBrightness !== undefined ? clamp(requestedBrightness) : undefined;
        const contrast = requestedContrast !== undefined ? clamp(requestedContrast) : undefined;

        for (const monitor of targets) {
            if (brightness !== undefined) {
                this.#writePercentage(monitor, VCP_BRIGHTNESS, brightness);
                this.#updateSnapshotValue(monitor.id, { brightness });
            }

            if (contrast !== undefined) {
                this.#writePercentage(monitor, VCP_CONTRAST, contrast);
                this.#updateSnapshotValue(monitor.id, { contrast });
            }
        }

        return {
            ...(brightness !== undefined ? { brightness } : {}),
            ...(contrast !== undefined ? { contrast } : {}),
        };
    }

    async dispose(): Promise<void> {
        this.#client.dispose();
        this.#monitors = [];
        this.#snapshots = [];
        this.#maximumValues.clear();
        this.#percentageValues.clear();
    }

    #refreshSnapshots(): MonitorSnapshot[] {
        const monitors = this.#client.refreshMonitors();

        this.#monitors = monitors;
        this.#snapshots = [];
        this.#maximumValues.clear();
        this.#percentageValues.clear();

        this.#snapshots = monitors.map((monitor) => {
            const errors: string[] = [];
            let brightness: number | null = null;
            let contrast: number | null = null;

            try {
                brightness = this.#readAndCachePercentage(monitor, VCP_BRIGHTNESS);
            } catch (error) {
                console.error(`读取显示器“${monitor.name || monitor.id}”亮度失败：`, error);
                errors.push(`亮度：${toErrorMessage(error)}`);
            }

            try {
                contrast = this.#readAndCachePercentage(monitor, VCP_CONTRAST);
            } catch (error) {
                console.error(`读取显示器“${monitor.name || monitor.id}”对比度失败：`, error);
                errors.push(`对比度：${toErrorMessage(error)}`);
            }

            return {
                id: monitor.id,
                name: monitor.name,
                index: monitor.index,
                brightness,
                contrast,
                ...(errors.length > 0 ? { error: errors.join('\n') } : {}),
            } satisfies MonitorSnapshot;
        });

        return this.getCachedSnapshots();
    }

    #readAndCachePercentage(monitor: NativeMonitor, code: number): number {
        const value = this.#client.readVcpValue(monitor.index, code);
        const percentage = toPercentage(value);
        const cacheKey = createVcpCacheKey(monitor.id, code);

        this.#maximumValues.set(cacheKey, value.maximum);
        this.#percentageValues.set(cacheKey, percentage);
        return percentage;
    }

    #writePercentage(monitor: NativeMonitor, code: number, percentage: number): void {
        const cacheKey = createVcpCacheKey(monitor.id, code);

        if (this.#percentageValues.get(cacheKey) === percentage) {
            return;
        }

        let maximum = this.#maximumValues.get(cacheKey);

        if (maximum === undefined) {
            // 仅在刷新快照时读取该 VCP 失败时发生
            const value = this.#client.readVcpValue(monitor.index, code);
            maximum = value.maximum;
            this.#maximumValues.set(cacheKey, maximum);

            const currentPercentage = toPercentage(value);
            this.#percentageValues.set(cacheKey, currentPercentage);

            if (currentPercentage === percentage) {
                return;
            }
        }

        const rawValue = maximum > 0 ? Math.round((percentage / 100) * maximum) : percentage;

        this.#client.writeVcpValue(monitor.index, code, rawValue);
        this.#percentageValues.set(cacheKey, percentage);
    }

    #updateSnapshotValue(monitorId: string, values: { brightness?: number; contrast?: number }): void {
        this.#snapshots = this.#snapshots.map((monitor) => {
            if (monitor.id !== monitorId) {
                return monitor;
            }

            return {
                id: monitor.id,
                index: monitor.index,
                name: monitor.name,
                brightness: values.brightness ?? monitor.brightness,
                contrast: values.contrast ?? monitor.contrast,
                ...(monitor.error ? { error: monitor.error } : {}),
            };
        });
    }

    #clearSnapshotError(monitorId: string): void {
        this.#snapshots = this.#snapshots.map((monitor) => {
            if (monitor.id !== monitorId || monitor.error === undefined) {
                return monitor;
            }

            return {
                id: monitor.id,
                index: monitor.index,
                name: monitor.name,
                brightness: monitor.brightness,
                contrast: monitor.contrast,
            };
        });
    }
}

function toPercentage(value: VcpValue): number {
    if (value.maximum <= 0) {
        return clamp(value.current);
    }

    return clamp((value.current / value.maximum) * 100);
}

function createVcpCacheKey(monitorId: string, code: number): string {
    return `${monitorId}\u0000${code}`;
}

function resolveTargets(monitors: readonly NativeMonitor[], target: MonitorTarget): NativeMonitor[] {
    if (monitors.length === 0) {
        throw new Error('未检测到支持 DDC/CI 的物理显示器');
    }

    if (target === 'all') {
        return [...monitors];
    }

    const monitor = monitors.find(({ id }) => id === target);

    if (!monitor) {
        throw new Error(`目标显示器已断开或标识发生变化：${target}`);
    }

    return [monitor];
}

function resolveSingleMonitor(monitors: readonly NativeMonitor[], monitorId: string): NativeMonitor {
    if (monitorId === 'all') {
        throw new Error('VCP 枚举需要选择一台具体显示器');
    }

    const targets = resolveTargets(monitors, monitorId);
    const monitor = targets[0];

    if (!monitor) {
        throw new Error(`目标显示器已断开或标识发生变化：${monitorId}`);
    }

    return monitor;
}

function clamp(value: number): number {
    if (!Number.isFinite(value)) {
        throw new TypeError('显示器调整值必须为有限数字');
    }

    return Math.min(100, Math.max(0, Math.round(value)));
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
