import type {
    AppSettings,
    AppState,
    ControlWindowBounds,
    IntervalMinutes,
    LiveApplyRequest,
    ManualApplyRequest,
    MonitorSnapshot,
    MonitorTarget,
    SchedulePoint,
    UiScalePercent,
    UiScaleTarget,
} from '../shared/model';
import { calculateAutoSettings } from '../shared/schedule';
import {
    createDefaultUiScaleSettings,
    isUiScalePercent,
    isUiScaleTarget,
    UI_SCALE_MAX_PERCENT,
    UI_SCALE_MIN_PERCENT,
    UI_SCALE_STEP_PERCENT,
} from '../shared/ui-scale';
import { AutoAdjustmentScheduler } from './services/auto-adjustment-scheduler';
import { DDCMonitorController } from './services/monitor-controller';
import { ScheduleProfileService } from './services/schedule-profile-service';
import { SettingsStore } from './services/settings-store';

interface ApplyAutoOptions {
    emit?: boolean;
    refreshCache?: boolean;
}

export class AppController {
    readonly #monitorController = new DDCMonitorController();
    readonly #settingsStore = new SettingsStore();
    readonly #scheduleProfiles = new ScheduleProfileService();
    readonly #autoScheduler: AutoAdjustmentScheduler;
    readonly #onLogEnabledChanged: (enabled: boolean) => void;

    #settings: AppSettings = this.#settingsStore.createDefault();
    #monitors: MonitorSnapshot[] = [];
    #lastOperation = '正在初始化';
    #lastError: string | null = null;
    #onStateChanged: ((state: AppState) => void) | undefined;
    #settingsSaveTail: Promise<void> = Promise.resolve();
    #disposePromise: Promise<void> | undefined;

    constructor(onLogEnabledChanged: (enabled: boolean) => void = () => undefined) {
        this.#onLogEnabledChanged = onLogEnabledChanged;
        this.#autoScheduler = new AutoAdjustmentScheduler({
            run: async () => {
                await this.applyAutoNow({ emit: false });
            },
            onCycleCompleted: () => this.#emitState(),
        });
    }

    setStateListener(listener: (state: AppState) => void): void {
        this.#onStateChanged = listener;
    }

    async initialize(): Promise<void> {
        this.#settings = await this.#settingsStore.load();
        this.#onLogEnabledChanged(this.#settings.logEnabled);
        await this.refreshMonitors(false);

        if (this.#settings.autoEnabled) {
            // 启动阶段刚完成刷新，直接复用这批缓存，避免连续读取两次
            await this.applyAutoNow({ emit: false, refreshCache: false });
            this.#autoScheduler.schedule(this.#settings.intervalMinutes);
        } else {
            this.#lastOperation = '自动调节已关闭';
        }

        this.#emitState();
    }

    async getState(refresh = false): Promise<AppState> {
        if (refresh) {
            await this.refreshMonitors(false);
        }

        return this.#buildState();
    }

    async setLogEnabled(enabled: boolean): Promise<AppState> {
        this.#settings.logEnabled = enabled;
        await this.#saveSettings();

        this.#onLogEnabledChanged(enabled);
        this.#lastOperation = enabled ? '文件日志已开启' : '文件日志已关闭';
        this.#lastError = null;

        return this.#finish(true);
    }

    getControlWindowBounds(): ControlWindowBounds | null {
        return this.#settings.controlWindowBounds ? structuredClone(this.#settings.controlWindowBounds) : null;
    }

    async saveControlWindowBounds(bounds: ControlWindowBounds): Promise<void> {
        this.#settings.controlWindowBounds = structuredClone(bounds);
        await this.#saveSettings();
    }

    async refreshMonitors(emit = true): Promise<AppState> {
        try {
            const targetReset = await this.#refreshMonitorCache();

            this.#lastOperation = targetReset
                ? `已检测到 ${this.#monitors.length} 台显示器；原目标不存在，已切换为全部显示器`
                : `已检测到 ${this.#monitors.length} 台显示器`;
            this.#lastError = null;
        } catch (error) {
            // 刷新失败时保留最后一份可用缓存，而不是把面板状态清空
            this.#monitors = this.#monitorController.getCachedSnapshots();
            this.#setError('检测显示器失败', error);
        }

        return this.#finish(emit);
    }

    async applyManual(request: ManualApplyRequest): Promise<AppState> {
        try {
            const result = await this.#monitorController.apply(request);
            this.#monitors = result.snapshots;
            this.#lastOperation = `已应用手动设置：亮度 ${result.brightness}，对比度 ${result.contrast}`;
            this.#lastError = null;
        } catch (error) {
            this.#monitors = this.#monitorController.getCachedSnapshots();
            this.#setError('应用手动设置失败', error);
        }

        return this.#finish(true);
    }

    async applyLive(request: LiveApplyRequest): Promise<AppState> {
        try {
            const result = await this.#monitorController.applyLive(request);
            this.#monitors = result.snapshots;

            const changes: string[] = [];

            if (result.brightness !== undefined) {
                changes.push(`亮度 ${result.brightness}`);
            }

            if (result.contrast !== undefined) {
                changes.push(`对比度 ${result.contrast}`);
            }

            this.#lastOperation = `已实时调节：${changes.join('，')}`;
            this.#lastError = null;
        } catch (error) {
            this.#monitors = this.#monitorController.getCachedSnapshots();
            this.#setError('实时调节失败', error);
        }

        return this.#finish(true);
    }

    async applyAutoNow(options: ApplyAutoOptions = {}): Promise<AppState> {
        const { emit = true, refreshCache = true } = options;
        const values = calculateAutoSettings(new Date(), this.#scheduleProfiles.getActive(this.#settings).schedule);

        try {
            if (refreshCache) {
                // 自动设置是低频操作，先读取实际状态，可修正物理按键或其他软件造成的缓存失真
                await this.#refreshMonitorCache();
            }

            const result = await this.#monitorController.apply({
                monitorId: this.#settings.targetMonitorId,
                ...values,
            });

            this.#monitors = result.snapshots;
            this.#lastOperation = `已应用自动设置：亮度 ${result.brightness}，对比度 ${result.contrast}`;
            this.#lastError = null;
        } catch (error) {
            this.#monitors = this.#monitorController.getCachedSnapshots();
            this.#setError('应用自动设置失败', error);
        }

        return this.#finish(emit);
    }

    setAutoEnabled(enabled: boolean): Promise<AppState> {
        return this.setAutoInterval(enabled ? this.#settings.intervalMinutes : null);
    }

    async setAutoInterval(intervalMinutes: IntervalMinutes | null): Promise<AppState> {
        const wasEnabled = this.#settings.autoEnabled;
        const previousInterval = this.#settings.intervalMinutes;

        if (intervalMinutes === null) {
            if (!wasEnabled) {
                return this.#finish(true);
            }

            this.#settings.autoEnabled = false;
            await this.#saveSettings();
            this.#autoScheduler.stop();
            this.#lastOperation = '自动调节已关闭';
            this.#lastError = null;

            return this.#finish(true);
        }

        if (wasEnabled && previousInterval === intervalMinutes) {
            return this.#finish(true);
        }

        this.#settings.autoEnabled = true;
        this.#settings.intervalMinutes = intervalMinutes;
        await this.#saveSettings();
        this.#autoScheduler.stop();

        if (!wasEnabled) {
            await this.applyAutoNow({ emit: false });

            if (this.#lastError === null) {
                this.#lastOperation = `自动调节已开启，每 ${intervalMinutes} 分钟运行；${this.#lastOperation}`;
            }
        } else {
            this.#lastOperation = `自动调节间隔已设置为 ${intervalMinutes} 分钟`;
            this.#lastError = null;
        }

        this.#autoScheduler.schedule(intervalMinutes);
        return this.#finish(true);
    }

    async setTargetMonitor(monitorId: MonitorTarget): Promise<AppState> {
        if (monitorId !== 'all' && !this.#monitors.some((monitor) => monitor.id === monitorId)) {
            throw new Error(`无法选择不存在的显示器：${monitorId}`);
        }

        this.#settings.targetMonitorId = monitorId;
        await this.#saveSettings();
        this.#lastOperation = monitorId === 'all' ? '目标已切换为全部显示器' : '目标显示器已更新';
        this.#lastError = null;

        return this.#finish(true);
    }

    async setUiScale(target: UiScaleTarget, percent: UiScalePercent): Promise<AppState> {
        if (!isUiScaleTarget(target)) {
            throw new RangeError(`不支持的 UI 缩放目标：${String(target)}`);
        }

        if (!isUiScalePercent(percent)) {
            throw new RangeError(
                `UI 缩放比例必须为 ${UI_SCALE_MIN_PERCENT}%–${UI_SCALE_MAX_PERCENT}%，` +
                    `且以 ${UI_SCALE_STEP_PERCENT}% 为步进：${String(percent)}`,
            );
        }

        if (this.#settings.uiScale[target] === percent) {
            return this.#finish(true);
        }

        this.#settings.uiScale[target] = percent;
        await this.#saveSettings();

        const targetName = target === 'quick' ? '快速设置面板' : '详细设置面板';
        this.#lastOperation = `${targetName} UI 缩放已设置为 ${percent}%`;
        this.#lastError = null;

        return this.#finish(true);
    }

    async resetUiScale(): Promise<AppState> {
        this.#settings.uiScale = createDefaultUiScaleSettings();
        await this.#saveSettings();

        this.#lastOperation = '快速设置面板和详细设置面板 UI 缩放已重置为 100%';
        this.#lastError = null;

        return this.#finish(true);
    }

    async setActiveScheduleProfile(profileId: string): Promise<AppState> {
        const profile = this.#scheduleProfiles.get(this.#settings, profileId);

        if (this.#settings.activeScheduleProfileId === profileId) {
            return this.#finish(true);
        }

        this.#settings.activeScheduleProfileId = profileId;
        await this.#saveSettings();
        this.#lastOperation = `已切换到定时方案“${profile.name}”`;
        this.#lastError = null;

        if (this.#settings.autoEnabled) {
            await this.applyAutoNow({ emit: false });
            this.#autoScheduler.schedule(this.#settings.intervalMinutes);

            if (this.#lastError === null) {
                this.#lastOperation = `已切换到定时方案“${profile.name}”并应用自动设置`;
            }
        }

        return this.#finish(true);
    }

    async createScheduleProfile(name: string, schedule: SchedulePoint[]): Promise<AppState> {
        const profile = this.#scheduleProfiles.create(this.#settings, name, schedule);

        await this.#saveSettings();
        this.#lastOperation = `已新建并切换到定时方案“${profile.name}”`;
        this.#lastError = null;

        if (this.#settings.autoEnabled) {
            await this.applyAutoNow({ emit: false });
            this.#autoScheduler.schedule(this.#settings.intervalMinutes);

            if (this.#lastError === null) {
                this.#lastOperation = `已新建定时方案“${profile.name}”并应用自动设置`;
            }
        }

        return this.#finish(true);
    }

    async renameScheduleProfile(profileId: string, name: string): Promise<AppState> {
        const profile = this.#scheduleProfiles.rename(this.#settings, profileId, name);

        await this.#saveSettings();
        this.#lastOperation = `定时方案已重命名为“${profile.name}”`;
        this.#lastError = null;

        return this.#finish(true);
    }

    async deleteScheduleProfile(profileId: string): Promise<AppState> {
        const { profile, activeProfileDeleted } = this.#scheduleProfiles.delete(this.#settings, profileId);

        await this.#saveSettings();
        this.#lastOperation = `已删除定时方案“${profile.name}”`;
        this.#lastError = null;

        if (activeProfileDeleted && this.#settings.autoEnabled) {
            await this.applyAutoNow({ emit: false });
            this.#autoScheduler.schedule(this.#settings.intervalMinutes);

            if (this.#lastError === null) {
                const activeProfile = this.#scheduleProfiles.getActive(this.#settings);
                this.#lastOperation = `已删除定时方案“${profile.name}”并切换到“${activeProfile.name}”`;
            }
        }

        return this.#finish(true);
    }

    async saveSchedule(profileId: string, schedule: SchedulePoint[]): Promise<AppState> {
        const profile = this.#scheduleProfiles.save(this.#settings, profileId, schedule);

        await this.#saveSettings();
        this.#lastOperation = `定时方案“${profile.name}”已保存`;
        this.#lastError = null;

        if (this.#settings.autoEnabled && this.#settings.activeScheduleProfileId === profileId) {
            await this.applyAutoNow({ emit: false });
            this.#autoScheduler.schedule(this.#settings.intervalMinutes);

            if (this.#lastError === null) {
                this.#lastOperation = `定时方案“${profile.name}”已保存并应用`;
            }
        }

        return this.#finish(true);
    }

    async resetSettings(): Promise<AppState> {
        this.#autoScheduler.stop();
        this.#settings = this.#settingsStore.createDefault();
        await this.#saveSettings();
        this.#onLogEnabledChanged(this.#settings.logEnabled);
        this.#lastOperation = '已恢复默认配置';
        this.#lastError = null;

        await this.applyAutoNow({ emit: false });
        this.#autoScheduler.schedule(this.#settings.intervalMinutes);

        return this.#finish(true);
    }

    dispose(): Promise<void> {
        this.#disposePromise ??= this.#disposeResources();
        return this.#disposePromise;
    }

    async #disposeResources(): Promise<void> {
        this.#autoScheduler.dispose();
        this.#onStateChanged = undefined;

        const [settingsResult, monitorResult] = await Promise.allSettled([
            this.#settingsSaveTail,
            this.#monitorController.dispose(),
        ]);

        if (settingsResult.status === 'rejected') {
            console.warn('等待设置保存完成失败：', settingsResult.reason);
        }

        if (monitorResult.status === 'rejected') {
            throw monitorResult.reason;
        }
    }

    async #refreshMonitorCache(): Promise<boolean> {
        this.#monitors = await this.#monitorController.getSnapshots();

        if (
            this.#settings.targetMonitorId === 'all' ||
            this.#monitors.some(({ id }) => id === this.#settings.targetMonitorId)
        ) {
            return false;
        }

        this.#settings.targetMonitorId = 'all';
        await this.#saveSettings();
        return true;
    }

    #saveSettings(): Promise<void> {
        const snapshot = structuredClone(this.#settings);
        const save = this.#settingsSaveTail.then(() => this.#settingsStore.save(snapshot));

        this.#settingsSaveTail = save.catch(() => undefined);
        return save;
    }

    #setError(context: string, error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        this.#lastOperation = context;
        this.#lastError = message;
        console.error(`${context}:`, error);
    }

    #finish(emit: boolean): AppState {
        const state = this.#buildState();

        if (this.#settings.logEnabled) {
            console.log(`[操作] ${this.#lastOperation}；${this.#lastError ? `错误：${this.#lastError}` : ''} `);
        }

        if (emit) {
            this.#onStateChanged?.(state);
        }

        return state;
    }

    #emitState(): void {
        this.#onStateChanged?.(this.#buildState());
    }

    #buildState(): AppState {
        return {
            settings: structuredClone(this.#settings),
            monitors: structuredClone(this.#monitors),
            calculatedValues: calculateAutoSettings(
                new Date(),
                this.#scheduleProfiles.getActive(this.#settings).schedule,
            ),
            nextRunAt: this.#autoScheduler.nextRunAt,
            lastOperation: this.#lastOperation,
            lastError: this.#lastError,
        };
    }
}
