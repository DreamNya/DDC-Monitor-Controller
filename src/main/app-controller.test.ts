import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
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
    assert.deepEqual(changes.map(({ reason }) => reason), ['initialize']);

    changes.length = 0;
    await controller.setUiScale('quick', 125);

    assert.equal(controller.getState().settings.uiScale.quick, 125);
    assert.equal(settingsStore.staged.length, 1);
    assert.deepEqual(changes.map(({ reason }) => reason), ['update-settings']);

    await controller.setUiScale('quick', 125);
    assert.equal(settingsStore.staged.length, 1);
    assert.equal(changes.length, 1);

    await assert.rejects(controller.setUiScale('quick', 123), /UI 缩放比例必须/);
    assert.equal(controller.getState().settings.uiScale.quick, 125);
    assert.equal(settingsStore.staged.length, 1);

    await controller.dispose();
    assert.equal(settingsStore.disposed, true);
    assert.equal(monitorController.disposed, true);
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
    assert.deepEqual(changes.map(({ reason }) => reason), ['apply-auto', 'update-settings']);
    assert.equal(settingsStore.staged.at(-1)?.autoEnabled, false);

    await controller.dispose();
});

function createController(
    monitorController: MonitorDependency,
    settingsStore: SettingsDependency,
    scheduler: FakeScheduler,
): AppController {
    return new AppController({
        monitorController,
        settingsStore,
        createAutoScheduler: (_options: AutoAdjustmentSchedulerOptions) => scheduler,
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
        return this.getCachedSnapshots();
    }

    getCachedSnapshots(): MonitorSnapshot[] {
        return structuredClone(this.#snapshots);
    }

    async apply(request: ManualApplyRequest) {
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

    tryPowerOff(_monitorId: string): void {}

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
