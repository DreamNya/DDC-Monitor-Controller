import type {
    AdvancedVcpExecutionResult,
    AdvancedVcpShortcutCommand,
    AppState,
    IntervalMinutes,
    MonitorCapabilities,
    MonitorSnapshot,
    MonitorVcpReadResult,
    ScheduleProfile,
} from '../shared/model.ts';

export const PUBLIC_API_REQUEST_METHOD = '$request' as const;

export type PublicApiMethod =
    | 'state.get'
    | 'monitor.list'
    | 'monitor.target'
    | 'monitor.set'
    | 'auto.setEnabled'
    | 'auto.setInterval'
    | 'auto.applyNow'
    | 'schedule.list'
    | 'schedule.activate'
    | 'command.list'
    | 'command.execute'
    | 'vcp.capabilities'
    | 'vcp.read'
    | 'vcp.write'
    | 'vcp.adjust';

/** 高频操作的简写命令；高级 VCP 命令仅保留完整 method 名称 */
export type PublicApiAlias =
    'state' | 'monitor' | 'brightness' | 'contrast' | 'auto' | 'interval' | 'apply' | 'schedule';

/** batch 控制命令，单位为毫秒 */
export type PublicApiControlMethod = 'sleep';

export type PublicApiResponseMethod =
    PublicApiMethod | PublicApiAlias | PublicApiControlMethod | typeof PUBLIC_API_REQUEST_METHOD;

/** Dispatcher 内部使用的规范化业务请求 */
export type PublicApiRequest =
    | { method: 'state.get'; params?: never }
    | { method: 'monitor.list'; params?: never }
    | { method: 'monitor.target'; params: { monitorId: string } }
    | {
          method: 'monitor.set';
          params: {
              monitorId?: string;
              brightness?: number;
              contrast?: number;
          };
      }
    | { method: 'auto.setEnabled'; params: { enabled: boolean } }
    | { method: 'auto.setInterval'; params: { intervalMinutes: IntervalMinutes } }
    | { method: 'auto.applyNow'; params?: never }
    | { method: 'schedule.list'; params?: never }
    | { method: 'schedule.activate'; params: { profileId: string } }
    | { method: 'command.list'; params?: never }
    | { method: 'command.execute'; params: { commandId: string } }
    | { method: 'vcp.capabilities'; params: { monitorId?: string } }
    | { method: 'vcp.read'; params: { monitorId?: string; codes: number[] } }
    | { method: 'vcp.write'; params: { monitorId?: string; code: number; value: number } }
    | {
          method: 'vcp.adjust';
          params: {
              monitorId?: string;
              code: number;
              direction: 'increase' | 'decrease';
              percent: number;
          };
      };

export interface PublicApiMonitorSnapshot extends MonitorSnapshot {
    /** 当前 batch 中此显示器是否属于 monitor.target 选中的作用域 */
    active: boolean;
}

export interface PublicApiResultMap {
    'state.get': AppState;
    'monitor.list': PublicApiMonitorSnapshot[];
    'monitor.target': null;
    'monitor.set': null;
    'auto.setEnabled': null;
    'auto.setInterval': null;
    'auto.applyNow': null;
    'schedule.list': {
        activeProfileId: string;
        profiles: ScheduleProfile[];
    };
    'schedule.activate': null;
    'command.list': AdvancedVcpShortcutCommand[];
    'command.execute': AdvancedVcpExecutionResult;
    'vcp.capabilities': MonitorCapabilities;
    'vcp.read': MonitorVcpReadResult[];
    'vcp.write': AdvancedVcpExecutionResult;
    'vcp.adjust': AdvancedVcpExecutionResult;
}

export type PublicApiResult<M extends PublicApiMethod = PublicApiMethod> = PublicApiResultMap[M];

export type PublicApiErrorCode = 'INVALID_REQUEST' | 'METHOD_NOT_FOUND' | 'INVALID_PARAMS' | 'EXECUTION_FAILED';

export interface PublicApiError {
    code: PublicApiErrorCode;
    message: string;
}

export interface PublicApiMonitorValue {
    monitorId: string;
    monitorName: string;
    value: number | null;
}

export type PublicApiCommandResponse<T = unknown> =
    | {
          method: PublicApiResponseMethod;
          ok: true;
          result: T;
      }
    | {
          method: PublicApiResponseMethod;
          ok: false;
          error: PublicApiError;
      };

/**
 * 公开 API 始终返回数组，即使请求只包含一个命令
 * batch 运行时失败会保留此前成功项，并以失败项结束数组
 */
export type PublicApiResponse = PublicApiCommandResponse[];

export function isPublicApiResponseSuccessful(response: PublicApiResponse): boolean {
    return response.length > 0 && response.every((item) => item.ok);
}
