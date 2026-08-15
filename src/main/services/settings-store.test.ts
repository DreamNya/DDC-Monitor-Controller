import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
    createDefaultSettings,
    SETTINGS_SAVE_THROTTLE_MS,
    SettingsStore,
} from './settings-store.ts';

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
