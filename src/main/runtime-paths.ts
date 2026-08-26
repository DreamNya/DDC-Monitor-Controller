import { homedir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RuntimePaths {
    distributionRoot: string;
    rendererRoot: string;
    assetsRoot: string;
    webviewDataDirectory: string;
    launcherPath: string | null;
}

export function resolveRuntimePaths(moduleUrl: string): RuntimePaths {
    const distributionRoot = path.dirname(fileURLToPath(moduleUrl));

    const launcherPath =
        [
            path.resolve(distributionRoot, 'DDCMonitorController.exe'),
            path.resolve(distributionRoot, '..', 'DDCMonitorController.exe'),
        ].find((candidate) => fs.existsSync(candidate)) ?? null;

    return {
        distributionRoot,
        rendererRoot: path.resolve(distributionRoot, 'renderer'),
        assetsRoot: path.resolve(distributionRoot, 'assets'),
        webviewDataDirectory: path.resolve(
            process.env.LOCALAPPDATA ?? path.resolve(homedir(), 'AppData', 'Local'),
            'DDCMonitorController',
            'WebView2',
        ),
        launcherPath,
    };
}
