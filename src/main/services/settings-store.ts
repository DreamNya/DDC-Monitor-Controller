import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { INTERVAL_MINUTES_OPTIONS } from '../../shared/model';
import type {
    AppSettings,
    ControlWindowBounds,
    IntervalMinutes,
    SchedulePoint,
    ScheduleProfile,
} from '../../shared/model';
import { cloneDefaultSchedule, normalizeSchedule } from '../../shared/schedule';

const SETTINGS_PATH = path.join(
    process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local'),
    'DDCMonitorController',
    'settings.json',
);

const DEFAULT_PROFILE_ID = 'default';
const MAX_PROFILE_NAME_LENGTH = 40;

export class SettingsStore {
    async load(): Promise<AppSettings> {
        try {
            const content = await fs.readFile(SETTINGS_PATH, 'utf8');
            return normalizeSettings(JSON.parse(content) as unknown);
        } catch (error) {
            const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';

            if (code !== 'ENOENT') {
                console.warn('读取配置失败，将使用默认配置：', error);
            }

            return createDefaultSettings();
        }
    }

    async save(settings: AppSettings): Promise<void> {
        const normalized = normalizeSettings(settings);
        const temporaryPath = `${SETTINGS_PATH}.tmp`;

        await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
        await fs.writeFile(temporaryPath, `${JSON.stringify(normalized, null, 4)}\n`, 'utf8');
        await fs.rename(temporaryPath, SETTINGS_PATH);
    }

    createDefault(): AppSettings {
        return createDefaultSettings();
    }
}

function createDefaultSettings(): AppSettings {
    return {
        autoEnabled: true,
        logEnabled: false,
        intervalMinutes: 30,
        targetMonitorId: 'all',
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
        : scheduleProfiles[0]?.id;

    if (!activeScheduleProfileId) {
        throw new RangeError('自动调节方案不能为空');
    }

    return {
        logEnabled: typeof source.logEnabled === 'boolean' ? source.logEnabled : false,
        autoEnabled: typeof source.autoEnabled === 'boolean' ? source.autoEnabled : true,
        controlWindowBounds: normalizeControlWindowBounds(source.controlWindowBounds),
        intervalMinutes,
        targetMonitorId: targetMonitorId === 'all' || typeof targetMonitorId === 'string' ? targetMonitorId : 'all',
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
    return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, MAX_PROFILE_NAME_LENGTH) : '';
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
