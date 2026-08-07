import { randomUUID } from 'node:crypto';
import { MAX_SCHEDULE_PROFILE_NAME_LENGTH } from '../../shared/model.ts';
import type { AppSettings, SchedulePoint, ScheduleProfile } from '../../shared/model.ts';
import { normalizeSchedule } from '../../shared/schedule.ts';

export interface DeletedScheduleProfile {
    profile: ScheduleProfile;
    activeProfileDeleted: boolean;
}

export function getActiveScheduleProfile(settings: AppSettings): ScheduleProfile {
    return getScheduleProfile(settings, settings.activeScheduleProfileId);
}

export function getScheduleProfile(settings: AppSettings, profileId: string): ScheduleProfile {
    const profile = settings.scheduleProfiles.find(({ id }) => id === profileId);

    if (!profile) {
        throw new Error(`找不到定时方案：${profileId}`);
    }

    return profile;
}

export function createScheduleProfile(
    settings: AppSettings,
    name: string,
    schedule: SchedulePoint[],
): ScheduleProfile {
    const normalizedName = normalizeScheduleProfileName(name);
    assertUniqueScheduleProfileName(settings, normalizedName);

    const profile: ScheduleProfile = {
        id: randomUUID(),
        name: normalizedName,
        schedule: normalizeSchedule(schedule),
    };

    settings.scheduleProfiles.push(profile);
    settings.activeScheduleProfileId = profile.id;
    return profile;
}

export function renameScheduleProfile(settings: AppSettings, profileId: string, name: string): ScheduleProfile {
    const profile = getScheduleProfile(settings, profileId);
    const normalizedName = normalizeScheduleProfileName(name);

    assertUniqueScheduleProfileName(settings, normalizedName, profileId);
    profile.name = normalizedName;
    return profile;
}

export function deleteScheduleProfile(settings: AppSettings, profileId: string): DeletedScheduleProfile {
    if (settings.scheduleProfiles.length <= 1) {
        throw new Error('至少需要保留一个定时方案');
    }

    const index = settings.scheduleProfiles.findIndex(({ id }) => id === profileId);

    if (index < 0) {
        throw new Error(`找不到定时方案：${profileId}`);
    }

    const profile = settings.scheduleProfiles[index]!;
    settings.scheduleProfiles.splice(index, 1);

    const activeProfileDeleted = settings.activeScheduleProfileId === profileId;

    if (activeProfileDeleted) {
        settings.activeScheduleProfileId = settings.scheduleProfiles[
            Math.min(index, settings.scheduleProfiles.length - 1)
        ]!.id;
    }

    return { profile, activeProfileDeleted };
}

export function saveScheduleProfile(
    settings: AppSettings,
    profileId: string,
    schedule: SchedulePoint[],
): ScheduleProfile {
    const profile = getScheduleProfile(settings, profileId);
    profile.schedule = normalizeSchedule(schedule);
    return profile;
}

function assertUniqueScheduleProfileName(settings: AppSettings, name: string, excludedProfileId?: string): void {
    const normalizedName = name.toLocaleLowerCase();
    const duplicate = settings.scheduleProfiles.some(
        (profile) => profile.id !== excludedProfileId && profile.name.toLocaleLowerCase() === normalizedName,
    );

    if (duplicate) {
        throw new Error(`定时方案名称“${name}”已存在`);
    }
}

function normalizeScheduleProfileName(name: string): string {
    const normalized = name.trim().replace(/\s+/g, ' ').slice(0, MAX_SCHEDULE_PROFILE_NAME_LENGTH);

    if (!normalized) {
        throw new Error('定时方案名称不能为空');
    }

    return normalized;
}
