import type { Application } from '@webviewjs/webview';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppStateChange } from '../../shared/model.ts';
import type { AppController } from '../app-controller.ts';
import type { ResourceServer } from '../resource-server.ts';
import type { PanelPage } from './panel-config.ts';
import { PanelSession } from './panel-session.ts';

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

    #session: PanelSession | undefined;
    #opening: Promise<void> | undefined;
    #applicationExiting = false;
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
        this.#session?.prepareForApplicationExit();
    }

    destroy(): void {
        if (this.#applicationExiting) {
            return;
        }

        const session = this.#session;
        this.#session = undefined;
        session?.dispose();
    }

    pushState(change: AppStateChange): void {
        if (!this.#applicationExiting) {
            this.#session?.pushState(change);
        }
    }

    reloadPageForDevelopment(): void {
        if (!this.#applicationExiting) {
            this.#session?.reloadPageForDevelopment();
        }
    }

    reloadStylesheetsForDevelopment(): void {
        if (!this.#applicationExiting) {
            this.#session?.reloadStylesheetsForDevelopment();
        }
    }

    async #open(page: PanelPage, x?: number, y?: number): Promise<void> {
        if (this.#applicationExiting) {
            return;
        }

        // 面板打开属于低频边界；先刷新实际显示器状态，避免物理按键或其他软件
        // 修改后仍展示旧缓存；刷新失败时 AppController 会保留最后一份可用快照
        await this.#appController.refreshMonitors();
        const refreshedState = this.#appController.getState();

        if (this.#applicationExiting) {
            return;
        }

        const uiScalePercent = refreshedState.settings.uiScale[page];
        const session = this.#session;

        if (session?.page === page && session.usable) {
            session.show(x, y, uiScalePercent);
            return;
        }

        this.destroy();
        this.#appIcon ??= await fs.readFile(path.resolve(this.#assetsRoot, 'tray-icon.png'));

        if (this.#applicationExiting) {
            return;
        }

        this.#session = new PanelSession({
            app: this.#app,
            appController: this.#appController,
            resourceServer: this.#resourceServer,
            appIcon: this.#appIcon,
            webviewDataDirectory: this.#webviewDataDirectory,
            page,
            uiScalePercent,
            ...(x !== undefined && y !== undefined ? { x, y } : {}),
            onOpenControlPanel: () => this.requestOpen('control'),
            onCloseRequested: () => this.destroy(),
        });
    }
}
