import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { copyRuntimeDependencies } from './copy-runtime-dependencies.mjs';

const root = path.resolve(import.meta.dirname, '..');
const outputRoot = path.resolve(root, 'dist/build');
const development = process.argv.includes('--dev');

await fs.rm(outputRoot, {
    recursive: true,
    force: true,
});

await Promise.all([
    fs.mkdir(path.resolve(outputRoot, 'renderer'), { recursive: true }),
    fs.mkdir(path.resolve(outputRoot, 'assets'), { recursive: true }),
    fs.mkdir(path.resolve(outputRoot, 'native'), { recursive: true }),
]);

await build({
    entryPoints: [path.resolve(root, 'src/main/index.ts')],
    outfile: path.resolve(outputRoot, 'index.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    sourcemap: development ? 'inline' : false,
    minify: false,
    external: ['@webviewjs/webview', 'koffi'],
    define: {
        'process.env.NODE_ENV': JSON.stringify(development ? 'development' : 'production'),
    },
});

await build({
    entryPoints: [path.resolve(root, 'src/renderer/control.ts')],
    outfile: path.resolve(outputRoot, 'renderer/control.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2023',
    sourcemap: development ? 'inline' : false,
    minify: !development,
    charset: 'utf8',
});

await build({
    entryPoints: [path.resolve(root, 'src/renderer/quick.ts')],
    outfile: path.resolve(outputRoot, 'renderer/quick.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2023',
    sourcemap: development ? 'inline' : false,
    minify: !development,
    charset: 'utf8',
});

await Promise.all([
    fs.copyFile(path.resolve(root, 'src/renderer/control.html'), path.resolve(outputRoot, 'renderer/control.html')),
    fs.copyFile(path.resolve(root, 'src/renderer/control.css'), path.resolve(outputRoot, 'renderer/control.css')),
    fs.copyFile(path.resolve(root, 'src/renderer/quick.html'), path.resolve(outputRoot, 'renderer/quick.html')),
    fs.copyFile(path.resolve(root, 'src/renderer/quick.css'), path.resolve(outputRoot, 'renderer/quick.css')),
    fs.copyFile(path.resolve(root, 'assets/tray-icon.png'), path.resolve(outputRoot, 'assets/tray-icon.png')),
    // fs.copyFile(path.resolve(root, 'assets/app-icon.ico'), path.resolve(outputRoot, 'assets/app-icon.ico')),
]);

const dll = path.resolve(root, 'native/bin/win-x64/MonitorDdc.dll');
const launcher = path.resolve(root, 'native/bin/win-x64/DDCMonitorController.exe');

try {
    await fs.stat(dll);
    await fs.copyFile(dll, path.resolve(outputRoot, 'native/MonitorDdc.dll'));
} catch {
    console.warn('警告：尚未生成 MonitorDdc.dll；请在 Windows 上执行 npm run build:native 后重新构建');
}

try {
    await fs.stat(launcher);
    await fs.copyFile(launcher, path.resolve(outputRoot, 'DDCMonitorController.exe'));
} catch {
    console.warn('警告：尚未生成无控制台启动器；可先执行 npm run build:native，再重新构建');
}

await copyRuntimeDependencies('build');

const packageJSON = path.resolve(root, 'package.json');
await fs.copyFile(packageJSON, path.resolve(outputRoot, 'package.json'));

console.log(`构建完成：${outputRoot}`);
