import type { BrowserWindow } from '@webviewjs/webview';
import type { ControlWindowBounds, UiScalePercent } from '../../shared/model';
import { DEFAULT_UI_SCALE_PERCENT, scaleUiDimension, unscaleUiDimension } from '../../shared/ui-scale';

export function positionQuickPanel(window: BrowserWindow, trayX: number, trayY: number): void {
    const screenMargin = 8;
    const taskbarOffset = 70;
    const { width, height } = window.getOuterSize(false);

    const monitor =
        window.getAvailableMonitors().find(({ position, size }) => {
            return (
                trayX >= position.x &&
                trayX < position.x + size.width &&
                trayY >= position.y &&
                trayY < position.y + size.height
            );
        }) ?? window.getPrimaryMonitor();

    let panelX = Math.round(trayX - width / 2);
    let panelY = Math.round(trayY - height - 58);

    if (monitor) {
        const minimumX = monitor.position.x + screenMargin;
        const maximumX = monitor.position.x + monitor.size.width - width - screenMargin;

        panelX = Math.min(Math.max(panelX, minimumX), maximumX);
        panelY = monitor.size.height - taskbarOffset - height;
    }

    window.setPosition(panelX, panelY, false);
}

export function restoreControlWindowBounds(
    window: BrowserWindow,
    bounds: ControlWindowBounds | null,
    uiScalePercent: UiScalePercent = DEFAULT_UI_SCALE_PERCENT,
): boolean {
    if (!bounds) {
        return false;
    }

    window.setSize(
        scaleUiDimension(bounds.width, uiScalePercent),
        scaleUiDimension(bounds.height, uiScalePercent),
        true,
    );
    window.setPosition(bounds.x, bounds.y, true);

    return hasVisibleWindowArea(window);
}

export function readControlWindowBounds(
    window: BrowserWindow,
    uiScalePercent: UiScalePercent = DEFAULT_UI_SCALE_PERCENT,
): ControlWindowBounds | undefined {
    if (window.isDisposed() || window.isMaximized() || window.isMinimized()) {
        return undefined;
    }

    const { x, y } = window.getPosition(true);
    const { width, height } = window.getInnerSize(true);

    return {
        x: Math.round(x),
        y: Math.round(y),
        width: unscaleUiDimension(width, uiScalePercent),
        height: unscaleUiDimension(height, uiScalePercent),
    };
}

function hasVisibleWindowArea(window: BrowserWindow): boolean {
    const position = window.getPosition(false);
    const size = window.getOuterSize(false);
    const minimumVisibleSize = 64;

    return window.getAvailableMonitors().some((monitor) => {
        const visibleWidth =
            Math.min(position.x + size.width, monitor.position.x + monitor.size.width) -
            Math.max(position.x, monitor.position.x);

        const visibleHeight =
            Math.min(position.y + size.height, monitor.position.y + monitor.size.height) -
            Math.max(position.y, monitor.position.y);

        return visibleWidth >= minimumVisibleSize && visibleHeight >= minimumVisibleSize;
    });
}
