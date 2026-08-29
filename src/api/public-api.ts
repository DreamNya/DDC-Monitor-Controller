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

export const PUBLIC_API_VERSION = 1 as const;

export type PublicApiMethod =
    | 'system.ping'
    | 'state.get'
    | 'monitor.list'
    | 'monitor.refresh'
    | 'monitor.set'
    | 'auto.setEnabled'
    | 'auto.setInterval'
    | 'auto.setTarget'
    | 'auto.applyNow'
    | 'schedule.list'
    | 'schedule.activate'
    | 'command.list'
    | 'command.execute'
    | 'vcp.capabilities'
    | 'vcp.read'
    | 'vcp.write'
    | 'vcp.adjust'
    | 'app.setTheme'
    | 'app.setLogEnabled';

export type PublicApiRequest =
    | { method: 'system.ping'; params?: never }
    | { method: 'state.get'; params?: never }
    | { method: 'monitor.list'; params?: never }
    | { method: 'monitor.refresh'; params?: never }
    | {
          method: 'monitor.set';
          params: {
              monitorId: string;
              brightness?: number;
              contrast?: number;
          };
      }
    | { method: 'auto.setEnabled'; params: { enabled: boolean } }
    | { method: 'auto.setInterval'; params: { intervalMinutes: IntervalMinutes } }
    | { method: 'auto.setTarget'; params: { monitorId: string } }
    | { method: 'auto.applyNow'; params?: never }
    | { method: 'schedule.list'; params?: never }
    | { method: 'schedule.activate'; params: { profileId: string } }
    | { method: 'command.list'; params?: never }
    | { method: 'command.execute'; params: { commandId: string } }
    | { method: 'vcp.capabilities'; params: { monitorId: string } }
    | { method: 'vcp.read'; params: { monitorId: string; codes: number[] } }
    | { method: 'vcp.write'; params: { monitorId: string; code: number; value: number } }
    | {
          method: 'vcp.adjust';
          params: {
              monitorId: string;
              code: number;
              direction: 'increase' | 'decrease';
              percent: number;
          };
      }
    | { method: 'app.setTheme'; params: { theme: 'light' | 'dark' } }
    | { method: 'app.setLogEnabled'; params: { enabled: boolean } };

export interface PublicApiResultMap {
    'system.ping': {
        apiVersion: typeof PUBLIC_API_VERSION;
    };
    'state.get': AppState;
    'monitor.list': MonitorSnapshot[];
    'monitor.refresh': null;
    'monitor.set': null;
    'auto.setEnabled': null;
    'auto.setInterval': null;
    'auto.setTarget': null;
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
    'app.setTheme': null;
    'app.setLogEnabled': null;
}

export type PublicApiResult<M extends PublicApiMethod = PublicApiMethod> = PublicApiResultMap[M];

export type PublicApiErrorCode = 'INVALID_REQUEST' | 'METHOD_NOT_FOUND' | 'INVALID_PARAMS' | 'EXECUTION_FAILED';

export interface PublicApiError {
    code: PublicApiErrorCode;
    message: string;
}

export type PublicApiResponse<T = unknown> =
    | {
          ok: true;
          result: T;
      }
    | {
          ok: false;
          error: PublicApiError;
      };
