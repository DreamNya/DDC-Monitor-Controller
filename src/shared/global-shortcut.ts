export const GLOBAL_SHORTCUT_MAX_LENGTH = 64;

export interface KeyboardShortcutKeyInput {
    key: string;
    code: string;
}

/**
 * 将 KeyboardEvent 的按键转换为全局快捷键使用的稳定名称
 *
 * 对 Shift+数字优先使用 KeyboardEvent.code，
 * 例如 Shift+1 的 event.key，通常是 "!"，但 RegisterHotKey 需要的是 MOD_SHIFT + VK_1
 */
export function keyboardShortcutKey(input: KeyboardShortcutKeyInput): string {
    const letterMatch = /^Key([A-Z])$/.exec(input.code);
    if (letterMatch) {
        return letterMatch[1]!;
    }

    const digitMatch = /^Digit([0-9])$/.exec(input.code);
    if (digitMatch) {
        return digitMatch[1]!;
    }

    const numpadMatch = /^Numpad([0-9])$/.exec(input.code);
    if (numpadMatch) {
        return `Numpad${numpadMatch[1]}`;
    }

    if (input.code === 'Space') {
        return 'Space';
    }
    if (input.code.startsWith('Arrow')) {
        return input.code.slice('Arrow'.length);
    }
    if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(input.code)) {
        return input.code;
    }
    if (['PageUp', 'PageDown', 'Home', 'End', 'Insert', 'Delete'].includes(input.code)) {
        return input.code;
    }

    if (input.key === ' ') {
        return 'Space';
    }
    if (input.key.startsWith('Arrow')) {
        return input.key.slice('Arrow'.length);
    }
    if (/^[a-z]$/i.test(input.key)) {
        return input.key.toUpperCase();
    }
    if (/^[0-9]$/.test(input.key)) {
        return input.key;
    }
    if (/^F(?:[1-9]|1[0-9]|2[0-4])$/i.test(input.key)) {
        return input.key.toUpperCase();
    }
    if (['PageUp', 'PageDown', 'Home', 'End', 'Insert', 'Delete'].includes(input.key)) {
        return input.key;
    }
    return input.key;
}

export interface ParsedGlobalShortcut {
    normalized: string;
    modifiers: number;
    virtualKey: number;
}

const MOD_ALT = 0x0001;
const MOD_CONTROL = 0x0002;
const MOD_SHIFT = 0x0004;
const MOD_WIN = 0x0008;

const NAMED_KEYS = new Map<string, number>([
    ['Space', 0x20],
    ['Numpad0', 0x60],
    ['Numpad1', 0x61],
    ['Numpad2', 0x62],
    ['Numpad3', 0x63],
    ['Numpad4', 0x64],
    ['Numpad5', 0x65],
    ['Numpad6', 0x66],
    ['Numpad7', 0x67],
    ['Numpad8', 0x68],
    ['Numpad9', 0x69],
    ['PageUp', 0x21],
    ['PageDown', 0x22],
    ['End', 0x23],
    ['Home', 0x24],
    ['Left', 0x25],
    ['Up', 0x26],
    ['Right', 0x27],
    ['Down', 0x28],
    ['Insert', 0x2d],
    ['Delete', 0x2e],
]);

export function parseGlobalShortcut(value: string): ParsedGlobalShortcut {
    const raw = value.trim();

    if (!raw || raw.length > GLOBAL_SHORTCUT_MAX_LENGTH) {
        throw new Error('全局快捷键为空或过长');
    }

    const parts = raw
        .split('+')
        .map((part) => part.trim())
        .filter(Boolean);
    const modifiers = new Set<string>();
    let key = '';

    for (const part of parts) {
        const normalizedPart = normalizePart(part);

        if (
            normalizedPart === 'Ctrl' ||
            normalizedPart === 'Alt' ||
            normalizedPart === 'Shift' ||
            normalizedPart === 'Win'
        ) {
            if (modifiers.has(normalizedPart)) {
                throw new Error(`全局快捷键包含重复修饰键：${normalizedPart}`);
            }
            modifiers.add(normalizedPart);
            continue;
        }

        if (key) {
            throw new Error('全局快捷键只能包含一个普通按键');
        }
        key = normalizedPart;
    }

    if (!key) {
        throw new Error('全局快捷键缺少普通按键');
    }
    if (modifiers.size === 0) {
        throw new Error('全局快捷键至少需要 Ctrl、Alt、Shift 或 Win 中的一个修饰键');
    }

    let modifierFlags = 0;
    if (modifiers.has('Ctrl')) {
        modifierFlags |= MOD_CONTROL;
    }
    if (modifiers.has('Alt')) {
        modifierFlags |= MOD_ALT;
    }
    if (modifiers.has('Shift')) {
        modifierFlags |= MOD_SHIFT;
    }
    if (modifiers.has('Win')) {
        modifierFlags |= MOD_WIN;
    }

    const virtualKey = toVirtualKey(key);
    const ordered = ['Ctrl', 'Alt', 'Shift', 'Win'].filter((part) => modifiers.has(part));

    return {
        normalized: [...ordered, key].join('+'),
        modifiers: modifierFlags,
        virtualKey,
    };
}

function normalizePart(value: string): string {
    const lower = value.toLocaleLowerCase('en-US');

    if (lower === 'ctrl' || lower === 'control') {
        return 'Ctrl';
    }
    if (lower === 'alt') {
        return 'Alt';
    }
    if (lower === 'shift') {
        return 'Shift';
    }
    if (lower === 'win' || lower === 'meta' || lower === 'super') {
        return 'Win';
    }
    if (lower === 'space' || lower === 'spacebar') {
        return 'Space';
    }
    if (lower === 'pageup' || lower === 'page up') {
        return 'PageUp';
    }
    if (lower === 'pagedown' || lower === 'page down') {
        return 'PageDown';
    }
    if (lower === 'arrowleft' || lower === 'left') {
        return 'Left';
    }
    if (lower === 'arrowright' || lower === 'right') {
        return 'Right';
    }
    if (lower === 'arrowup' || lower === 'up') {
        return 'Up';
    }
    if (lower === 'arrowdown' || lower === 'down') {
        return 'Down';
    }
    if (lower === 'insert') {
        return 'Insert';
    }
    if (lower === 'delete' || lower === 'del') {
        return 'Delete';
    }
    if (lower === 'home') {
        return 'Home';
    }
    if (lower === 'end') {
        return 'End';
    }
    const numpadMatch = /^numpad([0-9])$/i.exec(value);
    if (numpadMatch) {
        return `Numpad${numpadMatch[1]}`;
    }

    if (/^[a-z]$/i.test(value)) {
        return value.toUpperCase();
    }
    if (/^[0-9]$/.test(value)) {
        return value;
    }
    const functionMatch = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(value);
    if (functionMatch) {
        return `F${functionMatch[1]}`;
    }

    throw new Error(`不支持的全局快捷键按键：${value}`);
}

function toVirtualKey(key: string): number {
    if (/^[A-Z]$/.test(key) || /^[0-9]$/.test(key)) {
        return key.charCodeAt(0);
    }

    const functionMatch = /^F([1-9]|1[0-9]|2[0-4])$/.exec(key);
    if (functionMatch) {
        return 0x70 + Number(functionMatch[1]) - 1;
    }

    const named = NAMED_KEYS.get(key);
    if (named !== undefined) {
        return named;
    }

    throw new Error(`无法转换全局快捷键：${key}`);
}
