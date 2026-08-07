import { Application } from '@webviewjs/webview';
import fs from 'node:fs/promises';
import { AppController } from './app-controller';
import { registerDevelopmentMessageHandler } from './development';
import { PanelManager } from './panel/panel-manager';
import { createResourceServer } from './resource-server';
import type { RuntimePaths } from './runtime-paths';
import type { FileLogger } from './services/file-logger';
import type { SingleInstanceLock } from './single-instance';
import { TrayController } from './tray-controller';

export interface DesktopApplicationOptions {
    paths: RuntimePaths;
    fileLogger: FileLogger;
    singleInstanceLock: SingleInstanceLock;
}

export class DesktopApplication {
    readonly #paths: RuntimePaths;
    readonly #singleInstanceLock: SingleInstanceLock;
    readonly #app = new Application();
    readonly #appController: AppController;

    #panelManager: PanelManager | undefined;
    #trayController: TrayController | undefined;
    #resourceServer: Awaited<ReturnType<typeof createResourceServer>> | undefined;
    #unregisterDevelopmentHandler: (() => void) | undefined;
    #desktopReady = false;
    #requestedOpen = false;
    #quitting = false;

    constructor(options: DesktopApplicationOptions) {
        this.#paths = options.paths;
        this.#singleInstanceLock = options.singleInstanceLock;
        this.#appController = new AppController({
            onLogEnabledChanged: (enabled) => {
                options.fileLogger.setEnabled(enabled);
            },
        });
    }

    async start(): Promise<void> {
        await this.#app.whenReady({ interval: 32, ref: true });

        this.#createAnchorWindow();
        await fs.mkdir(this.#paths.webviewDataDirectory, { recursive: true });
        await this.#appController.initialize();
        this.#resourceServer = await createResourceServer(this.#paths.rendererRoot);

        const panelManager = new PanelManager({
            app: this.#app,
            appController: this.#appController,
            resourceServer: this.#resourceServer,
            assetsRoot: this.#paths.assetsRoot,
            webviewDataDirectory: this.#paths.webviewDataDirectory,
        });

        const trayController = new TrayController({
            app: this.#app,
            appController: this.#appController,
            panelManager,
            assetsRoot: this.#paths.assetsRoot,
            webviewDataDirectory: this.#paths.webviewDataDirectory,
            quitApplication: () => this.quit(),
        });

        this.#panelManager = panelManager;
        this.#trayController = trayController;

        await trayController.initialize(this.#appController.getState().settings.autoEnabled);

        this.#appController.setStateListener((change) => {
            const { state } = change;
            trayController.updateAutoEnabled(state.settings.autoEnabled);
            panelManager.pushState(change);
        });

        if (this.#quitting) {
            return;
        }

        this.#desktopReady = true;

        if (this.#requestedOpen) {
            this.#requestedOpen = false;
            panelManager.requestOpen('control');
        }

        console.log('显示器控制器已启动，正在系统托盘中运行');

        this.#unregisterDevelopmentHandler = registerDevelopmentMessageHandler({
            reloadStylesheets: () => panelManager.reloadStylesheetsForDevelopment(),
            reloadPage: () => panelManager.reloadPageForDevelopment(),
            shutdown: () => this.quit(),
        });
    }

    requestControlPanel(): void {
        if (this.#quitting) {
            return;
        }

        if (!this.#desktopReady || !this.#panelManager) {
            this.#requestedOpen = true;
            return;
        }

        this.#requestedOpen = false;
        this.#panelManager.requestOpen('control');
    }

    /**
     * 请求退出
     *
     * 这里只负责设置一次性退出标记，并把真正的异步清理移出当前原生事件回调栈
     */
    quit(): void {
        if (this.#quitting) {
            return;
        }

        this.#quitting = true;
        this.#desktopReady = false;
        this.#requestedOpen = false;

        setImmediate(() => {
            void this.#performQuit();
        });
    }

    async #performQuit(): Promise<void> {
        const resourceServer = this.#resourceServer;
        this.#resourceServer = undefined;

        try {
            this.#unregisterDevelopmentHandler?.();
            this.#unregisterDevelopmentHandler = undefined;

            this.#panelManager?.prepareForApplicationExit();
            this.#trayController?.stop();

            const results = await Promise.allSettled([
                this.#appController.dispose(),
                resourceServer?.close(),
                this.#singleInstanceLock.close(),
            ]);

            for (const result of results) {
                if (result.status === 'rejected') {
                    console.error('退出应用时释放资源失败：', result.reason);
                }
            }
        } catch (error) {
            console.error('准备退出应用时发生错误：', error);
        } finally {
            this.#app.exit();
        }
    }

    #createAnchorWindow(): void {
        // 保留一个不含 WebView、永不显示的原生窗口，使系统托盘持续存在
        this.#app.createBrowserWindow({
            title: 'DDC Monitor Controller Anchor',
            width: 1,
            height: 1,
            x: -32_000,
            y: -32_000,
            logical: true,
            visible: false,
            focused: false,
            decorations: false,
            maximizable: false,
            minimizable: false,
            windowsSkipTaskbar: true,
            windowsClassName: 'DDCMonitorControllerAnchorWindow',
        });
    }
}
