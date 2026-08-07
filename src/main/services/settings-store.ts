import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type {
    AppSettings,
    ControlWindowBounds,
    IntervalMinutes,
    SchedulePoint,
    ScheduleProfile,
} from '../../shared/model.ts';
import { INTERVAL_MINUTES_OPTIONS, MAX_SCHEDULE_PROFILE_NAME_LENGTH } from '../../shared/model.ts';
import { cloneDefaultSchedule, normalizeSchedule } from '../../shared/schedule.ts';
import { createDefaultUiScaleSettings, normalizeUiScaleSettings } from '../../shared/ui-scale.ts';

const DEFAULT_SETTINGS_PATH = path.join(
    process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local'),
    'DDCMonitorController',
    'settings.json',
);

const DEFAULT_PROFILE_ID = 'default';
export const SETTINGS_SAVE_THROTTLE_MS = 10_000;

type TimerHandle = ReturnType<typeof setTimeout>;
type TimerCallback = () => void;

export interface SettingsStoreOptions {
    settingsPath?: string;
    saveThrottleMs?: number;
    setTimer?: (callback: TimerCallback, delay: number) => TimerHandle;
    clearTimer?: (timer: TimerHandle) => void;
}

export class SettingsStore {
    readonly #settingsPath: string;
    readonly #saveThrottleMs: number;
    readonly #setTimer: (callback: TimerCallback, delay: number) => TimerHandle;
    readonly #clearTimer: (timer: TimerHandle) => void;

    #pendingSettings: AppSettings | undefined;
    #saveTimer: TimerHandle | undefined;
    #writeTail: Promise<void> = Promise.resolve();
    #disposePromise: Promise<void> | undefined;
    #disposed = false;

    constructor(options: SettingsStoreOptions = {}) {
        this.#settingsPath = options.settingsPath ?? DEFAULT_SETTINGS_PATH;
        this.#saveThrottleMs = options.saveThrottleMs ?? SETTINGS_SAVE_THROTTLE_MS;
        this.#setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
        this.#clearTimer = options.clearTimer ?? clearTimeout;

        if (!Number.isFinite(this.#saveThrottleMs) || this.#saveThrottleMs < 0) {
            throw new RangeError('配置保存节流时间必须是大于或等于 0 的有限数值');
        }
    }

    async load(): Promise<AppSettings> {
        try {
            const content = await fs.readFile(this.#settingsPath, 'utf8');
            return normalizeSettings(JSON.parse(content) as unknown);
        } catch (error) {
            const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';

            if (code !== 'ENOENT') {
                console.warn('读取配置失败，将使用默认配置：', error);
            }

            return createDefaultSettings();
        }
    }

    /**
     * 暂存最新配置，并从本批次第一次修改起最多等待 10 秒后写盘
     * 同一窗口内的后续调用只替换内存快照，不会重置计时器
     */
    stage(settings: AppSettings): void {
        if (this.#disposed) {
            throw new Error('配置存储正在退出，无法继续保存');
        }

        this.#pendingSettings = structuredClone(settings);
        this.#scheduleFlush();
    }

    /** 立即写入当前暂存快照；主要用于显式同步和测试 */
    flush(): Promise<void> {
        this.#clearSaveTimer();
        return this.#flushPending(true);
    }

    /** 退出时停止计时器并强制写入最后一份内存配置 */
    dispose(): Promise<void> {
        this.#disposePromise ??= this.#disposeResources();
        return this.#disposePromise;
    }

    async #disposeResources(): Promise<void> {
        this.#disposed = true;
        this.#clearSaveTimer();
        await this.#flushPending(false);
    }

    #scheduleFlush(): void {
        if (this.#disposed || this.#saveTimer !== undefined) {
            return;
        }

        this.#saveTimer = this.#setTimer(() => {
            this.#saveTimer = undefined;
            void this.#flushPending(true).catch((error: unknown) => {
                console.warn('写入配置失败，将在下一个节流窗口重试：', error);
            });
        }, this.#saveThrottleMs);
    }

    #clearSaveTimer(): void {
        if (this.#saveTimer === undefined) {
            return;
        }

        this.#clearTimer(this.#saveTimer);
        this.#saveTimer = undefined;
    }

    async #flushPending(retryOnFailure: boolean): Promise<void> {
        const snapshot = this.#pendingSettings;
        this.#pendingSettings = undefined;

        if (!snapshot) {
            await this.#writeTail;
            return;
        }

        const write = this.#writeTail.then(() => this.#write(snapshot));
        this.#writeTail = write.catch(() => undefined);

        try {
            await write;
        } catch (error) {
            // 如果写入期间没有更新的快照，保留失败快照供下一窗口重试
            this.#pendingSettings ??= snapshot;

            if (retryOnFailure) {
                this.#scheduleFlush();
            }

            throw error;
        }
    }

    async #write(settings: AppSettings): Promise<void> {
        const temporaryPath = `${this.#settingsPath}.tmp`;

        await fs.mkdir(path.dirname(this.#settingsPath), { recursive: true });
        await fs.writeFile(temporaryPath, `${JSON.stringify(settings, null, 4)}\n`, 'utf8');
        await fs.rename(temporaryPath, this.#settingsPath);
    }
}

export function createDefaultSettings(): AppSettings {
    return {
        autoEnabled: true,
        logEnabled: false,
        intervalMinutes: 30,
        targetMonitorId: 'all',
        uiScale: createDefaultUiScaleSettings(),
        activeScheduleProfileId: DEFAULT_PROFILE_ID,
        scheduleProfiles: [createDefaultScheduleProfile()],
        controlWindowBounds: null,
    };
}

function createDefaultScheduleProfile(): ScheduleProfile {
    return {
        id: DEFAULT_PROFILE_ID,
        name: '默认方案',
        schedule: cloneDefaultSchedule(),
    };
}

function normalizeSettings(value: unknown): AppSettings {
    const source = isRecord(value) ? value : {};
    const intervalMinutes = normalizeIntervalMinutes(source.intervalMinutes);
    const targetMonitorId = source.targetMonitorId;
    const scheduleProfiles = normalizeScheduleProfiles(source);
    const requestedProfileId = typeof source.activeScheduleProfileId === 'string' ? source.activeScheduleProfileId : '';
    const activeScheduleProfileId = scheduleProfiles.some(({ id }) => id === requestedProfileId)
        ? requestedProfileId
        : scheduleProfiles[0]!.id;

    return {
        logEnabled: typeof source.logEnabled === 'boolean' ? source.logEnabled : false,
        autoEnabled: typeof source.autoEnabled === 'boolean' ? source.autoEnabled : true,
        controlWindowBounds: normalizeControlWindowBounds(source.controlWindowBounds),
        intervalMinutes,
        targetMonitorId: typeof targetMonitorId === 'string' ? targetMonitorId : 'all',
        uiScale: normalizeUiScaleSettings(source.uiScale),
        activeScheduleProfileId,
        scheduleProfiles,
    };
}

function normalizeIntervalMinutes(value: unknown): IntervalMinutes {
    const intervalMinutes = Number(value);

    return isIntervalMinutes(intervalMinutes) ? intervalMinutes : 30;
}

function isIntervalMinutes(value: number): value is IntervalMinutes {
    return INTERVAL_MINUTES_OPTIONS.some((interval) => interval === value);
}

function normalizeScheduleProfiles(source: Record<string, unknown>): ScheduleProfile[] {
    const profiles: ScheduleProfile[] = [];
    const usedIds = new Set<string>();
    const usedNames = new Set<string>();

    if (Array.isArray(source.scheduleProfiles)) {
        for (const [index, value] of source.scheduleProfiles.entries()) {
            if (!isRecord(value)) {
                continue;
            }

            const schedule = normalizeScheduleSafely(value.schedule);

            if (!schedule) {
                continue;
            }

            const id = createUniqueProfileId(value.id, index, usedIds);
            const name = createUniqueProfileName(value.name, index, usedNames);

            usedIds.add(id);
            usedNames.add(name.toLocaleLowerCase());
            profiles.push({ id, name, schedule });
        }
    }

    return profiles.length > 0 ? profiles : [createDefaultScheduleProfile()];
}

function normalizeScheduleSafely(value: unknown): SchedulePoint[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }

    try {
        return normalizeSchedule(value as SchedulePoint[]);
    } catch {
        return undefined;
    }
}

function createUniqueProfileId(value: unknown, index: number, usedIds: ReadonlySet<string>): string {
    const requested = typeof value === 'string' ? value.trim() : '';
    const base = requested || `profile-${index + 1}`;

    if (!usedIds.has(base)) {
        return base;
    }

    let suffix = 2;

    while (usedIds.has(`${base}-${suffix}`)) {
        suffix += 1;
    }

    return `${base}-${suffix}`;
}

function createUniqueProfileName(value: unknown, index: number, usedNames: ReadonlySet<string>): string {
    const requested = normalizeProfileName(value) || `方案 ${index + 1}`;

    if (!usedNames.has(requested.toLocaleLowerCase())) {
        return requested;
    }

    let suffix = 2;

    while (usedNames.has(`${requested} (${suffix})`.toLocaleLowerCase())) {
        suffix += 1;
    }

    return `${requested} (${suffix})`;
}

function normalizeProfileName(value: unknown): string {
    return typeof value === 'string'
        ? value.trim().replace(/\s+/g, ' ').slice(0, MAX_SCHEDULE_PROFILE_NAME_LENGTH)
        : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function normalizeControlWindowBounds(value: unknown): ControlWindowBounds | null {
    if (!isRecord(value)) {
        return null;
    }

    const x = Number(value.x);
    const y = Number(value.y);
    const width = Number(value.width);
    const height = Number(value.height);

    if (
        ![x, y, width, height].every(Number.isFinite) ||
        width < 680 ||
        height < 560 ||
        width > 16_384 ||
        height > 16_384
    ) {
        return null;
    }

    return {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
    };
}
