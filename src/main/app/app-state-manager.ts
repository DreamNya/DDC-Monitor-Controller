import type {
    AppSettings,
    AppState,
    AppStateChange,
    AppStateChangeReason,
    ControlWindowBounds,
    MonitorSnapshot,
} from '../../shared/model.ts';
import { calculateAutoSettings } from '../../shared/schedule.ts';
import { getActiveScheduleProfile } from '../services/schedule-profile.ts';
import { createDefaultSettings, type SettingsStore } from '../services/settings-store.ts';

export type SettingsPersistence = Pick<SettingsStore, 'load' | 'stage' | 'dispose'>;

export interface AppStateManagerOptions {
    settingsStore: SettingsPersistence;
    getMonitors(): MonitorSnapshot[];
    getNextRunAt(): string | null;
}

export class AppStateManager {
    readonly #settingsStore: SettingsPersistence;
    readonly #getMonitors: () => MonitorSnapshot[];
    readonly #getNextRunAt: () => string | null;

    #settings: AppSettings = createDefaultSettings();
    #lastOperation = '正在初始化';
    #lastError: string | null = null;
    #onStateChanged: ((change: AppStateChange) => void) | undefined;

    constructor(options: AppStateManagerOptions) {
        this.#settingsStore = options.settingsStore;
        this.#getMonitors = options.getMonitors;
        this.#getNextRunAt = options.getNextRunAt;
    }

    get settings(): AppSettings {
        return this.#settings;
    }

    get lastOperation(): string {
        return this.#lastOperation;
    }

    get lastError(): string | null {
        return this.#lastError;
    }

    async load(): Promise<void> {
        this.#settings = await this.#settingsStore.load();
    }

    setListener(listener: (change: AppStateChange) => void): void {
        this.#onStateChanged = listener;
    }

    clearListener(): void {
        this.#onStateChanged = undefined;
    }

    getState(): AppState {
        return {
            settings: structuredClone(this.#settings),
            monitors: this.#getMonitors(),
            calculatedValues: calculateAutoSettings(
                new Date(),
                getActiveScheduleProfile(this.#settings).schedule,
            ),
            nextRunAt: this.#getNextRunAt(),
            lastOperation: this.#lastOperation,
            lastError: this.#lastError,
        };
    }

    getControlWindowBounds(): ControlWindowBounds | null {
        return this.#settings.controlWindowBounds ? structuredClone(this.#settings.controlWindowBounds) : null;
    }

    commit<T>(mutate: (settings: AppSettings) => T): T {
        const nextSettings = structuredClone(this.#settings);
        const result = mutate(nextSettings);

        this.#settingsStore.stage(nextSettings);
        this.#settings = nextSettings;
        return result;
    }

    replace(settings: AppSettings): void {
        const nextSettings = structuredClone(settings);
        this.#settingsStore.stage(nextSettings);
        this.#settings = nextSettings;
    }

    succeed(message: string): void {
        this.#lastOperation = message;
        this.#lastError = null;
    }

    setOperation(message: string): void {
        this.#lastOperation = message;
    }

    setError(context: string, error: unknown): void {
        this.#lastOperation = context;
        this.#lastError = error instanceof Error ? error.message : String(error);
        console.error(`${context}:`, error);
    }

    publish(reason: AppStateChangeReason): void {
        const state = this.getState();

        if (this.#settings.logEnabled) {
            console.log(`[操作] ${this.#lastOperation}${this.#lastError ? `；错误：${this.#lastError}` : ''}`);
        }

        this.#onStateChanged?.({ reason, state });
    }

    dispose(): Promise<void> {
        this.clearListener();
        return this.#settingsStore.dispose();
    }
}
