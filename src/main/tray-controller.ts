import path from 'node:path';
import type { AppState, ScheduleProfile } from '../shared/model';
import type { AppController } from './app-controller';
import type { NativeShell, NativeTrayMenuItem } from './native-shell';
import type { PanelManager } from './panel/panel-manager';
import { runBackground } from './utils/run-background.ts';

export interface TrayControllerOptions {
    appController: AppController;
    panelManager: PanelManager;
    nativeShell: NativeShell;
    webviewDataDirectory: string;
    programDirectory: string;
    quitApplication(): void;
}

export class TrayController {
    readonly #appController: AppController;
    readonly #panelManager: PanelManager;
    readonly #nativeShell: NativeShell;
    readonly #webviewDataDirectory: string;
    readonly #programDirectory: string;
    readonly #quitApplication: () => void;

    #stopped = false;
    #menuSignature = '';

    constructor(options: TrayControllerOptions) {
        this.#appController = options.appController;
        this.#panelManager = options.panelManager;
        this.#nativeShell = options.nativeShell;
        this.#webviewDataDirectory = options.webviewDataDirectory;
        this.#programDirectory = options.programDirectory;
        this.#quitApplication = options.quitApplication;
    }

    update(state: AppState): void {
        if (this.#stopped) {
            return;
        }

        const signature = JSON.stringify([
            state.settings.autoEnabled,
            state.settings.theme,
            state.settings.activeScheduleProfileId,
            state.settings.scheduleProfiles.map(({ id, name }) => [id, name]),
        ]);
        if (signature === this.#menuSignature) {
            return;
        }

        this.#menuSignature = signature;
        this.#nativeShell.setTrayMenu(createTrayMenu(state));
    }

    stop(): void {
        this.#stopped = true;
    }

    handleMenuClick(id: string, x?: number, y?: number): void {
        if (this.#stopped) {
            return;
        }

        if (id.startsWith('select-profile:')) {
            const profileId = decodeURIComponent(id.slice('select-profile:'.length));
            runBackground('切换自动调节方案', () => this.#appController.setActiveScheduleProfile(profileId));
            return;
        }

        switch (id) {
            case 'open-quick':
                this.#panelManager.requestOpen('quick', x, y);
                break;

            case 'open-control':
                this.#panelManager.requestOpen('control');
                break;

            case 'toggle-auto':
                runBackground('切换自动模式', async () => {
                    const state = this.#appController.getState();
                    await this.#appController.setAutoEnabled(!state.settings.autoEnabled);
                });
                break;

            case 'toggle-theme':
                runBackground('切换界面主题', async () => {
                    const state = this.#appController.getState();
                    await this.#appController.setTheme(state.settings.theme === 'dark' ? 'light' : 'dark');
                });
                break;

            case 'apply-auto':
                runBackground('应用自动设置', () => this.#appController.applyAutoNow());
                break;

            case 'refresh':
                runBackground('重新检测显示器', () => this.#appController.refreshMonitors());
                break;

            case 'reset-panel-styles':
                runBackground('重置面板所有样式', async () => {
                    await this.#appController.resetPanelStyles();
                    this.#panelManager.resetControlWindowLayout();
                });
                break;

            case 'open-webview':
                // 路径策略仍由 TS 决定；Native Shell 只负责调用系统 Shell 打开传入目录
                this.#nativeShell.openPath(path.dirname(this.#webviewDataDirectory));
                break;

            case 'open-program-directory':
                this.#nativeShell.openPath(this.#programDirectory);
                break;

            case 'quit':
                setImmediate(this.#quitApplication);
                break;
        }
    }
}

export function createTrayMenu(state: AppState): NativeTrayMenuItem[] {
    const { autoEnabled, theme, activeScheduleProfileId, scheduleProfiles } = state.settings;

    return [
        { type: 'item', id: 'open-control', label: '详细设置面板' },
        { type: 'item', id: 'open-quick', label: '快速设置面板' },
        {
            type: 'item',
            id: 'toggle-theme',
            label: theme === 'dark' ? '切换为明亮主题' : '切换为夜间主题',
        },
        { type: 'separator' },
        { type: 'item', id: 'toggle-auto', label: '自动调节', checked: autoEnabled },
        { type: 'item', id: 'apply-auto', label: '立即应用当前方案' },
        {
            type: 'submenu',
            label: '自动调节方案',
            items: scheduleProfiles.map((profile) => createScheduleProfileMenuItem(profile, activeScheduleProfileId)),
        },
        { type: 'separator' },
        { type: 'item', id: 'refresh', label: '重新检测显示器' },
        {
            type: 'submenu',
            label: '工具',
            items: [
                { type: 'item', id: 'reset-panel-styles', label: '重置面板所有样式' },
                { type: 'item', id: 'open-webview', label: '打开 WebView 目录' },
                { type: 'item', id: 'open-program-directory', label: '打开程序目录' },
            ],
        },
        { type: 'separator' },
        { type: 'item', id: 'quit', label: '退出' },
    ];
}

function createScheduleProfileMenuItem(profile: ScheduleProfile, activeScheduleProfileId: string): NativeTrayMenuItem {
    return {
        type: 'item',
        id: `select-profile:${encodeURIComponent(profile.id)}`,
        label: escapeMenuLabel(profile.name),
        checked: profile.id === activeScheduleProfileId,
    };
}

function escapeMenuLabel(label: string): string {
    return label.replaceAll('&', '&&');
}
