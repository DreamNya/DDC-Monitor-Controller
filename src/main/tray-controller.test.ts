import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppState } from '../shared/model.ts';
import type { AppController } from './app-controller.ts';
import type { NativeShell, NativeTrayMenuItem } from './native-shell.ts';
import type { PanelManager } from './panel/panel-manager.ts';
import { createDefaultSettings } from './services/settings-store.ts';
import { createTrayMenu, TrayController } from './tray-controller.ts';

test('tray menu groups profiles and tools while marking active state', () => {
    const state = createState();
    const menu = createTrayMenu(state);

    assert.deepEqual(menu.slice(0, 6), [
        { type: 'item', id: 'open-control', label: '详细设置面板' },
        { type: 'item', id: 'open-quick', label: '快速设置面板' },
        { type: 'item', id: 'toggle-theme', label: '切换为夜间主题' },
        { type: 'separator' },
        { type: 'item', id: 'toggle-auto', label: '自动调节', checked: true },
        { type: 'item', id: 'apply-auto', label: '立即应用当前方案' },
    ]);

    const profiles = menu.find(
        (item): item is Extract<NativeTrayMenuItem, { type: 'submenu' }> =>
            item.type === 'submenu' && item.label === '自动调节方案',
    );
    assert.ok(profiles);
    assert.deepEqual(profiles.items, [
        { type: 'item', id: 'select-profile:default', label: '默认方案', checked: true },
        { type: 'item', id: 'select-profile:office%2Fnight', label: '办公 && 夜间', checked: false },
    ]);

    const tools = menu.find(
        (item): item is Extract<NativeTrayMenuItem, { type: 'submenu' }> =>
            item.type === 'submenu' && item.label === '工具',
    );
    assert.ok(tools);
    assert.deepEqual(tools.items, [
        { type: 'item', id: 'reset-panel-styles', label: '重置面板所有样式' },
        { type: 'item', id: 'open-webview', label: '打开 WebView 目录' },
        { type: 'item', id: 'open-program-directory', label: '打开程序目录' },
    ]);
});

test('tray menu theme action follows current theme', () => {
    const state = createState();
    state.settings.theme = 'dark';

    const menu = createTrayMenu(state);

    assert.deepEqual(menu[2], { type: 'item', id: 'toggle-theme', label: '切换为明亮主题' });
});

test('TrayController reuses existing commands for quick-open, theme and profile switching', async () => {
    const state = createState();
    const menus: NativeTrayMenuItem[][] = [];
    const calls: Array<{ name: string; args: unknown[] }> = [];
    const appController = {
        getState: () => state,
        setAutoEnabled: async (enabled: boolean) => {
            calls.push({ name: 'setAutoEnabled', args: [enabled] });
        },
        setTheme: async (theme: AppState['settings']['theme']) => {
            calls.push({ name: 'setTheme', args: [theme] });
        },
        setActiveScheduleProfile: async (profileId: string) => {
            calls.push({ name: 'setActiveScheduleProfile', args: [profileId] });
        },
    } as unknown as AppController;
    const panelManager = {
        requestOpen: (page: string, x?: number, y?: number) => {
            calls.push({ name: 'requestOpen', args: [page, x, y] });
        },
    } as unknown as PanelManager;
    const nativeShell = {
        setTrayMenu: (items: NativeTrayMenuItem[]) => menus.push(items),
        openPath: (targetPath: string) => calls.push({ name: 'openPath', args: [targetPath] }),
    } as unknown as NativeShell;
    const controller = new TrayController({
        appController,
        panelManager,
        nativeShell,
        webviewDataDirectory: 'C:\\WebView2',
        programDirectory: 'D:\\MonitorController',
        quitApplication: () => undefined,
    });

    controller.update(state);
    controller.update(structuredClone(state));
    assert.equal(menus.length, 1);

    const darkState = structuredClone(state);
    darkState.settings.theme = 'dark';
    controller.update(darkState);
    assert.equal(menus.length, 2);

    controller.handleMenuClick('open-quick', 120, 240);
    controller.handleMenuClick('toggle-theme');
    controller.handleMenuClick('select-profile:office%2Fnight');
    controller.handleMenuClick('open-program-directory');
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(calls, [
        { name: 'requestOpen', args: ['quick', 120, 240] },
        { name: 'setTheme', args: ['dark'] },
        { name: 'setActiveScheduleProfile', args: ['office/night'] },
        { name: 'openPath', args: ['D:\\MonitorController'] },
    ]);
});

function createState(): AppState {
    const settings = createDefaultSettings();
    settings.scheduleProfiles.push({
        id: 'office/night',
        name: '办公 & 夜间',
        schedule: [{ time: 8, brightness: 40, contrast: 50 }],
    });

    return {
        settings,
        monitors: [],
        calculatedValues: { brightness: 10, contrast: 35 },
        nextRunAt: null,
        lastOperation: 'test',
        lastError: null,
    };
}
