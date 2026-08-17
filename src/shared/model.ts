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

/** Capabilities String 中声明的单个 VCP Code */
export interface VcpCapability {
    code: number;
    /** 非连续型 VCP 声明的支持值；未声明时为 null */
    supportedValues: number[] | null;
}

/** 单台显示器的 DDC/CI Capabilities 查询结果 */
export interface MonitorCapabilities {
    monitorId: string;
    monitorName: string;
    raw: string;
    vcpCodes: VcpCapability[];
}

/** 单个 VCP Code 的批量读取结果；失败项保留错误文本而不中断整批读取 */
export interface MonitorVcpReadResult {
    code: number;
    current: number | null;
    maximum: number | null;
    error?: string;
}

export type AdvancedVcpDirection = 'increase' | 'decrease';

/** 高级 VCP 页面可执行并可保存为快捷命令的原子操作 */
export type AdvancedVcpAction =
    | { type: 'adjust-percent'; code: number; direction: AdvancedVcpDirection; percent: number }
    | { type: 'write'; code: number; value: number }
    | { type: 'read'; code: number };

export interface AdvancedVcpExecuteRequest {
    monitorId: string;
    action: AdvancedVcpAction;
    /** 仅在写入成功后由界面层销毁当前 WebView */
    closeWebViewAfter?: boolean;
}

export interface AdvancedVcpExecutionResult {
    monitorId: string;
    code: number;
    operation: 'read' | 'write';
    current?: number;
    maximum?: number;
    previous?: number;
    value?: number;
}

export interface AdvancedVcpExecutionOutcome extends AdvancedVcpExecutionResult {
    closeWebViewAfter: boolean;
}

/** 持久化的高级 VCP 快捷命令；绑定到单个物理显示器标识 */
export interface AdvancedVcpShortcutCommand {
    id: string;
    name: string;
    monitorId: string;
    monitorName: string;
    action: AdvancedVcpAction;
    shortcut: string | null;
    closeWebViewAfter: boolean;
}

export interface AdvancedVcpShortcutDraft {
    name: string;
    monitorId: string;
    action: AdvancedVcpAction;
    shortcut: string | null;
    closeWebViewAfter?: boolean;
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
    theme: 'light' | 'dark';
    intervalMinutes: IntervalMinutes;
    targetMonitorId: MonitorTarget;
    uiScale: UiScaleSettings;
    fontSize: FontSizeSettings;
    activeScheduleProfileId: string;
    scheduleProfiles: ScheduleProfile[];
    controlWindowBounds: ControlWindowBounds | null;
    advancedVcpCommands: AdvancedVcpShortcutCommand[];
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
    | 'update-schedule'
    | 'execute-vcp-command';

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
