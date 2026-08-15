export const INTERVAL_MINUTES_OPTIONS = [10, 15, 20, 30, 60] as const;

export const MAX_SCHEDULE_PROFILE_NAME_LENGTH = 40;

export type IntervalMinutes = (typeof INTERVAL_MINUTES_OPTIONS)[number];

export interface SchedulePoint {
    /** 从当天 00:00 起经过的小时数，允许小数，例如 8.5 表示 08:30 */
    time: number;
    brightness: number;
    contrast: number;
}

/** 一套可独立保存和切换的自动调节时间方案 */
export interface ScheduleProfile {
    id: string;
    name: string;
    schedule: SchedulePoint[];
}

export interface MonitorValues {
    brightness: number;
    contrast: number;
}

export interface MonitorSnapshot {
    id: string;
    index: number;
    name: string;
    brightness: number | null;
    contrast: number | null;
    error?: string;
}

/** 显示器标识；保留字符串 `all` 表示全部显示器 */
export type MonitorTarget = string;

export type UiScaleTarget = 'quick' | 'control';

export type UiScalePercent = number;

export type UiScaleSettings = Record<UiScaleTarget, UiScalePercent>;

export type FontSizeTarget = 'default' | 'hint';

export type FontSizePx = number;

export type FontSizeSettings = Record<FontSizeTarget, FontSizePx>;

export interface ControlWindowBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface AppSettings {
    autoEnabled: boolean;
    logEnabled: boolean;
    intervalMinutes: IntervalMinutes;
    targetMonitorId: MonitorTarget;
    uiScale: UiScaleSettings;
    fontSize: FontSizeSettings;
    activeScheduleProfileId: string;
    scheduleProfiles: ScheduleProfile[];
    controlWindowBounds: ControlWindowBounds | null;
}

export interface AppState {
    settings: AppSettings;
    monitors: MonitorSnapshot[];
    calculatedValues: MonitorValues;
    nextRunAt: string | null;
    lastOperation: string;
    lastError: string | null;
}

export type AppStateChangeReason =
    | 'initialize'
    | 'refresh-monitors'
    | 'apply-manual'
    | 'apply-live'
    | 'apply-auto'
    | 'update-settings'
    | 'update-schedule';

/** 主进程向所有界面广播的唯一状态变更消息 */
export interface AppStateChange {
    state: AppState;
    reason: AppStateChangeReason;
}

export interface ManualApplyRequest {
    monitorId: MonitorTarget;
    brightness: number;
    contrast: number;
}

/** 实时调节请求；只携带本次实际发生变化的 VCP 值 */
export interface LiveApplyRequest {
    monitorId: MonitorTarget;
    brightness?: number;
    contrast?: number;
}
