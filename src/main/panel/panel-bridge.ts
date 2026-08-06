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
        getState: () => appController.getState(),
        refreshMonitors: () => appController.refreshMonitors(),
        applyManual: (request) => appController.applyManual(request),
        applyLive: (request) => appController.applyLive(request),
        applyAutoNow: () => appController.applyAutoNow(),
        setAutoInterval: ({ intervalMinutes }) => appController.setAutoInterval(intervalMinutes),
        setTargetMonitor: ({ monitorId }) => appController.setTargetMonitor(monitorId),
        setActiveScheduleProfile: ({ profileId }) => appController.setActiveScheduleProfile(profileId),
        createScheduleProfile: ({ name, schedule }) => appController.createScheduleProfile(name, schedule),
        renameScheduleProfile: ({ profileId, name }) => appController.renameScheduleProfile(profileId, name),
        deleteScheduleProfile: ({ profileId }) => appController.deleteScheduleProfile(profileId),
        saveSchedule: ({ profileId, schedule }) => appController.saveSchedule(profileId, schedule),
        setLogEnabled: ({ enabled }) => appController.setLogEnabled(enabled),
        startControlWindowDrag: () => {
            dependencies.startControlWindowDrag();
            return Promise.resolve(null);
        },
        resetSettings: () => appController.resetSettings(),
        openControlPanel: () => {
            setImmediate(dependencies.openControlPanel);
            return Promise.resolve(null);
        },
        closePanel: () => {
            setImmediate(dependencies.closePanel);
            return Promise.resolve(null);
        },
    } satisfies MonitorBridge;
}
