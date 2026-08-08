import type { UiScaleTarget } from '../../shared/model';

export type PanelPage = UiScaleTarget;

export interface PanelPageOptions {
    pathname: string;
    title: string;
    width: number;
    height: number;
    minWidth: number;
    minHeight: number;
    resizable: boolean;
    alwaysOnTop: boolean;
    skipTaskbar: boolean;
    placement: 'anchor' | 'bounds';
    anchorMargin: number;
    closeOnDeactivate: boolean;
    emitBoundsChanges: boolean;
}

export const PANEL_PAGES = Object.freeze({
    quick: {
        pathname: 'quick.html',
        title: 'DDC/CI',
        width: 500,
        height: 200,
        minWidth: 0,
        minHeight: 0,
        resizable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        placement: 'anchor',
        anchorMargin: 8,
        closeOnDeactivate: true,
        emitBoundsChanges: false,
    },
    control: {
        pathname: 'control.html',
        title: 'DDC/CI',
        width: 760,
        height: 720,
        minWidth: 680,
        minHeight: 560,
        resizable: true,
        alwaysOnTop: false,
        skipTaskbar: false,
        placement: 'bounds',
        anchorMargin: 0,
        closeOnDeactivate: false,
        emitBoundsChanges: true,
    },
} satisfies Record<PanelPage, PanelPageOptions>);
