import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AdvancedVcpShortcutCommand } from '../../shared/model.ts';
import { createGlobalHotkeyBindings } from './global-hotkeys.ts';

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
