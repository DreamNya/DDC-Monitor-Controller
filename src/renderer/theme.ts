export type Theme = 'light' | 'dark';

export function isTheme(value: unknown): value is Theme {
    return value === 'light' || value === 'dark';
}

export function readThemeFromSearch(search: string): Theme {
    const theme = new URLSearchParams(search).get('theme');
    return isTheme(theme) ? theme : 'light';
}

export function readThemeFromUrl(): Theme {
    return readThemeFromSearch(window.location.search);
}

export function applyDocumentTheme(theme: Theme): void {
    document.documentElement.dataset.theme = theme;
}

export function syncThemeToUrl(theme: Theme): void {
    const url = new URL(window.location.href);

    if (url.searchParams.get('theme') === theme) {
        return;
    }

    url.searchParams.set('theme', theme);
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

export function applyTheme(theme: Theme): void {
    applyDocumentTheme(theme);
    syncThemeToUrl(theme);
}
