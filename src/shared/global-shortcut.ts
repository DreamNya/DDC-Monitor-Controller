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
    const physicalKey = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(input.code);
    if (physicalKey) {
        return physicalKey[1] ?? physicalKey[2]!;
    }

    const codeKey = PART_NAMES.get(input.code.toLowerCase());
    if (codeKey && NAMED_KEYS.has(codeKey)) {
        return codeKey;
    }
    if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(input.code)) {
        return input.code;
    }

    return normalizePart(input.key === ' ' ? 'Space' : input.key);
}

export interface ParsedGlobalShortcut {
    normalized: string;
    modifiers: number;
    virtualKey: number;
}

// 插入顺序同时决定快捷键文本中的修饰键顺序
const MODIFIER_FLAGS = new Map<string, number>([
    ['Ctrl', 0x0002],
    ['Alt', 0x0001],
    ['Shift', 0x0004],
    ['Win', 0x0008],
]);

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

const PART_NAMES = new Map<string, string>([
    ...[...MODIFIER_FLAGS.keys(), ...NAMED_KEYS.keys()].map((name) => [name.toLowerCase(), name] as const),
    // 保留已有配置可使用的别名，统一输出规范名称
    ['control', 'Ctrl'],
    ['meta', 'Win'],
    ['super', 'Win'],
    ['spacebar', 'Space'],
    ['page up', 'PageUp'],
    ['page down', 'PageDown'],
    ['arrowleft', 'Left'],
    ['arrowright', 'Right'],
    ['arrowup', 'Up'],
    ['arrowdown', 'Down'],
    ['del', 'Delete'],
]);

export function parseGlobalShortcut(value: string): ParsedGlobalShortcut {
    const raw = value.trim();

    if (!raw) {
        throw new Error('全局快捷键为空');
    }

    const parts = raw.split('+').map((part) => part.trim());
    if (parts.some((part) => !part)) {
        throw new Error('全局快捷键包含空的按键片段');
    }
    const modifiers = new Set<string>();
    let modifierFlags = 0;
    let key = '';

    for (const part of parts) {
        const normalizedPart = normalizePart(part);

        const modifierFlag = MODIFIER_FLAGS.get(normalizedPart);
        if (modifierFlag !== undefined) {
            if (modifiers.has(normalizedPart)) {
                throw new Error(`全局快捷键包含重复修饰键：${normalizedPart}`);
            }
            modifiers.add(normalizedPart);
            modifierFlags |= modifierFlag;
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

    const virtualKey = toVirtualKey(key);
    const ordered = [...MODIFIER_FLAGS.keys()].filter((part) => modifiers.has(part));

    return {
        normalized: [...ordered, key].join('+'),
        modifiers: modifierFlags,
        virtualKey,
    };
}

function normalizePart(value: string): string {
    const named = PART_NAMES.get(value.toLowerCase());
    if (named) {
        return named;
    }

    if (/^[a-z0-9]$/i.test(value) || /^f([1-9]|1[0-9]|2[0-4])$/i.test(value)) {
        return value.toUpperCase();
    }

    throw new Error(`不支持的全局快捷键按键：${value}`);
}

function toVirtualKey(key: string): number {
    if (/^[A-Z0-9]$/.test(key)) {
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
