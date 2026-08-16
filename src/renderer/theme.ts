export type Theme = 'light' | 'dark';

const THEME_STORAGE_KEY = 'theme';

export function isTheme(value: unknown): value is Theme {
    return value === 'light' || value === 'dark';
}

export function readCachedTheme(): Theme | undefined {
    try {
        const theme = localStorage.getItem(THEME_STORAGE_KEY);
        return isTheme(theme) ? theme : undefined;
    } catch {
        return undefined;
    }
}

export function applyDocumentTheme(theme: Theme): void {
    document.documentElement.dataset.theme = theme;
}

export function cacheTheme(theme: Theme): void {
    try {
        localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
        // localStorage 缓存失败不影响 settings.json
    }
}

export function applyAndCacheTheme(theme: Theme): void {
    applyDocumentTheme(theme);
    cacheTheme(theme);
}
