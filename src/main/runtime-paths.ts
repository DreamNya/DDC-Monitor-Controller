import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RuntimePaths {
    distributionRoot: string;
    rendererRoot: string;
    assetsRoot: string;
    webviewDataDirectory: string;
}

export function resolveRuntimePaths(moduleUrl: string): RuntimePaths {
    const distributionRoot = path.dirname(fileURLToPath(moduleUrl));

    return {
        distributionRoot,
        rendererRoot: path.resolve(distributionRoot, 'renderer'),
        assetsRoot: path.resolve(distributionRoot, 'assets'),
        webviewDataDirectory: path.resolve(
            process.env.LOCALAPPDATA ?? path.resolve(homedir(), 'AppData', 'Local'),
            'DDCMonitorController',
            'WebView2',
        ),
    };
}
