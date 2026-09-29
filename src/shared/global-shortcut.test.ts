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
    assert.deepEqual(parseGlobalShortcut('win+shift+alt+control+page down'), {
        normalized: 'Ctrl+Alt+Shift+Win+PageDown',
        modifiers: 0x000f,
        virtualKey: 0x22,
    });
});

test('parseGlobalShortcut preserves existing aliases and named key virtual codes', () => {
    const keys: Array<[string, string, number]> = [
        ['spacebar', 'Space', 0x20],
        ['page up', 'PageUp', 0x21],
        ['page down', 'PageDown', 0x22],
        ['arrowleft', 'Left', 0x25],
        ['arrowup', 'Up', 0x26],
        ['arrowright', 'Right', 0x27],
        ['arrowdown', 'Down', 0x28],
        ['del', 'Delete', 0x2e],
        ['HOME', 'Home', 0x24],
        ['end', 'End', 0x23],
        ['insert', 'Insert', 0x2d],
        ['numpad0', 'Numpad0', 0x60],
        ['NUMPAD9', 'Numpad9', 0x69],
        ['f1', 'F1', 0x70],
        ['f24', 'F24', 0x87],
    ];
    for (const [input, name, virtualKey] of keys) {
        assert.deepEqual(parseGlobalShortcut(`Control+${input}`), {
            normalized: `Ctrl+${name}`,
            modifiers: 0x0002,
            virtualKey,
        });
    }
    for (const alias of ['meta', 'super']) {
        assert.deepEqual(parseGlobalShortcut(`${alias}+a`), {
            normalized: 'Win+A',
            modifiers: 0x0008,
            virtualKey: 0x41,
        });
    }
});

test('parseGlobalShortcut accepts surrounding whitespace without an arbitrary length cap', () => {
    assert.deepEqual(parseGlobalShortcut(`  ctrl${' '.repeat(70)}+ alt + a  `), parseGlobalShortcut('Ctrl+Alt+A'));
});

test('keyboardShortcutKey uses the physical digit key for Shift+number', () => {
    assert.equal(keyboardShortcutKey({ key: '!', code: 'Digit1' }), '1');
    assert.deepEqual(parseGlobalShortcut(`Shift+${keyboardShortcutKey({ key: '!', code: 'Digit1' })}`), {
        normalized: 'Shift+1',
        modifiers: 0x0004,
        virtualKey: 0x31,
    });
});

test('keyboardShortcutKey preserves physical letters and numpad keys and normalizes key fallback', () => {
    const inputs: Array<[string, string, string, number]> = [
        ['й', 'KeyQ', 'Q', 0x51],
        ['Home', 'Numpad7', 'Numpad7', 0x67],
        ['Delete', 'Numpad0', 'Numpad0', 0x60],
        [' ', 'Space', 'Space', 0x20],
        ['ArrowLeft', 'ArrowLeft', 'Left', 0x25],
        ['PageDown', 'PageDown', 'PageDown', 0x22],
        ['F24', 'F24', 'F24', 0x87],
        ['a', '', 'A', 0x41],
        [' ', '', 'Space', 0x20],
        ['ArrowDown', '', 'Down', 0x28],
        ['f12', '', 'F12', 0x7b],
    ];
    for (const [key, code, expected, virtualKey] of inputs) {
        const shortcutKey = keyboardShortcutKey({ key, code });
        assert.equal(shortcutKey, expected);
        assert.equal(parseGlobalShortcut(`Alt+${shortcutKey}`).virtualKey, virtualKey);
    }
});

test('parseGlobalShortcut rejects unsafe or ambiguous shortcuts', () => {
    assert.throws(() => parseGlobalShortcut('A'), /至少需要/);
    assert.throws(() => parseGlobalShortcut('Ctrl+Alt'), /缺少普通按键/);
    assert.throws(() => parseGlobalShortcut('Ctrl+A+B'), /只能包含一个普通按键/);
    assert.throws(() => parseGlobalShortcut('Ctrl+Control+A'), /重复修饰键/);
    assert.throws(() => parseGlobalShortcut('Win+Meta+A'), /重复修饰键/);
    for (const shortcut of ['', '   ']) {
        assert.throws(() => parseGlobalShortcut(shortcut), /全局快捷键为空/);
    }
    for (const shortcut of ['Ctrl++A', '+Ctrl+A', 'Ctrl+A+', 'Ctrl+ +A']) {
        assert.throws(() => parseGlobalShortcut(shortcut), /空的按键片段/);
    }
    for (const key of ['F0', 'F25', 'Numpad10', 'Escape', '未知键']) {
        assert.throws(() => parseGlobalShortcut(`Ctrl+${key}`), /不支持/);
    }
});
