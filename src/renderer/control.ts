import type { MonitorBridge } from '../shared/bridge';
import { isFontSizePx } from '../shared/font-size';
import type {
    AppState,
    AppStateChange,
    FontSizeTarget,
    IntervalMinutes,
    MonitorTarget,
    SchedulePoint,
    ScheduleProfile,
    UiScaleTarget,
} from '../shared/model';
import { INTERVAL_MINUTES_OPTIONS } from '../shared/model';
import { formatTime, parseTime } from '../shared/schedule';
import { isUiScalePercent } from '../shared/ui-scale';
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

type ControlSubpanelId = 'control-panel' | 'settings-panel';

let bridge: MonitorBridge;
let currentState: AppState | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

const elements = {
    autoBadge: getElement<HTMLSpanElement>('#auto-badge'),
    lastOperation: getElement<HTMLElement>('#last-operation'),
    lastError: getElement<HTMLElement>('#last-error'),
    refreshButton: getElement<HTMLButtonElement>('#refresh-button'),
    monitorSelect: getElement<HTMLSelectElement>('#monitor-select'),
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

void initialize();

async function initialize(): Promise<void> {
    try {
        bridge = await waitForBridge();
        window.__monitorStateChanged = renderStateChange;
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

            if (target === 'control-panel' || target === 'settings-panel') {
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
}

function showToast(message: string): void {
    elements.toast.textContent = message;
    elements.toast.classList.add('visible');

    if (toastTimer !== undefined) {
        clearTimeout(toastTimer);
    }

    toastTimer = setTimeout(() => {
        elements.toast.classList.remove('visible');
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
