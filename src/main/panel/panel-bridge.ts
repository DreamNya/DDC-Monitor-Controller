import type { MonitorBridge } from '../../shared/bridge';
import type { AppController } from '../app-controller';

export interface PanelBridgeDependencies {
    appController: AppController;
    openControlPanel(): void;
    closePanel(): void;
    startControlWindowDrag(): void;
}

export function createPanelBridge(dependencies: PanelBridgeDependencies) {
    const { appController } = dependencies;

    return {
        getState: async () => appController.getState(),
        refreshMonitors: () => runCommand(() => appController.refreshMonitors()),
        applyManual: (request) => runCommand(() => appController.applyManual(request)),
        applyLive: (request) => runCommand(() => appController.applyLive(request)),
        applyAutoNow: () => runCommand(() => appController.applyAutoNow()),
        setAutoInterval: ({ intervalMinutes }) => runCommand(() => appController.setAutoInterval(intervalMinutes)),
        setTargetMonitor: ({ monitorId }) => runCommand(() => appController.setTargetMonitor(monitorId)),
        setUiScale: ({ target, percent }) => runCommand(() => appController.setUiScale(target, percent)),
        setActiveScheduleProfile: ({ profileId }) =>
            runCommand(() => appController.setActiveScheduleProfile(profileId)),
        createScheduleProfile: ({ name, schedule }) =>
            runCommand(() => appController.createScheduleProfile(name, schedule)),
        renameScheduleProfile: ({ profileId, name }) =>
            runCommand(() => appController.renameScheduleProfile(profileId, name)),
        deleteScheduleProfile: ({ profileId }) => runCommand(() => appController.deleteScheduleProfile(profileId)),
        saveSchedule: ({ profileId, schedule }) => runCommand(() => appController.saveSchedule(profileId, schedule)),
        setLogEnabled: ({ enabled }) => runCommand(() => appController.setLogEnabled(enabled)),
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
    await command();
    return null;
}
