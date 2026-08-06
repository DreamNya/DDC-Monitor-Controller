import type { BrowserWindow } from '@webviewjs/webview';
import koffi from 'koffi';

const WM_NCLBUTTONDOWN = 0x00a1;
const HTCAPTION = 2;

interface User32Library {
    func(signature: string): unknown;
}

let user32Library: User32Library | undefined;
let releaseCapture: (() => boolean) | undefined;
let sendMessageW: ((handle: bigint, message: number, wParam: number, lParam: number) => number | bigint) | undefined;

export function startNativeWindowDrag(window: BrowserWindow): void {
    if (process.platform !== 'win32' || window.isDisposed()) {
        return;
    }

    const handle = window.getNativeHandle();

    if (handle === 0n) {
        return;
    }

    user32Library ??= koffi.load('user32.dll') as unknown as User32Library;
    releaseCapture ??= user32Library.func('bool ReleaseCapture(void)') as () => boolean;
    sendMessageW ??= user32Library.func(
        'intptr_t SendMessageW(void *hWnd, uint32_t Msg, uintptr_t wParam, intptr_t lParam)',
    ) as (handle: bigint, message: number, wParam: number, lParam: number) => number | bigint;

    releaseCapture();
    sendMessageW(handle, WM_NCLBUTTONDOWN, HTCAPTION, 0);
}
