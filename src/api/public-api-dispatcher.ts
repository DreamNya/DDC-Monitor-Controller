import type { AppController } from '../main/app-controller.ts';
import type { AdvancedVcpExecutionOutcome, AppState } from '../shared/model.ts';
import {
    normalizePublicApiRequest,
    PublicApiValidationError,
    type NormalizedPublicApiCommand,
} from './public-api-normalizer.ts';
import {
    PUBLIC_API_REQUEST_METHOD,
    type PublicApiAlias,
    type PublicApiCommandResponse,
    type PublicApiErrorCode,
    type PublicApiMonitorValue,
    type PublicApiRequest,
    type PublicApiResponse,
    type PublicApiResponseMethod,
} from './public-api.ts';

interface PublicApiExecutionContext {
    monitorId: string;
}

type PublicApiController = Pick<
    AppController,
    | 'getState'
    | 'applyLive'
    | 'setAutoEnabled'
    | 'setAutoInterval'
    | 'applyAutoNow'
    | 'setActiveScheduleProfile'
    | 'executeAdvancedVcpCommand'
    | 'getMonitorCapabilities'
    | 'getMonitorVcpValues'
    | 'executeAdvancedVcp'
>;

export class PublicApiDispatcher {
    readonly #appController: PublicApiController;

    constructor(appController: PublicApiController) {
        this.#appController = appController;
    }

    /**
     * 先完整校验整个请求，再严格按顺序 await 执行
     * 运行时失败时保留此前已成功结果，不回滚，并停止执行后续命令
     */
    async execute(request: unknown): Promise<PublicApiResponse> {
        let commands: NormalizedPublicApiCommand[];

        try {
            commands = normalizePublicApiRequest(request);
        } catch (error) {
            return [toFailureResponse(error)];
        }

        const responses: PublicApiResponse = [];
        const context: PublicApiExecutionContext = {
            monitorId: this.#appController.getState().settings.targetMonitorId,
        };

        for (const command of commands) {
            try {
                responses.push({
                    method: command.sourceMethod,
                    ok: true,
                    result: await this.#executeCommand(command, context),
                });
            } catch (error) {
                responses.push(toFailureResponse(error, command.sourceMethod));
                break;
            }
        }

        return responses;
    }

    async #executeCommand(command: NormalizedPublicApiCommand, context: PublicApiExecutionContext): Promise<unknown> {
        switch (command.type) {
            case 'canonical':
                return this.#dispatch(command.request, context);

            case 'sleep':
                await sleep(command.milliseconds);
                return null;

            case 'alias':
                return this.#dispatchAlias(command.sourceMethod, command.value, context);
        }
    }

    async #dispatchAlias(method: PublicApiAlias, value: unknown, context: PublicApiExecutionContext) {
        switch (method) {
            case 'state':
                return this.#dispatch({ method: 'state.get' }, context);

            case 'monitor':
                if (value === null) {
                    return listMonitors(this.#appController.getState(), context.monitorId);
                }
                setExecutionMonitorTarget(context, this.#appController.getState(), value as string);
                return null;

            case 'brightness':
                if (value === null) {
                    return readTargetMonitorValues(this.#appController.getState(), context.monitorId, 'brightness');
                }
                return this.#dispatch(
                    {
                        method: 'monitor.set',
                        params: {
                            brightness: value as number,
                        },
                    },
                    context,
                );

            case 'contrast':
                if (value === null) {
                    return readTargetMonitorValues(this.#appController.getState(), context.monitorId, 'contrast');
                }
                return this.#dispatch(
                    {
                        method: 'monitor.set',
                        params: {
                            contrast: value as number,
                        },
                    },
                    context,
                );

            case 'auto':
                if (value === null) {
                    return this.#appController.getState().settings.autoEnabled;
                }
                return this.#dispatch({ method: 'auto.setEnabled', params: { enabled: value as boolean } }, context);

            case 'interval':
                if (value === null) {
                    return this.#appController.getState().settings.intervalMinutes;
                }
                return this.#dispatch(
                    {
                        method: 'auto.setInterval',
                        params: { intervalMinutes: value as AppState['settings']['intervalMinutes'] },
                    },
                    context,
                );

            case 'apply':
                return this.#dispatch({ method: 'auto.applyNow' }, context);

            case 'schedule':
                if (value === null) {
                    return this.#dispatch({ method: 'schedule.list' }, context);
                }
                return this.#dispatch({ method: 'schedule.activate', params: { profileId: value as string } }, context);
        }
    }

    async #dispatch(request: PublicApiRequest, context: PublicApiExecutionContext): Promise<unknown> {
        switch (request.method) {
            case 'state.get':
                return this.#appController.getState();

            case 'monitor.list':
                return listMonitors(this.#appController.getState(), context.monitorId);

            case 'monitor.target':
                setExecutionMonitorTarget(context, this.#appController.getState(), request.params.monitorId);
                return null;

            case 'monitor.set':
                await this.#appController.applyLive({
                    ...request.params,
                    monitorId: request.params.monitorId ?? context.monitorId,
                });
                return null;

            case 'auto.setEnabled':
                await this.#appController.setAutoEnabled(request.params.enabled);
                return null;

            case 'auto.setInterval':
                await this.#appController.setAutoInterval(request.params.intervalMinutes);
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
                return this.#appController.getMonitorCapabilities(request.params.monitorId ?? context.monitorId);

            case 'vcp.read':
                return this.#appController.getMonitorVcpValues(
                    request.params.monitorId ?? context.monitorId,
                    request.params.codes,
                );

            case 'vcp.write':
                return toPublicVcpResult(
                    await this.#appController.executeAdvancedVcp({
                        monitorId: request.params.monitorId ?? context.monitorId,
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
                        monitorId: request.params.monitorId ?? context.monitorId,
                        action: {
                            type: 'adjust-percent',
                            code: request.params.code,
                            direction: request.params.direction,
                            percent: request.params.percent,
                        },
                    }),
                );
        }
    }
}

function listMonitors(state: AppState, target: string) {
    return state.monitors.map((monitor) => ({
        ...monitor,
        active: target === 'all' || monitor.id === target,
    }));
}

function setExecutionMonitorTarget(context: PublicApiExecutionContext, state: AppState, monitorId: string): void {
    if (monitorId !== 'all' && !state.monitors.some((monitor) => monitor.id === monitorId)) {
        throw new Error(`无法选择不存在的显示器：${monitorId}`);
    }
    context.monitorId = monitorId;
}

function readTargetMonitorValues(
    state: AppState,
    target: string,
    property: 'brightness' | 'contrast',
): PublicApiMonitorValue[] {
    const monitors = target === 'all' ? state.monitors : state.monitors.filter((monitor) => monitor.id === target);

    if (target !== 'all' && monitors.length === 0) {
        throw new Error(`目标显示器当前不可用：${target}`);
    }

    return monitors.map((monitor) => ({
        monitorId: monitor.id,
        monitorName: monitor.name,
        value: monitor[property],
    }));
}

function sleep(milliseconds: number): Promise<void> {
    return new Promise((resolvePromise) => {
        setTimeout(resolvePromise, milliseconds);
    });
}

function toPublicVcpResult(outcome: AdvancedVcpExecutionOutcome) {
    const { closeWebViewAfter: _closeWebViewAfter, ...result } = outcome;
    return result;
}

function toFailureResponse(
    error: unknown,
    fallbackMethod: PublicApiResponseMethod = PUBLIC_API_REQUEST_METHOD,
): PublicApiCommandResponse {
    if (error instanceof PublicApiValidationError) {
        return {
            method: error.method,
            ok: false,
            error: {
                code: error.code,
                message: error.message,
            },
        };
    }

    return {
        method: fallbackMethod,
        ok: false,
        error: {
            code: 'EXECUTION_FAILED' satisfies PublicApiErrorCode,
            message: toErrorMessage(error),
        },
    };
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
