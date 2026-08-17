import type { MonitorBridge } from '../shared/bridge';
import { formatCapabilitiesString } from '../shared/capabilities-format';
import { isFontSizePx } from '../shared/font-size';
import type {
    AppState,
    AppStateChange,
    FontSizeTarget,
    IntervalMinutes,
    MonitorCapabilities,
    MonitorTarget,
    SchedulePoint,
    ScheduleProfile,
    UiScaleTarget,
} from '../shared/model';
import { INTERVAL_MINUTES_OPTIONS } from '../shared/model';
import { formatTime, parseTime } from '../shared/schedule';
import { isUiScalePercent } from '../shared/ui-scale';
import { createAdvancedVcpPanel } from './advanced-vcp-panel';
import {
    applyFontSizeSettings,
    createActionController,
    createLiveAdjustmentController,
    disableDefaultContextMenu,
    getElement,
    getErrorMessage,
    readManualAdjustment,
    resolveMonitorValues,
    setRangeValue,
    updateRangeOutput,
    updateRangeProgress,
    waitForBridge,
    type ManualAdjustment,
} from './common';
import { applyAndCacheTheme } from './theme';

type RenderOptions = {
    syncManualValues?: boolean;
};

type ControlSubpanelId = 'control-panel' | 'vcp-panel' | 'advanced-vcp-panel' | 'settings-panel';

let bridge: MonitorBridge;
let currentState: AppState | undefined;
let lastCapabilities: MonitorCapabilities | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let copiedVcpCellTimer: ReturnType<typeof setTimeout> | undefined;
let copiedVcpCell: HTMLTableCellElement | undefined;

const VCP_CODE_NAMES = new Map<number, string>([
    [0x10, '亮度'],
    [0x12, '对比度'],
    [0x60, '输入源'],
    [0xd6, '电源模式'],
]);

const elements = {
    autoBadge: getElement<HTMLSpanElement>('#auto-badge'),
    lastOperation: getElement<HTMLElement>('#last-operation'),
    lastError: getElement<HTMLElement>('#last-error'),
    refreshButton: getElement<HTMLButtonElement>('#refresh-button'),
    monitorSelect: getElement<HTMLSelectElement>('#monitor-select'),
    vcpMonitorSelect: getElement<HTMLSelectElement>('#vcp-monitor-select'),
    enumerateVcpButton: getElement<HTMLButtonElement>('#enumerate-vcp-button'),
    readVcpButton: getElement<HTMLButtonElement>('#read-vcp-button'),
    vcpSummary: getElement<HTMLElement>('#vcp-summary'),
    vcpBody: getElement<HTMLTableSectionElement>('#vcp-body'),
    vcpRawOutput: getElement<HTMLPreElement>('#vcp-raw-output'),
    brightnessSlider: getElement<HTMLInputElement>('#brightness-slider'),
    brightnessValue: getElement<HTMLOutputElement>('#brightness-value'),
    contrastSlider: getElement<HTMLInputElement>('#contrast-slider'),
    contrastValue: getElement<HTMLOutputElement>('#contrast-value'),
    liveAdjustToggle: getElement<HTMLInputElement>('#live-adjust-toggle'),
    applyButton: getElement<HTMLButtonElement>('#apply-button'),
    addCurrentPointButton: getElement<HTMLButtonElement>('#add-current-point-button'),
    autoIntervalSelect: getElement<HTMLSelectElement>('#auto-interval-select'),
    autoIntervalDisplay: getElement<HTMLElement>('#auto-interval-display'),
    autoBrightness: getElement<HTMLElement>('#auto-brightness'),
    autoContrast: getElement<HTMLElement>('#auto-contrast'),
    nextRun: getElement<HTMLElement>('#next-run'),
    applyAutoButton: getElement<HTMLButtonElement>('#apply-auto-button'),
    scheduleProfileSelect: getElement<HTMLSelectElement>('#schedule-profile-select'),
    createProfileButton: getElement<HTMLButtonElement>('#create-profile-button'),
    renameProfileButton: getElement<HTMLButtonElement>('#rename-profile-button'),
    deleteProfileButton: getElement<HTMLButtonElement>('#delete-profile-button'),
    scheduleBody: getElement<HTMLTableSectionElement>('#schedule-body'),
    addPointButton: getElement<HTMLButtonElement>('#add-point-button'),
    saveScheduleButton: getElement<HTMLButtonElement>('#save-schedule-button'),
    toast: getElement<HTMLElement>('#toast'),
    closeButton: getElement<HTMLButtonElement>('#close-button'),
    windowDragRegion: getElement<HTMLElement>('#window-drag-region'),
    themeToggle: getElement<HTMLInputElement>('#theme-toggle'),
    logToggle: getElement<HTMLInputElement>('#log-toggle'),
    openLogFolderButton: getElement<HTMLButtonElement>('#open-log-folder-button'),
    quickUiScaleSlider: getElement<HTMLInputElement>('#quick-ui-scale-slider'),
    quickUiScaleValue: getElement<HTMLOutputElement>('#quick-ui-scale-value'),
    controlUiScaleSlider: getElement<HTMLInputElement>('#control-ui-scale-slider'),
    controlUiScaleValue: getElement<HTMLOutputElement>('#control-ui-scale-value'),
    resetUiScaleButton: getElement<HTMLButtonElement>('#reset-ui-scale-button'),
    defaultFontSizeSlider: getElement<HTMLInputElement>('#default-font-size-slider'),
    defaultFontSizeValue: getElement<HTMLOutputElement>('#default-font-size-value'),
    hintFontSizeSlider: getElement<HTMLInputElement>('#hint-font-size-slider'),
    hintFontSizeValue: getElement<HTMLOutputElement>('#hint-font-size-value'),
    resetFontSizeButton: getElement<HTMLButtonElement>('#reset-font-size-button'),
    navigationItems: [...document.querySelectorAll<HTMLButtonElement>('.nav-item[data-panel-target]')],
    subpanels: [...document.querySelectorAll<HTMLElement>('.subpanel')],
};

const liveAdjustment = createLiveAdjustmentController({
    interval: 200,
    apply: (values) => bridge.applyLive(values),
    onError: (error) => showToast(getErrorMessage(error)),
});

const actions = createActionController({
    setBusy,
    onError: (error) => showToast(getErrorMessage(error)),
});

const advancedVcpPanel = createAdvancedVcpPanel({
    getBridge: () => bridge,
    runAction: (action) => {
        void actions.run(action);
    },
    showToast,
});

void initialize();

async function initialize(): Promise<void> {
    try {
        bridge = await waitForBridge();
        window.__monitorStateChanged = renderStateChange;
        window.__monitorToast = showToast;
        bindEvents();

        await actions.run(async () => {
            render(await bridge.getState(), {
                syncManualValues: true,
            });
        });
    } catch (error) {
        console.error('控制面板初始化失败：', error);
        elements.lastOperation.textContent = '控制面板初始化失败';
        elements.lastError.hidden = false;
        elements.lastError.textContent = getErrorMessage(error);
    }
}

function bindEvents(): void {
    bindPanelNavigation();
    advancedVcpPanel.bind();
    elements.brightnessSlider.addEventListener('input', handleSliderInput);
    elements.contrastSlider.addEventListener('input', handleSliderInput);
    bindUiScaleSlider('quick', elements.quickUiScaleSlider, elements.quickUiScaleValue);
    bindUiScaleSlider('control', elements.controlUiScaleSlider, elements.controlUiScaleValue);
    bindFontSizeSlider('default', elements.defaultFontSizeSlider, elements.defaultFontSizeValue);
    bindFontSizeSlider('hint', elements.hintFontSizeSlider, elements.hintFontSizeValue);

    elements.resetUiScaleButton.addEventListener('click', () => {
        void actions.run(async () => {
            await bridge.resetUiScale();
        });
    });

    elements.resetFontSizeButton.addEventListener('click', () => {
        void actions.run(async () => {
            await bridge.resetFontSize();
        });
    });

    elements.themeToggle.addEventListener('change', () => {
        const theme: AppState['settings']['theme'] = elements.themeToggle.checked ? 'dark' : 'light';
        applyAndCacheTheme(theme);

        void bridge.setTheme({ theme }).catch((error: unknown) => {
            showToast(getErrorMessage(error));
            renderTheme(currentState?.settings.theme ?? 'light');
        });
    });

    elements.liveAdjustToggle.addEventListener('change', () => {
        if (!elements.liveAdjustToggle.checked) {
            liveAdjustment.cancelPending();
        }
    });

    elements.monitorSelect.addEventListener('change', () => {
        liveAdjustment.cancelPending();
        const monitorId = elements.monitorSelect.value as MonitorTarget;
        selectMonitorValues(monitorId);

        void actions.run(async () => {
            await bridge.setTargetMonitor({ monitorId });
        });
    });

    elements.refreshButton.addEventListener('click', () => {
        liveAdjustment.cancelPending();

        void actions.run(async () => {
            await bridge.refreshMonitors();
        });
    });

    elements.vcpMonitorSelect.addEventListener('change', () => {
        if (lastCapabilities?.monitorId !== elements.vcpMonitorSelect.value) {
            clearVcpResults();
        }

        updateControlStates();
    });

    elements.enumerateVcpButton.addEventListener('click', () => {
        const monitorId = elements.vcpMonitorSelect.value;

        void actions.run(async () => {
            if (!monitorId) {
                throw new Error('请先选择一台显示器');
            }

            elements.vcpSummary.textContent = '正在读取显示器 Capabilities…';

            try {
                const result = await bridge.getMonitorCapabilities({ monitorId });
                renderVcpCapabilities(result);
                showToast(`已枚举 ${result.vcpCodes.length} 个 VCP Code`);
            } catch (error) {
                elements.vcpSummary.textContent = `枚举失败：${getErrorMessage(error)}`;
                throw error;
            }
        });
    });

    elements.vcpBody.addEventListener('click', (event) => {
        void handleVcpCellCopy(event);
    });

    elements.readVcpButton.addEventListener('click', () => {
        const monitorId = elements.vcpMonitorSelect.value;
        const capabilities = lastCapabilities;

        void actions.run(async () => {
            if (!monitorId || !capabilities || capabilities.monitorId !== monitorId) {
                throw new Error('请先枚举当前显示器的 VCP Code');
            }

            const codes = capabilities.vcpCodes.map(({ code }) => code);

            if (codes.length === 0) {
                throw new Error('当前 Capabilities 中没有可读取的 VCP Code');
            }

            markVcpValuesReading();
            elements.vcpSummary.textContent = `正在批量读取 ${codes.length} 个 VCP Code…`;

            const results = await bridge.getMonitorVcpValues({ monitorId, codes });

            if (lastCapabilities?.monitorId !== monitorId) {
                return;
            }

            renderVcpReadResults(results);

            const successCount = results.filter(({ error }) => error === undefined).length;
            const failedCount = results.length - successCount;
            const monitorName = capabilities.monitorName || capabilities.monitorId;
            elements.vcpSummary.textContent =
                `${monitorName} 声明支持 ${capabilities.vcpCodes.length} 个 VCP Code；` +
                `读取成功 ${successCount} 个${failedCount > 0 ? `，不可读取 ${failedCount} 个` : ''}`;
            showToast(`VCP 读取完成：成功 ${successCount}，不可读取 ${failedCount}`);
        });
    });

    elements.applyButton.addEventListener('click', () => {
        liveAdjustment.cancelPending();

        void actions.run(async () => {
            await bridge.applyManual(readManualValues());
        });
    });

    elements.addCurrentPointButton.addEventListener('click', addCurrentSchedulePoint);

    elements.autoIntervalSelect.addEventListener('change', () => {
        void actions.run(async () => {
            const intervalMinutes = parseAutoInterval(elements.autoIntervalSelect.value);
            updateAutoIntervalDisplay();
            await bridge.setAutoInterval({ intervalMinutes });
        });
    });

    elements.applyAutoButton.addEventListener('click', () => {
        void actions.run(async () => {
            await bridge.applyAutoNow();
        });
    });

    elements.scheduleProfileSelect.addEventListener('change', handleScheduleProfileChange);
    elements.createProfileButton.addEventListener('click', createScheduleProfile);
    elements.renameProfileButton.addEventListener('click', renameScheduleProfile);
    elements.deleteProfileButton.addEventListener('click', deleteScheduleProfile);

    elements.addPointButton.addEventListener('click', () => {
        addScheduleRow({ time: 12, brightness: 50, contrast: 50 });
    });

    elements.saveScheduleButton.addEventListener('click', () => {
        const profileId = getActiveScheduleProfile().id;

        void actions.run(async () => {
            await bridge.saveSchedule({
                profileId,
                schedule: readScheduleRows(),
            });
        });
    });

    elements.closeButton.addEventListener('click', () => {
        void bridge.closePanel();
    });

    elements.windowDragRegion.addEventListener('mousedown', (event) => {
        const target = event.target;

        if (event.button !== 0 || !(target instanceof Element) || target.closest('button, input, select, label, a')) {
            return;
        }

        event.preventDefault();
        void bridge.startControlWindowDrag();
    });

    elements.logToggle.addEventListener('change', () => {
        void actions.run(async () => {
            await bridge.setLogEnabled({
                enabled: elements.logToggle.checked,
            });
        });
    });

    elements.openLogFolderButton.addEventListener('click', () => {
        void actions.run(async () => {
            await bridge.openLogFolder();
        });
    });

    disableDefaultContextMenu();
}

function bindPanelNavigation(): void {
    for (const item of elements.navigationItems) {
        item.addEventListener('click', () => {
            const target = item.dataset.panelTarget;

            if (
                target === 'control-panel' ||
                target === 'vcp-panel' ||
                target === 'advanced-vcp-panel' ||
                target === 'settings-panel'
            ) {
                showSubpanel(target);
            }
        });
    }
}

function showSubpanel(target: ControlSubpanelId): void {
    for (const item of elements.navigationItems) {
        const isActive = item.dataset.panelTarget === target;
        item.classList.toggle('active', isActive);
        item.setAttribute('aria-selected', String(isActive));
    }

    for (const panel of elements.subpanels) {
        const isActive = panel.id === target;
        panel.hidden = !isActive;
        panel.classList.toggle('active', isActive);
    }
}

function renderTheme(theme: AppState['settings']['theme']): void {
    elements.themeToggle.checked = theme === 'dark';
    applyAndCacheTheme(theme);
}

function parseAutoInterval(value: string): IntervalMinutes | null {
    if (value === 'off') {
        return null;
    }

    const intervalMinutes = Number(value);
    const matchedInterval = INTERVAL_MINUTES_OPTIONS.find((interval) => interval === intervalMinutes);

    if (matchedInterval === undefined) {
        throw new Error(`不支持的自动调节时间间隔：${value}`);
    }

    return matchedInterval;
}

function bindUiScaleSlider(target: UiScaleTarget, slider: HTMLInputElement, output: HTMLOutputElement): void {
    slider.addEventListener('input', () => {
        output.value = `${slider.value}%`;
        updateRangeProgress(slider, '%');
    });

    slider.addEventListener('change', () => {
        const percent = Number(slider.value);

        if (!isUiScalePercent(percent)) {
            showToast(`不支持的 UI 缩放比例：${slider.value}%`);
            return;
        }

        void actions.run(async () => {
            await bridge.setUiScale({ target, percent });
        });
    });
}

function bindFontSizeSlider(target: FontSizeTarget, slider: HTMLInputElement, output: HTMLOutputElement): void {
    const syncPreview = (): void => {
        const pixels = Number(slider.value);
        output.value = `${slider.value} px`;
        updateRangeProgress(slider, ' px');
        document.documentElement.style.setProperty(
            target === 'default' ? '--font-size-default' : '--font-size-hint',
            `${pixels}px`,
        );
    };

    slider.addEventListener('input', syncPreview);

    slider.addEventListener('change', () => {
        const pixels = Number(slider.value);

        if (!isFontSizePx(target, pixels)) {
            showToast(`不支持的文字大小：${slider.value}px`);
            renderFontSizeSettings(currentState?.settings.fontSize);
            return;
        }

        void actions.run(async () => {
            await bridge.setFontSize({ target, pixels });
        });
    });
}

function renderFontSizeSettings(settings: AppState['settings']['fontSize'] | undefined): void {
    if (!settings) {
        return;
    }

    elements.defaultFontSizeSlider.value = String(settings.default);
    elements.defaultFontSizeValue.value = `${settings.default} px`;
    updateRangeProgress(elements.defaultFontSizeSlider, ' px');

    elements.hintFontSizeSlider.value = String(settings.hint);
    elements.hintFontSizeValue.value = `${settings.hint} px`;
    updateRangeProgress(elements.hintFontSizeSlider, ' px');

    applyFontSizeSettings(settings);
}

function handleSliderInput(event: Event): void {
    updateSliderOutputs();

    if (!elements.liveAdjustToggle.checked) {
        return;
    }

    const monitorId = elements.monitorSelect.value as MonitorTarget;

    if (event.currentTarget === elements.brightnessSlider) {
        liveAdjustment.schedule({
            monitorId,
            brightness: Number(elements.brightnessSlider.value),
        });
        return;
    }

    if (event.currentTarget === elements.contrastSlider) {
        liveAdjustment.schedule({
            monitorId,
            contrast: Number(elements.contrastSlider.value),
        });
    }
}

function handleScheduleProfileChange(): void {
    const currentProfile = getActiveScheduleProfile();
    const profileId = elements.scheduleProfileSelect.value;

    if (profileId === currentProfile.id) {
        return;
    }

    if (hasUnsavedScheduleChanges() && !confirm('当前方案存在未保存的修改，是否放弃修改并切换方案？')) {
        elements.scheduleProfileSelect.value = currentProfile.id;
        return;
    }

    void actions.run(async () => {
        await bridge.setActiveScheduleProfile({ profileId });
    });
}

function createScheduleProfile(): void {
    const defaultName = `方案 ${(currentState?.settings.scheduleProfiles.length ?? 0) + 1}`;
    const name = prompt('请输入新定时方案的名称：', defaultName);

    if (name === null) {
        return;
    }

    void actions.run(async () => {
        await bridge.createScheduleProfile({
            name,
            schedule: readScheduleRows(),
        });
    });
}

function renameScheduleProfile(): void {
    const profile = getActiveScheduleProfile();
    const name = prompt('请输入新的定时方案名称：', profile.name);

    if (name === null || name === profile.name) {
        return;
    }

    void actions.run(async () => {
        await bridge.renameScheduleProfile({
            profileId: profile.id,
            name,
        });
    });
}

function deleteScheduleProfile(): void {
    const profile = getActiveScheduleProfile();

    if ((currentState?.settings.scheduleProfiles.length ?? 0) <= 1) {
        showToast('至少需要保留一个定时方案');
        return;
    }

    if (!confirm(`确定删除定时方案“${profile.name}”吗？此操作无法撤销`)) {
        return;
    }

    void actions.run(async () => {
        await bridge.deleteScheduleProfile({ profileId: profile.id });
    });
}

function renderStateChange({ reason, state }: AppStateChange): void {
    render(state, {
        syncManualValues: reason === 'refresh-monitors' || reason === 'apply-manual' || reason === 'apply-auto',
    });
}

function readManualValues(): ManualAdjustment {
    return readManualAdjustment(
        elements.monitorSelect.value as MonitorTarget,
        elements.brightnessSlider,
        elements.contrastSlider,
    );
}

function addCurrentSchedulePoint(): void {
    const now = new Date();
    const time = now.getHours() + now.getMinutes() / 60;
    const values = readManualValues();

    addScheduleRow({
        time,
        brightness: values.brightness,
        contrast: values.contrast,
    });
    sortScheduleRows();
    showToast(`已添加 ${formatTime(time)} 时间节点`);
}

function render(state: AppState, options: RenderOptions = {}): void {
    const previousActiveProfile = currentState ? getActiveScheduleProfile(currentState) : undefined;
    const previousTarget = currentState?.settings.targetMonitorId;
    currentState = state;
    const activeProfile = getActiveScheduleProfile(state);

    elements.autoIntervalSelect.value = state.settings.autoEnabled ? String(state.settings.intervalMinutes) : 'off';
    updateAutoIntervalDisplay();
    elements.logToggle.checked = state.settings.logEnabled;
    renderTheme(state.settings.theme);
    elements.openLogFolderButton.disabled = !state.settings.logEnabled;
    setRangeValue(elements.quickUiScaleSlider, elements.quickUiScaleValue, state.settings.uiScale.quick);
    setRangeValue(elements.controlUiScaleSlider, elements.controlUiScaleValue, state.settings.uiScale.control);
    renderFontSizeSettings(state.settings.fontSize);
    elements.autoBadge.textContent = state.settings.autoEnabled ? `自动模式开启` : '自动模式关闭';
    elements.autoBadge.classList.toggle('on', state.settings.autoEnabled);

    elements.lastOperation.textContent = state.lastOperation;
    elements.lastError.hidden = state.lastError === null;
    elements.lastError.textContent = state.lastError ?? '';

    elements.autoBrightness.textContent = String(state.calculatedValues.brightness);
    elements.autoContrast.textContent = String(state.calculatedValues.contrast);
    elements.nextRun.textContent = formatDateTime(state.nextRunAt, '--');

    renderMonitorOptions(state);
    renderVcpMonitorOptions(state);
    advancedVcpPanel.render(state);
    renderScheduleProfileOptions(state);

    if (options.syncManualValues || previousTarget === undefined || previousTarget !== state.settings.targetMonitorId) {
        selectMonitorValues(elements.monitorSelect.value as MonitorTarget);
    }

    if (
        previousActiveProfile === undefined ||
        previousActiveProfile.id !== activeProfile.id ||
        !sameSchedule(previousActiveProfile.schedule, activeProfile.schedule)
    ) {
        renderSchedule(activeProfile.schedule);
    }

    actions.refreshBusyState();
}

function updateAutoIntervalDisplay(): void {
    elements.autoIntervalDisplay.textContent =
        elements.autoIntervalSelect.options[elements.autoIntervalSelect.selectedIndex]?.text ?? '关闭';
}

function renderMonitorOptions(state: AppState): void {
    const selected = state.settings.targetMonitorId;
    elements.monitorSelect.replaceChildren();
    elements.monitorSelect.add(new Option('全部显示器', 'all'));

    for (const monitor of state.monitors) {
        const suffix =
            monitor.brightness === null || monitor.contrast === null
                ? '（读取失败）'
                : `（亮度 ${monitor.brightness} / 对比度 ${monitor.contrast}）`;
        elements.monitorSelect.add(
            new Option(`${monitor.name || `显示器 ${monitor.index + 1}`} ${suffix}`, monitor.id),
        );
    }

    elements.monitorSelect.value =
        selected === 'all' || state.monitors.some(({ id }) => id === selected) ? selected : 'all';
}

function renderVcpMonitorOptions(state: AppState): void {
    const previousSelection = elements.vcpMonitorSelect.value;
    elements.vcpMonitorSelect.replaceChildren();

    if (state.monitors.length === 0) {
        elements.vcpMonitorSelect.add(new Option('未检测到支持 DDC/CI 的显示器', ''));
        elements.vcpMonitorSelect.value = '';
        clearVcpResults('未检测到可枚举的显示器');
        return;
    }

    for (const monitor of state.monitors) {
        elements.vcpMonitorSelect.add(new Option(monitor.name || `显示器 ${monitor.index + 1}`, monitor.id));
    }

    const preferredSelection = state.monitors.some(({ id }) => id === previousSelection)
        ? previousSelection
        : state.settings.targetMonitorId !== 'all' &&
            state.monitors.some(({ id }) => id === state.settings.targetMonitorId)
          ? state.settings.targetMonitorId
          : (state.monitors[0]?.id ?? '');

    elements.vcpMonitorSelect.value = preferredSelection;

    if (lastCapabilities && lastCapabilities.monitorId !== preferredSelection) {
        clearVcpResults();
    }
}

function renderVcpCapabilities(result: MonitorCapabilities): void {
    lastCapabilities = result;
    elements.vcpRawOutput.textContent = formatCapabilitiesString(result.raw);
    elements.vcpBody.replaceChildren();

    const monitorName = result.monitorName || result.monitorId;
    elements.vcpSummary.textContent =
        result.vcpCodes.length > 0
            ? `${monitorName} 声明支持 ${result.vcpCodes.length} 个 VCP Code`
            : `${monitorName} 返回了 Capabilities，但未解析到 vcp(...) 项；可展开 Raw Capabilities 检查原始内容`;

    for (const capability of result.vcpCodes) {
        const row = document.createElement('tr');
        const codeCell = document.createElement('td');
        const nameCell = document.createElement('td');
        const valuesCell = document.createElement('td');
        const currentCell = document.createElement('td');

        row.dataset.vcpCode = String(capability.code);
        codeCell.className = 'vcp-code';
        codeCell.textContent = formatHex(capability.code);
        nameCell.textContent = getVcpCodeName(capability.code);
        valuesCell.className = 'vcp-supported-values';
        valuesCell.textContent = capability.supportedValues?.map(formatHex).join(' ') || '—';
        currentCell.className = 'vcp-current-value';
        currentCell.textContent = '—';

        row.append(codeCell, nameCell, valuesCell, currentCell);
        elements.vcpBody.append(row);
    }
}

async function handleVcpCellCopy(event: MouseEvent): Promise<void> {
    if (!(event.target instanceof Element)) {
        return;
    }

    const cell = event.target.closest<HTMLTableCellElement>('td');

    if (!cell || !elements.vcpBody.contains(cell)) {
        return;
    }

    const text = cell.textContent?.trim() ?? '';

    if (!text || text == '—') {
        return;
    }

    try {
        await copyTextToClipboard(text);
        showVcpCellCopiedFeedback(cell);
        showToast(`已复制：${text}`);
    } catch (error) {
        showToast(`复制失败：${getErrorMessage(error)}`);
    }
}

async function copyTextToClipboard(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return;
        } catch {
            // WebView 安全上下文或剪贴板权限可能阻止 Clipboard API，继续尝试兼容回退方案
        }
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.append(textarea);
    textarea.select();

    const copied = document.execCommand('copy');
    textarea.remove();

    if (!copied) {
        throw new Error('无法写入系统剪贴板');
    }
}

function showVcpCellCopiedFeedback(cell: HTMLTableCellElement): void {
    if (copiedVcpCellTimer !== undefined) {
        clearTimeout(copiedVcpCellTimer);
    }

    copiedVcpCell?.classList.remove('vcp-cell-copied');
    copiedVcpCell = cell;
    cell.classList.add('vcp-cell-copied');

    copiedVcpCellTimer = setTimeout(() => {
        cell.classList.remove('vcp-cell-copied');

        if (copiedVcpCell === cell) {
            copiedVcpCell = undefined;
        }

        copiedVcpCellTimer = undefined;
    }, 700);
}

function markVcpValuesReading(): void {
    for (const cell of elements.vcpBody.querySelectorAll<HTMLTableCellElement>('.vcp-current-value')) {
        cell.classList.remove('vcp-read-error');
        cell.textContent = '读取中…';
        cell.removeAttribute('title');
    }
}

function renderVcpReadResults(results: Awaited<ReturnType<MonitorBridge['getMonitorVcpValues']>>): void {
    const resultByCode = new Map(results.map((result) => [result.code, result]));

    for (const row of elements.vcpBody.querySelectorAll<HTMLTableRowElement>('tr[data-vcp-code]')) {
        const code = Number(row.dataset.vcpCode);
        const currentCell = row.querySelector<HTMLTableCellElement>('.vcp-current-value');
        const result = resultByCode.get(code);

        if (!currentCell || !result) {
            continue;
        }

        if (result.error !== undefined || result.current === null || result.maximum === null) {
            currentCell.classList.add('vcp-read-error');
            currentCell.textContent = isUnsupportedVcpReadError(result.error) ? '不支持读取' : '读取失败';
            currentCell.title = result.error ?? '显示器未返回有效 VCP 值';
            continue;
        }

        currentCell.classList.remove('vcp-read-error');
        currentCell.textContent = `${result.current} / ${result.maximum} (${formatHex(result.current)})`;
        currentCell.removeAttribute('title');
    }
}

function clearVcpResults(message = '选择一台显示器后按需读取 Capabilities'): void {
    lastCapabilities = undefined;
    elements.vcpBody.replaceChildren();
    elements.vcpRawOutput.textContent = '枚举完成后显示显示器返回的 Capabilities String';
    elements.vcpSummary.textContent = message;
}

function getVcpCodeName(code: number): string {
    const knownName = VCP_CODE_NAMES.get(code);

    if (knownName) {
        return knownName;
    }

    if (code >= 0xe0 && code <= 0xff) {
        return '厂商私有';
    }

    return '—';
}

function isUnsupportedVcpReadError(error: string | undefined): boolean {
    return error?.includes('不支持指定的 VCP 代码') === true;
}

function formatHex(value: number): string {
    return `0x${Math.max(0, Math.trunc(value)).toString(16).toUpperCase().padStart(2, '0')}`;
}

function renderScheduleProfileOptions(state: AppState): void {
    elements.scheduleProfileSelect.replaceChildren();

    for (const profile of state.settings.scheduleProfiles) {
        elements.scheduleProfileSelect.add(new Option(profile.name, profile.id));
    }

    elements.scheduleProfileSelect.value = state.settings.activeScheduleProfileId;
}

function selectMonitorValues(target: MonitorTarget): void {
    if (!currentState) {
        return;
    }

    const values = resolveMonitorValues(currentState, target);
    setRangeValue(elements.brightnessSlider, elements.brightnessValue, values.brightness);
    setRangeValue(elements.contrastSlider, elements.contrastValue, values.contrast);
}

function renderSchedule(schedule: readonly SchedulePoint[]): void {
    elements.scheduleBody.replaceChildren();

    for (const point of schedule) {
        addScheduleRow(point);
    }
}

function addScheduleRow(point: SchedulePoint): void {
    const row = document.createElement('tr');
    row.innerHTML = `
        <td><input class="schedule-time" type="time" step="60" /></td>
        <td><input class="schedule-brightness" type="number" min="0" max="100" step="1" /></td>
        <td><input class="schedule-contrast" type="number" min="0" max="100" step="1" /></td>
        <td><button class="remove-point" type="button" title="删除节点" aria-label="删除节点">×</button></td>
    `;

    getElement<HTMLInputElement>('.schedule-time', row).value = formatTime(point.time);
    getElement<HTMLInputElement>('.schedule-brightness', row).value = String(point.brightness);
    getElement<HTMLInputElement>('.schedule-contrast', row).value = String(point.contrast);
    getElement<HTMLButtonElement>('.remove-point', row).addEventListener('click', () => row.remove());

    elements.scheduleBody.append(row);
}

function sortScheduleRows(): void {
    const rows = [...elements.scheduleBody.querySelectorAll('tr')];

    rows.sort((left, right) => {
        const leftTime = getElement<HTMLInputElement>('.schedule-time', left).value;
        const rightTime = getElement<HTMLInputElement>('.schedule-time', right).value;
        return leftTime.localeCompare(rightTime);
    });

    elements.scheduleBody.append(...rows);
}

function readScheduleRows(): SchedulePoint[] {
    const rows = [...elements.scheduleBody.querySelectorAll('tr')];

    if (rows.length === 0) {
        throw new Error('时间表至少需要一个节点');
    }

    return rows.map((row) => ({
        time: parseTime(getElement<HTMLInputElement>('.schedule-time', row).value),
        brightness: Number(getElement<HTMLInputElement>('.schedule-brightness', row).value),
        contrast: Number(getElement<HTMLInputElement>('.schedule-contrast', row).value),
    }));
}

function hasUnsavedScheduleChanges(): boolean {
    try {
        return !sameSchedule(getActiveScheduleProfile().schedule, readScheduleRows());
    } catch (error) {
        console.error('检查定时方案未保存状态失败：', error);
        return true;
    }
}

function getActiveScheduleProfile(state = currentState): ScheduleProfile {
    if (!state) {
        throw new Error('控制面板状态尚未初始化');
    }

    const profile = state.settings.scheduleProfiles.find(({ id }) => id === state.settings.activeScheduleProfileId);

    if (!profile) {
        throw new Error(`找不到当前定时方案：${state.settings.activeScheduleProfileId}`);
    }

    return profile;
}

function updateSliderOutputs(): void {
    updateRangeOutput(elements.brightnessSlider, elements.brightnessValue);
    updateRangeOutput(elements.contrastSlider, elements.contrastValue);
}

function setBusy(value: boolean): void {
    for (const element of document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>(
        'button, input, select',
    )) {
        if (element.hasAttribute('data-allow-while-busy')) {
            continue;
        }

        element.disabled = value;
    }

    if (!value) {
        updateControlStates();
    }
}

function updateControlStates(): void {
    elements.deleteProfileButton.disabled = (currentState?.settings.scheduleProfiles.length ?? 0) <= 1;
    elements.openLogFolderButton.disabled = !currentState?.settings.logEnabled;
    elements.enumerateVcpButton.disabled = !elements.vcpMonitorSelect.value;
    elements.readVcpButton.disabled =
        !elements.vcpMonitorSelect.value ||
        lastCapabilities?.monitorId !== elements.vcpMonitorSelect.value ||
        lastCapabilities.vcpCodes.length === 0;
    advancedVcpPanel.refreshControlStates();
}

function showToast(message: string): void {
    elements.toast.textContent = message;

    // 如果已经打开，重新加入 top layer，这样即使期间又打开了一个 modal dialog，Toast 也会重新成为更新的 top-layer 元素
    if (elements.toast.matches(':popover-open')) {
        elements.toast.hidePopover();
    }
    elements.toast.showPopover();

    if (toastTimer !== undefined) {
        clearTimeout(toastTimer);
    }
    toastTimer = setTimeout(() => {
        if (elements.toast.matches(':popover-open')) {
            elements.toast.hidePopover();
        }
    }, 5000);
}

function formatDateTime(value: string | null, fallback: string): string {
    if (!value) {
        return fallback;
    }

    return new Intl.DateTimeFormat('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).format(new Date(value));
}

function sameSchedule(left: readonly SchedulePoint[] | undefined, right: readonly SchedulePoint[]): boolean {
    return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}
