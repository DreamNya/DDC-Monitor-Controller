import { assertUint32, assertVcpCode } from '../shared/advanced-vcp.ts';
import { INTERVAL_MINUTES_OPTIONS, type IntervalMinutes } from '../shared/model.ts';
import type {
    PublicApiAlias,
    PublicApiErrorCode,
    PublicApiMethod,
    PublicApiRequest,
    PublicApiResponseMethod,
} from './public-api.ts';
import { PUBLIC_API_REQUEST_METHOD } from './public-api.ts';

export const PUBLIC_API_MAX_SLEEP_MS = 60_000;

export type NormalizedPublicApiCommand =
    | {
          type: 'canonical';
          sourceMethod: PublicApiMethod;
          request: PublicApiRequest;
      }
    | {
          type: 'alias';
          sourceMethod: PublicApiAlias;
          value: unknown;
      }
    | {
          type: 'sleep';
          sourceMethod: 'sleep';
          milliseconds: number;
      };

const PUBLIC_API_ALIASES = new Set<PublicApiAlias>([
    'state',
    'monitor',
    'brightness',
    'contrast',
    'auto',
    'interval',
    'apply',
    'schedule',
]);

/**
 * 将用户友好的命令对象完整校验并规范化后再交给 Dispatcher
 * 对象 shorthand 按属性插入顺序执行；需要重复命令时使用数组，每个数组项只允许一个命令
 */
export function normalizePublicApiRequest(value: unknown): NormalizedPublicApiCommand[] {
    const entries = getCommandEntries(value);
    return entries.map(([method, params]) => normalizeCommand(method, params));
}

function getCommandEntries(value: unknown): Array<[string, unknown]> {
    if (Array.isArray(value)) {
        if (value.length === 0) {
            throw invalidRequest('API batch 数组不能为空');
        }

        return value.map((item, index) => {
            if (!isRecord(item)) {
                throw invalidRequest(`API batch 第 ${index + 1} 项必须是 JSON 对象`);
            }

            const entries = Object.entries(item);
            if (entries.length !== 1) {
                throw invalidRequest(`API batch 第 ${index + 1} 项必须且只能包含一个命令`);
            }

            return entries[0]!;
        });
    }

    if (!isRecord(value)) {
        throw invalidRequest('API 请求必须是命令 JSON 对象或命令对象数组');
    }

    const entries = Object.entries(value);
    if (entries.length === 0) {
        throw invalidRequest('API 请求至少需要一个命令');
    }

    return entries;
}

function normalizeCommand(method: string, value: unknown): NormalizedPublicApiCommand {
    if (method === 'sleep') {
        return {
            type: 'sleep',
            sourceMethod: method,
            milliseconds: getSleepMilliseconds(value),
        };
    }

    if (PUBLIC_API_ALIASES.has(method as PublicApiAlias)) {
        const sourceMethod = method as PublicApiAlias;
        validateAlias(sourceMethod, value);
        return {
            type: 'alias',
            sourceMethod,
            value,
        };
    }

    return {
        type: 'canonical',
        sourceMethod: method as PublicApiMethod,
        request: parseCanonicalRequest(method, value),
    };
}

function validateAlias(method: PublicApiAlias, value: unknown): void {
    switch (method) {
        case 'state':
        case 'apply':
            return;

        case 'monitor':
            if (value === null) {
                return;
            }
            getNonEmptyStringValue(value, method);
            return;

        case 'brightness':
        case 'contrast':
            if (value === null) {
                return;
            }
            getPercentage(value, method);
            return;

        case 'auto':
            if (value === null || typeof value === 'boolean') {
                return;
            }
            throw invalidParams(method, `${method} 必须是布尔值；读取时传入 null`);

        case 'interval':
            if (value === null) {
                return;
            }
            getIntervalMinutes(value, method);
            return;

        case 'schedule':
            if (value === null) {
                return;
            }
            getNonEmptyStringValue(value, method);
            return;
    }
}

function parseCanonicalRequest(method: string, value: unknown): PublicApiRequest {
    switch (method) {
        case 'state.get':
        case 'monitor.list':
        case 'auto.applyNow':
        case 'schedule.list':
        case 'command.list':
            // 无参数命令按公开协议忽略 value，调用者可传入任意 JSON 值
            return { method };

        case 'monitor.target':
            return { method, params: { monitorId: getNonEmptyStringValue(value, method) } };

        case 'monitor.set': {
            const params = getParams(method, value);
            const monitorId = getOptionalNonEmptyString(params, 'monitorId', method);
            const brightness = getOptionalPercentage(params, 'brightness', method);
            const contrast = getOptionalPercentage(params, 'contrast', method);

            if (brightness === undefined && contrast === undefined) {
                throw invalidParams(method, 'monitor.set 至少需要 brightness 或 contrast');
            }

            return {
                method,
                params: {
                    ...(monitorId !== undefined ? { monitorId } : {}),
                    ...(brightness !== undefined ? { brightness } : {}),
                    ...(contrast !== undefined ? { contrast } : {}),
                },
            };
        }

        case 'auto.setEnabled': {
            const params = getParams(method, value);
            return { method, params: { enabled: getBoolean(params, 'enabled', method) } };
        }

        case 'auto.setInterval': {
            const params = getParams(method, value);
            return {
                method,
                params: { intervalMinutes: getIntervalMinutes(params.intervalMinutes, method, 'intervalMinutes') },
            };
        }

        case 'schedule.activate': {
            const params = getParams(method, value);
            return { method, params: { profileId: getNonEmptyString(params, 'profileId', method) } };
        }

        case 'command.execute': {
            const params = getParams(method, value);
            return { method, params: { commandId: getNonEmptyString(params, 'commandId', method) } };
        }

        case 'vcp.capabilities': {
            const params = getParams(method, value);
            const monitorId = getOptionalNonEmptyString(params, 'monitorId', method);
            return {
                method,
                params: {
                    ...(monitorId !== undefined ? { monitorId } : {}),
                },
            };
        }

        case 'vcp.read': {
            const params = getParams(method, value);
            const monitorId = getOptionalNonEmptyString(params, 'monitorId', method);
            const codes = params.codes;

            if (!Array.isArray(codes) || codes.length === 0) {
                throw invalidParams(method, 'codes 必须是至少包含一个 VCP Code 的数组');
            }

            return {
                method,
                params: {
                    ...(monitorId !== undefined ? { monitorId } : {}),
                    codes: codes.map((code) => getVcpCode(code, method)),
                },
            };
        }

        case 'vcp.write': {
            const params = getParams(method, value);
            const monitorId = getOptionalNonEmptyString(params, 'monitorId', method);
            return {
                method,
                params: {
                    ...(monitorId !== undefined ? { monitorId } : {}),
                    code: getVcpCode(params.code, method),
                    value: getUint32(params.value, 'value', method),
                },
            };
        }

        case 'vcp.adjust': {
            const params = getParams(method, value);
            const monitorId = getOptionalNonEmptyString(params, 'monitorId', method);
            const direction = params.direction;
            const percent = getFiniteNumber(params, 'percent', method);

            if (direction !== 'increase' && direction !== 'decrease') {
                throw invalidParams(method, 'direction 必须是 increase 或 decrease');
            }
            if (percent <= 0) {
                throw invalidParams(method, 'percent 必须是大于 0 的有限数值');
            }

            return {
                method,
                params: {
                    ...(monitorId !== undefined ? { monitorId } : {}),
                    code: getVcpCode(params.code, method),
                    direction,
                    percent,
                },
            };
        }

        default:
            throw new PublicApiValidationError(
                method as PublicApiResponseMethod,
                'METHOD_NOT_FOUND',
                `不支持的 API 方法：${method}`,
            );
    }
}

function getParams(method: PublicApiResponseMethod, value: unknown): Record<string, unknown> {
    if (!isRecord(value)) {
        throw invalidParams(method, `${method} 的参数必须是 JSON 对象`);
    }
    return value;
}

function getNonEmptyString(params: Record<string, unknown>, key: string, method: PublicApiResponseMethod): string {
    return getNonEmptyStringValue(params[key], method, key);
}

function getOptionalNonEmptyString(
    params: Record<string, unknown>,
    key: string,
    method: PublicApiResponseMethod,
): string | undefined {
    if (!(key in params)) {
        return undefined;
    }
    return getNonEmptyStringValue(params[key], method, key);
}

function getNonEmptyStringValue(value: unknown, method: PublicApiResponseMethod, name: string = method): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw invalidParams(method, `${name} 必须是非空字符串`);
    }
    return value;
}

function getBoolean(params: Record<string, unknown>, key: string, method: PublicApiResponseMethod): boolean {
    const value = params[key];
    if (typeof value !== 'boolean') {
        throw invalidParams(method, `${key} 必须是布尔值`);
    }
    return value;
}

function getFiniteNumber(params: Record<string, unknown>, key: string, method: PublicApiResponseMethod): number {
    const value = params[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw invalidParams(method, `${key} 必须是有限数值`);
    }
    return value;
}

function getOptionalPercentage(
    params: Record<string, unknown>,
    key: string,
    method: PublicApiResponseMethod,
): number | undefined {
    if (!(key in params)) {
        return undefined;
    }
    return getPercentage(params[key], method, key);
}

function getPercentage(value: unknown, method: PublicApiResponseMethod, name: string = method): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
        throw invalidParams(method, `${name} 必须是 0 到 100 的有限数值`);
    }
    return value;
}

function getIntervalMinutes(value: unknown, method: PublicApiResponseMethod, name: string = method): IntervalMinutes {
    if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        !INTERVAL_MINUTES_OPTIONS.some((interval) => interval === value)
    ) {
        throw invalidParams(method, `${name} 必须是 ${INTERVAL_MINUTES_OPTIONS.join('、')} 分钟之一`);
    }
    return value as IntervalMinutes;
}

function getVcpCode(value: unknown, method: PublicApiResponseMethod): number {
    if (typeof value !== 'number') {
        throw invalidParams(method, 'VCP Code 必须是数值');
    }

    try {
        assertVcpCode(value);
        return value;
    } catch (error) {
        throw invalidParams(method, toErrorMessage(error));
    }
}

function getUint32(value: unknown, name: string, method: PublicApiResponseMethod): number {
    if (typeof value !== 'number') {
        throw invalidParams(method, `${name} 必须是数值`);
    }

    try {
        assertUint32(value, name);
        return value;
    } catch (error) {
        throw invalidParams(method, toErrorMessage(error));
    }
}

function getSleepMilliseconds(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > PUBLIC_API_MAX_SLEEP_MS) {
        throw invalidParams('sleep', `sleep 必须是 0 到 ${PUBLIC_API_MAX_SLEEP_MS} 的整数毫秒数`);
    }
    return value;
}

function invalidRequest(message: string): PublicApiValidationError {
    return new PublicApiValidationError(PUBLIC_API_REQUEST_METHOD, 'INVALID_REQUEST', message);
}

function invalidParams(method: PublicApiResponseMethod, message: string): PublicApiValidationError {
    return new PublicApiValidationError(method, 'INVALID_PARAMS', message);
}

export class PublicApiValidationError extends Error {
    readonly method: PublicApiResponseMethod;
    readonly code: PublicApiErrorCode;

    constructor(method: PublicApiResponseMethod, code: PublicApiErrorCode, message: string) {
        super(message);
        this.method = method;
        this.code = code;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
