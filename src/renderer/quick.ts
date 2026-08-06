import type { MonitorBridge } from '../shared/bridge';
import type { AppState, MonitorTarget } from '../shared/model';
import {
    createActionController,
    createLiveAdjustmentController,
    disableDefaultContextMenu,
    getElement,
    getErrorMessage,
    resolveMonitorValues,
    setRangeValue,
    updateRangeOutput,
    waitForBridge,
} from './common';

type RenderOptions = {
    syncManualValues?: boolean;
    resetMonitorSelection?: boolean;
};

let bridge: MonitorBridge;
let currentState: AppState | undefined;
let selectedMonitorId: MonitorTarget | undefined;

const elements = {
    status: getElement<HTMLElement>('#status'),
    error: getElement<HTMLElement>('#error'),
    monitorSwitchButton: getElement<HTMLButtonElement>('#monitor-switch-button'),
    monitorNumber: getElement<HTMLElement>('#monitor-number'),
    monitorName: getElement<HTMLElement>('#monitor-name'),
    brightnessSlider: getElement<HTMLInputElement>('#brightness-slider'),
    brightnessValue: getElement<HTMLOutputElement>('#brightness-value'),
    contrastSlider: getElement<HTMLInputElement>('#contrast-slider'),
    contrastValue: getElement<HTMLOutputElement>('#contrast-value'),
    refreshButton: getElement<HTMLButtonElement>('#refresh-button'),
    openControlButton: getElement<HTMLButtonElement>('#open-control-button'),
};

const liveAdjustment = createLiveAdjustmentController({
    interval: 200,
    apply: (values) => bridge.applyLive(values),
    onApplied: render,
    onError: (error) => showError('实时调节失败', error),
});

const actions = createActionController({
    setBusy,
    onError: (error) => showError('操作失败', error),
});

void initialize();

async function initialize(): Promise<void> {
    try {
        bridge = await waitForBridge();
        window.__monitorStateChanged = render;
        bindEvents();

        await actions.run(async () => {
            render(await bridge.getState(), {
                resetMonitorSelection: true,
                syncManualValues: true,
            });
        });
    } catch (error) {
        showError('快捷控制页初始化失败', error);
    }
}

function bindEvents(): void {
    elements.brightnessSlider.addEventListener('input', handleSliderInput);
    elements.contrastSlider.addEventListener('input', handleSliderInput);

    elements.monitorSwitchButton.addEventListener('click', cycleMonitor);

    elements.refreshButton.addEventListener('click', () => {
        liveAdjustment.cancelPending();
        selectedMonitorId = undefined;

        void actions.run(async () => {
            render(await bridge.refreshMonitors(), {
                resetMonitorSelection: true,
                syncManualValues: true,
            });
        });
    });

    elements.openControlButton.addEventListener('click', () => {
        void bridge.openControlPanel();
    });

    const focusListener = (): void => {
        window.removeEventListener('focus', focusListener);
        window.addEventListener('blur', () => {
            void bridge.closePanel();
        });
    };
    window.addEventListener('focus', focusListener);

    disableDefaultContextMenu();
}

function handleSliderInput(event: Event): void {
    updateSliderOutputs();

    const monitor = getSelectedMonitor();

    if (!monitor) {
        return;
    }

    if (event.currentTarget === elements.brightnessSlider) {
        liveAdjustment.schedule({
            monitorId: monitor.id,
            brightness: Number(elements.brightnessSlider.value),
        });
        return;
    }

    if (event.currentTarget === elements.contrastSlider) {
        liveAdjustment.schedule({
            monitorId: monitor.id,
            contrast: Number(elements.contrastSlider.value),
        });
    }
}

function cycleMonitor(): void {
    liveAdjustment.cancelPending();
    const monitors = currentState?.monitors ?? [];

    if (monitors.length <= 1) {
        return;
    }

    const currentIndex = monitors.findIndex(({ id }) => id === selectedMonitorId);
    const nextMonitor = monitors[(currentIndex + 1 + monitors.length) % monitors.length];

    if (!nextMonitor) {
        return;
    }

    selectedMonitorId = nextMonitor.id;
    renderMonitorHeader();
    selectMonitorValues();

    void actions.run(async () => {
        render(await bridge.setTargetMonitor({ monitorId: nextMonitor.id }));
    });
}

function render(state: AppState, options: RenderOptions = {}): void {
    const previousSelection = selectedMonitorId;
    currentState = state;

    elements.status.textContent = state.lastOperation;
    elements.error.hidden = state.lastError === null;
    elements.error.textContent = state.lastError ?? '';

    if (
        options.resetMonitorSelection ||
        selectedMonitorId === undefined ||
        !state.monitors.some(({ id }) => id === selectedMonitorId)
    ) {
        selectedMonitorId = state.monitors[0]?.id;
    }

    renderMonitorHeader();

    if (options.syncManualValues || previousSelection !== selectedMonitorId) {
        selectMonitorValues();
    }

    actions.refreshBusyState();
}

function renderMonitorHeader(): void {
    const monitor = getSelectedMonitor();
    const monitorCount = currentState?.monitors.length ?? 0;

    if (!monitor) {
        elements.monitorNumber.textContent = '–';
        elements.monitorName.textContent = '未检测到显示器';
        elements.monitorSwitchButton.title = '没有可切换的显示器';
        elements.monitorSwitchButton.setAttribute('aria-label', '未检测到显示器');
        return;
    }

    elements.monitorNumber.textContent = String(monitor.index + 1);
    elements.monitorName.textContent = monitor.name || `显示器 ${monitor.index + 1}`;

    if (monitorCount > 1) {
        elements.monitorSwitchButton.title = `当前为第 ${monitor.index + 1} 台显示器，点击切换下一台`;
        elements.monitorSwitchButton.setAttribute(
            'aria-label',
            `当前显示器：${elements.monitorName.textContent}，点击切换下一台`,
        );
    } else {
        elements.monitorSwitchButton.title = '当前仅检测到一台显示器';
        elements.monitorSwitchButton.setAttribute('aria-label', `当前显示器：${elements.monitorName.textContent}`);
    }
}

function selectMonitorValues(): void {
    if (!currentState || selectedMonitorId === undefined) {
        return;
    }

    const values = resolveMonitorValues(currentState, selectedMonitorId);
    setRangeValue(elements.brightnessSlider, elements.brightnessValue, values.brightness);
    setRangeValue(elements.contrastSlider, elements.contrastValue, values.contrast);
}

function getSelectedMonitor(): AppState['monitors'][number] | undefined {
    if (!currentState || selectedMonitorId === undefined) {
        return undefined;
    }

    return currentState.monitors.find(({ id }) => id === selectedMonitorId);
}

function updateSliderOutputs(): void {
    updateRangeOutput(elements.brightnessSlider, elements.brightnessValue);
    updateRangeOutput(elements.contrastSlider, elements.contrastValue);
}

function setBusy(value: boolean): void {
    const hasMonitor = (currentState?.monitors.length ?? 0) > 0;

    elements.monitorSwitchButton.disabled = value || !hasMonitor;
    elements.brightnessSlider.disabled = value || !hasMonitor;
    elements.contrastSlider.disabled = value || !hasMonitor;
    elements.refreshButton.disabled = value;
    elements.openControlButton.disabled = value;
}

function showError(prefix: string, error: unknown): void {
    elements.status.textContent = prefix;
    elements.error.hidden = false;
    elements.error.textContent = getErrorMessage(error);
}
