import { DesktopApplication } from './application';
import { resolveRuntimePaths } from './runtime-paths';
import { FileLogger } from './services/file-logger';
import { SingleInstanceLock } from './single-instance';

const paths = resolveRuntimePaths(import.meta.url);
process.chdir(paths.distributionRoot);

const fileLogger = new FileLogger(paths.distributionRoot);
fileLogger.install();

try {
    const singleInstanceLock = new SingleInstanceLock();
    const acquired = await singleInstanceLock.acquire();

    if (!acquired) {
        process.exit(0);
    }

    const desktopApplication = new DesktopApplication({
        paths,
        fileLogger,
        singleInstanceLock,
    });

    singleInstanceLock.setOpenRequestHandler(() => {
        desktopApplication.requestControlPanel();
    });

    await desktopApplication.start();
} catch (error) {
    console.error('启动应用失败：', error);
    throw error;
}
