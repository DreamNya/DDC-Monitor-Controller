import { randomUUID } from 'node:crypto';
import type { AppSettings, SchedulePoint, ScheduleProfile } from '../../shared/model';
import { normalizeSchedule } from '../../shared/schedule';

const MAX_PROFILE_NAME_LENGTH = 40;

export interface DeletedScheduleProfile {
    profile: ScheduleProfile;
    activeProfileDeleted: boolean;
}

/** 管理定时方案集合及其约束，不负责配置持久化或自动应用 */
export class ScheduleProfileService {
    getActive(settings: AppSettings): ScheduleProfile {
        return this.get(settings, settings.activeScheduleProfileId);
    }

    get(settings: AppSettings, profileId: string): ScheduleProfile {
        const profile = settings.scheduleProfiles.find(({ id }) => id === profileId);

        if (!profile) {
            throw new Error(`找不到定时方案：${profileId}`);
        }

        return profile;
    }

    create(settings: AppSettings, name: string, schedule: SchedulePoint[]): ScheduleProfile {
        const normalizedName = normalizeScheduleProfileName(name);
        this.#assertUniqueName(settings, normalizedName);

        const profile: ScheduleProfile = {
            id: randomUUID(),
            name: normalizedName,
            schedule: normalizeSchedule(schedule),
        };

        settings.scheduleProfiles.push(profile);
        settings.activeScheduleProfileId = profile.id;
        return profile;
    }

    rename(settings: AppSettings, profileId: string, name: string): ScheduleProfile {
        const profile = this.get(settings, profileId);
        const normalizedName = normalizeScheduleProfileName(name);

        this.#assertUniqueName(settings, normalizedName, profileId);
        profile.name = normalizedName;
        return profile;
    }

    delete(settings: AppSettings, profileId: string): DeletedScheduleProfile {
        if (settings.scheduleProfiles.length <= 1) {
            throw new Error('至少需要保留一个定时方案');
        }

        const index = settings.scheduleProfiles.findIndex(({ id }) => id === profileId);

        if (index < 0) {
            throw new Error(`找不到定时方案：${profileId}`);
        }

        const [profile] = settings.scheduleProfiles.splice(index, 1);

        if (!profile) {
            throw new Error(`找不到定时方案：${profileId}`);
        }

        const activeProfileDeleted = settings.activeScheduleProfileId === profileId;

        if (activeProfileDeleted) {
            const nextProfile = settings.scheduleProfiles[Math.min(index, settings.scheduleProfiles.length - 1)];

            if (!nextProfile) {
                throw new Error('删除定时方案后没有可用方案');
            }

            settings.activeScheduleProfileId = nextProfile.id;
        }

        return { profile, activeProfileDeleted };
    }

    save(settings: AppSettings, profileId: string, schedule: SchedulePoint[]): ScheduleProfile {
        const profile = this.get(settings, profileId);
        profile.schedule = normalizeSchedule(schedule);
        return profile;
    }

    #assertUniqueName(settings: AppSettings, name: string, excludedProfileId?: string): void {
        const normalizedName = name.toLocaleLowerCase();
        const duplicate = settings.scheduleProfiles.some(
            (profile) => profile.id !== excludedProfileId && profile.name.toLocaleLowerCase() === normalizedName,
        );

        if (duplicate) {
            throw new Error(`定时方案名称“${name}”已存在`);
        }
    }
}

function normalizeScheduleProfileName(name: string): string {
    const normalized = name.trim().replace(/\s+/g, ' ').slice(0, MAX_PROFILE_NAME_LENGTH);

    if (!normalized) {
        throw new Error('定时方案名称不能为空');
    }

    return normalized;
}
