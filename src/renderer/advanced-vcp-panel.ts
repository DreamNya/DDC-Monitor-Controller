import { VCP_CODE_BRIGHTNESS, VCP_CODE_CONTRAST } from '../shared/advanced-vcp';
import type { MonitorBridge } from '../shared/bridge';
import { keyboardShortcutKey, parseGlobalShortcut } from '../shared/global-shortcut';
import type {
    AdvancedVcpAction,
    AdvancedVcpExecutionOutcome,
    AdvancedVcpShortcutCommand,
    AdvancedVcpShortcutDraft,
    AppState,
} from '../shared/model';
import { getElement } from './common';

interface AdvancedVcpPanelOptions {
    getBridge(): MonitorBridge;
    runAction(action: () => Promise<void>): void;
    showToast(message: string): void;
}

type PendingShortcut = Omit<AdvancedVcpShortcutDraft, 'name' | 'shortcut' | 'closeWebViewAfter'> & {
    defaultName: string;
    closeWebViewAfter: boolean;
};

export interface AdvancedVcpPanelController {
    bind(): void;
    render(state: AppState): void;
    refreshControlStates(): void;
}

export function createAdvancedVcpPanel(options: AdvancedVcpPanelOptions): AdvancedVcpPanelController {
    const elements = {
        monitorSelect: getElement<HTMLSelectElement>('#advanced-vcp-monitor-select'),
        presetMode: getElement<HTMLSelectElement>('#advanced-preset-mode'),
        presetRun: getElement<HTMLButtonElement>('#advanced-preset-run'),
        presetSave: getElement<HTMLButtonElement>('#advanced-preset-save'),
        relativeTarget: getElement<HTMLSelectElement>('#advanced-relative-target'),
        relativeCode: getElement<HTMLInputElement>('#advanced-relative-code'),
        relativeDirection: getElement<HTMLSelectElement>('#advanced-relative-direction'),
        relativePercent: getElement<HTMLInputElement>('#advanced-relative-percent'),
        absoluteTarget: getElement<HTMLSelectElement>('#advanced-absolute-target'),
        absoluteCode: getElement<HTMLInputElement>('#advanced-absolute-code'),
        absoluteValue: getElement<HTMLInputElement>('#advanced-absolute-value'),
        inputCode: getElement<HTMLInputElement>('#advanced-input-code'),
        inputValue: getElement<HTMLInputElement>('#advanced-input-value'),
        inputCloseToggle: getElement<HTMLInputElement>('#advanced-input-close-toggle'),
        powerCode: getElement<HTMLInputElement>('#advanced-power-code'),
        powerValue: getElement<HTMLInputElement>('#advanced-power-value'),
        customMode: getElement<HTMLSelectElement>('#advanced-custom-mode'),
        customCode: getElement<HTMLInputElement>('#advanced-custom-code'),
        customValueField: getElement<HTMLElement>('#advanced-custom-value-field'),
        customValue: getElement<HTMLInputElement>('#advanced-custom-value'),
        customResult: getElement<HTMLElement>('#advanced-custom-result'),
        customRun: getElement<HTMLButtonElement>('#advanced-custom-run'),
        customSave: getElement<HTMLButtonElement>('#advanced-custom-save'),
        commandGroups: getElement<HTMLElement>('#advanced-command-groups'),
        commandDialog: getElement<HTMLDialogElement>('#advanced-command-dialog'),
        commandForm: getElement<HTMLFormElement>('#advanced-command-form'),
        commandName: getElement<HTMLInputElement>('#advanced-command-name'),
        commandShortcut: getElement<HTMLInputElement>('#advanced-command-shortcut'),
        commandCancel: getElement<HTMLButtonElement>('#advanced-command-cancel'),
        toast: getElement<HTMLElement>('#toast'),
    };

    let state: AppState | undefined;
    let pendingShortcut: PendingShortcut | undefined;

    function bind(): void {
        elements.presetMode.addEventListener('change', syncPresetMode);
        elements.relativeTarget.addEventListener('change', () => {
            elements.relativeCode.value = formatHex(
                elements.relativeTarget.value === 'contrast' ? VCP_CODE_CONTRAST : VCP_CODE_BRIGHTNESS,
            );
        });
        elements.absoluteTarget.addEventListener('change', () => {
            elements.absoluteCode.value = formatHex(
                elements.absoluteTarget.value === 'contrast' ? VCP_CODE_CONTRAST : VCP_CODE_BRIGHTNESS,
            );
        });
        elements.customMode.addEventListener('change', syncCustomMode);

        elements.presetRun.addEventListener('click', () => {
            runUi(executePreset);
        });
        elements.presetSave.addEventListener('click', () => {
            options.runAction(savePresetShortcut);
        });
        elements.customRun.addEventListener('click', () => {
            runUi(() => execute(readCustomAction(), false, elements.customResult));
        });

        elements.customSave.addEventListener('click', () => {
            options.runAction(async () => {
                const action = readCustomAction();
                await openShortcutDialog(
                    action,
                    `${action.type === 'read' ? '读取' : '写入'} VCP ${formatHex(action.code)}`,
                );
            });
        });

        elements.commandCancel.addEventListener('click', () => {
            pendingShortcut = undefined;
            elements.commandDialog.close();
        });
        elements.commandDialog.addEventListener('close', () => {
            pendingShortcut = undefined;
            void options
                .getBridge()
                .setGlobalHotkeyCaptureActive({ active: false })
                .catch((error: unknown) => options.showToast(error instanceof Error ? error.message : String(error)));
        });
        elements.commandShortcut.addEventListener('keydown', captureShortcut);
        elements.commandForm.addEventListener('submit', (event) => {
            event.preventDefault();
            savePendingShortcut();
        });
        elements.commandGroups.addEventListener('click', handleCommandGroupClick);

        syncPresetMode();
        syncCustomMode();
    }

    function render(nextState: AppState): void {
        state = nextState;
        renderMonitorOptions(nextState);
        renderCommands(nextState);
        refreshControlStates();
    }

    function renderMonitorOptions(nextState: AppState): void {
        const previous = elements.monitorSelect.value;
        elements.monitorSelect.replaceChildren();

        if (nextState.monitors.length === 0) {
            elements.monitorSelect.add(new Option('未检测到支持 DDC/CI 的显示器', ''));
            elements.monitorSelect.value = '';
            return;
        }

        for (const monitor of nextState.monitors) {
            elements.monitorSelect.add(new Option(monitor.name || `显示器 ${monitor.index + 1}`, monitor.id));
        }

        const preferred = nextState.monitors.some(({ id }) => id === previous)
            ? previous
            : nextState.settings.targetMonitorId !== 'all' &&
                nextState.monitors.some(({ id }) => id === nextState.settings.targetMonitorId)
              ? nextState.settings.targetMonitorId
              : nextState.monitors[0]!.id;
        elements.monitorSelect.value = preferred;
    }

    function refreshControlStates(): void {
        const unavailable = !elements.monitorSelect.value;
        for (const button of [elements.presetRun, elements.presetSave, elements.customRun, elements.customSave]) {
            button.disabled = unavailable;
        }

        for (const button of elements.commandGroups.querySelectorAll<HTMLButtonElement>('[data-command-run]')) {
            const monitorId = button.dataset.monitorId ?? '';
            button.disabled = !state?.monitors.some(({ id }) => id === monitorId);
        }
    }

    function execute(action: AdvancedVcpAction, closeWebViewAfter = false, resultElement?: HTMLElement): void {
        const monitorId = requireMonitorId();
        options.runAction(async () => {
            if (resultElement) {
                resultElement.textContent = '正在执行…';
            }
            const result = await options.getBridge().executeAdvancedVcp({ monitorId, action, closeWebViewAfter });
            const message = formatExecutionResult(result);
            if (resultElement) {
                resultElement.textContent = message;
            }
            options.showToast(message);
        });
    }

    function executePreset(): void {
        const preset = readPreset();
        execute(preset.action, preset.closeWebViewAfter);
    }

    async function savePresetShortcut(): Promise<void> {
        const preset = readPreset();
        await openShortcutDialog(preset.action, preset.defaultName, preset.closeWebViewAfter);
    }

    async function openShortcutDialog(
        action: AdvancedVcpAction,
        defaultName: string,
        closeWebViewAfter = false,
    ): Promise<void> {
        const monitorId = requireMonitorId();

        // RegisterHotKey 注册过的组合键可能不会继续作为普通 keydown 送到 WebView
        // 在快捷键录制期间临时挂起本程序自己的全局快捷键，让重复快捷键也能
        // 正常显示在输入框中，再由当前 settings 精确指出是哪条命令占用
        await options.getBridge().setGlobalHotkeyCaptureActive({ active: true });

        try {
            pendingShortcut = { monitorId, action, closeWebViewAfter, defaultName };
            elements.commandName.value = defaultName;
            elements.commandShortcut.value = '';
            elements.commandDialog.showModal();
            if (elements.toast.matches(':popover-open')) {
                elements.toast.hidePopover();
                elements.toast.showPopover();
            }
            elements.commandName.focus();
            elements.commandName.select();
        } catch (error) {
            await options.getBridge().setGlobalHotkeyCaptureActive({ active: false });
            throw error;
        }
    }

    function savePendingShortcut(): void {
        if (!pendingShortcut) {
            return;
        }

        const shortcutText = elements.commandShortcut.value.trim();
        const shortcut = shortcutText ? parseGlobalShortcut(shortcutText).normalized : null;
        const shortcutOwner = shortcut ? findShortcutOwner(shortcut) : undefined;

        if (shortcut && shortcutOwner) {
            options.showToast(formatShortcutConflict(shortcut, shortcutOwner));
            return;
        }

        const command: AdvancedVcpShortcutDraft = {
            monitorId: pendingShortcut.monitorId,
            action: pendingShortcut.action,
            closeWebViewAfter: pendingShortcut.closeWebViewAfter,
            name: elements.commandName.value,
            shortcut,
        };

        options.runAction(async () => {
            await options.getBridge().saveAdvancedVcpCommand({ command });
            pendingShortcut = undefined;
            elements.commandDialog.close();
            options.showToast('快捷命令已保存');
        });
    }

    function captureShortcut(event: KeyboardEvent): void {
        event.preventDefault();
        event.stopPropagation();

        if (event.key === 'Backspace' && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
            elements.commandShortcut.value = '';
            return;
        }
        if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) {
            return;
        }

        const key = keyboardShortcutKey({ key: event.key, code: event.code });
        const parts = [
            event.ctrlKey ? 'Ctrl' : '',
            event.altKey ? 'Alt' : '',
            event.shiftKey ? 'Shift' : '',
            event.metaKey ? 'Win' : '',
            key,
        ].filter(Boolean);

        try {
            const shortcut = parseGlobalShortcut(parts.join('+')).normalized;
            elements.commandShortcut.value = shortcut;

            const shortcutOwner = findShortcutOwner(shortcut);
            if (shortcutOwner) {
                options.showToast(formatShortcutConflict(shortcut, shortcutOwner));
            }
        } catch (error) {
            options.showToast(error instanceof Error ? error.message : String(error));
        }
    }

    function findShortcutOwner(shortcut: string): AdvancedVcpShortcutCommand | undefined {
        return state?.settings.advancedVcpCommands.find((command) => command.shortcut === shortcut);
    }

    function handleCommandGroupClick(event: MouseEvent): void {
        if (!(event.target instanceof Element)) {
            return;
        }

        const runButton = event.target.closest<HTMLButtonElement>('[data-command-run]');
        if (runButton) {
            const commandId = runButton.dataset.commandRun;
            if (!commandId) {
                return;
            }
            options.runAction(async () => {
                const result = await options.getBridge().executeAdvancedVcpCommand({ commandId });
                options.showToast(formatExecutionResult(result));
            });
            return;
        }

        const deleteButton = event.target.closest<HTMLButtonElement>('[data-command-delete]');
        if (!deleteButton) {
            return;
        }
        const commandId = deleteButton.dataset.commandDelete;
        const command = state?.settings.advancedVcpCommands.find(({ id }) => id === commandId);
        if (!command || !confirm(`确定删除快捷命令“${command.name}”吗？`)) {
            return;
        }

        options.runAction(async () => {
            await options.getBridge().deleteAdvancedVcpCommand({ commandId: command.id });
        });
    }

    function renderCommands(nextState: AppState): void {
        elements.commandGroups.replaceChildren();
        const commands = nextState.settings.advancedVcpCommands;

        if (commands.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'advanced-command-empty';
            empty.textContent = '尚未保存高级 VCP 快捷命令';
            elements.commandGroups.append(empty);
            return;
        }

        const groups = new Map<string, AdvancedVcpShortcutCommand[]>();
        for (const command of commands) {
            const list = groups.get(command.monitorId) ?? [];
            list.push(command);
            groups.set(command.monitorId, list);
        }

        for (const [monitorId, groupCommands] of groups) {
            const onlineMonitor = nextState.monitors.find(({ id }) => id === monitorId);
            const group = document.createElement('section');
            group.className = 'advanced-command-group';

            const heading = document.createElement('div');
            heading.className = 'advanced-command-group-heading';
            const name = document.createElement('strong');
            name.textContent = onlineMonitor?.name || groupCommands[0]!.monitorName || monitorId;
            const status = document.createElement('span');
            status.className = `advanced-monitor-status ${onlineMonitor ? 'online' : 'offline'}`;
            status.textContent = onlineMonitor ? '在线' : '离线 / 不可用';
            heading.append(name, status);
            group.append(heading);

            for (const command of groupCommands) {
                group.append(createCommandRow(command, Boolean(onlineMonitor)));
            }
            elements.commandGroups.append(group);
        }
    }

    function createCommandRow(command: AdvancedVcpShortcutCommand, online: boolean): HTMLElement {
        const row = document.createElement('div');
        row.className = 'advanced-command-row';

        const main = document.createElement('div');
        main.className = 'advanced-command-main';
        const name = document.createElement('strong');
        name.textContent = command.name;
        const description = document.createElement('small');
        description.textContent = describeAction(command);
        main.append(name, description);
        if (command.shortcut) {
            const hotkey = document.createElement('span');
            hotkey.className = 'advanced-command-hotkey';
            hotkey.textContent = command.shortcut;
            main.append(hotkey);
        }

        const actions = document.createElement('div');
        actions.className = 'advanced-command-actions';
        const run = document.createElement('button');
        run.className = 'primary compact';
        run.type = 'button';
        run.textContent = '执行';
        run.dataset.commandRun = command.id;
        run.dataset.monitorId = command.monitorId;
        run.disabled = !online;
        run.title = online ? '执行此快捷命令' : '目标显示器当前离线';
        const remove = document.createElement('button');
        remove.className = 'secondary compact';
        remove.type = 'button';
        remove.textContent = '删除';
        remove.dataset.commandDelete = command.id;
        actions.append(run, remove);
        row.append(main, actions);
        return row;
    }

    function readPreset(): { action: AdvancedVcpAction; defaultName: string; closeWebViewAfter: boolean } {
        switch (elements.presetMode.value) {
            case 'absolute': {
                const action = readAbsoluteAction();
                const target = elements.absoluteTarget.value === 'contrast' ? '对比度' : '亮度';
                return {
                    action,
                    defaultName: `${target}设为 ${action.type === 'write' ? action.value : ''}`,
                    closeWebViewAfter: false,
                };
            }
            case 'input': {
                const action = readInputAction();
                return {
                    action,
                    defaultName: `切换输入源 ${action.type === 'write' ? formatFlexibleNumber(action.value) : ''}`,
                    closeWebViewAfter: elements.inputCloseToggle.checked,
                };
            }
            case 'power': {
                const action = readPowerAction();
                return {
                    action,
                    defaultName: `切换电源模式 ${action.type === 'write' ? formatFlexibleNumber(action.value) : ''}`,
                    closeWebViewAfter: false,
                };
            }
            case 'relative':
            default: {
                const action = readRelativeAction();
                const target = elements.relativeTarget.value === 'contrast' ? '对比度' : '亮度';
                const direction = elements.relativeDirection.value === 'decrease' ? '减少' : '增加';
                return {
                    action,
                    defaultName: `${target}${direction} ${action.type === 'adjust-percent' ? action.percent : ''}%`,
                    closeWebViewAfter: false,
                };
            }
        }
    }

    function readRelativeAction(): AdvancedVcpAction {
        const code = parseCode(elements.relativeCode.value);
        const percent = Number(elements.relativePercent.value);
        if (!Number.isFinite(percent) || percent <= 0) {
            throw new Error('请填写大于 0 的调节百分比');
        }
        return {
            type: 'adjust-percent',
            code,
            direction: elements.relativeDirection.value === 'decrease' ? 'decrease' : 'increase',
            percent,
        };
    }

    function readAbsoluteAction(): AdvancedVcpAction {
        return {
            type: 'write',
            code: parseCode(elements.absoluteCode.value),
            value: parseValue(elements.absoluteValue.value),
        };
    }

    function readInputAction(): AdvancedVcpAction {
        return {
            type: 'write',
            code: parseCode(elements.inputCode.value),
            value: parseValue(elements.inputValue.value),
        };
    }

    function readPowerAction(): AdvancedVcpAction {
        return {
            type: 'write',
            code: parseCode(elements.powerCode.value),
            value: parseValue(elements.powerValue.value),
        };
    }

    function readCustomAction(): AdvancedVcpAction {
        const code = parseCode(elements.customCode.value);
        return elements.customMode.value === 'write'
            ? { type: 'write', code, value: parseValue(elements.customValue.value) }
            : { type: 'read', code };
    }

    function syncPresetMode(): void {
        const mode = elements.presetMode.value;
        for (const section of document.querySelectorAll<HTMLElement>('.advanced-preset-section')) {
            section.hidden = section.dataset.presetMode !== mode;
        }
    }

    function syncCustomMode(): void {
        elements.customValueField.hidden = elements.customMode.value !== 'write';
    }

    function runUi(operation: () => void): void {
        try {
            operation();
        } catch (error) {
            options.showToast(error instanceof Error ? error.message : String(error));
        }
    }

    function requireMonitorId(): string {
        const monitorId = elements.monitorSelect.value;
        if (!monitorId) {
            throw new Error('请先选择一台在线显示器');
        }
        return monitorId;
    }

    return { bind, render, refreshControlStates };
}

function formatShortcutConflict(shortcut: string, owner: AdvancedVcpShortcutCommand): string {
    return `全局快捷键 ${shortcut} 已被快捷命令“${owner.name}”（${owner.monitorName}）占用`;
}

function parseCode(value: string): number {
    const parsed = parseFlexibleUnsignedInteger(value, 'VCP Code');
    if (parsed > 0xff) {
        throw new Error(`VCP Code 必须位于 0x00 到 0xFF：${value}`);
    }
    return parsed;
}

function parseValue(value: string): number {
    const parsed = parseFlexibleUnsignedInteger(value, 'VCP Value');
    if (parsed > 0xffffffff) {
        throw new Error(`VCP Value 必须位于 0 到 0xFFFFFFFF：${value}`);
    }
    return parsed;
}

function parseFlexibleUnsignedInteger(value: string, name: string): number {
    const text = value.trim();
    if (!text) {
        throw new Error(`请填写 ${name}`);
    }
    if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(text)) {
        throw new Error(`${name} 仅支持十进制整数或 0x 前缀十六进制：${text}`);
    }
    const parsed = Number(text);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error(`${name} 不是有效的无符号整数：${text}`);
    }
    return parsed;
}

function formatExecutionResult(result: AdvancedVcpExecutionOutcome): string {
    const code = formatHex(result.code);
    if (result.operation === 'read') {
        return `${code} = ${result.current ?? '?'} / ${result.maximum ?? '?'}`;
    }
    if (result.previous !== undefined) {
        return `${code}：${result.previous} → ${result.value}（maximum ${result.maximum ?? '?'}）`;
    }
    return `${code} 已写入 ${result.value}`;
}

function describeAction(command: AdvancedVcpShortcutCommand): string {
    const action = command.action;
    if (action.type === 'read') {
        return `读取 ${formatHex(action.code)}`;
    }
    if (action.type === 'adjust-percent') {
        return `${action.direction === 'increase' ? '增加' : '减少'} ${action.percent}% · ${formatHex(action.code)}`;
    }
    return `写入 ${formatHex(action.code)} = ${formatFlexibleNumber(action.value)}${command.closeWebViewAfter ? ' · 成功后关闭 WebView' : ''}`;
}

function formatFlexibleNumber(value: number): string {
    return `${value} (${formatHex(value)})`;
}

function formatHex(value: number): string {
    return `0x${Math.max(0, Math.trunc(value)).toString(16).toUpperCase().padStart(2, '0')}`;
}
