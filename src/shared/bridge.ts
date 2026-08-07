import type {
    AppState,
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
 * @webviewjs/webview 会把这些方法注入到 window.monitor；页面侧调用时，
 * 所有函数都返回 Promise
 */
export interface MonitorBridge {
    getState(): Promise<AppState>;
    refreshMonitors(): Promise<AppState>;
    applyManual(request: ManualApplyRequest): Promise<AppState>;
    applyLive(request: LiveApplyRequest): Promise<AppState>;
    applyAutoNow(): Promise<AppState>;
    setAutoInterval(options: { intervalMinutes: IntervalMinutes | null }): Promise<AppState>;
    setLogEnabled(options: { enabled: boolean }): Promise<AppState>;
    setTargetMonitor(options: { monitorId: MonitorTarget }): Promise<AppState>;
    setUiScale(options: { target: UiScaleTarget; percent: UiScalePercent }): Promise<AppState>;
    setActiveScheduleProfile(options: { profileId: string }): Promise<AppState>;
    createScheduleProfile(options: { name: string; schedule: SchedulePoint[] }): Promise<AppState>;
    renameScheduleProfile(options: { profileId: string; name: string }): Promise<AppState>;
    deleteScheduleProfile(options: { profileId: string }): Promise<AppState>;
    saveSchedule(options: { profileId: string; schedule: SchedulePoint[] }): Promise<AppState>;
    resetSettings(): Promise<AppState>;
    startControlWindowDrag(): Promise<null>;
    openControlPanel(): Promise<null>;
    closePanel(): Promise<null>;
}
