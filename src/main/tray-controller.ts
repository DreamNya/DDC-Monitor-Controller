import path from 'node:path';
import type { AppController } from './app-controller';
import type { NativeShell, NativeTrayMenuItem } from './native-shell';
import type { PanelManager } from './panel/panel-manager';
import { runBackground } from './utils/run-background';

export interface TrayControllerOptions {
    appController: AppController;
    panelManager: PanelManager;
    nativeShell: NativeShell;
    webviewDataDirectory: string;
    quitApplication(): void;
}

export class TrayController {
    readonly #appController: AppController;
    readonly #panelManager: PanelManager;
    readonly #nativeShell: NativeShell;
    readonly #webviewDataDirectory: string;
    readonly #quitApplication: () => void;

    #stopped = false;

    constructor(options: TrayControllerOptions) {
        this.#appController = options.appController;
        this.#panelManager = options.panelManager;
        this.#nativeShell = options.nativeShell;
        this.#webviewDataDirectory = options.webviewDataDirectory;
        this.#quitApplication = options.quitApplication;
    }

    updateAutoEnabled(autoEnabled: boolean): void {
        if (this.#stopped) {
            return;
        }
        this.#nativeShell.setTrayMenu(createTrayMenu(autoEnabled));
    }

    stop(): void {
        this.#stopped = true;
    }

    handleMenuClick(id: string): void {
        if (this.#stopped) {
            return;
        }

        switch (id) {
            case 'open':
                this.#panelManager.requestOpen('control');
                break;

            case 'toggle-auto':
                runBackground('切换自动模式', async () => {
                    const state = this.#appController.getState();
                    await this.#appController.setAutoEnabled(!state.settings.autoEnabled);
                });
                break;

            case 'apply-auto':
                runBackground('应用自动设置', () => this.#appController.applyAutoNow());
                break;

            case 'refresh':
                runBackground('重新检测显示器', () => this.#appController.refreshMonitors());
                break;

            case 'reset-ui-scale':
                runBackground('重置面板缩放比例', () => this.#appController.resetUiScale());
                break;

            case 'open-webview':
                // 路径策略仍由 TS 决定；Native Shell 只负责调用系统 Shell 打开传入目录。
                this.#nativeShell.openPath(path.dirname(this.#webviewDataDirectory));
                break;

            case 'quit':
                setImmediate(this.#quitApplication);
                break;
        }
    }
}

function createTrayMenu(autoEnabled: boolean): NativeTrayMenuItem[] {
    return [
        { type: 'item', id: 'open', label: '打开控制面板' },
        { type: 'item', id: 'toggle-auto', label: autoEnabled ? '关闭自动调节' : '开启自动调节' },
        { type: 'item', id: 'apply-auto', label: '立即应用自动设置' },
        { type: 'item', id: 'refresh', label: '重新检测显示器' },
        { type: 'item', id: 'reset-ui-scale', label: '重置面板缩放比例（100%）' },
        { type: 'separator' },
        { type: 'item', id: 'open-webview', label: '打开WebView目录' },
        { type: 'separator' },
        { type: 'item', id: 'quit', label: '退出' },
    ];
}
