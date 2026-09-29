import type { MonitorGroup } from './model.ts';

export const MAX_MONITOR_GROUP_NAME_LENGTH = 40;

export function validateMonitorGroup(value: unknown): MonitorGroup {
    if (typeof value !== 'object' || value === null) {
        throw new TypeError('显示器组配置无效');
    }
    const source = value as Record<string, unknown>;
    const id = typeof source.id === 'string' ? source.id.trim() : '';
    const name = typeof source.name === 'string' ? source.name.trim().replace(/\s+/g, ' ') : '';
    if (!id || !name || name.length > MAX_MONITOR_GROUP_NAME_LENGTH) {
        throw new Error(`显示器组名称长度必须为 1～${MAX_MONITOR_GROUP_NAME_LENGTH}`);
    }
    if (
        !Array.isArray(source.monitorIds) ||
        source.monitorIds.some((id) => typeof id !== 'string' || !id.trim() || id.trim() === 'all')
    ) {
        throw new Error('显示器组成员必须是具体显示器标识');
    }
    const monitorIds = [...new Set((source.monitorIds as string[]).map((id) => id.trim()))];
    if (!monitorIds.length) {
        throw new Error('显示器组至少需要包含 1 台显示器');
    }
    return { id, name, monitorIds };
}

export function normalizeMonitorGroups(value: unknown): MonitorGroup[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const groups: MonitorGroup[] = [];
    for (const item of value) {
        try {
            const group = validateMonitorGroup(item);
            if (
                groups.some(
                    ({ id, name }) => id === group.id || name.toLocaleLowerCase() === group.name.toLocaleLowerCase(),
                )
            ) {
                continue;
            }
            groups.push(group);
        } catch {
            // 忽略损坏的组，不把原有命令转绑到其他显示器。
        }
    }
    return groups;
}
