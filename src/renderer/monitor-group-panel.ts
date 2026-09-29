import type { MonitorBridge } from '../shared/bridge';
import type { AppState, MonitorGroup } from '../shared/model';
import { getElement } from './common';
import type { Modal } from './modal';

export function createMonitorGroupPanel(options: {
    getBridge(): MonitorBridge;
    runAction(action: () => Promise<void>): void;
    modal: Modal;
}) {
    const list = getElement<HTMLElement>('#monitor-group-list');
    const create = getElement<HTMLButtonElement>('#monitor-group-create');
    const dialog = getElement<HTMLDialogElement>('#monitor-group-dialog');
    const form = getElement<HTMLFormElement>('#monitor-group-form');
    const title = getElement<HTMLElement>('#monitor-group-title');
    const name = getElement<HTMLInputElement>('#monitor-group-name');
    const members = getElement<HTMLElement>('#monitor-group-members');
    const cancel = getElement<HTMLButtonElement>('#monitor-group-cancel');
    let state: AppState | undefined;
    let editingId: string | undefined;

    function open(group?: MonitorGroup): void {
        editingId = group?.id;
        title.textContent = group ? '编辑显示器组' : '新建显示器组';
        name.value = group?.name ?? '';
        members.replaceChildren();
        const ids = new Set([...(state?.monitors.map(({ id }) => id) ?? []), ...(group?.monitorIds ?? [])]);
        for (const id of ids) {
            const matches = state?.monitors.filter((monitor) => monitor.id === id) ?? [];
            const selected = group?.monitorIds.includes(id) ?? false;
            const label = document.createElement('label');
            label.className = 'monitor-group-member';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = id;
            checkbox.checked = selected;
            checkbox.disabled = matches.length !== 1 && !selected;
            const text = document.createElement('span');
            text.textContent = `${matches[0]?.name || id}${matches.length === 0 ? '（离线）' : matches.length > 1 ? '（身份不唯一）' : ''}`;
            label.append(checkbox, text);
            members.append(label);
        }
        if (!ids.size) {
            members.textContent = '未检测到显示器，请刷新显示器后再添加。';
        }
        dialog.showModal();
        name.focus();
    }

    function bind(): void {
        create.addEventListener('click', () => open());
        cancel.addEventListener('click', () => dialog.close());
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            const group = {
                ...(editingId ? { id: editingId } : {}),
                name: name.value,
                monitorIds: [...members.querySelectorAll<HTMLInputElement>('input:checked')].map(({ value }) => value),
            };
            options.runAction(async () => {
                await options.getBridge().saveMonitorGroup({ group });
                dialog.close();
            });
        });
        list.addEventListener('click', (event) => {
            void handleGroupClick(event);
        });
    }

    async function handleGroupClick(event: MouseEvent): Promise<void> {
        if (!(event.target instanceof Element)) {
            return;
        }
        const editId = event.target.closest<HTMLButtonElement>('[data-group-edit]')?.dataset.groupEdit;
        if (editId) {
            const group = state?.settings.monitorGroups.find(({ id }) => id === editId);
            if (group) {
                open(group);
            }
            return;
        }
        const deleteId = event.target.closest<HTMLButtonElement>('[data-group-delete]')?.dataset.groupDelete;
        const group = state?.settings.monitorGroups.find(({ id }) => id === deleteId);
        const commandCount =
            state?.settings.advancedVcpCommands.filter((command) => command.monitorGroupId === deleteId).length ?? 0;
        if (
            !group ||
            !(await options.modal.confirm({
                title: '删除显示器组',
                message: `确定删除显示器组“${group.name}”吗？${commandCount ? `将同时删除 ${commandCount} 个关联快捷命令，并注销对应的全局快捷键。` : ''}`,
                confirmText: '删除',
                danger: true,
            }))
        ) {
            return;
        }
        options.runAction(async () => {
            await options.getBridge().deleteMonitorGroup({ groupId: group.id });
        });
    }

    function render(nextState: AppState): void {
        state = nextState;
        list.replaceChildren();
        if (!state.settings.monitorGroups.length) {
            const empty = document.createElement('div');
            empty.className = 'advanced-command-empty';
            empty.textContent = '尚未新建显示器组';
            list.append(empty);
        }
        for (const group of state.settings.monitorGroups) {
            const row = document.createElement('div');
            row.className = 'advanced-command-row';
            const main = document.createElement('div');
            main.className = 'advanced-command-main';
            const heading = document.createElement('strong');
            heading.textContent = group.name;
            const detail = document.createElement('small');
            const online = group.monitorIds.filter(
                (id) => nextState.monitors.filter((monitor) => monitor.id === id).length === 1,
            ).length;
            detail.textContent = `${online}/${group.monitorIds.length} 台可用 · ${group.monitorIds.map((id) => nextState.monitors.find((monitor) => monitor.id === id)?.name || id).join('、')}`;
            main.append(heading, detail);
            const actions = document.createElement('div');
            actions.className = 'advanced-command-actions';
            const edit = document.createElement('button');
            edit.type = 'button';
            edit.className = 'secondary compact';
            edit.textContent = '编辑';
            edit.dataset.groupEdit = group.id;
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'secondary compact';
            remove.textContent = '删除';
            remove.dataset.groupDelete = group.id;
            remove.title = '删除显示器组及其关联快捷命令';
            actions.append(edit, remove);
            row.append(main, actions);
            list.append(row);
        }
    }

    function refreshControlStates(): void {
        const group = state?.settings.monitorGroups.find(({ id }) => id === editingId);
        for (const checkbox of members.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
            const unique = state?.monitors.filter(({ id }) => id === checkbox.value).length === 1;
            checkbox.disabled = !unique && !group?.monitorIds.includes(checkbox.value);
        }
    }

    return { bind, render, refreshControlStates };
}
