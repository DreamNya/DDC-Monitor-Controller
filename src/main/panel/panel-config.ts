import type { BrowserWindowOptions } from '@webviewjs/webview';

export type PanelPage = 'quick' | 'control';

export type PanelPageOptions = BrowserWindowOptions & {
    pathname: string;
};

export const PANEL_PAGES = Object.freeze({
    quick: {
        pathname: 'quick.html',
        width: 500,
        height: 200,
        title: 'DDC/CI',
        decorations: false,
        windowsUndecoratedShadow: true,
        resizable: false,
        maximized: false,
        alwaysOnTop: true,
        windowsSkipTaskbar: true,
    },
    control: {
        pathname: 'control.html',
        width: 760,
        height: 720,
        title: 'DDC/CI',
        decorations: false,
        windowsUndecoratedShadow: true,
        resizable: true,
        maximized: false,
    },
} satisfies Record<PanelPage, PanelPageOptions>);
