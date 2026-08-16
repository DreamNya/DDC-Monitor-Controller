import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

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
    minify: !development,
    define: {
        'process.env.NODE_ENV': JSON.stringify(development ? 'development' : 'production'),
    },
});

await build({
    entryPoints: {
        control: path.resolve(root, 'src/renderer/control.ts'),
        quick: path.resolve(root, 'src/renderer/quick.ts'),
        'theme-bootstrap': path.resolve(root, 'src/renderer/theme-bootstrap.ts'),
    },
    outdir: path.resolve(outputRoot, 'renderer'),
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
    fs.copyFile(path.resolve(root, 'assets/tray-icon.ico'), path.resolve(outputRoot, 'assets/tray-icon.ico')),
]);

const nativeAddon = path.resolve(root, 'native/bin/win-x64/MonitorNative.node');
const webViewNativeAddon = path.resolve(root, 'native/bin/win-x64/WebViewNative.node');
const launcher = path.resolve(root, 'native/bin/win-x64/DDCMonitorController.exe');

try {
    await fs.stat(nativeAddon);
    await fs.copyFile(nativeAddon, path.resolve(outputRoot, 'native/MonitorNative.node'));
} catch {
    console.warn('警告：尚未生成 MonitorNative.node；请在 Windows 上执行 npm run build:native 后重新构建');
}

try {
    await fs.stat(webViewNativeAddon);
    await fs.copyFile(webViewNativeAddon, path.resolve(outputRoot, 'native/WebViewNative.node'));
} catch {
    console.warn('警告：尚未生成 WebViewNative.node；请在 Windows 上执行 npm run build:native 后重新构建');
}

try {
    await fs.stat(launcher);
    await fs.copyFile(launcher, path.resolve(outputRoot, 'DDCMonitorController.exe'));
} catch {
    console.warn('警告：尚未生成无控制台启动器；可先执行 npm run build:native，再重新构建');
}

const packageJSON = path.resolve(root, 'package.json');
await fs.copyFile(packageJSON, path.resolve(outputRoot, 'package.json'));

console.log(`构建完成：${outputRoot}`);
