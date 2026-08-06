import { type Application, type BrowserWindow, type WebContext, type Webview } from '@webviewjs/webview';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppState } from '../../shared/model';
import type { AppController } from '../app-controller';
import type { createResourceServer } from '../resource-server';
import { runBackground } from '../utils/run-background';
import { startNativeWindowDrag } from './native-window-drag';
import { createPanelBridge } from './panel-bridge';
import { PANEL_PAGES, type PanelPage } from './panel-config';
import { positionQuickPanel, readControlWindowBounds, restoreControlWindowBounds } from './window-placement';

type ResourceServer = Awaited<ReturnType<typeof createResourceServer>>;

export interface PanelManagerOptions {
    app: Application;
    appController: AppController;
    resourceServer: ResourceServer;
    assetsRoot: string;
    webviewDataDirectory: string;
}

export class PanelManager {
    readonly #app: Application;
    readonly #appController: AppController;
    readonly #resourceServer: ResourceServer;
    readonly #assetsRoot: string;
    readonly #webviewDataDirectory: string;

    #window: BrowserWindow | undefined;
    #webview: Webview | undefined;
    #context: WebContext | undefined;
    #page: PanelPage | undefined;
    #opening: Promise<void> | undefined;
    #destroying = false;
    #applicationExiting = false;
    #controlWindowBoundsTimer: ReturnType<typeof setTimeout> | undefined;
    #appIcon: Buffer | undefined;

    constructor(options: PanelManagerOptions) {
        this.#app = options.app;
        this.#appController = options.appController;
        this.#resourceServer = options.resourceServer;
        this.#assetsRoot = options.assetsRoot;
        this.#webviewDataDirectory = options.webviewDataDirectory;
    }

    requestOpen(page: PanelPage = 'control', x?: number, y?: number): void {
        if (this.#applicationExiting || this.#opening) {
            return;
        }

        this.#opening = this.#open(page, x, y);
        void this.#opening
            .catch((error) => {
                console.error('打开控制面板失败：', error);

                if (!this.#applicationExiting) {
                    this.destroy();
                }
            })
            .finally(() => {
                this.#opening = undefined;
            });
    }

    prepareForApplicationExit(): void {
        this.#applicationExiting = true;
        this.#clearBoundsSaveTimer();
    }

    destroy(): void {
        if (this.#applicationExiting || this.#destroying) {
            return;
        }

        this.#destroying = true;
        this.#clearBoundsSaveTimer();

        try {
            this.#webview?.dispose();
            this.#window?.dispose();
            this.#context?.dispose();
        } catch (error) {
            console.warn('释放控制面板资源时发生错误：', error);
        } finally {
            this.#webview = undefined;
            this.#window = undefined;
            this.#context = undefined;
            this.#page = undefined;
            this.#destroying = false;
        }
    }

    pushState(state: AppState): void {
        if (this.#applicationExiting) {
            return;
        }

        const webview = this.#webview;

        if (!webview || webview.isDisposed()) {
            return;
        }

        try {
            const payload = JSON.stringify(state)
                .replaceAll('<', '\\u003c')
                .replaceAll('\u2028', '\\u2028')
                .replaceAll('\u2029', '\\u2029');

            webview.evaluateScript(`globalThis.__monitorStateChanged?.(${payload});`);
        } catch {
            // WebView 正在关闭或尚未初始化时，页面的初始 getState 会补齐状态
        }
    }

    reloadPageForDevelopment(): void {
        if (this.#applicationExiting) {
            return;
        }

        const window = this.#window;
        const oldWebview = this.#webview;
        const context = this.#context;
        const page = this.#page;

        if (!window || !oldWebview || !context || !page || window.isDisposed() || oldWebview.isDisposed()) {
            return;
        }

        const pageOptions = PANEL_PAGES[page];
        const pageUrl = `${this.#resourceServer.getUrl(pageOptions.pathname)}?development=${Date.now()}`;

        console.log(`正在重新创建 ${page} WebView：${pageUrl}`);

        try {
            this.#webview = undefined;
            oldWebview.dispose();

            const newWebview = window.createWebview({
                url: pageUrl,
                webContext: context,
                enableDevtools: true,
            });

            this.#webview = newWebview;
            this.#exposeBridge(newWebview);
            this.#bindWebviewEvents(newWebview, window, page);
            newWebview.focus();
        } catch (error) {
            console.error('重新创建开发 WebView 失败：', error);
            this.destroy();
        }
    }

    reloadStylesheetsForDevelopment(): void {
        if (this.#applicationExiting) {
            return;
        }

        const webview = this.#webview;

        if (!webview || webview.isDisposed()) {
            return;
        }

        try {
            const result = webview.evaluateScript(`
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

    async #open(page: PanelPage, x?: number, y?: number): Promise<void> {
        if (this.#applicationExiting) {
            return;
        }

        // 面板打开属于低频边界；先刷新实际显示器状态，避免物理按键或其他软件
        // 修改后仍展示旧缓存；刷新失败时 AppController 会保留最后一份可用快照
        const refreshedState = await this.#appController.refreshMonitors(false);

        if (this.#applicationExiting) {
            return;
        }

        const pageOptions = PANEL_PAGES[page];

        if (this.#canReuseCurrentPanel(page)) {
            const window = this.#window as BrowserWindow;
            const webview = this.#webview as Webview;

            if (page === 'quick' && x !== undefined && y !== undefined) {
                positionQuickPanel(window, x, y);
            }

            window.show();

            if (pageOptions.maximized) {
                window.setMaximized(true);
            }

            window.focus();
            webview.focus();
            this.pushState(refreshedState);
            return;
        }

        this.destroy();

        this.#appIcon ??= await fs.readFile(path.resolve(this.#assetsRoot, 'tray-icon.png'));

        if (this.#applicationExiting) {
            return;
        }

        const context = this.#app.createWebContext({
            dataDirectory: this.#webviewDataDirectory,
        });

        const window = this.#app.createBrowserWindow({
            ...pageOptions,
            logical: true,
            visible: false,
            resizable: false,
            maximizable: true,
            minimizable: true,
            windowsTaskbarIcon: { data: this.#appIcon },
            windowsClassName: page === 'control' ? 'DDCMonitorControllerWindow' : 'DDCMonitorControllerQuickWindow',
        });

        const pageUrl = this.#resourceServer.getUrl(pageOptions.pathname);

        console.log(`正在打开${pageOptions.title}：${pageUrl}`);

        const webview = window.createWebview({
            url: pageUrl,
            webContext: context,
            enableDevtools: process.env.NODE_ENV !== 'production',
        });

        this.#window = window;
        this.#webview = webview;
        this.#context = context;
        this.#page = page;

        this.#configureWindow(window, page);
        this.#exposeBridge(webview);
        this.#bindWebviewEvents(webview, window, page);
        this.#bindWindowClose(window, page);
        this.#placeWindow(window, page, x, y);

        window.show();

        if (pageOptions.maximized) {
            window.setMaximized(true);
        }

        window.focus();
    }

    #canReuseCurrentPanel(page: PanelPage): boolean {
        return (
            this.#page === page &&
            this.#window !== undefined &&
            this.#webview !== undefined &&
            !this.#window.isDisposed() &&
            !this.#webview.isDisposed()
        );
    }

    #configureWindow(window: BrowserWindow, page: PanelPage): void {
        if (page !== 'control') {
            return;
        }

        window.setResizable(true);
        window.setMinSize(500, 400, true);
        window.on('move', () => this.#scheduleControlWindowBoundsSave(window));
        window.on('resize', () => this.#scheduleControlWindowBoundsSave(window));
    }

    #bindWindowClose(window: BrowserWindow, page: PanelPage): void {
        window.on('close', () => {
            if (this.#applicationExiting) {
                return;
            }

            if (page === 'control') {
                this.#persistControlWindowBounds(window);
            }

            setImmediate(() => {
                if (!this.#applicationExiting && this.#window === window) {
                    this.destroy();
                }
            });
        });
    }

    #placeWindow(window: BrowserWindow, page: PanelPage, x?: number, y?: number): void {
        if (page === 'quick' && x !== undefined && y !== undefined) {
            positionQuickPanel(window, x, y);
            return;
        }

        if (page === 'control') {
            const restored = restoreControlWindowBounds(window, this.#appController.getControlWindowBounds());

            if (!restored) {
                window.center();
            }
            return;
        }

        if (!PANEL_PAGES[page].maximized) {
            window.center();
        }
    }

    #exposeBridge(webview: Webview): void {
        webview.expose(
            'monitor',
            createPanelBridge({
                appController: this.#appController,
                openControlPanel: () => this.requestOpen('control'),
                closePanel: () => this.destroy(),
                startControlWindowDrag: () => this.#startControlWindowDrag(),
            }),
        );
    }

    #startControlWindowDrag(): void {
        const window = this.#window;

        if (this.#page !== 'control' || !window) {
            return;
        }

        startNativeWindowDrag(window);
    }

    #bindWebviewEvents(webview: Webview, window: BrowserWindow, page: PanelPage): void {
        const pageOptions = PANEL_PAGES[page];

        webview.on('page-load-started', ({ url }) => {
            console.log(`${pageOptions.title}开始加载：${url ?? '未知地址'}`);
        });

        webview.on('page-load-finished', ({ url }) => {
            console.log(`${pageOptions.title}加载完成：${url ?? '未知地址'}`);

            if (this.#window !== window || this.#webview !== webview || window.isDisposed() || webview.isDisposed()) {
                return;
            }

            if (pageOptions.maximized) {
                window.setMaximized(true);
            }

            window.focus();
            webview.focus();
        });
    }

    #scheduleControlWindowBoundsSave(window: BrowserWindow): void {
        if (this.#applicationExiting) {
            return;
        }

        this.#clearBoundsSaveTimer();

        this.#controlWindowBoundsTimer = setTimeout(() => {
            this.#controlWindowBoundsTimer = undefined;
            this.#persistControlWindowBounds(window);
        }, 300);
    }

    #persistControlWindowBounds(window: BrowserWindow): void {
        if (this.#applicationExiting || this.#page !== 'control' || this.#window !== window) {
            return;
        }

        const bounds = readControlWindowBounds(window);

        if (!bounds) {
            return;
        }

        runBackground('保存控制窗口位置', () => {
            return this.#appController.saveControlWindowBounds(bounds);
        });
    }

    #clearBoundsSaveTimer(): void {
        if (this.#controlWindowBoundsTimer === undefined) {
            return;
        }

        clearTimeout(this.#controlWindowBoundsTimer);
        this.#controlWindowBoundsTimer = undefined;
    }
}
