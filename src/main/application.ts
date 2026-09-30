import path from 'node:path';
import { HttpApiServer } from '../api/http-api-server.ts';
import { PublicApiDispatcher } from '../api/public-api-dispatcher.ts';
import type { PublicApiResponse } from '../api/public-api.ts';
import type { AppState } from '../shared/model';
import { AppController } from './app-controller';
import { registerDevelopmentMessageHandler } from './development';
import { NativeShell, type NativeShellEvent } from './native-shell';
import { PanelManager } from './panel/panel-manager';
import type { RuntimePaths } from './runtime-paths';
import type { FileLogger } from './services/file-logger';
import { AutoStartService } from './services/auto-start-service';
import { createGlobalHotkeyBindings, GlobalHotkeyRouter } from './services/global-hotkeys';
import type { SingleInstanceLock } from './single-instance';
import { TrayController } from './tray-controller';
import { runBackground } from './utils/run-background';

export interface DesktopApplicationOptions {
    paths: RuntimePaths;
    fileLogger: FileLogger;
    singleInstanceLock: SingleInstanceLock;
}

export class DesktopApplication {
    readonly #paths: RuntimePaths;
    readonly #singleInstanceLock: SingleInstanceLock;
    readonly #appController: AppController;
    readonly #publicApiDispatcher: PublicApiDispatcher;
    readonly #httpApiServer: HttpApiServer;
    readonly #nativeShell = new NativeShell();

    #panelManager: PanelManager | undefined;
    #trayController: TrayController | undefined;
    #unregisterDevelopmentHandler: (() => void) | undefined;
    #desktopReady = false;
    #requestedOpen = false;
    #quitting = false;
    #globalHotkeySignature = '';
    #nativeTheme: AppState['settings']['theme'] | undefined;
    readonly #globalHotkeyRouter = new GlobalHotkeyRouter();

    constructor(options: DesktopApplicationOptions) {
        this.#paths = options.paths;
        this.#singleInstanceLock = options.singleInstanceLock;

        const autoStartService = new AutoStartService({
            launcherPath: this.#paths.launcherPath,
        });

        this.#appController = new AppController({
            onLogEnabledChanged: (enabled) => {
                options.fileLogger.setEnabled(enabled);
            },
            setAutoStartRegistration: (enabled) => autoStartService.setEnabled(enabled),
            configureExternalApi: (configuration) => this.#httpApiServer.configure(configuration),
        });

        this.#publicApiDispatcher = new PublicApiDispatcher(this.#appController);
        this.#httpApiServer = new HttpApiServer({ executor: this.#publicApiDispatcher });
    }

    async start(): Promise<void> {
        await this.#appController.initialize({ mode: 'desktop' });
        this.#singleInstanceLock.setApiRequestHandler((request) => this.#publicApiDispatcher.execute(request));
        const initialState = this.#appController.getState();

        try {
            await this.#httpApiServer.configure({
                enabled: initialState.settings.externalApiEnabled,
                port: initialState.settings.externalApiPort,
            });
        } catch (error) {
            console.error(`启动本地 HTTP API 失败（127.0.0.1:${initialState.settings.externalApiPort}）：`, error);
        }

        const panelManager = new PanelManager({
            appController: this.#appController,
            nativeShell: this.#nativeShell,
            openLogFolder: () => {
                const logDirectory = path.resolve(this.#paths.distributionRoot, 'log');
                this.#nativeShell.openPath(logDirectory);
            },
            setGlobalHotkeyCaptureActive: (active) => this.#setGlobalHotkeyCaptureActive(active),
        });

        const trayController = new TrayController({
            appController: this.#appController,
            panelManager,
            nativeShell: this.#nativeShell,
            webviewDataDirectory: this.#paths.webviewDataDirectory,
            programDirectory:
                process.env.NODE_ENV === 'development' || !this.#paths.launcherPath
                    ? this.#paths.distributionRoot
                    : path.dirname(this.#paths.launcherPath),
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

        this.#syncNativeTheme(initialState);
        this.#syncGlobalHotkeys(initialState);

        trayController.update(initialState);

        this.#appController.setStateListener((change) => {
            const { state } = change;
            trayController.update(state);
            this.#syncNativeTheme(state);
            this.#syncGlobalHotkeys(state);
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

    executePublicApi(request: unknown): Promise<PublicApiResponse> {
        return this.#publicApiDispatcher.execute(request);
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

            try {
                await this.#httpApiServer.stop();
            } catch (error) {
                console.error('退出应用时停止本地 HTTP API 失败：', error);
            }

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

    #setGlobalHotkeyCaptureActive(active: boolean): void {
        if (this.#globalHotkeyRouter.captureActive === active) {
            return;
        }

        this.#globalHotkeyRouter.setCaptureActive(active, this.#nativeShell.getEventSequence());

        if (!active) {
            // 捕获期间暂缓配置同步；结束时只提交发生变化的绑定。
            this.#syncGlobalHotkeys(this.#appController.getState());
        }
    }

    #syncNativeTheme(state: AppState): void {
        const theme = state.settings.theme;
        if (theme === this.#nativeTheme) {
            return;
        }

        this.#nativeTheme = theme;
        this.#nativeShell.setTheme(theme);
    }

    #syncGlobalHotkeys(state: AppState): void {
        if (this.#globalHotkeyRouter.captureActive) {
            return;
        }

        const signature = JSON.stringify(
            state.settings.advancedVcpCommands.map(({ id, name, shortcut }) => [id, name, shortcut]),
        );

        if (signature === this.#globalHotkeySignature) {
            return;
        }

        const bindings = createGlobalHotkeyBindings(state.settings.advancedVcpCommands);

        this.#globalHotkeySignature = signature;
        this.#nativeShell.setGlobalHotkeys(bindings);
    }

    #handleNativeShellEvent(event: NativeShellEvent): void {
        switch (event.type) {
            case 'tray-primary-click':
                this.#panelManager?.requestOpen('quick', event.x, event.y);
                break;

            case 'tray-command':
                this.#trayController?.handleMenuClick(event.id, event.x, event.y);
                break;

            case 'global-hotkey': {
                const route = this.#globalHotkeyRouter.route(event.sequence);
                if (route === 'ignore') {
                    break;
                }
                if (route === 'capture') {
                    const command = this.#appController
                        .getState()
                        .settings.advancedVcpCommands.find(({ id }) => id === event.id);
                    if (command?.shortcut) {
                        this.#panelManager?.pushCapturedShortcut(command.shortcut);
                    }
                    break;
                }
                runBackground('执行高级 VCP 全局快捷命令', async () => {
                    const results = await this.#appController.executeAdvancedVcpHotkey(event.id);
                    if (results.some((result) => result.status === 'fulfilled' && result.value.closeWebViewAfter)) {
                        this.#panelManager?.destroy();
                    }
                    for (const result of results) {
                        if (result.status === 'rejected') {
                            console.error('执行高级 VCP 全局快捷命令失败：', result.reason);
                        }
                    }
                });
                break;
            }

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
                if (event.message.includes('全局快捷键')) {
                    this.#panelManager?.pushToast(event.message);
                }
                break;
        }
    }
}
