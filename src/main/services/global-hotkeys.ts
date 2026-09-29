import { parseGlobalShortcut } from '../../shared/global-shortcut.ts';
import type { AdvancedVcpShortcutCommand } from '../../shared/model.ts';
import type { NativeGlobalHotkeyBinding } from '../native-shell.ts';

export function createGlobalHotkeyBindings(
    commands: readonly AdvancedVcpShortcutCommand[],
): NativeGlobalHotkeyBinding[] {
    const bindings: NativeGlobalHotkeyBinding[] = [];
    const registered = new Set<string>();

    for (const command of commands) {
        if (!command.shortcut) {
            continue;
        }
        try {
            const parsed = parseGlobalShortcut(command.shortcut);
            if (registered.has(parsed.normalized)) {
                continue;
            }
            registered.add(parsed.normalized);
            bindings.push({
                id: command.id,
                label: `${command.name} (${parsed.normalized})`,
                modifiers: parsed.modifiers,
                virtualKey: parsed.virtualKey,
            });
        } catch (error) {
            console.error(`忽略无效全局快捷键“${command.shortcut}”：`, error);
        }
    }

    return bindings;
}
