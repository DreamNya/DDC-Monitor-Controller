import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_EXTERNAL_API_PORT } from '../../api/external-api-config.ts';
import { createDefaultSettings, SETTINGS_SAVE_THROTTLE_MS, SettingsStore } from './settings-store.ts';

test('SettingsStore preserves monitor groups and group shortcuts across saves and loads old single-monitor configurations', async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'monitor-groups-'));
    const settingsPath = path.join(directory, 'settings.json');
    const store = new SettingsStore({ settingsPath });
    try {
        const settings = createDefaultSettings();
        settings.monitorGroups = [{ id: 'desk', name: 'Desk', monitorIds: ['first', 'second'] }];
        settings.advancedVcpCommands = [
            {
                id: 'group-command',
                name: 'Group brightness',
                monitorId: '',
                monitorGroupId: 'desk',
                monitorName: 'Desk',
                action: { type: 'adjust-percent', code: 0x10, direction: 'increase', percent: 5 },
                shortcut: 'Ctrl+Alt+Up',
                closeWebViewAfter: false,
            },
        ];
        store.stage(settings);
        await store.flush();
        assert.deepEqual(await store.load(), settings);
        const legacy = {
            ...settings,
            monitorGroups: undefined,
            advancedVcpCommands: [
                {
                    ...settings.advancedVcpCommands[0],
                    monitorId: 'first',
                    monitorGroupId: undefined,
                    monitorName: 'First',
                },
            ],
        };
        await fs.writeFile(settingsPath, JSON.stringify(legacy), 'utf8');
        const loaded = await store.load();
        assert.deepEqual(loaded.monitorGroups, []);
        assert.equal(loaded.advancedVcpCommands[0]?.monitorId, 'first');
        assert.equal(loaded.advancedVcpCommands[0]?.monitorGroupId, undefined);

        await fs.writeFile(
            settingsPath,
            JSON.stringify({
                ...settings,
                monitorGroups: [
                    ...settings.monitorGroups,
                    { id: 'duplicate', name: 'desk', monitorIds: ['first'] },
                    { id: 'invalid', name: 'Invalid', monitorIds: ['all'] },
                    { id: 'empty', name: 'Empty', monitorIds: [] },
                ],
                advancedVcpCommands: [
                    ...settings.advancedVcpCommands,
                    {
                        ...settings.advancedVcpCommands[0],
                        id: 'single',
                        monitorId: 'first',
                        monitorGroupId: undefined,
                        shortcut: 'Alt+Control+Up',
                    },
                    { ...settings.advancedVcpCommands[0], id: 'ambiguous', monitorId: 'first', shortcut: null },
                    {
                        ...settings.advancedVcpCommands[0],
                        id: 'missing-group',
                        monitorGroupId: 'deleted',
                        shortcut: null,
                    },
                ],
            }),
            'utf8',
        );
        const normalized = await store.load();
        assert.deepEqual(normalized.monitorGroups, settings.monitorGroups);
        assert.deepEqual(
            normalized.advancedVcpCommands.map(({ id }) => id),
            ['group-command', 'single', 'missing-group'],
        );
        assert.equal(normalized.advancedVcpCommands[1]?.shortcut, 'Ctrl+Alt+Up');
        assert.equal(normalized.advancedVcpCommands[2]?.monitorGroupId, 'deleted');
        assert.equal(normalized.advancedVcpCommands[2]?.monitorId, '');
    } finally {
        await store.dispose();
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('SettingsStore persists duplicate shortcuts with either switch state and defaults legacy settings to disabled', async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'duplicate-shortcuts-'));
    const settingsPath = path.join(directory, 'settings.json');
    const store = new SettingsStore({ settingsPath });
    try {
        const settings = createDefaultSettings();
        settings.advancedVcpCommands = ['first', 'second'].map((id) => ({
            id,
            name: id,
            monitorId: 'monitor-1',
            monitorName: 'Test Monitor',
            action: { type: 'read', code: 0x10 },
            shortcut: 'Ctrl+Alt+H',
            closeWebViewAfter: false,
        }));
        for (const enabled of [true, false]) {
            settings.allowDuplicateShortcuts = enabled;
            store.stage(settings);
            await store.flush();
            assert.deepEqual(await store.load(), settings);
        }
        await fs.writeFile(settingsPath, JSON.stringify({ ...settings, allowDuplicateShortcuts: undefined }), 'utf8');
        assert.deepEqual(await store.load(), settings);
    } finally {
        await store.dispose();
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('SettingsStore merges all changes in one 10-second window into one write', async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'monitor-settings-'));
    const settingsPath = path.join(directory, 'settings.json');
    let scheduled: { callback: () => void; delay: number; handle: ReturnType<typeof setTimeout> } | undefined;
    let scheduleCount = 0;

    const store = new SettingsStore({
        settingsPath,
        setTimer: (callback, delay) => {
            scheduleCount += 1;
            const handle = { id: scheduleCount } as unknown as ReturnType<typeof setTimeout>;
            scheduled = { callback, delay, handle };
            return handle;
        },
        clearTimer: (handle) => {
            if (scheduled?.handle === handle) {
                scheduled = undefined;
            }
        },
    });

    try {
        const first = createDefaultSettings();
        first.logEnabled = true;
        store.stage(first);

        const latest = structuredClone(first);
        latest.intervalMinutes = 15;
        latest.uiScale.quick = 125;
        latest.fontSize.default = 18;
        latest.fontSize.hint = 13;
        store.stage(latest);

        assert.equal(scheduleCount, 1);
        assert.equal(scheduled?.delay, SETTINGS_SAVE_THROTTLE_MS);
        await assert.rejects(fs.access(settingsPath));

        scheduled?.callback();
        await store.flush();

        const saved = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as typeof latest;
        assert.equal(saved.logEnabled, true);
        assert.equal(saved.intervalMinutes, 15);
        assert.equal(saved.uiScale.quick, 125);
        assert.equal(saved.fontSize.default, 18);
        assert.equal(saved.fontSize.hint, 13);
    } finally {
        await store.dispose();
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('SettingsStore flushes pending changes immediately on dispose', async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'monitor-settings-dispose-'));
    const settingsPath = path.join(directory, 'settings.json');
    const store = new SettingsStore({ settingsPath });

    try {
        const settings = createDefaultSettings();
        settings.logEnabled = true;
        store.stage(settings);

        await assert.rejects(fs.access(settingsPath));
        await store.dispose();

        const saved = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as typeof settings;
        assert.equal(saved.logEnabled, true);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('SettingsStore defaults missing auto-start preference to false for existing settings files', async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'monitor-settings-autostart-default-'));
    const settingsPath = path.join(directory, 'settings.json');
    await fs.writeFile(settingsPath, JSON.stringify({ autoEnabled: false, logEnabled: true }), 'utf8');
    const store = new SettingsStore({ settingsPath });

    try {
        const settings = await store.load();
        assert.equal(settings.autoStartEnabled, false);
    } finally {
        await store.dispose();
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('SettingsStore restores persisted auto-start preference from settings.json', async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'monitor-settings-autostart-enabled-'));
    const settingsPath = path.join(directory, 'settings.json');
    await fs.writeFile(settingsPath, JSON.stringify({ autoStartEnabled: true }), 'utf8');
    const store = new SettingsStore({ settingsPath });

    try {
        const settings = await store.load();
        assert.equal(settings.autoStartEnabled, true);
    } finally {
        await store.dispose();
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('SettingsStore defaults local HTTP API to disabled with the default port', async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'monitor-settings-external-api-default-'));
    const settingsPath = path.join(directory, 'settings.json');
    await fs.writeFile(settingsPath, JSON.stringify({ theme: 'dark' }), 'utf8');
    const store = new SettingsStore({ settingsPath });

    try {
        const settings = await store.load();
        assert.equal(settings.externalApiEnabled, false);
        assert.equal(settings.externalApiPort, DEFAULT_EXTERNAL_API_PORT);
    } finally {
        await store.dispose();
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('SettingsStore restores valid local HTTP API settings and rejects invalid persisted ports', async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'monitor-settings-external-api-port-'));
    const settingsPath = path.join(directory, 'settings.json');
    const store = new SettingsStore({ settingsPath });

    try {
        await fs.writeFile(settingsPath, JSON.stringify({ externalApiEnabled: true, externalApiPort: 54321 }), 'utf8');
        let settings = await store.load();
        assert.equal(settings.externalApiEnabled, true);
        assert.equal(settings.externalApiPort, 54321);

        await fs.writeFile(settingsPath, JSON.stringify({ externalApiEnabled: true, externalApiPort: 80 }), 'utf8');
        settings = await store.load();
        assert.equal(settings.externalApiEnabled, true);
        assert.equal(settings.externalApiPort, DEFAULT_EXTERNAL_API_PORT);
    } finally {
        await store.dispose();
        await fs.rm(directory, { recursive: true, force: true });
    }
});
