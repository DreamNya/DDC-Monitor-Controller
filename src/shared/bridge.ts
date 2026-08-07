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
    refreshMonitors(): Promise<null>;
    applyManual(request: ManualApplyRequest): Promise<null>;
    applyLive(request: LiveApplyRequest): Promise<null>;
    applyAutoNow(): Promise<null>;
    tryPowerOff(options: { monitorId: MonitorTarget }): Promise<null>;
    setAutoInterval(options: { intervalMinutes: IntervalMinutes | null }): Promise<null>;
    setLogEnabled(options: { enabled: boolean }): Promise<null>;
    setTargetMonitor(options: { monitorId: MonitorTarget }): Promise<null>;
    setUiScale(options: { target: UiScaleTarget; percent: UiScalePercent }): Promise<null>;
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
