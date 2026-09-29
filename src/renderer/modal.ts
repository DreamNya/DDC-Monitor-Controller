import { getElement } from './common';

interface ConfirmOptions {
    title: string;
    message: string;
    confirmText: string;
    danger?: boolean;
}

interface PromptOptions {
    title: string;
    label: string;
    defaultValue: string;
    confirmText: string;
    maxLength?: number;
}

export function createModal() {
    const dialog = getElement<HTMLDialogElement>('#app-modal');
    const form = getElement<HTMLFormElement>('#app-modal-form', dialog);
    const title = getElement<HTMLElement>('#app-modal-title', dialog);
    const message = getElement<HTMLElement>('#app-modal-message', dialog);
    const field = getElement<HTMLLabelElement>('#app-modal-field', dialog);
    const label = getElement<HTMLElement>('#app-modal-label', dialog);
    const input = getElement<HTMLInputElement>('#app-modal-input', dialog);
    const cancel = getElement<HTMLButtonElement>('#app-modal-cancel', dialog);
    const confirm = getElement<HTMLButtonElement>('#app-modal-confirm', dialog);
    let resolvePending: ((value: string | null) => void) | undefined;
    let submittedValue: string | null = null;

    form.addEventListener('submit', (event) => {
        event.preventDefault();
        submittedValue = field.hidden ? '' : input.value;
        dialog.close();
    });
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
        resolvePending?.(submittedValue);
        resolvePending = undefined;
        submittedValue = null;
    });

    function open(): Promise<string | null> {
        if (dialog.open || resolvePending) {
            throw new Error('已有模态框正在显示');
        }
        const result = new Promise<string | null>((resolve) => {
            resolvePending = resolve;
        });
        dialog.showModal();
        return result;
    }

    return {
        async confirm(options: ConfirmOptions): Promise<boolean> {
            title.textContent = options.title;
            message.textContent = options.message;
            message.hidden = false;
            field.hidden = true;
            input.required = false;
            confirm.textContent = options.confirmText;
            confirm.className = options.danger ? 'danger' : 'primary';
            const result = open();
            (options.danger ? cancel : confirm).focus();
            return (await result) !== null;
        },
        prompt(options: PromptOptions): Promise<string | null> {
            title.textContent = options.title;
            message.hidden = true;
            field.hidden = false;
            label.textContent = options.label;
            input.value = options.defaultValue;
            input.required = true;
            input.maxLength = options.maxLength ?? -1;
            confirm.textContent = options.confirmText;
            confirm.className = 'primary';
            const result = open();
            input.focus();
            input.select();
            return result;
        },
    };
}

export type Modal = ReturnType<typeof createModal>;
