export const DEFAULT_EXTERNAL_API_PORT = 45678;
export const MIN_EXTERNAL_API_PORT = 1024;
export const MAX_EXTERNAL_API_PORT = 65535;

export interface ExternalApiConfiguration {
    enabled: boolean;
    port: number;
}

export function isExternalApiPort(value: unknown): value is number {
    return (
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= MIN_EXTERNAL_API_PORT &&
        value <= MAX_EXTERNAL_API_PORT
    );
}

export function assertExternalApiConfiguration(configuration: ExternalApiConfiguration): void {
    if (typeof configuration.enabled !== 'boolean') {
        throw new TypeError('本地 API 启用状态必须是布尔值');
    }

    if (!isExternalApiPort(configuration.port)) {
        throw new RangeError(
            `本地 API 端口必须是 ${MIN_EXTERNAL_API_PORT} 到 ${MAX_EXTERNAL_API_PORT} 的整数：${String(configuration.port)}`,
        );
    }
}
