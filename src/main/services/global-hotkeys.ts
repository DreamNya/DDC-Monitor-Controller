import { parseGlobalShortcut } from '../../shared/global-shortcut.ts';
import type { AdvancedVcpShortcutCommand } from '../../shared/model.ts';
import type { NativeGlobalHotkeyBinding } from '../native-shell.ts';

export class GlobalHotkeyRouter {
    #captureActive = false;
    #transitionSequence = 0;

    get captureActive(): boolean {
        return this.#captureActive;
    }

    setCaptureActive(active: boolean, eventSequence: number): void {
        if (this.#captureActive === active) {
            return;
        }
        this.#captureActive = active;
        // Exclude events already emitted before this UI mode transition,
        // including recordings still queued when the dialog closes.
        this.#transitionSequence = eventSequence;
    }

    route(eventSequence: number): 'execute' | 'capture' | 'ignore' {
        if (eventSequence <= this.#transitionSequence) {
            return 'ignore';
        }
        return this.#captureActive ? 'capture' : 'execute';
    }
}

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
