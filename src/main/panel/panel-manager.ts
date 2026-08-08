import type { MonitorBridge } from '../../shared/bridge';
import type { AppStateChange, ControlWindowBounds } from '../../shared/model';
import type { AppController } from '../app-controller';
import type { NativeShell, NativeWindowBounds } from '../native-shell';
import { runBackground } from '../utils/run-background';
import { createPanelBridge } from './panel-bridge';
import { PANEL_PAGES, type PanelPage } from './panel-config';

type RpcRequest = {
    id: number;
    method: keyof MonitorBridge;
    args: unknown[];
};

const STYLESHEET_RELOAD_SCRIPT = `
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
`;

export interface PanelManagerOptions {
    appController: AppController;
    nativeShell: NativeShell;
}

export class PanelManager {
    readonly #appController: AppController;
    readonly #nativeShell: NativeShell;
    readonly #bridge: MonitorBridge;

    #page: PanelPage | undefined;
    #opening: Promise<void> | undefined;
    #applicationExiting = false;

    constructor(options: PanelManagerOptions) {
        this.#appController = options.appController;
        this.#nativeShell = options.nativeShell;
        this.#bridge = createPanelBridge({
            appController: options.appController,
            openControlPanel: () => this.requestOpen('control'),
            closePanel: () => this.destroy(),
            startControlWindowDrag: () => this.#nativeShell.startWindowDrag(),
        });
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
        this.#page = undefined;
    }

    destroy(): void {
        if (this.#applicationExiting) {
            return;
        }

        this.#page = undefined;
        this.#nativeShell.closeWindow();
    }

    pushState(change: AppStateChange): void {
        const page = this.#page;

        if (this.#applicationExiting || !page) {
            return;
        }

        this.#nativeShell.setWindowScale(change.state.settings.uiScale[page]);
        this.#nativeShell.postWebMessage(`state:${JSON.stringify(change)}`);
    }

    reloadPageForDevelopment(): void {
        if (!this.#applicationExiting && this.#page) {
            this.#nativeShell.reload();
        }
    }

    reloadStylesheetsForDevelopment(): void {
        if (!this.#applicationExiting && this.#page) {
            this.#nativeShell.executeScript(STYLESHEET_RELOAD_SCRIPT);
        }
    }

    handleWebMessage(message: string): void {
        if (this.#applicationExiting || !message.startsWith('rpc:')) {
            return;
        }

        let request: RpcRequest;

        try {
            request = parseRpcRequest(message.slice('rpc:'.length));
        } catch (error) {
            console.error('WebView RPC 请求格式错误：', error);
            return;
        }

        void this.#handleRpcRequest(request);
    }

    handleWindowClosed(id: string): void {
        if (this.#page === id) {
            this.#page = undefined;
        }
    }

    handleWindowBounds(id: string, bounds: NativeWindowBounds): void {
        if (this.#applicationExiting || id !== 'control') {
            return;
        }

        runBackground('保存控制窗口位置', () => this.#appController.saveControlWindowBounds(toControlWindowBounds(bounds)));
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

        this.#page = page;
        this.#nativeShell.openWindow({
            id: page,
            ...PANEL_PAGES[page],
            uiScalePercent: refreshedState.settings.uiScale[page],
            ...(x !== undefined && y !== undefined ? { x, y } : {}),
            ...(page === 'control' ? { initialBounds: this.#appController.getControlWindowBounds() } : {}),
        });
    }

    async #handleRpcRequest(request: RpcRequest): Promise<void> {
        try {
            const operation = this.#bridge[request.method] as unknown as (...args: unknown[]) => unknown;

            if (typeof operation !== 'function') {
                throw new Error(`不支持的 WebView RPC 方法：${String(request.method)}`);
            }

            const value = await operation(...request.args);
            this.#nativeShell.postWebMessage(
                `rpc-result:${JSON.stringify({ id: request.id, ok: true, value: value ?? null })}`,
            );
        } catch (error) {
            console.error('WebView 后端调用失败：', error);
            this.#nativeShell.postWebMessage(
                `rpc-result:${JSON.stringify({ id: request.id, ok: false, error: toErrorMessage(error) })}`,
            );
        }
    }
}

function parseRpcRequest(payload: string): RpcRequest {
    const value: unknown = JSON.parse(payload);

    if (!value || typeof value !== 'object') {
        throw new TypeError('RPC 请求必须是对象');
    }

    const request = value as Record<string, unknown>;

    if (!Number.isSafeInteger(request.id) || typeof request.method !== 'string' || !Array.isArray(request.args)) {
        throw new TypeError('RPC 请求字段无效');
    }

    return {
        id: request.id as number,
        method: request.method as keyof MonitorBridge,
        args: request.args,
    };
}

function toControlWindowBounds(bounds: NativeWindowBounds): ControlWindowBounds {
    return {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
    };
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
