import type { FontSizePx, FontSizeSettings, FontSizeTarget } from './model';

export const DEFAULT_FONT_SIZE_PX = 14;
export const DEFAULT_HINT_FONT_SIZE_PX = 11;

export const FONT_SIZE_LIMITS = {
    default: { min: 10, max: 24, step: 1, fallback: DEFAULT_FONT_SIZE_PX },
    hint: { min: 8, max: 18, step: 1, fallback: DEFAULT_HINT_FONT_SIZE_PX },
} as const satisfies Record<FontSizeTarget, { min: number; max: number; step: number; fallback: number }>;

export function createDefaultFontSizeSettings(): FontSizeSettings {
    return {
        default: DEFAULT_FONT_SIZE_PX,
        hint: DEFAULT_HINT_FONT_SIZE_PX,
    };
}

export function normalizeFontSizeSettings(value: unknown): FontSizeSettings {
    const source = isRecord(value) ? value : {};

    return {
        default: normalizeFontSizePx('default', source.default),
        hint: normalizeFontSizePx('hint', source.hint),
    };
}

export function normalizeFontSizePx(target: FontSizeTarget, value: unknown): FontSizePx {
    const limits = FONT_SIZE_LIMITS[target];

    if (
        (typeof value !== 'number' && typeof value !== 'string') ||
        (typeof value === 'string' && value.trim() === '')
    ) {
        return limits.fallback;
    }

    const numericValue = Number(value);

    if (!Number.isFinite(numericValue)) {
        return limits.fallback;
    }

    const clampedValue = Math.min(limits.max, Math.max(limits.min, numericValue));
    const stepCount = Math.round((clampedValue - limits.min) / limits.step);

    return limits.min + stepCount * limits.step;
}

export function isFontSizePx(target: FontSizeTarget, value: unknown): value is FontSizePx {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return false;
    }

    const limits = FONT_SIZE_LIMITS[target];

    return value >= limits.min && value <= limits.max && (value - limits.min) % limits.step === 0;
}

export function isFontSizeTarget(value: unknown): value is FontSizeTarget {
    return value === 'default' || value === 'hint';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
