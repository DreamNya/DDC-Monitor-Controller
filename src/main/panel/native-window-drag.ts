import type { BrowserWindow } from '@webviewjs/webview';
import { getNativeAddon } from '../native-addon.ts';

export function startNativeWindowDrag(window: BrowserWindow): void {
    if (process.platform !== 'win32' || window.isDisposed()) {
        return;
    }

    const handle = window.getNativeHandle();

    if (handle === 0n) {
        return;
    }

    getNativeAddon().startWindowDrag(handle);
}
