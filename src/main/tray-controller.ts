import {
    type Application,
    type ApplicationEvent,
    type MenuOptions,
    type TrayEventPayload,
    type TrayIcon,
} from '@webviewjs/webview';
import { exec } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppController } from './app-controller';
import type { PanelManager } from './panel/panel-manager';
import { runBackground } from './utils/run-background';

export interface TrayControllerOptions {
    app: Application;
    appController: AppController;
    panelManager: PanelManager;
    assetsRoot: string;
    webviewDataDirectory: string;
    quitApplication(): void;
}

function createTrayMenu(autoEnabled: boolean): MenuOptions {
    return {
        items: [
            { id: 'open', label: '打开控制面板' },
            {
                id: 'toggle-auto',
                label: autoEnabled ? '关闭自动调节' : '开启自动调节',
            },
            { id: 'apply-auto', label: '立即应用自动设置' },
            { id: 'refresh', label: '重新检测显示器' },
            { role: 'separator' },
            { id: 'open-webview', label: '打开WebView目录' },
            { role: 'separator' },
            { id: 'quit', label: '退出' },
        ],
    };
}

export class TrayController {
    readonly #app: Application;
    readonly #appController: AppController;
    readonly #panelManager: PanelManager;
    readonly #assetsRoot: string;
    readonly #webviewDataDirectory: string;
    readonly #quitApplication: () => void;

    #tray: TrayIcon | undefined;
    #lastTrayOpenAt = 0;
    #stopped = false;

    readonly #handleTrayClick = ({ button, buttonState, x, y }: TrayEventPayload): void => {
        if (this.#stopped) {
            return;
        }

        const normalizedButton = button?.toLowerCase();
        const normalizedState = buttonState?.toLowerCase();

        if (normalizedButton === 'right' || (normalizedState !== undefined && normalizedState !== 'up')) {
            return;
        }

        const now = Date.now();
        if (now - this.#lastTrayOpenAt < 250) {
            return;
        }

        this.#lastTrayOpenAt = now;
        this.#panelManager.requestOpen('quick', x, y);
    };

    readonly #handleApplicationMenuClick = ({ customMenuEvent }: ApplicationEvent): void => {
        if (this.#stopped) {
            return;
        }

        this.#handleMenuClick(customMenuEvent?.id);
    };

    constructor(options: TrayControllerOptions) {
        this.#app = options.app;
        this.#appController = options.appController;
        this.#panelManager = options.panelManager;
        this.#assetsRoot = options.assetsRoot;
        this.#webviewDataDirectory = options.webviewDataDirectory;
        this.#quitApplication = options.quitApplication;
    }

    async initialize(autoEnabled: boolean): Promise<void> {
        this.#tray = this.#app.createTrayIcon({
            id: 'monitor-controller',
            icon: { data: await fs.readFile(path.resolve(this.#assetsRoot, 'tray-icon.png')) },
            tooltip: 'DDC Monitor Controller',
            menuOnLeftClick: false,
            menuOnRightClick: true,
            menu: createTrayMenu(autoEnabled),
        });

        this.#tray.on('click', this.#handleTrayClick);
        this.#app.on('custom-menu-click', this.#handleApplicationMenuClick);
    }

    updateAutoEnabled(autoEnabled: boolean): void {
        if (!this.#stopped) {
            this.#tray?.setMenu(createTrayMenu(autoEnabled));
        }
    }

    /**
     * 停止接收托盘事件，但不在退出过程中手动释放原生 Tray
     * 最终的 GUI 资源释放统一交给 Application.exit()
     */
    stop(): void {
        if (this.#stopped) {
            return;
        }

        this.#stopped = true;
        this.#tray?.off('click', this.#handleTrayClick);
        this.#app.off('custom-menu-click', this.#handleApplicationMenuClick);
    }

    #handleMenuClick(id: string | undefined): void {
        switch (id) {
            case 'open':
                this.#panelManager.requestOpen('control');
                break;

            case 'toggle-auto':
                runBackground('切换自动模式', async () => {
                    const state = await this.#appController.getState();
                    await this.#appController.setAutoEnabled(!state.settings.autoEnabled);
                });
                break;

            case 'apply-auto':
                runBackground('应用自动设置', () => this.#appController.applyAutoNow());
                break;

            case 'refresh':
                runBackground('重新检测显示器', () => this.#appController.refreshMonitors());
                break;

            case 'open-webview': {
                const directory = path.join(this.#webviewDataDirectory, '..');

                // 使用start代替explorer打开文件夹减少边界处理 *explorer即使正常打开文件夹exitcode返回也会非0
                exec(`start "" "${directory}"`, (error) => {
                    if (error) {
                        console.error(`打开目录失败：${directory}`, error);
                    }
                });
                break;
            }

            case 'quit':
                setImmediate(() => {
                    void this.#quitApplication();
                });
                break;
        }
    }
}
