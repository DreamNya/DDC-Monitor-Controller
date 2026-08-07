import type { UiScalePercent, UiScaleSettings, UiScaleTarget } from './model';

export const UI_SCALE_MIN_PERCENT = 75;
export const UI_SCALE_MAX_PERCENT = 200;
export const UI_SCALE_STEP_PERCENT = 5;
export const DEFAULT_UI_SCALE_PERCENT = 100;

export function createDefaultUiScaleSettings(): UiScaleSettings {
    return {
        quick: DEFAULT_UI_SCALE_PERCENT,
        control: DEFAULT_UI_SCALE_PERCENT,
    };
}

export function normalizeUiScaleSettings(value: unknown): UiScaleSettings {
    const source = isRecord(value) ? value : {};

    return {
        quick: normalizeUiScalePercent(source.quick),
        control: normalizeUiScalePercent(source.control),
    };
}

export function normalizeUiScalePercent(value: unknown): UiScalePercent {
    if (
        (typeof value !== 'number' && typeof value !== 'string') ||
        (typeof value === 'string' && value.trim() === '')
    ) {
        return DEFAULT_UI_SCALE_PERCENT;
    }

    const numericValue = Number(value);

    if (!Number.isFinite(numericValue)) {
        return DEFAULT_UI_SCALE_PERCENT;
    }

    const clampedValue = Math.min(UI_SCALE_MAX_PERCENT, Math.max(UI_SCALE_MIN_PERCENT, numericValue));
    const stepCount = Math.round((clampedValue - UI_SCALE_MIN_PERCENT) / UI_SCALE_STEP_PERCENT);

    return UI_SCALE_MIN_PERCENT + stepCount * UI_SCALE_STEP_PERCENT;
}

export function isUiScalePercent(value: unknown): value is UiScalePercent {
    return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= UI_SCALE_MIN_PERCENT &&
        value <= UI_SCALE_MAX_PERCENT &&
        (value - UI_SCALE_MIN_PERCENT) % UI_SCALE_STEP_PERCENT === 0
    );
}

export function isUiScaleTarget(value: unknown): value is UiScaleTarget {
    return value === 'quick' || value === 'control';
}

export function toUiScaleFactor(percent: UiScalePercent): number {
    return percent / 100;
}

export function scaleUiDimension(value: number, percent: UiScalePercent): number {
    return Math.round(value * toUiScaleFactor(percent));
}

export function unscaleUiDimension(value: number, percent: UiScalePercent): number {
    return Math.round(value / toUiScaleFactor(percent));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
