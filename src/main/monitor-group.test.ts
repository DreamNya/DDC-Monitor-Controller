import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppSettings, AppStateChange } from '../shared/model.ts';
import { AppController } from './app-controller.ts';
import { createPanelBridge } from './panel/panel-bridge.ts';
import { DDCMonitorController, type DdcClient } from './services/monitor-controller.ts';
import type { NativeMonitor } from './services/monitor/native-ddc-client.ts';
import { createDefaultSettings } from './services/settings-store.ts';

class GroupDdcClient implements DdcClient {
    monitors: NativeMonitor[] = [
        { id: 'first', index: 0, name: 'First' },
        { id: 'second', index: 1, name: 'Second' },
        { id: 'third', index: 2, name: 'Third' },
    ];
    writes: Array<{ index: number; code: number; value: number }> = [];
    failedIndex: number | undefined;
    refreshMonitors() {
        return this.monitors;
    }
    readVcpValue(index: number) {
        return { current: index === 1 ? 190 : 30, maximum: index === 1 ? 200 : 100 };
    }
    getCapabilities() {
        return '(vcp(10 12))';
    }
    writeVcpValue(index: number, code: number, value: number) {
        if (index === this.failedIndex) {
            throw new Error('DDC write failed');
        }
        this.writes.push({ index, code, value });
    }
    dispose() {}
}

async function setup() {
    const client = new GroupDdcClient();
    const settings = createDefaultSettings();
    settings.autoEnabled = false;
    const staged: AppSettings[] = [];
    const controller = new AppController({
        monitorController: new DDCMonitorController(client),
        settingsStore: {
            load: async () => settings,
            stage: (value) => {
                staged.push(structuredClone(value));
            },
            dispose: async () => {},
        },
    });
    await controller.initialize({ mode: 'command' });
    await controller.saveMonitorGroup({ name: 'Desk', monitorIds: ['first', 'second'] });
    const group = controller.getState().settings.monitorGroups[0]!;
    return { controller, client, staged, group };
}

test('group shortcuts use each monitor maximum and leave nonmembers untouched', async () => {
    const { controller, client, group } = await setup();
    try {
        await controller.saveAdvancedVcpCommand({
            name: 'Increase',
            monitorId: '',
            monitorGroupId: group.id,
            action: { type: 'adjust-percent', code: 0x10, direction: 'increase', percent: 10 },
            shortcut: 'alt+control+up',
        });
        const command = controller.getState().settings.advancedVcpCommands[0]!;
        const outcome = await controller.executeAdvancedVcpCommand(command.id);
        assert.deepEqual(client.writes, [
            { index: 0, code: 0x10, value: 40 },
            { index: 1, code: 0x10, value: 200 },
        ]);
        assert.equal(outcome.results?.length, 2);
        assert.equal(command.shortcut, 'Ctrl+Alt+Up');
        assert.deepEqual(
            controller.getState().monitors.map(({ brightness }) => brightness),
            [40, 100, 30],
        );
    } finally {
        await controller.dispose();
    }
});

test('editing a group updates command members and name; deleting it also removes its commands atomically', async () => {
    const { controller, client, group, staged } = await setup();
    try {
        await controller.saveAdvancedVcpCommand({
            name: 'Input',
            monitorId: '',
            monitorGroupId: group.id,
            action: { type: 'write', code: 0x60, value: 0x11 },
            shortcut: null,
        });
        const commandId = controller.getState().settings.advancedVcpCommands[0]!.id;
        await controller.saveMonitorGroup({ id: group.id, name: 'New Desk', monitorIds: ['second', 'third', 'third'] });
        await controller.executeAdvancedVcpCommand(commandId);
        assert.deepEqual(
            client.writes.map(({ index }) => index),
            [1, 2],
        );
        assert.equal(staged.at(-1)?.advancedVcpCommands[0]?.monitorName, 'New Desk');
        assert.deepEqual(staged.at(-1)?.monitorGroups[0]?.monitorIds, ['second', 'third']);
        await controller.saveAdvancedVcpCommand({
            name: 'Single',
            monitorId: 'first',
            action: { type: 'read', code: 0x10 },
            shortcut: 'Ctrl+Alt+A',
        });
        await controller.saveAdvancedVcpCommand({
            name: 'Group read',
            monitorId: '',
            monitorGroupId: group.id,
            action: { type: 'read', code: 0x10 },
            shortcut: 'Ctrl+Alt+B',
        });
        const changes: AppStateChange[] = [];
        controller.setStateListener((change) => changes.push(change));
        await controller.deleteMonitorGroup(group.id);
        assert.equal(controller.getState().settings.monitorGroups.length, 0);
        assert.deepEqual(
            controller.getState().settings.advancedVcpCommands.map(({ name }) => name),
            ['Single'],
        );
        assert.deepEqual(
            staged.at(-1)?.advancedVcpCommands.map(({ name }) => name),
            ['Single'],
        );
        assert.deepEqual(staged.at(-1)?.monitorGroups, []);
        assert.deepEqual(
            changes.map(({ reason }) => reason),
            ['update-settings'],
        );
        assert.match(controller.getState().lastOperation, /2 个关联快捷命令/);
        await assert.rejects(controller.executeAdvancedVcpCommand(commandId), /找不到高级 VCP 快捷命令/);
    } finally {
        await controller.dispose();
    }
});

test('the only monitor group can be deleted, while an unknown group leaves settings unchanged', async () => {
    const { controller, group, staged } = await setup();
    try {
        assert.equal(controller.getState().settings.monitorGroups.length, 1);
        const count = staged.length;
        await assert.rejects(controller.deleteMonitorGroup('missing'), /找不到显示器组/);
        assert.equal(staged.length, count);
        await controller.deleteMonitorGroup(group.id);
        assert.deepEqual(controller.getState().settings.monitorGroups, []);
    } finally {
        await controller.dispose();
    }
});

test('shortcuts stay unique across single monitors and groups, including normalized modifier aliases', async () => {
    const { controller, group } = await setup();
    try {
        const action = { type: 'read' as const, code: 0x10 };
        await controller.saveAdvancedVcpCommand({ name: 'Single', monitorId: 'third', action, shortcut: 'Ctrl+Alt+A' });
        await assert.rejects(
            controller.saveAdvancedVcpCommand({
                name: 'Group',
                monitorId: '',
                monitorGroupId: group.id,
                action,
                shortcut: 'alt+control+a',
            }),
            /已被快捷命令/,
        );
        await controller.saveAdvancedVcpCommand({
            name: 'Group',
            monitorId: '',
            monitorGroupId: group.id,
            action,
            shortcut: 'Ctrl+Alt+B',
        });
        await assert.rejects(
            controller.saveAdvancedVcpCommand({
                name: 'Single 2',
                monitorId: 'third',
                action,
                shortcut: 'Alt+Ctrl+B',
            }),
            /已被快捷命令/,
        );
        assert.equal(controller.getState().settings.advancedVcpCommands.length, 2);
    } finally {
        await controller.dispose();
    }
});

test('one hotkey executes both single-monitor and group commands after duplicate shortcuts are disabled', async () => {
    const { controller, client, group } = await setup();
    try {
        await controller.setAllowDuplicateShortcuts(true);
        await controller.saveAdvancedVcpCommand({
            name: 'Single',
            monitorId: 'third',
            action: { type: 'write', code: 0x10, value: 50 },
            shortcut: 'Ctrl+Alt+A',
        });
        await controller.saveAdvancedVcpCommand({
            name: 'Group',
            monitorId: '',
            monitorGroupId: group.id,
            action: { type: 'write', code: 0x12, value: 60 },
            shortcut: 'Alt+Control+A',
        });
        await controller.setAllowDuplicateShortcuts(false);
        const commands = controller.getState().settings.advancedVcpCommands;
        // 原生只注册其中一个命令 ID；任一关联 ID 都应执行完整快捷键集合
        const results = await controller.executeAdvancedVcpHotkey(commands[1]!.id);
        assert.deepEqual(
            results.map(({ status }) => status),
            ['fulfilled', 'fulfilled'],
        );
        assert.deepEqual(client.writes, [
            { index: 2, code: 0x10, value: 50 },
            { index: 0, code: 0x12, value: 60 },
            { index: 1, code: 0x12, value: 60 },
        ]);
    } finally {
        await controller.dispose();
    }
});

test('group execution continues after a failed write and publishes partial cache without closing the panel', async () => {
    const { controller, client, group } = await setup();
    try {
        client.failedIndex = 0;
        const changes: AppStateChange[] = [];
        controller.setStateListener((change) => changes.push(change));
        let closed = false;
        const bridge = createPanelBridge({
            appController: controller,
            closePanel: () => {
                closed = true;
            },
            openControlPanel() {},
            startControlWindowDrag() {},
            openLogFolder() {},
            setGlobalHotkeyCaptureActive() {},
        });
        await assert.rejects(
            bridge.executeAdvancedVcp({
                monitorId: '',
                monitorGroupId: group.id,
                action: { type: 'write', code: 0x10, value: 100 },
                closeWebViewAfter: true,
            }),
            /1\/2 台执行成功.*DDC write failed/,
        );
        assert.deepEqual(client.writes, [{ index: 1, code: 0x10, value: 100 }]);
        assert.equal(changes.length, 1);
        assert.equal(changes[0]?.state.monitors[1]?.brightness, 50);
        assert.match(controller.getState().lastError ?? '', /1\/2 台执行成功/);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(closed, false);
        client.failedIndex = undefined;
        await bridge.executeAdvancedVcp({
            monitorId: '',
            monitorGroupId: group.id,
            action: { type: 'write', code: 0x60, value: 17 },
            closeWebViewAfter: true,
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(closed, true);
    } finally {
        await controller.dispose();
    }
});

test('offline and ambiguous group members are retained and skipped while other members execute', async () => {
    const { controller, client, group } = await setup();
    try {
        await controller.saveAdvancedVcpCommand({
            name: 'Input',
            monitorId: '',
            monitorGroupId: group.id,
            action: { type: 'write', code: 0x60, value: 17 },
            shortcut: null,
        });
        const commandId = controller.getState().settings.advancedVcpCommands[0]!.id;
        client.monitors = client.monitors.filter(({ id }) => id !== 'first');
        await controller.refreshMonitors();
        await controller.saveMonitorGroup({ ...group, name: 'Offline Desk' });
        await assert.rejects(controller.executeAdvancedVcpCommand(commandId), /1\/2 台执行成功.*离线/);
        assert.deepEqual(
            client.writes.map(({ index }) => index),
            [1],
        );
        client.monitors.push({ id: 'first', name: 'First', index: 0 }, { id: 'first', name: 'Duplicate', index: 3 });
        await controller.refreshMonitors();
        await assert.rejects(controller.executeAdvancedVcpCommand(commandId), /1\/2 台执行成功.*身份不唯一/);
        assert.deepEqual(
            client.writes.map(({ index }) => index),
            [1, 1],
        );
        assert.deepEqual(controller.getState().settings.monitorGroups[0]?.monitorIds, ['first', 'second']);
        client.monitors = [];
        await controller.refreshMonitors();
        await assert.rejects(controller.executeAdvancedVcpCommand(commandId), /0\/2 台执行成功/);
        assert.equal(client.writes.length, 2);
    } finally {
        await controller.dispose();
    }
});

test('group reads return every result; invalid group edits and targets do not mutate settings or write', async () => {
    const { controller, client, group, staged } = await setup();
    try {
        const result = await controller.executeAdvancedVcp({
            monitorId: '',
            monitorGroupId: group.id,
            action: { type: 'read', code: 0x10 },
        });
        assert.deepEqual(
            result.results?.map(({ current, maximum }) => [current, maximum]),
            [
                [30, 100],
                [190, 200],
            ],
        );
        const count = staged.length;
        await assert.rejects(controller.saveMonitorGroup({ name: 'Empty', monitorIds: [] }), /需要包含/);
        await assert.rejects(controller.saveMonitorGroup({ name: 'Invalid', monitorIds: ['all'] }), /具体显示器/);
        await assert.rejects(controller.saveMonitorGroup({ name: 'Offline', monitorIds: ['missing'] }), /无法添加/);
        await assert.rejects(controller.saveMonitorGroup({ name: 'desk', monitorIds: ['third'] }), /已存在/);
        await assert.rejects(
            controller.executeAdvancedVcp({
                monitorId: 'first',
                monitorGroupId: group.id,
                action: { type: 'write', code: 0x10, value: 0 },
            }),
            /请选择/,
        );
        await assert.rejects(
            controller.saveAdvancedVcpCommand({
                name: 'Missing',
                monitorId: '',
                monitorGroupId: 'missing',
                action: { type: 'read', code: 0x10 },
                shortcut: null,
            }),
            /找不到显示器组/,
        );
        assert.equal(staged.length, count);
        assert.equal(client.writes.length, 0);
    } finally {
        await controller.dispose();
    }
});
