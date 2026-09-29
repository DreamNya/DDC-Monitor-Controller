import { randomUUID } from 'node:crypto';
import { assertExternalApiConfiguration, type ExternalApiConfiguration } from '../api/external-api-config.ts';
import { MAX_ADVANCED_VCP_COMMANDS, validateAdvancedVcpAction } from '../shared/advanced-vcp.ts';
import {
    createDefaultFontSizeSettings,
    FONT_SIZE_LIMITS,
    isFontSizePx,
    isFontSizeTarget,
} from '../shared/font-size.ts';
import { parseGlobalShortcut } from '../shared/global-shortcut.ts';
import type {
    AdvancedVcpExecuteRequest,
    AdvancedVcpExecutionOutcome,
    AdvancedVcpExecutionResult,
    AdvancedVcpShortcutCommand,
    AdvancedVcpShortcutDraft,
    AppState,
    AppStateChange,
    AppStateChangeReason,
    ControlWindowBounds,
    FontSizePx,
    FontSizeTarget,
    IntervalMinutes,
    LiveApplyRequest,
    ManualApplyRequest,
    MonitorCapabilities,
    MonitorGroupDraft,
    MonitorTarget,
    MonitorVcpReadResult,
    SchedulePoint,
    UiScalePercent,
    UiScaleTarget,
} from '../shared/model.ts';
import { validateMonitorGroup } from '../shared/monitor-group.ts';
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
    | 'getSnapshots'
    | 'getCachedSnapshots'
    | 'getCapabilities'
    | 'getVcpValues'
    | 'executeVcpAction'
    | 'apply'
    | 'applyLive'
    | 'dispose'
>;
type AutoScheduler = Pick<AutoAdjustmentScheduler, 'nextRunAt' | 'schedule' | 'stop' | 'dispose'>;
// TODO 自定义设置
const MONITOR_REFRESH_INTERVAL_MS = 60_000;

export type AppControllerInitializationMode = 'desktop' | 'command';

export interface AppControllerInitializeOptions {
    mode?: AppControllerInitializationMode;
}

export interface AppControllerOptions {
    monitorController?: MonitorController;
    settingsStore?: SettingsPersistence;
    createAutoScheduler?: (options: AutoAdjustmentSchedulerOptions) => AutoScheduler;
    onLogEnabledChanged?: (enabled: boolean) => void;
    setAutoStartRegistration?: (enabled: boolean) => Promise<void>;
    configureExternalApi?: (configuration: ExternalApiConfiguration) => Promise<void>;
    now?: () => number;
}

export class AppController {
    readonly #monitorController: MonitorController;
    readonly #commands = new AppCommandQueue();
    readonly #state: AppStateManager;
    readonly #autoScheduler: AutoScheduler;
    readonly #onLogEnabledChanged: (enabled: boolean) => void;
    readonly #setAutoStartRegistration: (enabled: boolean) => Promise<void>;
    readonly #configureExternalApi: (configuration: ExternalApiConfiguration) => Promise<void>;
    readonly #now: () => number;

    #disposePromise: Promise<void> | undefined;
    #lastMonitorRefreshAt: number | undefined;

    constructor(options: AppControllerOptions = {}) {
        this.#monitorController = options.monitorController ?? new DDCMonitorController();
        this.#onLogEnabledChanged = options.onLogEnabledChanged ?? (() => undefined);
        this.#setAutoStartRegistration =
            options.setAutoStartRegistration ??
            (async () => {
                throw new Error('当前运行环境不支持配置登录自动启动');
            });
        this.#configureExternalApi = options.configureExternalApi ?? (async () => undefined);
        this.#now = options.now ?? Date.now;

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

    async initialize(options: AppControllerInitializeOptions = {}): Promise<void> {
        const mode = options.mode ?? 'desktop';

        await this.#state.load();
        this.#onLogEnabledChanged(this.#state.settings.logEnabled);
        await this.#refreshMonitors();

        if (mode === 'desktop') {
            if (this.#state.settings.autoEnabled) {
                // 启动阶段刚完成刷新，直接复用这批缓存，避免连续读取两次
                await this.#applyAuto(false);
                this.#autoScheduler.schedule(this.#state.settings.intervalMinutes);
            } else {
                this.#state.succeed('自动调节已关闭');
            }
        }

        this.#state.publish('initialize');
    }

    getState(): AppState {
        return this.#state.getState();
    }

    setAutoStartEnabled(enabled: boolean): Promise<void> {
        return this.#executeCommand(async () => {
            if (this.#state.settings.autoStartEnabled === enabled) {
                return null;
            }

            // 只有外部计划任务操作成功后才更新 settings.json，避免 UI 状态提前变化
            await this.#setAutoStartRegistration(enabled);
            this.#state.commit((settings) => {
                settings.autoStartEnabled = enabled;
            });
            this.#state.succeed(enabled ? '已为当前用户启用登录自动启动' : '已关闭登录自动启动');
            return 'update-settings';
        });
    }

    setExternalApiConfiguration(configuration: ExternalApiConfiguration): Promise<void> {
        return this.#executeCommand(async () => {
            assertExternalApiConfiguration(configuration);

            // 先完成端口绑定/服务关闭，再提交设置，避免端口冲突时 settings.json 与实际监听状态不一致
            await this.#configureExternalApi(configuration);

            if (
                this.#state.settings.externalApiEnabled === configuration.enabled &&
                this.#state.settings.externalApiPort === configuration.port
            ) {
                return null;
            }

            this.#state.commit((settings) => {
                settings.externalApiEnabled = configuration.enabled;
                settings.externalApiPort = configuration.port;
            });

            this.#state.succeed(
                configuration.enabled ? `本地 API 已启用，监听端口 ${configuration.port}` : '本地 API 已关闭',
            );
            return 'update-settings';
        });
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

    setTheme(theme: AppState['settings']['theme']): Promise<void> {
        return this.#executeCommand(() => {
            if (theme !== 'light' && theme !== 'dark') {
                throw new RangeError(`不支持的界面主题：${String(theme)}`);
            }

            if (this.#state.settings.theme === theme) {
                return null;
            }

            this.#state.commit((settings) => {
                settings.theme = theme;
            });

            this.#state.succeed(theme === 'dark' ? '已切换为夜间主题' : '已切换为明亮主题');
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
            await this.#refreshMonitors(true);
            return 'refresh-monitors' as const;
        });
    }

    /** 面板打开等自动刷新场景共用一分钟内的显示器缓存 */
    refreshMonitorsIfStale(): Promise<void> {
        return this.#executeCommand(async () =>
            (await this.#refreshMonitors()) ? ('refresh-monitors' as const) : null,
        );
    }

    getMonitorCapabilities(monitorId: string): Promise<MonitorCapabilities> {
        return this.#commands.run(() => this.#monitorController.getCapabilities(monitorId));
    }

    getMonitorVcpValues(monitorId: string, codes: readonly number[]): Promise<MonitorVcpReadResult[]> {
        return this.#commands.run(() => this.#monitorController.getVcpValues(monitorId, codes));
    }

    executeAdvancedVcp(request: AdvancedVcpExecuteRequest): Promise<AdvancedVcpExecutionOutcome> {
        return this.#executeAdvancedVcpRequest(request, '执行高级 VCP 操作失败');
    }

    saveMonitorGroup(draft: MonitorGroupDraft): Promise<void> {
        return this.#executeCommand(() => {
            const existing = draft.id
                ? this.#state.settings.monitorGroups.find(({ id }) => id === draft.id)
                : undefined;
            if (draft.id && !existing) {
                throw new Error(`找不到显示器组：${draft.id}`);
            }
            const group = validateMonitorGroup({ ...draft, id: existing?.id ?? randomUUID() });
            if (
                this.#state.settings.monitorGroups.some(
                    ({ id, name }) => id !== group.id && name.toLocaleLowerCase() === group.name.toLocaleLowerCase(),
                )
            ) {
                throw new Error(`显示器组名称“${group.name}”已存在`);
            }
            const monitors = this.#monitorController.getCachedSnapshots();
            for (const monitorId of group.monitorIds) {
                // 已保存的成员可在离线时保留，新增成员必须具有唯一的在线身份。
                if (existing?.monitorIds.includes(monitorId)) {
                    continue;
                }
                if (monitors.filter(({ id }) => id === monitorId).length !== 1) {
                    throw new Error(`无法添加离线或身份不唯一的显示器：${monitorId}`);
                }
            }
            this.#state.commit((settings) => {
                settings.monitorGroups = existing
                    ? settings.monitorGroups.map((item) => (item.id === group.id ? group : item))
                    : [...settings.monitorGroups, group];
                for (const command of settings.advancedVcpCommands) {
                    if (command.monitorGroupId === group.id) {
                        command.monitorName = group.name;
                    }
                }
            });
            this.#state.succeed(`已保存显示器组“${group.name}”`);
            return 'update-settings';
        });
    }

    deleteMonitorGroup(groupId: string): Promise<void> {
        return this.#executeCommand(() => {
            const group = this.#getMonitorGroup(groupId);
            const commandCount = this.#state.settings.advancedVcpCommands.filter(
                (item) => item.monitorGroupId === groupId,
            ).length;
            this.#state.commit((settings) => {
                settings.monitorGroups = settings.monitorGroups.filter(({ id }) => id !== groupId);
                settings.advancedVcpCommands = settings.advancedVcpCommands.filter(
                    (item) => item.monitorGroupId !== groupId,
                );
            });
            this.#state.succeed(
                `已删除显示器组“${group.name}”${commandCount ? `及 ${commandCount} 个关联快捷命令` : ''}`,
            );
            return 'update-settings';
        });
    }

    saveAdvancedVcpCommand(draft: AdvancedVcpShortcutDraft): Promise<void> {
        return this.#executeCommand(() => {
            this.#validateAdvancedTarget(draft);
            const group = draft.monitorGroupId ? this.#getMonitorGroup(draft.monitorGroupId) : undefined;
            const matches = this.#monitorController.getCachedSnapshots().filter(({ id }) => id === draft.monitorId);
            const monitor = matches[0];

            if (!group && !monitor) {
                throw new Error(`无法为离线或不存在的显示器保存快捷命令：${draft.monitorId}`);
            }
            if (!group && matches.length > 1) {
                throw new Error(`显示器标识不唯一，无法安全地保存快捷命令：${draft.monitorId}`);
            }

            if (this.#state.settings.advancedVcpCommands.length >= MAX_ADVANCED_VCP_COMMANDS) {
                throw new Error(`高级 VCP 快捷命令最多保存 ${MAX_ADVANCED_VCP_COMMANDS} 个`);
            }

            const name = normalizeAdvancedCommandName(draft.name);
            const action = validateAdvancedVcpAction(draft.action);
            const shortcut = normalizeOptionalShortcut(draft.shortcut);

            const shortcutOwner = shortcut
                ? this.#state.settings.advancedVcpCommands.find((command) => command.shortcut === shortcut)
                : undefined;

            if (shortcutOwner) {
                throw new Error(
                    `全局快捷键 ${shortcut} 已被快捷命令“${shortcutOwner.name}”（${shortcutOwner.monitorName}）占用`,
                );
            }

            const command: AdvancedVcpShortcutCommand = {
                id: randomUUID(),
                name,
                monitorId: group ? '' : monitor!.id,
                ...(group ? { monitorGroupId: group.id } : {}),
                monitorName: group ? group.name : monitor!.name || monitor!.id,
                action,
                shortcut,
                closeWebViewAfter: draft.closeWebViewAfter === true,
            };

            this.#state.commit((settings) => {
                settings.advancedVcpCommands.push(command);
            });
            this.#state.succeed(`已保存高级 VCP 快捷命令“${command.name}”`);
            return 'update-settings';
        });
    }

    deleteAdvancedVcpCommand(commandId: string): Promise<void> {
        return this.#executeCommand(() => {
            const command = this.#state.settings.advancedVcpCommands.find(({ id }) => id === commandId);

            if (!command) {
                throw new Error(`找不到高级 VCP 快捷命令：${commandId}`);
            }

            this.#state.commit((settings) => {
                settings.advancedVcpCommands = settings.advancedVcpCommands.filter(({ id }) => id !== commandId);
            });
            this.#state.succeed(`已删除高级 VCP 快捷命令“${command.name}”`);
            return 'update-settings';
        });
    }

    executeAdvancedVcpCommand(commandId: string): Promise<AdvancedVcpExecutionOutcome> {
        return this.#commands.run(async () => {
            const command = this.#state.settings.advancedVcpCommands.find(({ id }) => id === commandId);

            if (!command) {
                throw new Error(`找不到高级 VCP 快捷命令：${commandId}`);
            }

            try {
                // 快捷命令可能在面板关闭很久后触发；缓存超过一分钟才重新枚举
                await this.#refreshMonitorCache();

                const result = this.#executeAdvancedTarget(command);
                this.#state.succeed(this.#formatAdvancedOutcome(`快捷命令“${command.name}”`, result));
                this.#state.publish('execute-vcp-command');
                return result;
            } catch (error) {
                this.#state.setError(`执行快捷命令“${command.name}”失败`, error);
                this.#state.publish('execute-vcp-command');
                throw error;
            }
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
            await this.#attempt(
                '实时调节失败',
                () => this.#monitorController.applyLive(request),
                (result) => {
                    const changes: string[] = [];

                    if (result.brightness !== undefined) {
                        changes.push(`亮度 ${result.brightness}`);
                    }

                    if (result.contrast !== undefined) {
                        changes.push(`对比度 ${result.contrast}`);
                    }

                    return `已实时调节：${changes.join('，')}`;
                },
            );
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

            if (monitorId !== 'all') {
                const matchCount = monitors.filter((monitor) => monitor.id === monitorId).length;
                if (matchCount === 0) {
                    throw new Error(`无法选择不存在的显示器：${monitorId}`);
                }
                if (matchCount > 1) {
                    throw new Error(`显示器标识不唯一，无法安全地选择单台显示器：${monitorId}`);
                }
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

    resetFontSize(): Promise<void> {
        return this.#executeCommand(() => {
            this.#state.commit((settings) => {
                settings.fontSize = createDefaultFontSizeSettings();
            });
            this.#state.succeed('默认文字和提示文字大小已重置');
            return 'update-settings';
        });
    }

    resetPanelStyles(): Promise<void> {
        return this.#executeCommand(() => {
            this.#state.commit((settings) => {
                settings.uiScale = createDefaultUiScaleSettings();
                settings.fontSize = createDefaultFontSizeSettings();
                settings.controlWindowBounds = null;
            });
            this.#state.succeed('面板样式已重置：缩放、文字大小、宽高和位置均已恢复默认');
            return 'update-settings';
        });
    }

    setFontSize(target: FontSizeTarget, pixels: FontSizePx): Promise<void> {
        return this.#executeCommand(() => {
            if (!isFontSizeTarget(target)) {
                throw new RangeError(`不支持的文字大小目标：${String(target)}`);
            }

            if (!isFontSizePx(target, pixels)) {
                const limits = FONT_SIZE_LIMITS[target];
                throw new RangeError(
                    `文字大小必须为 ${limits.min}px–${limits.max}px，` +
                        `且以 ${limits.step}px 为步进：${String(pixels)}`,
                );
            }

            if (this.#state.settings.fontSize[target] === pixels) {
                return null;
            }

            this.#state.commit((settings) => {
                settings.fontSize[target] = pixels;
            });

            const targetName = target === 'default' ? '默认文字' : '提示文字';
            this.#state.succeed(`${targetName}大小已设置为 ${pixels}px`);
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

            // “恢复默认配置”不修改系统级自动启动注册，避免 settings.json 与计划任务失配
            const autoStartEnabled = this.#state.settings.autoStartEnabled;
            const defaults = createDefaultSettings();
            defaults.autoStartEnabled = autoStartEnabled;
            await this.#configureExternalApi({
                enabled: defaults.externalApiEnabled,
                port: defaults.externalApiPort,
            });
            this.#state.replace(defaults);
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

    #executeAdvancedVcpRequest(
        request: AdvancedVcpExecuteRequest,
        context: string,
    ): Promise<AdvancedVcpExecutionOutcome> {
        return this.#commands.run(() => {
            try {
                const result = this.#executeAdvancedTarget(request);
                this.#state.succeed(this.#formatAdvancedOutcome('高级 VCP', result));
                this.#state.publish('execute-vcp-command');
                return result;
            } catch (error) {
                this.#state.setError(context, error);
                this.#state.publish('execute-vcp-command');
                throw error;
            }
        });
    }

    #getMonitorGroup(groupId: string) {
        const group = this.#state.settings.monitorGroups.find(({ id }) => id === groupId);
        if (!group) {
            throw new Error(`找不到显示器组：${groupId}`);
        }
        return group;
    }

    #validateAdvancedTarget(request: { monitorId: string; monitorGroupId?: string }): void {
        if (
            typeof request.monitorId !== 'string' ||
            (request.monitorGroupId !== undefined &&
                (typeof request.monitorGroupId !== 'string' || !request.monitorGroupId))
        ) {
            throw new Error('高级 VCP 操作目标无效');
        }
        if (Boolean(request.monitorId) === Boolean(request.monitorGroupId)) {
            throw new Error('请选择一台显示器或一个显示器组');
        }
    }

    #executeAdvancedTarget(request: AdvancedVcpExecuteRequest): AdvancedVcpExecutionOutcome {
        this.#validateAdvancedTarget(request);
        const action = validateAdvancedVcpAction(request.action);
        const group = request.monitorGroupId ? this.#getMonitorGroup(request.monitorGroupId) : undefined;
        const monitorIds = group ? group.monitorIds : [request.monitorId];
        const monitors = this.#monitorController.getCachedSnapshots();
        const results: AdvancedVcpExecutionResult[] = [];
        const errors: string[] = [];
        for (const monitorId of monitorIds) {
            const matches = monitors.filter(({ id }) => id === monitorId);
            const name = matches[0]?.name || monitorId;
            try {
                if (!matches.length) {
                    throw new Error(`目标显示器“${name}”当前离线，命令不可用`);
                }
                if (matches.length > 1) {
                    throw new Error(`目标显示器“${name}”身份不唯一，命令不可用`);
                }
                results.push(this.#monitorController.executeVcpAction(monitorId, action));
            } catch (error) {
                errors.push(`${name}：${error instanceof Error ? error.message : String(error)}`);
            }
        }
        if (errors.length) {
            throw new Error(
                `${group ? `显示器组“${group.name}”：${results.length}/${monitorIds.length} 台执行成功；` : ''}${errors.join('；')}`,
            );
        }
        if (!results[0]) {
            throw new Error('显示器组没有可执行的成员');
        }
        return {
            ...results[0],
            ...(group ? { results } : {}),
            closeWebViewAfter: request.closeWebViewAfter === true,
        };
    }

    #formatAdvancedOutcome(prefix: string, result: AdvancedVcpExecutionOutcome): string {
        return result.results
            ? `${prefix} 已对 ${result.results.length} 台显示器执行成功`
            : formatAdvancedVcpSuccess(prefix, result);
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
                this.#state.setOperation(
                    `自动调节已开启，每 ${intervalMinutes} 分钟运行；${this.#state.lastOperation}`,
                );
            }
        } else {
            this.#state.succeed(`自动调节间隔已设置为 ${intervalMinutes} 分钟`);
        }

        this.#autoScheduler.schedule(intervalMinutes);
        return reason;
    }

    async #refreshMonitors(force = false): Promise<boolean> {
        try {
            const { refreshed, targetUnavailable } = await this.#refreshMonitorCache(force);
            if (!refreshed) {
                return false;
            }
            const monitorCount = this.#monitorController.getCachedSnapshots().length;

            this.#state.succeed(
                targetUnavailable
                    ? `已检测到 ${monitorCount} 台显示器；原目标不存在或身份不唯一，请重新选择目标显示器`
                    : `已检测到 ${monitorCount} 台显示器`,
            );
        } catch (error) {
            // DDCMonitorController 会保留最后一份可用缓存，因此这里只更新错误状态
            this.#state.setError('检测显示器失败', error);
        }
        return true;
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

    async #refreshMonitorCache(force = false): Promise<{ refreshed: boolean; targetUnavailable: boolean }> {
        const now = this.#now();
        const shouldRefresh =
            force ||
            this.#lastMonitorRefreshAt === undefined ||
            now < this.#lastMonitorRefreshAt ||
            now - this.#lastMonitorRefreshAt >= MONITOR_REFRESH_INTERVAL_MS;
        const monitors = shouldRefresh
            ? await this.#monitorController.getSnapshots()
            : this.#monitorController.getCachedSnapshots();
        if (shouldRefresh) {
            this.#lastMonitorRefreshAt = this.#now();
        } /* else {
            console.log('距离上次自动枚举显示器不足1分钟 -> 跳过');
        } */

        if (
            this.#state.settings.targetMonitorId === 'all' ||
            monitors.filter(({ id }) => id === this.#state.settings.targetMonitorId).length === 1
        ) {
            return { refreshed: shouldRefresh, targetUnavailable: false };
        }

        // Keep the unresolved binding. Switching to "all" here can make an
        // existing single-monitor schedule write to the wrong physical screen.
        return { refreshed: shouldRefresh, targetUnavailable: true };
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

function normalizeAdvancedCommandName(value: string): string {
    const name = value.trim().replace(/\s+/g, ' ').slice(0, 60);

    if (!name) {
        throw new Error('快捷命令名称不能为空');
    }

    return name;
}

function normalizeOptionalShortcut(value: string | null): string | null {
    if (!value?.trim()) {
        return null;
    }

    return parseGlobalShortcut(value).normalized;
}

function formatAdvancedVcpSuccess(prefix: string, result: AdvancedVcpExecutionResult): string {
    const code = `0x${result.code.toString(16).toUpperCase().padStart(2, '0')}`;

    if (result.operation === 'read') {
        return `${prefix} 已读取 ${code}：${result.current ?? '?'} / ${result.maximum ?? '?'}`;
    }

    if (result.previous !== undefined) {
        return `${prefix} 已写入 ${code}：${result.previous} → ${result.value}`;
    }

    return `${prefix} 已写入 ${code}：${result.value}`;
}
