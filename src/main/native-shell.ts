import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface NativeWindowBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

export type NativeShellEvent =
    | { type: 'tray-primary-click'; x: number; y: number }
    | { type: 'tray-command'; id: string }
    | { type: 'web-message'; message: string }
    | { type: 'window-closed'; id: string }
    | { type: 'window-bounds'; id: string; bounds: NativeWindowBounds }
    | { type: 'error'; message: string };

export interface NativeShellInitializeOptions {
    rendererRoot: string;
    webviewDataDirectory: string;
    iconPath: string;
    trayTooltip: string;
    development: boolean;
}

export interface NativeWindowOpenOptions {
    id: string;
    pathname: string;
    title: string;
    width: number;
    height: number;
    minWidth: number;
    minHeight: number;
    uiScalePercent: number;
    anchorMargin: number;
    resizable: boolean;
    alwaysOnTop: boolean;
    skipTaskbar: boolean;
    closeOnDeactivate: boolean;
    emitBoundsChanges: boolean;
    placement: 'center' | 'anchor' | 'bounds';
    x?: number;
    y?: number;
    initialBounds?: NativeWindowBounds | null;
}

export type NativeTrayMenuItem =
    | {
          type: 'item';
          id: string;
          label: string;
          enabled?: boolean;
          checked?: boolean;
      }
    | { type: 'separator' };

interface WebViewNativeAddon {
    initialize(options: NativeShellInitializeOptions, eventCallback: (event: NativeShellEvent) => void): void;
    openWindow(options: NativeWindowOpenOptions): void;
    closeWindow(): void;
    startWindowDrag(): void;
    postWebMessage(message: string): void;
    setWindowScale(percent: number): void;
    reload(): void;
    executeScript(script: string): void;
    setTrayMenu(items: NativeTrayMenuItem[]): void;
    openPath(targetPath: string): void;
    shutdown(): void;
}

let cachedAddon: WebViewNativeAddon | undefined;

export class NativeShell {
    readonly #addon = getWebViewNativeAddon();
    #initialized = false;

    initialize(options: NativeShellInitializeOptions, eventCallback: (event: NativeShellEvent) => void): void {
        if (this.#initialized) {
            return;
        }
        this.#addon.initialize(options, eventCallback);
        this.#initialized = true;
    }

    openWindow(options: NativeWindowOpenOptions): void {
        this.#addon.openWindow(options);
    }
    closeWindow(): void {
        this.#addon.closeWindow();
    }
    startWindowDrag(): void {
        this.#addon.startWindowDrag();
    }
    postWebMessage(message: string): void {
        this.#addon.postWebMessage(message);
    }
    setWindowScale(percent: number): void {
        this.#addon.setWindowScale(percent);
    }
    reload(): void {
        this.#addon.reload();
    }
    executeScript(script: string): void {
        this.#addon.executeScript(script);
    }
    setTrayMenu(items: NativeTrayMenuItem[]): void {
        this.#addon.setTrayMenu(items);
    }
    openPath(targetPath: string): void {
        this.#addon.openPath(targetPath);
    }
    shutdown(): void {
        if (!this.#initialized) {
            return;
        }
        this.#initialized = false;
        this.#addon.shutdown();
    }
}

function getWebViewNativeAddon(): WebViewNativeAddon {
    if (cachedAddon) {
        return cachedAddon;
    }
    if (process.platform !== 'win32') {
        throw new Error('WebViewNative.node 仅支持 Windows');
    }

    const addonPath = resolveNativeAddonPath();
    if (!fs.existsSync(addonPath)) {
        throw new Error(
            [`找不到原生模块：${addonPath}`, '请先执行 npm run build:native，然后重新执行 npm run build'].join('\n'),
        );
    }

    try {
        const require = createRequire(import.meta.url);
        cachedAddon = require(addonPath) as WebViewNativeAddon;
        return cachedAddon;
    } catch (error) {
        throw new Error(
            [
                `无法加载 WebViewNative.node：${addonPath}`,
                '请确认原生模块架构与 Node.js 一致，并且 Microsoft Edge WebView2 Runtime 已安装',
                `底层错误：${toErrorMessage(error)}`,
            ].join('\n'),
            { cause: error },
        );
    }
}

function resolveNativeAddonPath(): string {
    const override = process.env.WEBVIEW_NATIVE_ADDON;
    if (override) {
        return path.resolve(override);
    }
    const mainDirectory = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(mainDirectory, './native/WebViewNative.node');
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
