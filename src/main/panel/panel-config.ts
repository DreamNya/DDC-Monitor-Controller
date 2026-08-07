import type { BrowserWindowOptions } from '@webviewjs/webview';
import type { UiScalePercent, UiScaleTarget } from '../../shared/model';
import { scaleUiDimension } from '../../shared/ui-scale';

export type PanelPage = UiScaleTarget;

export type PanelPageOptions = BrowserWindowOptions & {
    pathname: string;
    width: number;
    height: number;
};

export const CONTROL_PANEL_MIN_SIZE = Object.freeze({
    width: 680,
    height: 560,
});

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

export function getScaledPanelSize(page: PanelPage, percent: UiScalePercent): { width: number; height: number } {
    const { width, height } = PANEL_PAGES[page];

    return {
        width: scaleUiDimension(width, percent),
        height: scaleUiDimension(height, percent),
    };
}
