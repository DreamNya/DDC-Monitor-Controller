import { type Application, type BrowserWindow, type WebContext, type Webview } from '@webviewjs/webview';
import type { AppStateChange, UiScalePercent } from '../../shared/model.ts';
import { scaleUiDimension, toUiScaleFactor, unscaleUiDimension } from '../../shared/ui-scale.ts';
import type { AppController } from '../app-controller.ts';
import type { ResourceServer } from '../resource-server.ts';
import { runBackground } from '../utils/run-background.ts';
import { startNativeWindowDrag } from './native-window-drag.ts';
import { createPanelBridge } from './panel-bridge.ts';
import { CONTROL_PANEL_MIN_SIZE, getScaledPanelSize, PANEL_PAGES, type PanelPage } from './panel-config.ts';
import { positionQuickPanel, readControlWindowBounds, restoreControlWindowBounds } from './window-placement.ts';

export interface PanelSessionOptions {
    app: Application;
    appController: AppController;
    resourceServer: ResourceServer;
    appIcon: Buffer;
    webviewDataDirectory: string;
    page: PanelPage;
    uiScalePercent: UiScalePercent;
    x?: number;
    y?: number;
    onOpenControlPanel(): void;
    onCloseRequested(): void;
}

export class PanelSession {
    readonly #appController: AppController;
    readonly #resourceServer: ResourceServer;
    readonly #context: WebContext;
    readonly #window: BrowserWindow;
    readonly #page: PanelPage;
    readonly #onOpenControlPanel: () => void;
    readonly #onCloseRequested: () => void;

    #webview: Webview;
    #uiScalePercent: UiScalePercent;
    #quickPanelAnchor: { x: number; y: number } | undefined;
    #controlWindowBoundsTimer: ReturnType<typeof setTimeout> | undefined;
    #applicationExiting = false;
    #disposed = false;

    constructor(options: PanelSessionOptions) {
        this.#appController = options.appController;
        this.#resourceServer = options.resourceServer;
        this.#page = options.page;
        this.#uiScalePercent = options.uiScalePercent;
        this.#quickPanelAnchor =
            options.page === 'quick' && options.x !== undefined && options.y !== undefined
                ? { x: options.x, y: options.y }
                : undefined;
        this.#onOpenControlPanel = options.onOpenControlPanel;
        this.#onCloseRequested = options.onCloseRequested;

        this.#context = options.app.createWebContext({
            dataDirectory: options.webviewDataDirectory,
        });

        const pageOptions = PANEL_PAGES[options.page];
        const { pathname, ...windowOptions } = pageOptions;
        const windowSize = getScaledPanelSize(options.page, options.uiScalePercent);

        this.#window = options.app.createBrowserWindow({
            ...windowOptions,
            ...windowSize,
            logical: true,
            visible: false,
            maximizable: false,
            minimizable: false,
            windowsTaskbarIcon: { data: options.appIcon },
            windowsClassName:
                options.page === 'control' ? 'DDCMonitorControllerWindow' : 'DDCMonitorControllerQuickWindow',
        });

        const pageUrl = this.#resourceServer.getUrl(pathname);
        console.log(`正在打开${pageOptions.title}：${pageUrl}`);

        this.#webview = this.#window.createWebview({
            url: pageUrl,
            webContext: this.#context,
            enableDevtools: process.env.NODE_ENV !== 'production',
        });

        this.#configureWindow();
        this.#exposeBridge(this.#webview);
        this.#bindWebviewEvents(this.#webview);
        this.#bindWindowClose();
        this.#placeWindow(options.x, options.y);
        this.#setWebviewZoom(this.#webview);

        this.#window.show();
        this.#window.focus();
    }

    get page(): PanelPage {
        return this.#page;
    }

    get usable(): boolean {
        return !this.#disposed && !this.#window.isDisposed() && !this.#webview.isDisposed();
    }

    show(x?: number, y?: number, uiScalePercent = this.#uiScalePercent): void {
        if (!this.usable) {
            return;
        }

        if (this.#page === 'quick' && x !== undefined && y !== undefined) {
            this.#quickPanelAnchor = { x, y };
            positionQuickPanel(this.#window, x, y);
        }

        this.applyUiScale(uiScalePercent);
        this.#window.show();
        this.#window.focus();
        this.#webview.focus();
    }

    pushState(change: AppStateChange): void {
        if (!this.usable || this.#applicationExiting) {
            return;
        }

        this.applyUiScale(change.state.settings.uiScale[this.#page]);

        try {
            const payload = JSON.stringify(change)
                .replaceAll('<', '\\u003c')
                .replaceAll('\u2028', '\\u2028')
                .replaceAll('\u2029', '\\u2029');

            this.#webview.evaluateScript(`globalThis.__monitorStateChanged?.(${payload});`);
        } catch {
            // WebView 正在关闭或尚未初始化时，页面的初始 getState 会补齐状态
        }
    }

    reloadPageForDevelopment(): void {
        if (!this.usable || this.#applicationExiting) {
            return;
        }

        const oldWebview = this.#webview;
        const pageOptions = PANEL_PAGES[this.#page];
        const pageUrl = `${this.#resourceServer.getUrl(pageOptions.pathname)}?development=${Date.now()}`;

        console.log(`正在重新创建 ${this.#page} WebView：${pageUrl}`);

        try {
            oldWebview.dispose();

            const newWebview = this.#window.createWebview({
                url: pageUrl,
                webContext: this.#context,
                enableDevtools: true,
            });

            this.#webview = newWebview;
            this.#exposeBridge(newWebview);
            this.#bindWebviewEvents(newWebview);
            this.#setWebviewZoom(newWebview);
            newWebview.focus();
        } catch (error) {
            console.error('重新创建开发 WebView 失败：', error);
            this.#onCloseRequested();
        }
    }

    reloadStylesheetsForDevelopment(): void {
        if (!this.usable || this.#applicationExiting) {
            return;
        }

        try {
            const result = this.#webview.evaluateScript(`
                (() => {
                    const version = Date.now().toString();

                    for (const oldLink of document.querySelectorAll('link[rel="stylesheet"][href]')) {
                        const newLink = oldLink.cloneNode();
                        const url = new URL(oldLink.href, document.baseURI);

                        url.searchParams.set('__development', version);
                        newLink.href = url.href;

                        newLink.addEventListener('load', () => oldLink.remove(), { once: true });
                        newLink.addEventListener('error', () => newLink.remove(), { once: true });
                        oldLink.after(newLink);
                    }
                })();
            `);

            void Promise.resolve(result).catch((error: unknown) => {
                console.error('开发模式刷新样式表失败：', error);
            });
        } catch (error) {
            console.error('开发模式刷新样式表失败：', error);
        }
    }

    prepareForApplicationExit(): void {
        this.#applicationExiting = true;
        this.#clearBoundsSaveTimer();
    }

    dispose(): void {
        if (this.#disposed) {
            return;
        }

        this.#disposed = true;
        this.#clearBoundsSaveTimer();

        try {
            this.#webview.dispose();
            this.#window.dispose();
            this.#context.dispose();
        } catch (error) {
            console.warn('释放控制面板资源时发生错误：', error);
        }
    }

    applyUiScale(uiScalePercent: UiScalePercent): void {
        if (!this.usable || this.#uiScalePercent === uiScalePercent) {
            return;
        }

        const previousUiScalePercent = this.#uiScalePercent;
        const currentSize = this.#window.getInnerSize(true);

        this.#uiScalePercent = uiScalePercent;
        this.#webview.zoom(toUiScaleFactor(uiScalePercent));

        if (this.#page === 'control') {
            this.#setControlMinimumSize();
        }

        const baseWidth = unscaleUiDimension(currentSize.width, previousUiScalePercent);
        const baseHeight = unscaleUiDimension(currentSize.height, previousUiScalePercent);

        this.#window.setSize(
            scaleUiDimension(baseWidth, uiScalePercent),
            scaleUiDimension(baseHeight, uiScalePercent),
            true,
        );

        if (this.#page === 'quick' && this.#quickPanelAnchor) {
            positionQuickPanel(this.#window, this.#quickPanelAnchor.x, this.#quickPanelAnchor.y);
        }
    }

    #configureWindow(): void {
        if (this.#page !== 'control') {
            return;
        }

        this.#setControlMinimumSize();
        this.#window.on('move', () => this.#scheduleControlWindowBoundsSave());
        this.#window.on('resize', () => this.#scheduleControlWindowBoundsSave());
    }

    #setControlMinimumSize(): void {
        this.#window.setMinSize(
            scaleUiDimension(CONTROL_PANEL_MIN_SIZE.width, this.#uiScalePercent),
            scaleUiDimension(CONTROL_PANEL_MIN_SIZE.height, this.#uiScalePercent),
            true,
        );
    }

    #placeWindow(x?: number, y?: number): void {
        if (this.#page === 'quick') {
            if (x !== undefined && y !== undefined) {
                positionQuickPanel(this.#window, x, y);
            } else {
                this.#window.center();
            }
            return;
        }

        const restored = restoreControlWindowBounds(
            this.#window,
            this.#appController.getControlWindowBounds(),
            this.#uiScalePercent,
        );

        if (!restored) {
            this.#window.center();
        }
    }

    #exposeBridge(webview: Webview): void {
        webview.expose(
            'monitor',
            createPanelBridge({
                appController: this.#appController,
                openControlPanel: this.#onOpenControlPanel,
                closePanel: this.#onCloseRequested,
                startControlWindowDrag: () => this.#startControlWindowDrag(),
            }),
        );
    }

    #startControlWindowDrag(): void {
        if (this.#page === 'control' && this.usable) {
            startNativeWindowDrag(this.#window);
        }
    }

    #bindWebviewEvents(webview: Webview): void {
        const pageOptions = PANEL_PAGES[this.#page];

        webview.on('page-load-started', ({ url }) => {
            console.log(`${pageOptions.title}开始加载：${url ?? '未知地址'}`);
        });

        webview.on('page-load-finished', ({ url }) => {
            console.log(`${pageOptions.title}加载完成：${url ?? '未知地址'}`);

            if (this.#disposed || this.#webview !== webview || webview.isDisposed() || this.#window.isDisposed()) {
                return;
            }

            this.#setWebviewZoom(webview);
            this.#window.focus();
            webview.focus();
        });
    }

    #bindWindowClose(): void {
        this.#window.on('close', () => {
            if (this.#disposed || this.#applicationExiting) {
                return;
            }

            this.#persistControlWindowBounds();

            setImmediate(() => {
                if (!this.#disposed && !this.#applicationExiting) {
                    this.#onCloseRequested();
                }
            });
        });
    }

    #scheduleControlWindowBoundsSave(): void {
        if (this.#disposed || this.#applicationExiting || this.#page !== 'control') {
            return;
        }

        this.#clearBoundsSaveTimer();
        this.#controlWindowBoundsTimer = setTimeout(() => {
            this.#controlWindowBoundsTimer = undefined;
            this.#persistControlWindowBounds();
        }, 300);
    }

    #persistControlWindowBounds(): void {
        if (this.#disposed || this.#applicationExiting || this.#page !== 'control') {
            return;
        }

        const bounds = readControlWindowBounds(this.#window, this.#uiScalePercent);

        if (!bounds) {
            return;
        }

        runBackground('保存控制窗口位置', () => this.#appController.saveControlWindowBounds(bounds));
    }

    #clearBoundsSaveTimer(): void {
        if (this.#controlWindowBoundsTimer === undefined) {
            return;
        }

        clearTimeout(this.#controlWindowBoundsTimer);
        this.#controlWindowBoundsTimer = undefined;
    }

    #setWebviewZoom(webview: Webview): void {
        if (!webview.isDisposed()) {
            webview.zoom(toUiScaleFactor(this.#uiScalePercent));
        }
    }
}
