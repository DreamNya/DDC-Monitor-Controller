import type {
    AppState,
    AppStateChange,
    AppStateChangeReason,
    ControlWindowBounds,
    IntervalMinutes,
    LiveApplyRequest,
    ManualApplyRequest,
    MonitorTarget,
    SchedulePoint,
    UiScalePercent,
    UiScaleTarget,
} from '../shared/model.ts';
import { calculateAutoSettings } from '../shared/schedule.ts';
import {
    createDefaultUiScaleSettings,
    isUiScalePercent,
    isUiScaleTarget,
    UI_SCALE_MAX_PERCENT,
    UI_SCALE_MIN_PERCENT,
    UI_SCALE_STEP_PERCENT,
} from '../shared/ui-scale.ts';
import { AppCommandQueue } from './app/app-command-queue.ts';
import { AppStateManager, type SettingsPersistence } from './app/app-state-manager.ts';
import { AutoAdjustmentScheduler, type AutoAdjustmentSchedulerOptions } from './services/auto-adjustment-scheduler.ts';
import { DDCMonitorController } from './services/monitor-controller.ts';
import {
    createScheduleProfile,
    deleteScheduleProfile,
    getActiveScheduleProfile,
    getScheduleProfile,
    renameScheduleProfile,
    saveScheduleProfile,
} from './services/schedule-profile.ts';
import { createDefaultSettings, SettingsStore } from './services/settings-store.ts';

type MonitorController = Pick<
    DDCMonitorController,
    'getSnapshots' | 'getCachedSnapshots' | 'apply' | 'applyLive' | 'dispose'
>;
type AutoScheduler = Pick<AutoAdjustmentScheduler, 'nextRunAt' | 'schedule' | 'stop' | 'dispose'>;

export interface AppControllerOptions {
    monitorController?: MonitorController;
    settingsStore?: SettingsPersistence;
    createAutoScheduler?: (options: AutoAdjustmentSchedulerOptions) => AutoScheduler;
    onLogEnabledChanged?: (enabled: boolean) => void;
}

export class AppController {
    readonly #monitorController: MonitorController;
    readonly #commands = new AppCommandQueue();
    readonly #state: AppStateManager;
    readonly #autoScheduler: AutoScheduler;
    readonly #onLogEnabledChanged: (enabled: boolean) => void;

    #disposePromise: Promise<void> | undefined;

    constructor(options: AppControllerOptions = {}) {
        this.#monitorController = options.monitorController ?? new DDCMonitorController();
        this.#onLogEnabledChanged = options.onLogEnabledChanged ?? (() => undefined);

        this.#state = new AppStateManager({
            settingsStore: options.settingsStore ?? new SettingsStore(),
            getMonitors: () => this.#monitorController.getCachedSnapshots(),
            getNextRunAt: () => this.#autoScheduler.nextRunAt,
        });

        const createAutoScheduler =
            options.createAutoScheduler ?? ((schedulerOptions) => new AutoAdjustmentScheduler(schedulerOptions));

        this.#autoScheduler = createAutoScheduler({
            run: () => this.#commands.run(() => this.#applyAuto()),
            // Scheduler 会先更新 nextRunAt，再触发本次唯一的状态广播
            onCycleCompleted: () => this.#state.publish('apply-auto'),
        });
    }

    setStateListener(listener: (change: AppStateChange) => void): void {
        this.#state.setListener(listener);
    }

    async initialize(): Promise<void> {
        await this.#state.load();
        this.#onLogEnabledChanged(this.#state.settings.logEnabled);
        await this.#refreshMonitors();

        if (this.#state.settings.autoEnabled) {
            // 启动阶段刚完成刷新，直接复用这批缓存，避免连续读取两次
            await this.#applyAuto(false);
            this.#autoScheduler.schedule(this.#state.settings.intervalMinutes);
        } else {
            this.#state.succeed('自动调节已关闭');
        }

        this.#state.publish('initialize');
    }

    getState(): AppState {
        return this.#state.getState();
    }

    setLogEnabled(enabled: boolean): Promise<void> {
        return this.#executeCommand(() => {
            if (this.#state.settings.logEnabled === enabled) {
                return null;
            }

            this.#state.commit((settings) => {
                settings.logEnabled = enabled;
            });

            this.#onLogEnabledChanged(enabled);
            this.#state.succeed(enabled ? '文件日志已开启' : '文件日志已关闭');
            return 'update-settings';
        });
    }

    getControlWindowBounds(): ControlWindowBounds | null {
        return this.#state.getControlWindowBounds();
    }

    saveControlWindowBounds(bounds: ControlWindowBounds): Promise<void> {
        return this.#commands.run(() => {
            this.#state.commit((settings) => {
                settings.controlWindowBounds = structuredClone(bounds);
            });
        });
    }

    refreshMonitors(): Promise<void> {
        return this.#executeCommand(async () => {
            await this.#refreshMonitors();
            return 'refresh-monitors' as const;
        });
    }

    applyManual(request: ManualApplyRequest): Promise<void> {
        return this.#executeCommand(async () => {
            await this.#attempt(
                '应用手动设置失败',
                () => this.#monitorController.apply(request),
                (result) => `已应用手动设置：亮度 ${result.brightness}，对比度 ${result.contrast}`,
            );
            return 'apply-manual' as const;
        });
    }

    applyLive(request: LiveApplyRequest): Promise<void> {
        return this.#executeCommand(async () => {
            await this.#attempt('实时调节失败', () => this.#monitorController.applyLive(request), (result) => {
                const changes: string[] = [];

                if (result.brightness !== undefined) {
                    changes.push(`亮度 ${result.brightness}`);
                }

                if (result.contrast !== undefined) {
                    changes.push(`对比度 ${result.contrast}`);
                }

                return `已实时调节：${changes.join('，')}`;
            });
            return 'apply-live' as const;
        });
    }

    applyAutoNow(): Promise<void> {
        return this.#executeCommand(async () => {
            await this.#applyAuto();
            return 'apply-auto' as const;
        });
    }

    setAutoEnabled(enabled: boolean): Promise<void> {
        return this.#executeCommand(() => {
            return this.#setAutoInterval(enabled ? this.#state.settings.intervalMinutes : null);
        });
    }

    setAutoInterval(intervalMinutes: IntervalMinutes | null): Promise<void> {
        return this.#executeCommand(() => this.#setAutoInterval(intervalMinutes));
    }

    setTargetMonitor(monitorId: MonitorTarget): Promise<void> {
        return this.#executeCommand(() => {
            const monitors = this.#monitorController.getCachedSnapshots();

            if (monitorId !== 'all' && !monitors.some((monitor) => monitor.id === monitorId)) {
                throw new Error(`无法选择不存在的显示器：${monitorId}`);
            }

            if (this.#state.settings.targetMonitorId === monitorId) {
                return null;
            }

            this.#state.commit((settings) => {
                settings.targetMonitorId = monitorId;
            });
            this.#state.succeed(monitorId === 'all' ? '目标已切换为全部显示器' : '目标显示器已更新');
            return 'update-settings';
        });
    }

    setUiScale(target: UiScaleTarget, percent: UiScalePercent): Promise<void> {
        return this.#executeCommand(() => {
            if (!isUiScaleTarget(target)) {
                throw new RangeError(`不支持的 UI 缩放目标：${String(target)}`);
            }

            if (!isUiScalePercent(percent)) {
                throw new RangeError(
                    `UI 缩放比例必须为 ${UI_SCALE_MIN_PERCENT}%–${UI_SCALE_MAX_PERCENT}%，` +
                        `且以 ${UI_SCALE_STEP_PERCENT}% 为步进：${String(percent)}`,
                );
            }

            if (this.#state.settings.uiScale[target] === percent) {
                return null;
            }

            this.#state.commit((settings) => {
                settings.uiScale[target] = percent;
            });

            const targetName = target === 'quick' ? '快速设置面板' : '详细设置面板';
            this.#state.succeed(`${targetName} UI 缩放已设置为 ${percent}%`);
            return 'update-settings';
        });
    }

    resetUiScale(): Promise<void> {
        return this.#executeCommand(() => {
            this.#state.commit((settings) => {
                settings.uiScale = createDefaultUiScaleSettings();
            });
            this.#state.succeed('快速设置面板和详细设置面板 UI 缩放已重置为 100%');
            return 'update-settings';
        });
    }

    setActiveScheduleProfile(profileId: string): Promise<void> {
        return this.#executeCommand(async () => {
            const profile = getScheduleProfile(this.#state.settings, profileId);

            if (this.#state.settings.activeScheduleProfileId === profileId) {
                return null;
            }

            this.#state.commit((settings) => {
                settings.activeScheduleProfileId = profileId;
            });
            this.#state.succeed(`已切换到定时方案“${profile.name}”`);

            return this.#reapplyScheduleIfNeeded(true, `已切换到定时方案“${profile.name}”并应用自动设置`);
        });
    }

    createScheduleProfile(name: string, schedule: SchedulePoint[]): Promise<void> {
        return this.#executeCommand(async () => {
            const profile = this.#state.commit((settings) => createScheduleProfile(settings, name, schedule));
            this.#state.succeed(`已新建并切换到定时方案“${profile.name}”`);

            return this.#reapplyScheduleIfNeeded(true, `已新建定时方案“${profile.name}”并应用自动设置`);
        });
    }

    renameScheduleProfile(profileId: string, name: string): Promise<void> {
        return this.#executeCommand(() => {
            const profile = this.#state.commit((settings) => renameScheduleProfile(settings, profileId, name));
            this.#state.succeed(`定时方案已重命名为“${profile.name}”`);
            return 'update-schedule';
        });
    }

    deleteScheduleProfile(profileId: string): Promise<void> {
        return this.#executeCommand(async () => {
            const { profile, activeProfileDeleted } = this.#state.commit((settings) => {
                return deleteScheduleProfile(settings, profileId);
            });
            this.#state.succeed(`已删除定时方案“${profile.name}”`);

            const activeProfile = getActiveScheduleProfile(this.#state.settings);
            return this.#reapplyScheduleIfNeeded(
                activeProfileDeleted,
                `已删除定时方案“${profile.name}”并切换到“${activeProfile.name}”`,
            );
        });
    }

    saveSchedule(profileId: string, schedule: SchedulePoint[]): Promise<void> {
        return this.#executeCommand(async () => {
            const profile = this.#state.commit((settings) => saveScheduleProfile(settings, profileId, schedule));
            this.#state.succeed(`定时方案“${profile.name}”已保存`);

            return this.#reapplyScheduleIfNeeded(
                this.#state.settings.activeScheduleProfileId === profileId,
                `定时方案“${profile.name}”已保存并应用`,
            );
        });
    }

    resetSettings(): Promise<void> {
        return this.#executeCommand(async () => {
            this.#autoScheduler.stop();
            this.#state.replace(createDefaultSettings());
            this.#onLogEnabledChanged(this.#state.settings.logEnabled);
            this.#state.succeed('已恢复默认配置');

            let reason: AppStateChangeReason = 'update-settings';

            if (this.#state.settings.autoEnabled) {
                await this.#applyAuto();
                this.#autoScheduler.schedule(this.#state.settings.intervalMinutes);
                reason = 'apply-auto';

                if (this.#state.lastError === null) {
                    this.#state.setOperation('已恢复默认配置并应用自动设置');
                }
            }

            return reason;
        });
    }

    dispose(): Promise<void> {
        this.#disposePromise ??= this.#disposeResources();
        return this.#disposePromise;
    }

    async #disposeResources(): Promise<void> {
        this.#autoScheduler.dispose();
        this.#state.clearListener();

        // 等待已经进入应用级队列的操作结束，再落盘并释放原生显示器句柄
        await this.#commands.close();

        const [settingsResult, monitorResult] = await Promise.allSettled([
            this.#state.dispose(),
            this.#monitorController.dispose(),
        ]);

        if (settingsResult.status === 'rejected') {
            console.error('退出前写入最后一份配置失败：', settingsResult.reason);
        }

        if (monitorResult.status === 'rejected') {
            throw monitorResult.reason;
        }
    }

    async #setAutoInterval(intervalMinutes: IntervalMinutes | null): Promise<AppStateChangeReason | null> {
        const wasEnabled = this.#state.settings.autoEnabled;
        const previousInterval = this.#state.settings.intervalMinutes;

        if (intervalMinutes === null) {
            if (!wasEnabled) {
                return null;
            }

            this.#state.commit((settings) => {
                settings.autoEnabled = false;
            });
            this.#autoScheduler.stop();
            this.#state.succeed('自动调节已关闭');
            return 'update-settings';
        }

        if (wasEnabled && previousInterval === intervalMinutes) {
            return null;
        }

        this.#state.commit((settings) => {
            settings.autoEnabled = true;
            settings.intervalMinutes = intervalMinutes;
        });
        this.#autoScheduler.stop();

        let reason: AppStateChangeReason = 'update-settings';

        if (!wasEnabled) {
            await this.#applyAuto();
            reason = 'apply-auto';

            if (this.#state.lastError === null) {
                this.#state.setOperation(`自动调节已开启，每 ${intervalMinutes} 分钟运行；${this.#state.lastOperation}`);
            }
        } else {
            this.#state.succeed(`自动调节间隔已设置为 ${intervalMinutes} 分钟`);
        }

        this.#autoScheduler.schedule(intervalMinutes);
        return reason;
    }

    async #refreshMonitors(): Promise<void> {
        try {
            const targetReset = await this.#refreshMonitorCache();
            const monitorCount = this.#monitorController.getCachedSnapshots().length;

            this.#state.succeed(
                targetReset
                    ? `已检测到 ${monitorCount} 台显示器；原目标不存在，已切换为全部显示器`
                    : `已检测到 ${monitorCount} 台显示器`,
            );
        } catch (error) {
            // DDCMonitorController 会保留最后一份可用缓存，因此这里只更新错误状态
            this.#state.setError('检测显示器失败', error);
        }
    }

    async #applyAuto(refreshCache = true): Promise<void> {
        const values = calculateAutoSettings(new Date(), getActiveScheduleProfile(this.#state.settings).schedule);

        try {
            if (refreshCache) {
                // 自动设置是低频操作，先读取实际状态，可修正物理按键或其他软件造成的缓存失真
                await this.#refreshMonitorCache();
            }

            const result = await this.#monitorController.apply({
                monitorId: this.#state.settings.targetMonitorId,
                ...values,
            });

            this.#state.succeed(`已应用自动设置：亮度 ${result.brightness}，对比度 ${result.contrast}`);
        } catch (error) {
            this.#state.setError('应用自动设置失败', error);
        }
    }

    async #reapplyScheduleIfNeeded(
        scheduleAffectsActiveProfile: boolean,
        successMessage: string,
    ): Promise<AppStateChangeReason> {
        if (!scheduleAffectsActiveProfile || !this.#state.settings.autoEnabled) {
            return 'update-schedule';
        }

        await this.#applyAuto();
        this.#autoScheduler.schedule(this.#state.settings.intervalMinutes);

        if (this.#state.lastError === null) {
            this.#state.setOperation(successMessage);
        }

        return 'apply-auto' as const;
    }

    async #refreshMonitorCache(): Promise<boolean> {
        const monitors = await this.#monitorController.getSnapshots();

        if (
            this.#state.settings.targetMonitorId === 'all' ||
            monitors.some(({ id }) => id === this.#state.settings.targetMonitorId)
        ) {
            return false;
        }

        this.#state.commit((settings) => {
            settings.targetMonitorId = 'all';
        });
        return true;
    }

    #executeCommand<T extends AppStateChangeReason | null>(operation: () => T | Promise<T>): Promise<void> {
        return this.#commands.run(async () => {
            const reason = await operation();

            if (reason) {
                this.#state.publish(reason);
            }
        });
    }

    async #attempt<T>(
        context: string,
        operation: () => T | Promise<T>,
        successMessage: (result: T) => string,
    ): Promise<void> {
        try {
            const result = await operation();
            this.#state.succeed(successMessage(result));
        } catch (error) {
            this.#state.setError(context, error);
        }
    }
}
