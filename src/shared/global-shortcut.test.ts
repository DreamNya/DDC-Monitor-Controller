import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keyboardShortcutKey, parseGlobalShortcut } from './global-shortcut.ts';

test('parseGlobalShortcut normalizes modifiers and maps supported keys', () => {
    assert.deepEqual(parseGlobalShortcut('shift+ctrl+f12'), {
        normalized: 'Ctrl+Shift+F12',
        modifiers: 0x0002 | 0x0004,
        virtualKey: 0x7b,
    });
    assert.equal(parseGlobalShortcut('Alt+PageDown').virtualKey, 0x22);
    assert.equal(parseGlobalShortcut('Win+1').normalized, 'Win+1');
});


test('keyboardShortcutKey uses the physical digit key for Shift+number', () => {
    assert.equal(keyboardShortcutKey({ key: '!', code: 'Digit1' }), '1');
    assert.deepEqual(parseGlobalShortcut(`Shift+${keyboardShortcutKey({ key: '!', code: 'Digit1' })}`), {
        normalized: 'Shift+1',
        modifiers: 0x0004,
        virtualKey: 0x31,
    });
});

test('parseGlobalShortcut rejects unsafe or ambiguous shortcuts', () => {
    assert.throws(() => parseGlobalShortcut('A'), /至少需要/);
    assert.throws(() => parseGlobalShortcut('Ctrl+Alt'), /缺少普通按键/);
    assert.throws(() => parseGlobalShortcut('Ctrl+A+B'), /只能包含一个普通按键/);
});
