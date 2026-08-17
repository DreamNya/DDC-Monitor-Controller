import type { MonitorBridge } from '../../shared/bridge';
import type { AppController } from '../app-controller';

export interface PanelBridgeDependencies {
    appController: AppController;
    openControlPanel(): void;
    closePanel(): void;
    startControlWindowDrag(): void;
    openLogFolder(): void;
    setGlobalHotkeyCaptureActive(active: boolean): void;
}

export function createPanelBridge(dependencies: PanelBridgeDependencies) {
    const { appController } = dependencies;

    return {
        getState: () => runBridgeCall(() => appController.getState()),
        refreshMonitors: () => runCommand(() => appController.refreshMonitors()),
        getMonitorCapabilities: ({ monitorId }) =>
            runBridgeCall(() => appController.getMonitorCapabilities(monitorId)),
        getMonitorVcpValues: ({ monitorId, codes }) =>
            runBridgeCall(() => appController.getMonitorVcpValues(monitorId, codes)),
        executeAdvancedVcp: async (request) => {
            const result = await runBridgeCall(() => appController.executeAdvancedVcp(request));
            if (result.closeWebViewAfter) {
                setImmediate(dependencies.closePanel);
            }
            return result;
        },
        setGlobalHotkeyCaptureActive: async ({ active }) => {
            if (typeof active !== 'boolean') {
                throw new TypeError('全局快捷键捕获状态必须是布尔值');
            }
            dependencies.setGlobalHotkeyCaptureActive(active);
            return null;
        },
        saveAdvancedVcpCommand: ({ command }) => runCommand(() => appController.saveAdvancedVcpCommand(command)),
        deleteAdvancedVcpCommand: ({ commandId }) => runCommand(() => appController.deleteAdvancedVcpCommand(commandId)),
        executeAdvancedVcpCommand: async ({ commandId }) => {
            const result = await runBridgeCall(() => appController.executeAdvancedVcpCommand(commandId));
            if (result.closeWebViewAfter) {
                setImmediate(dependencies.closePanel);
            }
            return result;
        },
        applyManual: (request) => runCommand(() => appController.applyManual(request)),
        applyLive: (request) => runCommand(() => appController.applyLive(request)),
        applyAutoNow: () => runCommand(() => appController.applyAutoNow()),
        setAutoInterval: ({ intervalMinutes }) => runCommand(() => appController.setAutoInterval(intervalMinutes)),
        setTargetMonitor: ({ monitorId }) => runCommand(() => appController.setTargetMonitor(monitorId)),
        setUiScale: ({ target, percent }) => runCommand(() => appController.setUiScale(target, percent)),
        resetUiScale: () => runCommand(() => appController.resetUiScale()),
        setFontSize: ({ target, pixels }) => runCommand(() => appController.setFontSize(target, pixels)),
        resetFontSize: () => runCommand(() => appController.resetFontSize()),
        setActiveScheduleProfile: ({ profileId }) =>
            runCommand(() => appController.setActiveScheduleProfile(profileId)),
        createScheduleProfile: ({ name, schedule }) =>
            runCommand(() => appController.createScheduleProfile(name, schedule)),
        renameScheduleProfile: ({ profileId, name }) =>
            runCommand(() => appController.renameScheduleProfile(profileId, name)),
        deleteScheduleProfile: ({ profileId }) => runCommand(() => appController.deleteScheduleProfile(profileId)),
        saveSchedule: ({ profileId, schedule }) => runCommand(() => appController.saveSchedule(profileId, schedule)),
        setLogEnabled: ({ enabled }) => runCommand(() => appController.setLogEnabled(enabled)),
        setTheme: ({ theme }) => runCommand(() => appController.setTheme(theme)),
        openLogFolder: async () => {
            await runBridgeCall(() => dependencies.openLogFolder());
            return null;
        },
        startControlWindowDrag: async () => {
            dependencies.startControlWindowDrag();
            return null;
        },
        resetSettings: () => runCommand(() => appController.resetSettings()),
        openControlPanel: async () => {
            setImmediate(dependencies.openControlPanel);
            return null;
        },
        closePanel: async () => {
            setImmediate(dependencies.closePanel);
            return null;
        },
    } satisfies MonitorBridge;
}

async function runCommand(command: () => Promise<void>): Promise<null> {
    await runBridgeCall(command);
    return null;
}

async function runBridgeCall<T>(operation: () => T | Promise<T>): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        console.error('WebView 后端调用失败：', error);
        throw error;
    }
}
