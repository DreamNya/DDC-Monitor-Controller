import type {
    AppState,
    FontSizePx,
    FontSizeTarget,
    IntervalMinutes,
    LiveApplyRequest,
    ManualApplyRequest,
    MonitorTarget,
    SchedulePoint,
    UiScalePercent,
    UiScaleTarget,
} from './model';

/**
 * WebView 页面可调用的 Node.js 后端接口
 *
 * Renderer 通过 WebView2 自带的 window.chrome.webview 建立 RPC；
 * 所有函数都通过 WebMessage 转发到 Node.js，并返回 Promise
 */
export interface MonitorBridge {
    getState(): Promise<AppState>;
    refreshMonitors(): Promise<null>;
    applyManual(request: ManualApplyRequest): Promise<null>;
    applyLive(request: LiveApplyRequest): Promise<null>;
    applyAutoNow(): Promise<null>;
    setAutoInterval(options: { intervalMinutes: IntervalMinutes | null }): Promise<null>;
    setLogEnabled(options: { enabled: boolean }): Promise<null>;
    openLogFolder(): Promise<null>;
    setTargetMonitor(options: { monitorId: MonitorTarget }): Promise<null>;
    setUiScale(options: { target: UiScaleTarget; percent: UiScalePercent }): Promise<null>;
    resetUiScale(): Promise<null>;
    setFontSize(options: { target: FontSizeTarget; pixels: FontSizePx }): Promise<null>;
    resetFontSize(): Promise<null>;
    setActiveScheduleProfile(options: { profileId: string }): Promise<null>;
    createScheduleProfile(options: { name: string; schedule: SchedulePoint[] }): Promise<null>;
    renameScheduleProfile(options: { profileId: string; name: string }): Promise<null>;
    deleteScheduleProfile(options: { profileId: string }): Promise<null>;
    saveSchedule(options: { profileId: string; schedule: SchedulePoint[] }): Promise<null>;
    resetSettings(): Promise<null>;
    startControlWindowDrag(): Promise<null>;
    openControlPanel(): Promise<null>;
    closePanel(): Promise<null>;
}
