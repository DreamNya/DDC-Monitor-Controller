import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AdvancedVcpShortcutCommand } from '../../shared/model.ts';
import { createGlobalHotkeyBindings, GlobalHotkeyRouter } from './global-hotkeys.ts';

test('TypeScript routes registered hotkeys to execution or recording and excludes delayed events across transitions', () => {
    const router = new GlobalHotkeyRouter();
    assert.equal(router.route(1), 'execute');
    router.setCaptureActive(true, 3);
    assert.equal(router.route(2), 'ignore'); // Previously queued normal hotkey.
    assert.equal(router.route(3), 'ignore');
    assert.equal(router.route(4), 'capture');
    assert.equal(router.route(5), 'capture');

    router.setCaptureActive(false, 7);
    assert.equal(router.route(6), 'ignore'); // Recording delivered after close.
    assert.equal(router.route(7), 'ignore');
    assert.equal(router.route(8), 'execute');

    router.setCaptureActive(true, 10);
    assert.equal(router.route(9), 'ignore');
    assert.equal(router.route(11), 'capture');
    router.setCaptureActive(true, 20); // Repeated notifications are idempotent.
    assert.equal(router.route(12), 'capture');
    router.setCaptureActive(false, 21);
    assert.equal(router.route(22), 'execute');
    router.setCaptureActive(false, 30);
    assert.equal(router.route(23), 'execute');
});

test('global hotkeys register each normalized shortcut once and move the binding when its first command is deleted', () => {
    const command = (id: string, shortcut: string | null): AdvancedVcpShortcutCommand => ({
        id,
        name: id,
        monitorId: 'monitor-1',
        monitorName: 'Test Monitor',
        action: { type: 'read', code: 0x10 },
        shortcut,
        closeWebViewAfter: false,
    });
    const commands = [
        command('first', 'Ctrl+Alt+H'),
        command('second', 'alt+control+h'),
        command('manual-only', null),
        command('other', 'Ctrl+Alt+P'),
    ];
    assert.deepEqual(createGlobalHotkeyBindings(commands), [
        { id: 'first', label: 'first (Ctrl+Alt+H)', modifiers: 3, virtualKey: 0x48 },
        { id: 'other', label: 'other (Ctrl+Alt+P)', modifiers: 3, virtualKey: 0x50 },
    ]);
    assert.deepEqual(
        createGlobalHotkeyBindings(commands.slice(1)).map(({ id }) => id),
        ['second', 'other'],
    );
});
