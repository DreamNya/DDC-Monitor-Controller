import path from 'node:path';
import { AppController } from './app-controller';
import { registerDevelopmentMessageHandler } from './development';
import { NativeShell, type NativeShellEvent } from './native-shell';
import { PanelManager } from './panel/panel-manager';
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
    readonly #appController: AppController;
    readonly #nativeShell = new NativeShell();

    #panelManager: PanelManager | undefined;
    #trayController: TrayController | undefined;
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
        await this.#appController.initialize();
        const initialState = this.#appController.getState();

        const panelManager = new PanelManager({
            appController: this.#appController,
            nativeShell: this.#nativeShell,
        });

        const trayController = new TrayController({
            appController: this.#appController,
            panelManager,
            nativeShell: this.#nativeShell,
            webviewDataDirectory: this.#paths.webviewDataDirectory,
            quitApplication: () => this.quit(),
        });

        this.#panelManager = panelManager;
        this.#trayController = trayController;

        this.#nativeShell.initialize(
            {
                rendererRoot: this.#paths.rendererRoot,
                webviewDataDirectory: this.#paths.webviewDataDirectory,
                iconPath: path.resolve(this.#paths.assetsRoot, 'tray-icon.ico'),
                trayTooltip: 'DDC Monitor Controller',
                development: process.env.NODE_ENV !== 'production',
            },
            (event) => this.#handleNativeShellEvent(event),
        );

        trayController.updateAutoEnabled(initialState.settings.autoEnabled);

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
        try {
            this.#unregisterDevelopmentHandler?.();
            this.#unregisterDevelopmentHandler = undefined;

            this.#panelManager?.prepareForApplicationExit();
            this.#trayController?.stop();

            const results = await Promise.allSettled([this.#appController.dispose(), this.#singleInstanceLock.close()]);

            for (const result of results) {
                if (result.status === 'rejected') {
                    console.error('退出应用时释放资源失败：', result.reason);
                }
            }
        } catch (error) {
            console.error('准备退出应用时发生错误：', error);
        } finally {
            this.#nativeShell.shutdown();
        }
    }

    #handleNativeShellEvent(event: NativeShellEvent): void {
        switch (event.type) {
            case 'tray-primary-click':
                this.#panelManager?.requestOpen('quick', event.x, event.y);
                break;

            case 'tray-command':
                this.#trayController?.handleMenuClick(event.id);
                break;

            case 'web-message':
                this.#panelManager?.handleWebMessage(event.message);
                break;

            case 'window-closed':
                this.#panelManager?.handleWindowClosed(event.id);
                break;

            case 'window-bounds':
                this.#panelManager?.handleWindowBounds(event.id, event.bounds);
                break;

            case 'error':
                console.error(`Native Shell：${event.message}`);
                break;
        }
    }
}
