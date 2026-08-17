import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
    AdvancedVcpExecuteRequest,
    AdvancedVcpShortcutDraft,
    AppState,
    FontSizePx,
    FontSizeTarget,
    IntervalMinutes,
    LiveApplyRequest,
    ManualApplyRequest,
    MonitorTarget,
    SchedulePoint,
    UiScalePercent,
    UiScaleTarget,
} from '../../shared/model';
import type { AppController } from '../app-controller.ts';
import { createDefaultSettings } from '../services/settings-store.ts';
import { createPanelBridge } from './panel-bridge.ts';

test('PanelBridge keeps an explicit command boundary and returns only acknowledgements', async () => {
    const calls: Array<{ name: string; args: unknown[] }> = [];
    const state: AppState = {
        settings: createDefaultSettings(),
        monitors: [],
        calculatedValues: { brightness: 50, contrast: 50 },
        nextRunAt: null,
        lastOperation: 'test',
        lastError: null,
    };

    const record = (name: string, ...args: unknown[]): Promise<void> => {
        calls.push({ name, args });
        return Promise.resolve();
    };

    const appController = {
        getState: () => state,
        refreshMonitors: () => record('refreshMonitors'),
        getMonitorCapabilities: async (monitorId: string) => {
            calls.push({ name: 'getMonitorCapabilities', args: [monitorId] });
            return {
                monitorId,
                monitorName: 'Test Monitor',
                raw: '(vcp(10))',
                vcpCodes: [{ code: 0x10, supportedValues: null }],
            };
        },
        getMonitorVcpValues: async (monitorId: string, codes: readonly number[]) => {
            calls.push({ name: 'getMonitorVcpValues', args: [monitorId, codes] });
            return codes.map((code) => ({ code, current: 50, maximum: 100 }));
        },
        executeAdvancedVcp: async (request: AdvancedVcpExecuteRequest) => {
            calls.push({ name: 'executeAdvancedVcp', args: [request] });
            return {
                monitorId: request.monitorId,
                code: request.action.code,
                operation: request.action.type === 'read' ? 'read' as const : 'write' as const,
                ...(request.action.type === 'read' ? { current: 50, maximum: 100 } : { value: 'value' in request.action ? request.action.value : 55 }),
                closeWebViewAfter: request.closeWebViewAfter === true,
            };
        },
        saveAdvancedVcpCommand: (command: AdvancedVcpShortcutDraft) => record('saveAdvancedVcpCommand', command),
        deleteAdvancedVcpCommand: (commandId: string) => record('deleteAdvancedVcpCommand', commandId),
        executeAdvancedVcpCommand: async (commandId: string) => {
            calls.push({ name: 'executeAdvancedVcpCommand', args: [commandId] });
            return {
                monitorId: 'monitor-1',
                code: 0x60,
                operation: 'write' as const,
                value: 0x11,
                closeWebViewAfter: false,
            };
        },
        applyManual: (request: ManualApplyRequest) => record('applyManual', request),
        applyLive: (request: LiveApplyRequest) => record('applyLive', request),
        applyAutoNow: () => record('applyAutoNow'),
        setAutoInterval: (intervalMinutes: IntervalMinutes | null) => record('setAutoInterval', intervalMinutes),
        setTargetMonitor: (monitorId: MonitorTarget) => record('setTargetMonitor', monitorId),
        setUiScale: (target: UiScaleTarget, percent: UiScalePercent) => record('setUiScale', target, percent),
        resetUiScale: () => record('resetUiScale'),
        setFontSize: (target: FontSizeTarget, pixels: FontSizePx) => record('setFontSize', target, pixels),
        resetFontSize: () => record('resetFontSize'),
        setActiveScheduleProfile: (profileId: string) => record('setActiveScheduleProfile', profileId),
        createScheduleProfile: (name: string, schedule: SchedulePoint[]) =>
            record('createScheduleProfile', name, schedule),
        renameScheduleProfile: (profileId: string, name: string) =>
            record('renameScheduleProfile', profileId, name),
        deleteScheduleProfile: (profileId: string) => record('deleteScheduleProfile', profileId),
        saveSchedule: (profileId: string, schedule: SchedulePoint[]) => record('saveSchedule', profileId, schedule),
        setLogEnabled: (enabled: boolean) => record('setLogEnabled', enabled),
        resetSettings: () => record('resetSettings'),
    };

    let opened = false;
    let closed = false;
    let dragStarted = false;
    let logFolderOpened = false;
    let globalHotkeyCaptureActive = false;
    const bridge = createPanelBridge({
        appController: appController as unknown as AppController,
        openControlPanel: () => {
            opened = true;
        },
        closePanel: () => {
            closed = true;
        },
        startControlWindowDrag: () => {
            dragStarted = true;
        },
        openLogFolder: () => {
            logFolderOpened = true;
        },
        setGlobalHotkeyCaptureActive: (active) => {
            globalHotkeyCaptureActive = active;
        },
    });

    assert.equal(await bridge.getState(), state);
    assert.deepEqual(await bridge.getMonitorCapabilities({ monitorId: 'monitor-1' }), {
        monitorId: 'monitor-1',
        monitorName: 'Test Monitor',
        raw: '(vcp(10))',
        vcpCodes: [{ code: 0x10, supportedValues: null }],
    });
    assert.deepEqual(await bridge.getMonitorVcpValues({ monitorId: 'monitor-1', codes: [0x10, 0xfd] }), [
        { code: 0x10, current: 50, maximum: 100 },
        { code: 0xfd, current: 50, maximum: 100 },
    ]);
    assert.deepEqual(
        await bridge.executeAdvancedVcp({
            monitorId: 'monitor-1',
            action: { type: 'write', code: 0x60, value: 0x11 },
            closeWebViewAfter: false,
        }),
        { monitorId: 'monitor-1', code: 0x60, operation: 'write', value: 0x11, closeWebViewAfter: false },
    );
    const shortcutDraft: AdvancedVcpShortcutDraft = {
        name: 'HDMI',
        monitorId: 'monitor-1',
        action: { type: 'write', code: 0x60, value: 0x11 },
        shortcut: 'Ctrl+Alt+H',
    };
    assert.equal(await bridge.setGlobalHotkeyCaptureActive({ active: true }), null);
    assert.equal(globalHotkeyCaptureActive, true);
    assert.equal(await bridge.setGlobalHotkeyCaptureActive({ active: false }), null);
    assert.equal(globalHotkeyCaptureActive, false);
    assert.equal(await bridge.saveAdvancedVcpCommand({ command: shortcutDraft }), null);
    assert.deepEqual(await bridge.executeAdvancedVcpCommand({ commandId: 'command-1' }), {
        monitorId: 'monitor-1',
        code: 0x60,
        operation: 'write',
        value: 0x11,
        closeWebViewAfter: false,
    });
    assert.equal(await bridge.deleteAdvancedVcpCommand({ commandId: 'command-1' }), null);
    assert.equal(await bridge.setAutoInterval({ intervalMinutes: 15 }), null);
    assert.equal(await bridge.setUiScale({ target: 'quick', percent: 125 }), null);
    assert.equal(await bridge.resetUiScale(), null);
    assert.equal(await bridge.setFontSize({ target: 'hint', pixels: 13 }), null);
    assert.equal(await bridge.resetFontSize(), null);
    assert.deepEqual(calls, [
        { name: 'getMonitorCapabilities', args: ['monitor-1'] },
        { name: 'getMonitorVcpValues', args: ['monitor-1', [0x10, 0xfd]] },
        {
            name: 'executeAdvancedVcp',
            args: [{ monitorId: 'monitor-1', action: { type: 'write', code: 0x60, value: 0x11 }, closeWebViewAfter: false }],
        },
        { name: 'saveAdvancedVcpCommand', args: [shortcutDraft] },
        { name: 'executeAdvancedVcpCommand', args: ['command-1'] },
        { name: 'deleteAdvancedVcpCommand', args: ['command-1'] },
        { name: 'setAutoInterval', args: [15] },
        { name: 'setUiScale', args: ['quick', 125] },
        { name: 'resetUiScale', args: [] },
        { name: 'setFontSize', args: ['hint', 13] },
        { name: 'resetFontSize', args: [] },
    ]);

    assert.equal(await bridge.startControlWindowDrag(), null);
    assert.equal(dragStarted, true);

    assert.equal(await bridge.openLogFolder(), null);
    assert.equal(logFolderOpened, true);

    assert.equal(await bridge.openControlPanel(), null);
    assert.equal(opened, false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(opened, true);

    assert.equal(await bridge.closePanel(), null);
    assert.equal(closed, false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closed, true);
});
