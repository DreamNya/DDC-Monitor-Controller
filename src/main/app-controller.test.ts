import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_EXTERNAL_API_PORT } from '../api/external-api-config.ts';
import type {
    AdvancedVcpAction,
    AdvancedVcpExecutionResult,
    AppSettings,
    AppStateChange,
    LiveApplyRequest,
    ManualApplyRequest,
    MonitorSnapshot,
} from '../shared/model';
import { AppController, type AppControllerOptions } from './app-controller.ts';
import type { AutoAdjustmentSchedulerOptions } from './services/auto-adjustment-scheduler.ts';
import { createDefaultSettings } from './services/settings-store.ts';

type MonitorDependency = NonNullable<AppControllerOptions['monitorController']>;
type SettingsDependency = NonNullable<AppControllerOptions['settingsStore']>;

test('AppController desktop initialization preserves the existing automatic startup behavior', async () => {
    const settings = createDefaultSettings();
    const monitorController = new FakeMonitorController();
    const settingsStore = new FakeSettingsStore(settings);
    const scheduler = new FakeScheduler();
    const controller = createController(monitorController, settingsStore, scheduler);

    await controller.initialize();

    assert.equal(monitorController.getSnapshotsCalls, 1);
    assert.equal(monitorController.applyCalls, 1);
    assert.deepEqual(scheduler.scheduleCalls, [settings.intervalMinutes]);
    assert.equal(scheduler.active, true);
    assert.notEqual(controller.getState().nextRunAt, null);

    await controller.dispose();
});

test('AppController command initialization loads state without applying or scheduling automatic settings', async () => {
    const settings = createDefaultSettings();
    settings.logEnabled = true;
    const monitorController = new FakeMonitorController();
    const settingsStore = new FakeSettingsStore(settings);
    const scheduler = new FakeScheduler();
    const logStates: boolean[] = [];
    const controller = new AppController({
        monitorController,
        settingsStore,
        createAutoScheduler: (_options: AutoAdjustmentSchedulerOptions) => scheduler,
        onLogEnabledChanged: (enabled) => logStates.push(enabled),
    });
    const changes: AppStateChange[] = [];
    controller.setStateListener((change) => changes.push(change));

    await controller.initialize({ mode: 'command' });

    const state = controller.getState();
    assert.deepEqual(logStates, [true]);
    assert.equal(monitorController.getSnapshotsCalls, 1);
    assert.equal(monitorController.applyCalls, 0);
    assert.deepEqual(scheduler.scheduleCalls, []);
    assert.equal(scheduler.active, false);
    assert.equal(state.settings.autoEnabled, true);
    assert.equal(state.nextRunAt, null);
    assert.equal(state.lastOperation, '已检测到 1 台显示器');
    assert.deepEqual(
        changes.map(({ reason }) => reason),
        ['initialize'],
    );

    await controller.dispose();
});

test('AppController publishes each command once and commits settings atomically in memory', async () => {
    const settings = createDefaultSettings();
    settings.autoEnabled = false;
    const monitorController = new FakeMonitorController();
    const settingsStore = new FakeSettingsStore(settings);
    const scheduler = new FakeScheduler();
    const controller = createController(monitorController, settingsStore, scheduler);
    const changes: AppStateChange[] = [];
    controller.setStateListener((change) => changes.push(change));

    await controller.initialize();
    assert.deepEqual(
        changes.map(({ reason }) => reason),
        ['initialize'],
    );

    changes.length = 0;
    await controller.setUiScale('quick', 125);

    assert.equal(controller.getState().settings.uiScale.quick, 125);
    assert.equal(settingsStore.staged.length, 1);
    assert.deepEqual(
        changes.map(({ reason }) => reason),
        ['update-settings'],
    );

    await controller.setUiScale('quick', 125);
    assert.equal(settingsStore.staged.length, 1);
    assert.equal(changes.length, 1);

    await assert.rejects(controller.setUiScale('quick', 123), /UI 缩放比例必须/);
    assert.equal(controller.getState().settings.uiScale.quick, 125);
    assert.equal(settingsStore.staged.length, 1);

    await controller.setFontSize('default', 18);
    assert.equal(controller.getState().settings.fontSize.default, 18);
    assert.equal(settingsStore.staged.length, 2);
    assert.deepEqual(
        changes.map(({ reason }) => reason),
        ['update-settings', 'update-settings'],
    );

    await assert.rejects(controller.setFontSize('hint', 19), /文字大小必须/);
    assert.equal(controller.getState().settings.fontSize.hint, 11);
    assert.equal(settingsStore.staged.length, 2);

    await controller.dispose();
    assert.equal(settingsStore.disposed, true);
    assert.equal(monitorController.disposed, true);
});

test('AppController resets panel display settings without touching unrelated settings', async () => {
    const settings = createDefaultSettings();
    settings.autoEnabled = false;
    settings.logEnabled = true;
    const monitorController = new FakeMonitorController();
    const settingsStore = new FakeSettingsStore(settings);
    const scheduler = new FakeScheduler();
    const controller = createController(monitorController, settingsStore, scheduler);

    await controller.initialize();

    await controller.setUiScale('quick', 150);
    await controller.setUiScale('control', 175);
    await controller.setFontSize('default', 20);
    await controller.setFontSize('hint', 16);
    await controller.saveControlWindowBounds({ x: 120, y: 80, width: 930, height: 760 });

    await controller.resetUiScale();
    let state = controller.getState();
    assert.deepEqual(state.settings.uiScale, { quick: 100, control: 100 });
    assert.deepEqual(state.settings.fontSize, { default: 20, hint: 16 });
    assert.deepEqual(state.settings.controlWindowBounds, { x: 120, y: 80, width: 930, height: 760 });

    await controller.resetFontSize();
    state = controller.getState();
    assert.deepEqual(state.settings.fontSize, { default: 14, hint: 11 });
    assert.deepEqual(state.settings.controlWindowBounds, { x: 120, y: 80, width: 930, height: 760 });

    await controller.setUiScale('quick', 125);
    await controller.setUiScale('control', 140);
    await controller.setFontSize('default', 18);
    await controller.setFontSize('hint', 13);
    await controller.resetPanelStyles();

    state = controller.getState();
    assert.deepEqual(state.settings.uiScale, { quick: 100, control: 100 });
    assert.deepEqual(state.settings.fontSize, { default: 14, hint: 11 });
    assert.equal(state.settings.controlWindowBounds, null);
    assert.equal(state.settings.logEnabled, true);
    assert.equal(state.settings.autoEnabled, false);
    assert.match(state.lastOperation, /面板样式已重置/);

    await controller.dispose();
});

test('AppController saves monitor-bound advanced VCP commands and rejects execution when the monitor is offline', async () => {
    const settings = createDefaultSettings();
    settings.autoEnabled = false;
    const monitorController = new FakeMonitorController();
    const settingsStore = new FakeSettingsStore(settings);
    const scheduler = new FakeScheduler();
    const controller = createController(monitorController, settingsStore, scheduler);

    await controller.initialize();
    await controller.saveAdvancedVcpCommand({
        name: '切换 HDMI',
        monitorId: 'monitor-1',
        action: { type: 'write', code: 0x60, value: 0x11 },
        shortcut: 'shift+ctrl+f12',
        closeWebViewAfter: true,
    });

    const [command] = controller.getState().settings.advancedVcpCommands;
    assert.ok(command);
    assert.equal(command.monitorId, 'monitor-1');
    assert.equal(command.shortcut, 'Ctrl+Shift+F12');

    const result = await controller.executeAdvancedVcpCommand(command.id);
    assert.equal(result.operation, 'write');
    assert.equal(result.value, 0x11);
    assert.equal(result.closeWebViewAfter, true);

    await assert.rejects(
        controller.saveAdvancedVcpCommand({
            name: '重复快捷键',
            monitorId: 'monitor-1',
            action: { type: 'read', code: 0x10 },
            shortcut: 'Ctrl+Shift+F12',
        }),
        /已被快捷命令“切换 HDMI”.*占用/,
    );

    monitorController.disconnectAll();
    await assert.rejects(controller.executeAdvancedVcpCommand(command.id), /当前离线/);

    await controller.dispose();
});

test('AppController persists auto-start preference only after the scheduled-task operation succeeds', async () => {
    const settings = createDefaultSettings();
    settings.autoEnabled = false;
    const monitorController = new FakeMonitorController();
    const settingsStore = new FakeSettingsStore(settings);
    const scheduler = new FakeScheduler();
    const registrations: boolean[] = [];
    const controller = createController(monitorController, settingsStore, scheduler, async (enabled) => {
        registrations.push(enabled);
    });
    const changes: AppStateChange[] = [];
    controller.setStateListener((change) => changes.push(change));

    await controller.initialize();
    changes.length = 0;

    await controller.setAutoStartEnabled(true);
    assert.deepEqual(registrations, [true]);
    assert.equal(controller.getState().settings.autoStartEnabled, true);
    assert.equal(settingsStore.staged.at(-1)?.autoStartEnabled, true);
    assert.deepEqual(
        changes.map(({ reason }) => reason),
        ['update-settings'],
    );

    await controller.setAutoStartEnabled(false);
    assert.deepEqual(registrations, [true, false]);
    assert.equal(controller.getState().settings.autoStartEnabled, false);
    assert.equal(settingsStore.staged.at(-1)?.autoStartEnabled, false);

    await controller.dispose();
});

test('AppController leaves auto-start preference unchanged when scheduled-task update fails', async () => {
    const settings = createDefaultSettings();
    settings.autoEnabled = false;
    const monitorController = new FakeMonitorController();
    const settingsStore = new FakeSettingsStore(settings);
    const scheduler = new FakeScheduler();
    const controller = createController(monitorController, settingsStore, scheduler, async () => {
        throw new Error('task failed');
    });

    await controller.initialize();
    await assert.rejects(controller.setAutoStartEnabled(true), /task failed/);
    assert.equal(controller.getState().settings.autoStartEnabled, false);
    assert.equal(settingsStore.staged.length, 0);

    await controller.dispose();
});

test('AppController resetSettings preserves auto-start registration preference', async () => {
    const settings = createDefaultSettings();
    settings.autoEnabled = false;
    settings.autoStartEnabled = true;
    settings.logEnabled = true;
    const monitorController = new FakeMonitorController();
    const settingsStore = new FakeSettingsStore(settings);
    const scheduler = new FakeScheduler();
    const controller = createController(monitorController, settingsStore, scheduler);

    await controller.initialize();
    await controller.resetSettings();

    assert.equal(controller.getState().settings.autoStartEnabled, true);
    assert.equal(settingsStore.staged.at(-1)?.autoStartEnabled, true);

    await controller.dispose();
});

test('AppController serializes auto-enable and auto-disable side effects', async () => {
    const settings = createDefaultSettings();
    settings.autoEnabled = false;
    const monitorController = new FakeMonitorController(true);
    const settingsStore = new FakeSettingsStore(settings);
    const scheduler = new FakeScheduler();
    const controller = createController(monitorController, settingsStore, scheduler);
    const changes: AppStateChange[] = [];
    controller.setStateListener((change) => changes.push(change));
    await controller.initialize();
    changes.length = 0;

    const enable = controller.setAutoEnabled(true);
    await monitorController.applyStarted.promise;
    const disable = controller.setAutoEnabled(false);

    monitorController.releaseApply();
    await Promise.all([enable, disable]);

    assert.equal(controller.getState().settings.autoEnabled, false);
    assert.equal(scheduler.active, false);
    assert.equal(scheduler.scheduleCalls.length, 1);
    assert.deepEqual(
        changes.map(({ reason }) => reason),
        ['apply-auto', 'update-settings'],
    );
    assert.equal(settingsStore.staged.at(-1)?.autoEnabled, false);

    await controller.dispose();
});

test('AppController applies local HTTP API configuration before committing settings', async () => {
    const settings = createDefaultSettings();
    settings.autoEnabled = false;
    const monitorController = new FakeMonitorController();
    const settingsStore = new FakeSettingsStore(settings);
    const scheduler = new FakeScheduler();
    const configurations: Array<{ enabled: boolean; port: number }> = [];
    const controller = new AppController({
        monitorController,
        settingsStore,
        createAutoScheduler: (_options: AutoAdjustmentSchedulerOptions) => scheduler,
        configureExternalApi: async (configuration) => {
            configurations.push(structuredClone(configuration));
        },
    });

    await controller.initialize();
    await controller.setExternalApiConfiguration({ enabled: true, port: 54321 });

    assert.deepEqual(configurations, [{ enabled: true, port: 54321 }]);
    assert.equal(controller.getState().settings.externalApiEnabled, true);
    assert.equal(controller.getState().settings.externalApiPort, 54321);
    assert.equal(settingsStore.staged.at(-1)?.externalApiEnabled, true);
    assert.equal(settingsStore.staged.at(-1)?.externalApiPort, 54321);

    await controller.dispose();
});

test('AppController keeps local HTTP API settings unchanged when runtime reconfiguration fails', async () => {
    const settings = createDefaultSettings();
    settings.autoEnabled = false;
    const monitorController = new FakeMonitorController();
    const settingsStore = new FakeSettingsStore(settings);
    const scheduler = new FakeScheduler();
    const controller = new AppController({
        monitorController,
        settingsStore,
        createAutoScheduler: (_options: AutoAdjustmentSchedulerOptions) => scheduler,
        configureExternalApi: async () => {
            throw new Error('EADDRINUSE');
        },
    });

    await controller.initialize();
    await assert.rejects(controller.setExternalApiConfiguration({ enabled: true, port: 54321 }), /EADDRINUSE/);

    assert.equal(controller.getState().settings.externalApiEnabled, false);
    assert.equal(controller.getState().settings.externalApiPort, DEFAULT_EXTERNAL_API_PORT);
    assert.equal(settingsStore.staged.length, 0);

    await controller.dispose();
});

test('AppController rejects invalid local HTTP API ports before runtime reconfiguration', async () => {
    const settings = createDefaultSettings();
    settings.autoEnabled = false;
    const monitorController = new FakeMonitorController();
    const settingsStore = new FakeSettingsStore(settings);
    const scheduler = new FakeScheduler();
    let configurationCalls = 0;
    const controller = new AppController({
        monitorController,
        settingsStore,
        createAutoScheduler: (_options: AutoAdjustmentSchedulerOptions) => scheduler,
        configureExternalApi: async () => {
            configurationCalls += 1;
        },
    });

    await controller.initialize();
    await assert.rejects(
        controller.setExternalApiConfiguration({ enabled: true, port: 80 }),
        /端口必须是 1024 到 65535/,
    );

    assert.equal(configurationCalls, 0);
    assert.equal(settingsStore.staged.length, 0);

    await controller.dispose();
});

function createController(
    monitorController: MonitorDependency,
    settingsStore: SettingsDependency,
    scheduler: FakeScheduler,
    setAutoStartRegistration?: (enabled: boolean) => Promise<void>,
): AppController {
    return new AppController({
        monitorController,
        settingsStore,
        createAutoScheduler: (_options: AutoAdjustmentSchedulerOptions) => scheduler,
        ...(setAutoStartRegistration === undefined ? {} : { setAutoStartRegistration }),
    });
}

class FakeSettingsStore implements SettingsDependency {
    readonly staged: AppSettings[] = [];
    readonly settings: AppSettings;
    disposed = false;

    constructor(settings: AppSettings) {
        this.settings = settings;
    }

    async load(): Promise<AppSettings> {
        return structuredClone(this.settings);
    }

    stage(settings: AppSettings): void {
        this.staged.push(structuredClone(settings));
    }

    async dispose(): Promise<void> {
        this.disposed = true;
    }
}

class FakeMonitorController implements MonitorDependency {
    readonly applyStarted = createDeferred<void>();
    disposed = false;
    getSnapshotsCalls = 0;
    applyCalls = 0;
    #blockApply: boolean;
    #applyRelease = createDeferred<void>();
    #snapshots: MonitorSnapshot[] = [
        {
            id: 'monitor-1',
            index: 0,
            name: 'Test Monitor',
            brightness: 50,
            contrast: 50,
        },
    ];

    constructor(blockApply = false) {
        this.#blockApply = blockApply;
    }

    async getSnapshots(): Promise<MonitorSnapshot[]> {
        this.getSnapshotsCalls += 1;
        return this.getCachedSnapshots();
    }

    getCachedSnapshots(): MonitorSnapshot[] {
        return structuredClone(this.#snapshots);
    }

    getCapabilities(monitorId: string) {
        const monitor = this.#snapshots.find(({ id }) => id === monitorId);

        if (!monitor) {
            throw new Error(`Unknown monitor: ${monitorId}`);
        }

        return {
            monitorId,
            monitorName: monitor.name,
            raw: '(vcp(10))',
            vcpCodes: [{ code: 0x10, supportedValues: null }],
        };
    }

    getVcpValues(monitorId: string, codes: readonly number[]) {
        if (!this.#snapshots.some(({ id }) => id === monitorId)) {
            throw new Error(`Unknown monitor: ${monitorId}`);
        }

        return codes.map((code) => ({ code, current: 50, maximum: 100 }));
    }

    executeVcpAction(monitorId: string, action: AdvancedVcpAction): AdvancedVcpExecutionResult {
        if (!this.#snapshots.some(({ id }) => id === monitorId)) {
            throw new Error(`Unknown monitor: ${monitorId}`);
        }

        if (action.type === 'read') {
            return { monitorId, code: action.code, operation: 'read', current: 50, maximum: 100 };
        }
        if (action.type === 'write') {
            return { monitorId, code: action.code, operation: 'write', value: action.value };
        }

        const delta = Math.round((100 * action.percent) / 100);
        const value = action.direction === 'increase' ? 50 + delta : 50 - delta;
        return { monitorId, code: action.code, operation: 'write', previous: 50, maximum: 100, value };
    }

    disconnectAll(): void {
        this.#snapshots = [];
    }

    async apply(request: ManualApplyRequest) {
        this.applyCalls += 1;

        if (this.#blockApply) {
            this.applyStarted.resolve();
            await this.#applyRelease.promise;
            this.#blockApply = false;
        }

        this.#snapshots = this.#snapshots.map((monitor) => ({
            ...monitor,
            brightness: request.brightness,
            contrast: request.contrast,
        }));
        return { brightness: request.brightness, contrast: request.contrast };
    }

    async applyLive(request: LiveApplyRequest) {
        this.#snapshots = this.#snapshots.map((monitor) => ({
            ...monitor,
            brightness: request.brightness ?? monitor.brightness,
            contrast: request.contrast ?? monitor.contrast,
        }));
        return {
            ...(request.brightness === undefined ? {} : { brightness: request.brightness }),
            ...(request.contrast === undefined ? {} : { contrast: request.contrast }),
        };
    }

    releaseApply(): void {
        this.#applyRelease.resolve();
    }

    async dispose(): Promise<void> {
        this.disposed = true;
    }
}

class FakeScheduler {
    nextRunAt: string | null = null;
    active = false;
    scheduleCalls: number[] = [];

    schedule(intervalMinutes: number): void {
        this.active = true;
        this.scheduleCalls.push(intervalMinutes);
        this.nextRunAt = '2099-01-01T00:00:00.000Z';
    }

    stop(): void {
        this.active = false;
        this.nextRunAt = null;
    }

    dispose(): void {
        this.stop();
    }
}

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });

    return { promise, resolve, reject };
}
