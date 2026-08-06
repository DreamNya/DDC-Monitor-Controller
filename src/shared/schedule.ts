import type { MonitorValues, SchedulePoint } from './model';

export const DEFAULT_SCHEDULE: readonly SchedulePoint[] = Object.freeze([
    { time: 5, brightness: 10, contrast: 35 },
    { time: 8, brightness: 18, contrast: 40 },
    { time: 9, brightness: 23, contrast: 48 },
    { time: 12, brightness: 23, contrast: 48 },
    { time: 17, brightness: 10, contrast: 40 },
    { time: 18, brightness: 0, contrast: 30 },
]);

/**
 * 根据时间节点计算当前亮度和对比度
 *
 * 在首节点之前或末节点之后，固定使用末节点值；节点之间采用线性插值并向下取整
 */
export function calculateAutoSettings(date: Date, schedule: readonly SchedulePoint[]): MonitorValues {
    const points = normalizeSchedule(schedule);
    const firstPoint = points[0];
    const lastPoint = points.at(-1);

    if (!firstPoint || !lastPoint) {
        throw new RangeError('自动调节时间表不能为空');
    }

    const currentHours = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;

    if (currentHours < firstPoint.time || currentHours >= lastPoint.time) {
        return pickValues(lastPoint);
    }

    const startIndex = points.findIndex((point, index) => {
        const nextPoint = points[index + 1];

        return nextPoint !== undefined && currentHours >= point.time && currentHours < nextPoint.time;
    });

    const startPoint = points[startIndex];
    const endPoint = points[startIndex + 1];

    if (!startPoint || !endPoint) {
        throw new RangeError('无法匹配当前时间对应的调节区间');
    }

    const ratio = (currentHours - startPoint.time) / (endPoint.time - startPoint.time);

    return {
        brightness: Math.floor(startPoint.brightness + (endPoint.brightness - startPoint.brightness) * ratio),
        contrast: Math.floor(startPoint.contrast + (endPoint.contrast - startPoint.contrast) * ratio),
    };
}

export function normalizeSchedule(schedule: readonly SchedulePoint[]): SchedulePoint[] {
    if (schedule.length === 0) {
        throw new RangeError('自动调节时间表至少需要一个节点');
    }

    const points = schedule
        .map((point) => ({
            time: assertInRange(point.time, 0, 24, '时间'),
            brightness: assertInRange(Math.round(point.brightness), 0, 100, '亮度'),
            contrast: assertInRange(Math.round(point.contrast), 0, 100, '对比度'),
        }))
        .toSorted((left, right) => left.time - right.time);

    for (let index = 1; index < points.length; index += 1) {
        const previous = points[index - 1];
        const current = points[index];

        if (previous && current && previous.time === current.time) {
            throw new RangeError(`时间节点 ${formatTime(current.time)} 重复`);
        }
    }

    return points;
}

export function cloneDefaultSchedule(): SchedulePoint[] {
    return DEFAULT_SCHEDULE.map((point) => ({ ...point }));
}

export function formatTime(time: number): string {
    const totalMinutes = Math.round(time * 60);
    const hours = Math.floor(totalMinutes / 60) % 24;
    const minutes = totalMinutes % 60;

    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function parseTime(value: string): number {
    const match = /^(\d{2}):(\d{2})$/.exec(value);

    if (!match) {
        throw new TypeError(`无效的时间格式：${value}`);
    }

    const hours = Number(match[1]);
    const minutes = Number(match[2]);

    if (hours > 23 || minutes > 59) {
        throw new RangeError(`无效的时间：${value}`);
    }

    return hours + minutes / 60;
}

function pickValues(point: SchedulePoint): MonitorValues {
    return {
        brightness: point.brightness,
        contrast: point.contrast,
    };
}

function assertInRange(value: number, minimum: number, maximum: number, name: string): number {
    if (!Number.isFinite(value)) {
        throw new TypeError(`${name}必须为有限数字`);
    }

    // 时间允许 0 <= time < 24；其余值允许包含最大值
    const outside = name === '时间' ? value < minimum || value >= maximum : value < minimum || value > maximum;

    if (outside) {
        throw new RangeError(`${name}超出允许范围`);
    }

    return value;
}
