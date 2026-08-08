import type { MonitorBridge } from '../shared/bridge';
import type { AppState, AppStateChange, LiveApplyRequest, MonitorTarget } from '../shared/model';

interface WebViewHost {
    postMessage(message: string): void;
    addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
}

declare global {
    interface Window {
        chrome?: { webview?: WebViewHost };
        __monitorStateChanged?: (change: AppStateChange) => void;
    }
}

export type ManualAdjustment = {
    monitorId: MonitorTarget;
    brightness: number;
    contrast: number;
};

type LiveAdjustmentOptions = {
    interval?: number;
    apply: (values: LiveApplyRequest) => Promise<unknown>;
    onError: (error: unknown) => void;
};

export type LiveAdjustmentController = {
    schedule: (values: LiveApplyRequest) => void;
    cancelPending: () => void;
};

type ActionControllerOptions = {
    setBusy: (busy: boolean) => void;
    onError: (error: unknown) => void;
};

export type ActionController = {
    run: (action: () => Promise<void>) => Promise<void>;
    refreshBusyState: () => void;
};

type PendingRpcRequest = {
    resolve(value: unknown): void;
    reject(error: Error): void;
};

let monitorBridge: MonitorBridge | undefined;
let nextRpcRequestId = 0;
const pendingRpcRequests = new Map<number, PendingRpcRequest>();

export function waitForBridge(): Promise<MonitorBridge> {
    try {
        return Promise.resolve(getMonitorBridge());
    } catch (error) {
        return Promise.reject(error);
    }
}

function getMonitorBridge(): MonitorBridge {
    if (monitorBridge) {
        return monitorBridge;
    }

    const host = window.chrome?.webview;
    if (!host) {
        throw new Error('WebView2 原生消息桥不可用');
    }

    host.addEventListener('message', handleNativeMessage);
    monitorBridge = new Proxy(
        {},
        {
            get: (_target, property) => {
                if (typeof property !== 'string' || property === 'then') {
                    return undefined;
                }
                return (...args: unknown[]) => callNativeBridge(host, property, args);
            },
        },
    ) as MonitorBridge;

    return monitorBridge;
}

function callNativeBridge(host: WebViewHost, method: string, args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const id = ++nextRpcRequestId;
        pendingRpcRequests.set(id, { resolve, reject });
        host.postMessage(`rpc:${JSON.stringify({ id, method, args })}`);
    });
}

function handleNativeMessage(event: MessageEvent<unknown>): void {
    if (typeof event.data !== 'string') {
        return;
    }

    try {
        if (event.data.startsWith('rpc-result:')) {
            handleRpcResult(event.data.slice('rpc-result:'.length));
            return;
        }

        if (event.data.startsWith('state:')) {
            const change = JSON.parse(event.data.slice('state:'.length)) as AppStateChange;
            window.__monitorStateChanged?.(change);
        }
    } catch (error) {
        console.error('处理 Native WebView 消息失败：', error);
    }
}

function handleRpcResult(payload: string): void {
    const value: unknown = JSON.parse(payload);
    if (!value || typeof value !== 'object') {
        return;
    }

    const result = value as Record<string, unknown>;
    if (!Number.isSafeInteger(result.id)) {
        return;
    }

    const request = pendingRpcRequests.get(result.id as number);
    if (!request) {
        return;
    }
    pendingRpcRequests.delete(result.id as number);

    if (result.ok === true) {
        request.resolve(result.value);
    } else {
        request.reject(new Error(typeof result.error === 'string' ? result.error : 'Native RPC 调用失败'));
    }
}

export function disableDefaultContextMenu(): void {
    document.addEventListener(
        'contextmenu',
        (event) => {
            event.preventDefault();
        },
        {
            capture: true,
        },
    );
}

export function getElement<T extends Element>(selector: string, parent: ParentNode = document): T {
    const element = parent.querySelector(selector);
    if (!element) {
        const error = new Error(`缺少 UI 元素：${selector}`);
        console.error(error);
        throw error;
    }
    return element as T;
}

export function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function readManualAdjustment(
    monitorId: MonitorTarget,
    brightnessSlider: HTMLInputElement,
    contrastSlider: HTMLInputElement,
): ManualAdjustment {
    return {
        monitorId,
        brightness: Number(brightnessSlider.value),
        contrast: Number(contrastSlider.value),
    };
}

export function resolveMonitorValues(
    state: AppState,
    target: MonitorTarget,
): Pick<ManualAdjustment, 'brightness' | 'contrast'> {
    const monitor =
        target === 'all'
            ? state.monitors.find(({ brightness, contrast }) => brightness !== null && contrast !== null)
            : state.monitors.find(({ id }) => id === target);

    return {
        brightness: monitor?.brightness ?? state.calculatedValues.brightness,
        contrast: monitor?.contrast ?? state.calculatedValues.contrast,
    };
}

export function setRangeValue(slider: HTMLInputElement, output: HTMLOutputElement, value: number): void {
    slider.value = String(value);
    updateRangeOutput(slider, output);
}

export function updateRangeOutput(slider: HTMLInputElement, output: HTMLOutputElement): void {
    const suffix = '%';
    output.value = `${slider.value}${suffix}`;

    updateRangeProgress(slider, suffix);
}

export function updateRangeProgress(slider: HTMLInputElement, suffix = ''): void {
    const minimum = Number(slider.min);
    const maximum = Number(slider.max);
    const value = Number(slider.value);
    const progress = maximum === minimum ? 0 : ((value - minimum) / (maximum - minimum)) * 100;
    const normalizedProgress = Math.min(100, Math.max(0, progress));

    slider.style.setProperty('--range-progress', `${normalizedProgress}%`);
    slider.setAttribute('aria-valuetext', `${value}${suffix}`);
}

export function createLiveAdjustmentController(options: LiveAdjustmentOptions): LiveAdjustmentController {
    const interval = options.interval ?? 200;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let task: Promise<void> | undefined;
    let pendingValues: LiveApplyRequest | undefined;
    let lastFinishedAt = Number.NEGATIVE_INFINITY;

    function schedule(values: LiveApplyRequest): void {
        pendingValues = mergeLiveAdjustment(pendingValues, values);
        scheduleNext();
    }

    function scheduleNext(): void {
        if (!pendingValues || task || timer !== undefined) {
            return;
        }

        const elapsed = performance.now() - lastFinishedAt;
        const delay = Math.max(0, interval - elapsed);

        if (delay === 0) {
            execute();
            return;
        }

        timer = setTimeout(() => {
            timer = undefined;
            execute();
        }, delay);
    }

    function execute(): void {
        const values = pendingValues;

        if (!values) {
            return;
        }

        pendingValues = undefined;

        task = (async () => {
            try {
                await options.apply(values);
            } catch (error) {
                console.error('实时调节操作失败：', error);
                options.onError(error);
            } finally {
                lastFinishedAt = performance.now();
                task = undefined;
                scheduleNext();
            }
        })();
    }

    const cancelPending = (): void => {
        pendingValues = undefined;

        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
    };

    return {
        schedule,
        cancelPending,
    };
}

function mergeLiveAdjustment(current: LiveApplyRequest | undefined, next: LiveApplyRequest): LiveApplyRequest {
    if (!current || current.monitorId !== next.monitorId) {
        return { ...next };
    }

    return {
        ...current,
        ...next,
    };
}

export function createActionController(options: ActionControllerOptions): ActionController {
    let busy = false;

    const applyBusyState = (): void => {
        options.setBusy(busy);
    };

    const run = async (action: () => Promise<void>): Promise<void> => {
        if (busy) {
            return;
        }

        busy = true;
        applyBusyState();

        try {
            await action();
        } catch (error) {
            console.error('界面操作失败：', error);
            options.onError(error);
        } finally {
            busy = false;
            applyBusyState();
        }
    };

    return {
        run,
        refreshBusyState: applyBusyState,
    };
}
