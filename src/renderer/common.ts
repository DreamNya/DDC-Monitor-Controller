import type { MonitorBridge } from '../shared/bridge';
import type { AppState, AppStateChange, LiveApplyRequest, MonitorTarget } from '../shared/model';

declare global {
    interface Window {
        monitor?: MonitorBridge;
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

export function waitForBridge(timeout = 5000, pollInterval = 25): Promise<MonitorBridge> {
    const bridge = window.monitor;
    if (bridge) {
        return Promise.resolve(bridge);
    }

    return new Promise((resolve, reject) => {
        const retryTimes = Math.ceil(timeout / pollInterval);
        let times = 0;

        const intervalId = setInterval(() => {
            const bridge = window.monitor;
            if (bridge) {
                clearInterval(intervalId);
                resolve(bridge);
                return;
            }

            if (++times >= retryTimes) {
                clearInterval(intervalId);
                reject(new Error('Node.js 后端桥接初始化超时'));
            }
        }, pollInterval);
    });
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
