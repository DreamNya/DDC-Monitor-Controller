import {
    getNativeAddon,
    shutdownNativeAddon,
    type NativeMonitor,
    type VcpValue,
} from '../../native-addon.ts';

export type { NativeMonitor, VcpValue } from '../../native-addon.ts';

/** 封装项目自带的 Node-API 原生模块 */
export class NativeDdcClient {
    refreshMonitors(): NativeMonitor[] {
        return getNativeAddon().refreshMonitors();
    }

    readCapabilities(index: number): string {
        return getNativeAddon().getCapabilities(index);
    }

    readVcpValue(index: number, code: number): VcpValue {
        return getNativeAddon().getVcpValue(index, code);
    }

    writeVcpValue(index: number, code: number, value: number): void {
        getNativeAddon().setVcpValue(index, code, value);
    }

    dispose(): void {
        shutdownNativeAddon();
    }
}
