import { assertUint32, assertVcpCode } from '../shared/advanced-vcp.ts';
import type { AppController } from '../main/app-controller.ts';
import { INTERVAL_MINUTES_OPTIONS, type AdvancedVcpExecutionOutcome, type IntervalMinutes } from '../shared/model.ts';
import {
    PUBLIC_API_VERSION,
    type PublicApiErrorCode,
    type PublicApiRequest,
    type PublicApiResponse,
} from './public-api.ts';

type PublicApiController = Pick<
    AppController,
    | 'getState'
    | 'refreshMonitors'
    | 'applyLive'
    | 'setAutoEnabled'
    | 'setAutoInterval'
    | 'setTargetMonitor'
    | 'applyAutoNow'
    | 'setActiveScheduleProfile'
    | 'executeAdvancedVcpCommand'
    | 'getMonitorCapabilities'
    | 'getMonitorVcpValues'
    | 'executeAdvancedVcp'
    | 'setTheme'
    | 'setLogEnabled'
>;

export class PublicApiDispatcher {
    readonly #appController: PublicApiController;

    constructor(appController: PublicApiController) {
        this.#appController = appController;
    }

    async execute(request: unknown): Promise<PublicApiResponse> {
        try {
            return {
                ok: true,
                result: await this.#dispatch(parseRequest(request)),
            };
        } catch (error) {
            const apiError =
                error instanceof PublicApiFault
                    ? error
                    : new PublicApiFault('EXECUTION_FAILED', toErrorMessage(error));

            return {
                ok: false,
                error: {
                    code: apiError.code,
                    message: apiError.message,
                },
            };
        }
    }

    async #dispatch(request: PublicApiRequest): Promise<unknown> {
        switch (request.method) {
            case 'system.ping':
                return { apiVersion: PUBLIC_API_VERSION };

            case 'state.get':
                return this.#appController.getState();

            case 'monitor.list':
                return this.#appController.getState().monitors;

            case 'monitor.refresh':
                await this.#appController.refreshMonitors();
                return null;

            case 'monitor.set':
                await this.#appController.applyLive(request.params);
                return null;

            case 'auto.setEnabled':
                await this.#appController.setAutoEnabled(request.params.enabled);
                return null;

            case 'auto.setInterval':
                await this.#appController.setAutoInterval(request.params.intervalMinutes);
                return null;

            case 'auto.setTarget':
                await this.#appController.setTargetMonitor(request.params.monitorId);
                return null;

            case 'auto.applyNow':
                await this.#appController.applyAutoNow();
                return null;

            case 'schedule.list': {
                const { settings } = this.#appController.getState();
                return {
                    activeProfileId: settings.activeScheduleProfileId,
                    profiles: settings.scheduleProfiles,
                };
            }

            case 'schedule.activate':
                await this.#appController.setActiveScheduleProfile(request.params.profileId);
                return null;

            case 'command.list':
                return this.#appController.getState().settings.advancedVcpCommands;

            case 'command.execute':
                return toPublicVcpResult(await this.#appController.executeAdvancedVcpCommand(request.params.commandId));

            case 'vcp.capabilities':
                return this.#appController.getMonitorCapabilities(request.params.monitorId);

            case 'vcp.read':
                return this.#appController.getMonitorVcpValues(request.params.monitorId, request.params.codes);

            case 'vcp.write':
                return toPublicVcpResult(
                    await this.#appController.executeAdvancedVcp({
                        monitorId: request.params.monitorId,
                        action: {
                            type: 'write',
                            code: request.params.code,
                            value: request.params.value,
                        },
                    }),
                );

            case 'vcp.adjust':
                return toPublicVcpResult(
                    await this.#appController.executeAdvancedVcp({
                        monitorId: request.params.monitorId,
                        action: {
                            type: 'adjust-percent',
                            code: request.params.code,
                            direction: request.params.direction,
                            percent: request.params.percent,
                        },
                    }),
                );

            case 'app.setTheme':
                await this.#appController.setTheme(request.params.theme);
                return null;

            case 'app.setLogEnabled':
                await this.#appController.setLogEnabled(request.params.enabled);
                return null;
        }
    }
}

function parseRequest(value: unknown): PublicApiRequest {
    if (!isRecord(value) || typeof value.method !== 'string') {
        throw new PublicApiFault('INVALID_REQUEST', 'API 请求必须是包含 method 字段的 JSON 对象');
    }

    const { method } = value;

    switch (method) {
        case 'system.ping':
        case 'state.get':
        case 'monitor.list':
        case 'monitor.refresh':
        case 'auto.applyNow':
        case 'schedule.list':
        case 'command.list':
            assertNoParams(value.params);
            return { method };

        case 'monitor.set': {
            const params = getParams(value.params);
            const monitorId = getNonEmptyString(params, 'monitorId');
            const brightness = getOptionalPercentage(params, 'brightness');
            const contrast = getOptionalPercentage(params, 'contrast');

            if (brightness === undefined && contrast === undefined) {
                throw invalidParams('monitor.set 至少需要 brightness 或 contrast');
            }

            return {
                method,
                params: {
                    monitorId,
                    ...(brightness !== undefined ? { brightness } : {}),
                    ...(contrast !== undefined ? { contrast } : {}),
                },
            };
        }

        case 'auto.setEnabled': {
            const params = getParams(value.params);
            return { method, params: { enabled: getBoolean(params, 'enabled') } };
        }

        case 'auto.setInterval': {
            const params = getParams(value.params);
            return { method, params: { intervalMinutes: getIntervalMinutes(params, 'intervalMinutes') } };
        }

        case 'auto.setTarget': {
            const params = getParams(value.params);
            return { method, params: { monitorId: getNonEmptyString(params, 'monitorId') } };
        }

        case 'schedule.activate': {
            const params = getParams(value.params);
            return { method, params: { profileId: getNonEmptyString(params, 'profileId') } };
        }

        case 'command.execute': {
            const params = getParams(value.params);
            return { method, params: { commandId: getNonEmptyString(params, 'commandId') } };
        }

        case 'vcp.capabilities': {
            const params = getParams(value.params);
            return { method, params: { monitorId: getNonEmptyString(params, 'monitorId') } };
        }

        case 'vcp.read': {
            const params = getParams(value.params);
            const codes = params.codes;

            if (!Array.isArray(codes) || codes.length === 0) {
                throw invalidParams('codes 必须是至少包含一个 VCP Code 的数组');
            }

            return {
                method,
                params: {
                    monitorId: getNonEmptyString(params, 'monitorId'),
                    codes: codes.map((code) => getVcpCode(code)),
                },
            };
        }

        case 'vcp.write': {
            const params = getParams(value.params);
            return {
                method,
                params: {
                    monitorId: getNonEmptyString(params, 'monitorId'),
                    code: getVcpCode(params.code),
                    value: getUint32(params.value, 'value'),
                },
            };
        }

        case 'vcp.adjust': {
            const params = getParams(value.params);
            const direction = params.direction;
            const percent = getFiniteNumber(params, 'percent');

            if (direction !== 'increase' && direction !== 'decrease') {
                throw invalidParams('direction 必须是 increase 或 decrease');
            }
            if (percent <= 0) {
                throw invalidParams('percent 必须是大于 0 的有限数值');
            }

            return {
                method,
                params: {
                    monitorId: getNonEmptyString(params, 'monitorId'),
                    code: getVcpCode(params.code),
                    direction,
                    percent,
                },
            };
        }

        case 'app.setTheme': {
            const params = getParams(value.params);
            const theme = params.theme;

            if (theme !== 'light' && theme !== 'dark') {
                throw invalidParams('theme 必须是 light 或 dark');
            }

            return { method, params: { theme } };
        }

        case 'app.setLogEnabled': {
            const params = getParams(value.params);
            return { method, params: { enabled: getBoolean(params, 'enabled') } };
        }

        default:
            throw new PublicApiFault('METHOD_NOT_FOUND', `不支持的 API 方法：${method}`);
    }
}

function assertNoParams(value: unknown): void {
    if (value === undefined) {
        return;
    }

    if (!isRecord(value) || Object.keys(value).length > 0) {
        throw invalidParams('该 API 方法不接受 params');
    }
}

function getParams(value: unknown): Record<string, unknown> {
    if (!isRecord(value)) {
        throw invalidParams('params 必须是 JSON 对象');
    }
    return value;
}

function getNonEmptyString(params: Record<string, unknown>, key: string): string {
    const value = params[key];

    if (typeof value !== 'string' || value.length === 0) {
        throw invalidParams(`${key} 必须是非空字符串`);
    }

    return value;
}

function getBoolean(params: Record<string, unknown>, key: string): boolean {
    const value = params[key];

    if (typeof value !== 'boolean') {
        throw invalidParams(`${key} 必须是布尔值`);
    }

    return value;
}

function getFiniteNumber(params: Record<string, unknown>, key: string): number {
    const value = params[key];

    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw invalidParams(`${key} 必须是有限数值`);
    }

    return value;
}

function getOptionalPercentage(params: Record<string, unknown>, key: string): number | undefined {
    if (!(key in params)) {
        return undefined;
    }

    const value = getFiniteNumber(params, key);

    if (value < 0 || value > 100) {
        throw invalidParams(`${key} 必须位于 0 到 100`);
    }

    return value;
}

function getIntervalMinutes(params: Record<string, unknown>, key: string): IntervalMinutes {
    const value = getFiniteNumber(params, key);

    if (!INTERVAL_MINUTES_OPTIONS.some((interval) => interval === value)) {
        throw invalidParams(`${key} 必须是 ${INTERVAL_MINUTES_OPTIONS.join('、')} 分钟之一`);
    }

    return value as IntervalMinutes;
}

function getVcpCode(value: unknown): number {
    if (typeof value !== 'number') {
        throw invalidParams('VCP Code 必须是数值');
    }

    try {
        assertVcpCode(value);
        return value;
    } catch (error) {
        throw invalidParams(toErrorMessage(error));
    }
}

function getUint32(value: unknown, name: string): number {
    if (typeof value !== 'number') {
        throw invalidParams(`${name} 必须是数值`);
    }

    try {
        assertUint32(value, name);
        return value;
    } catch (error) {
        throw invalidParams(toErrorMessage(error));
    }
}

function toPublicVcpResult(outcome: AdvancedVcpExecutionOutcome) {
    const { closeWebViewAfter: _closeWebViewAfter, ...result } = outcome;
    return result;
}

function invalidParams(message: string): PublicApiFault {
    return new PublicApiFault('INVALID_PARAMS', message);
}

class PublicApiFault extends Error {
    readonly code: PublicApiErrorCode;

    constructor(code: PublicApiErrorCode, message: string) {
        super(message);
        this.code = code;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
