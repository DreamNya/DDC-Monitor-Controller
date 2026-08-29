import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyTheme, readThemeFromSearch } from './theme.ts';

test('readThemeFromSearch reads supported themes and falls back to light', () => {
    assert.equal(readThemeFromSearch('?theme=dark'), 'dark');
    assert.equal(readThemeFromSearch('?theme=light'), 'light');
    assert.equal(readThemeFromSearch('?other=value&theme=dark'), 'dark');
    assert.equal(readThemeFromSearch(''), 'light');
    assert.equal(readThemeFromSearch('?theme=unknown'), 'light');
});

test('applyTheme updates the document theme and replaces the current URL without reloading', () => {
    const replacedUrls: string[] = [];
    const documentElement = { dataset: {} as Record<string, string> };
    const mockWindow = {
        location: {
            href: 'https://app.local/control.html?theme=light&development=1#settings',
        },
        history: {
            state: { panel: 'settings' },
            replaceState: (_state: unknown, _unused: string, url: string) => replacedUrls.push(url),
        },
    };

    Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement } });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: mockWindow });

    try {
        applyTheme('dark');

        assert.equal(documentElement.dataset.theme, 'dark');
        assert.deepEqual(replacedUrls, ['/control.html?theme=dark&development=1#settings']);
    } finally {
        Reflect.deleteProperty(globalThis, 'document');
        Reflect.deleteProperty(globalThis, 'window');
    }
});
