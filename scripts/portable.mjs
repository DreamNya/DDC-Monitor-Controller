import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');

function assertWindows() {
    if (process.platform !== 'win32') {
        throw new Error('便携包构建仅支持 Windows');
    }
}

function assertFile(path, message) {
    if (!fs.existsSync(path)) {
        throw new Error(message);
    }
}

function runNodeScript(scriptPath) {
    const result = spawnSync(process.execPath, [scriptPath], {
        cwd: root,
        stdio: 'inherit',
        windowsHide: true,
    });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        throw new Error(`项目构建失败，退出码：${result.status ?? '未知'}`);
    }
}

function copyDirectoryContents(source, destination) {
    for (const entry of fs.readdirSync(source)) {
        fs.cpSync(path.join(source, entry), path.join(destination, entry), {
            recursive: true,
            force: true,
        });
    }
}

function main() {
    assertWindows();

    const buildRoot = path.join(root, 'dist', 'build');
    const portableRoot = path.join(root, 'dist', 'portable');
    const appRoot = path.join(portableRoot, 'app');
    const buildScript = path.join(root, 'scripts', 'build.mjs');
    const packageJson = path.join(root, 'package.json');
    const builtLauncher = path.join(buildRoot, 'DDCMonitorController.exe');
    const builtAddon = path.join(buildRoot, 'native', 'MonitorNative.node');

    assertFile(buildScript, `找不到构建脚本：${buildScript}`);
    assertFile(packageJson, `找不到 package.json：${packageJson}`);

    runNodeScript(buildScript);

    if (!fs.existsSync(builtLauncher) || !fs.existsSync(builtAddon)) {
        throw new Error('dist/build 缺少原生文件；请先执行 npm run build:native');
    }

    fs.rmSync(portableRoot, { recursive: true, force: true });
    fs.mkdirSync(appRoot, { recursive: true });

    copyDirectoryContents(buildRoot, appRoot);

    // 便携包只在根目录保留启动器
    fs.rmSync(path.join(appRoot, 'DDCMonitorController.exe'), { force: true });

    fs.copyFileSync(builtLauncher, path.join(portableRoot, 'DDCMonitorController.exe'));
    fs.copyFileSync(process.execPath, path.join(portableRoot, 'node.exe'));
    fs.copyFileSync(packageJson, path.join(portableRoot, 'package.json'));

    console.log(`便携目录已生成：${portableRoot}`);
    console.log('双击 DDCMonitorController.exe 即可启动');
}

try {
    main();
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`便携包构建失败：${message}`);
    process.exitCode = 1;
}
