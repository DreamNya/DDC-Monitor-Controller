import { context } from 'esbuild';
import { fork } from 'node:child_process';
import { watch } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

// 路径准备
const root = path.resolve(import.meta.dirname, '..');
const outputRoot = path.resolve(root, 'dist/dev');
const rendererSource = path.resolve(root, 'src/renderer');
const rendererOutput = path.resolve(outputRoot, 'renderer');
const entryFile = path.resolve(outputRoot, 'index.mjs');

let appProcess = null;
let isShuttingDown = false;
let staticWatcher = null;

// 初始化目录与静态文件
await prepareAssets();

const mainFirstBuild = Promise.withResolvers();
const rendererFirstBuild = Promise.withResolvers();

// 插件工厂：处理首次构建等待与后续增量重载
function createReloadPlugin(name, firstBuildResolver, onRebuild) {
    let isFirst = true;
    return {
        name,
        setup(build) {
            build.onEnd((res) => {
                if (res.errors.length > 0) {
                    return;
                }
                if (isFirst) {
                    isFirst = false;
                    firstBuildResolver.resolve();
                } else {
                    onRebuild();
                }
            });
        },
    };
}

// 配置 esbuild 构建上下文
const mainCtx = await context({
    entryPoints: [path.resolve(root, 'src/main/index.ts')],
    outfile: entryFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    sourcemap: 'inline',
    define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    plugins: [createReloadPlugin('main-reload', mainFirstBuild, restartApp)],
});

const rendererCtx = await context({
    entryPoints: {
        control: path.resolve(rendererSource, 'control.ts'),
        quick: path.resolve(rendererSource, 'quick.ts'),
        'theme-bootstrap': path.resolve(rendererSource, 'theme-bootstrap.ts'),
    },
    outdir: rendererOutput,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2023',
    sourcemap: 'inline',
    plugins: [createReloadPlugin('renderer-reload', rendererFirstBuild, () => notifyRenderer('page'))],
});

// 启动构建监听并等待首次构建结束
await Promise.all([mainCtx.watch(), rendererCtx.watch()]);
await Promise.all([mainFirstBuild.promise, rendererFirstBuild.promise]);

// 启动应用进程与静态资源监听
startApp();
watchStaticFiles();
console.log(`开发监听已启动：${outputRoot}；PID=${process.pid}`);

// --- 应用进程生命周期管理 ---

function startApp() {
    appProcess = fork(entryFile, [], {
        cwd: outputRoot,
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        env: { ...process.env, NODE_ENV: 'development' },
    });

    appProcess.once('exit', (code, signal) => {
        appProcess = null;
        if (isShuttingDown) {
            return;
        }

        if (code === 0) {
            console.log('应用已手动退出（托盘/主动关闭）');
        } else {
            const hexCode = code !== null ? `0x${(code >>> 0).toString(16).toUpperCase()}` : 'N/A';
            console.error(`应用异常崩溃：code=${code} (${hexCode})，signal=${signal}`);
        }

        // 应用退出后，开发监听服务也同步退出
        shutdown(code ?? 0);
    });
}

async function restartApp() {
    if (isShuttingDown) {
        return;
    }
    await stopApp();
    startApp();
}

function stopApp() {
    if (!appProcess || appProcess.exitCode !== null) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        const timer = setTimeout(() => appProcess?.kill(), 1000);
        appProcess.once('exit', () => {
            clearTimeout(timer);
            resolve();
        });

        if (appProcess.connected) {
            appProcess.send({ type: 'shutdown' });
        } else {
            appProcess.kill();
        }
    });
}

function notifyRenderer(mode = 'page') {
    if (appProcess?.connected) {
        appProcess.send({ type: 'renderer-reload', mode });
    }
}

// --- 静态文件处理与监听 ---

async function prepareAssets() {
    await fs.rm(outputRoot, { recursive: true, force: true });
    await fs.mkdir(rendererOutput, { recursive: true });
    await fs.mkdir(path.resolve(outputRoot, 'assets'), { recursive: true });
    await fs.mkdir(path.resolve(outputRoot, 'native'), { recursive: true });

    // 批量复制渲染进程静态资源
    const staticFiles = ['control.html', 'control.css', 'quick.html', 'quick.css'];
    await Promise.all([
        ...staticFiles.map((file) =>
            fs.copyFile(path.resolve(rendererSource, file), path.resolve(rendererOutput, file)),
        ),
        fs.copyFile(path.resolve(root, 'assets/tray-icon.ico'), path.resolve(outputRoot, 'assets/tray-icon.ico')),
        fs
            .copyFile(
                path.resolve(root, 'native/bin/win-x64/MonitorNative.node'),
                path.resolve(outputRoot, 'native/MonitorNative.node'),
            )
            .catch(() => console.warn('警告：MonitorNative.node 不存在；请先执行 npm run build:native')),
        fs
            .copyFile(
                path.resolve(root, 'native/bin/win-x64/WebViewNative.node'),
                path.resolve(outputRoot, 'native/WebViewNative.node'),
            )
            .catch(() => console.warn('警告：WebViewNative.node 不存在；请先执行 npm run build:native')),
    ]);
}

function watchStaticFiles() {
    let timer = null;
    staticWatcher = watch(rendererSource, { recursive: true }, (_, filename) => {
        if (!filename || !/\.(html|css)$/i.test(filename)) {
            return;
        }

        clearTimeout(timer);
        timer = setTimeout(async () => {
            const src = path.resolve(rendererSource, filename);
            const dist = path.resolve(rendererOutput, filename);
            try {
                await fs.mkdir(path.dirname(dist), { recursive: true });
                await fs.copyFile(src, dist);
                const ext = path.extname(filename).toLowerCase();
                notifyRenderer(ext === '.css' ? 'css' : 'page');
            } catch (err) {
                if (err.code !== 'ENOENT') {
                    console.error('复制静态文件失败', err);
                }
            }
        }, 200);
    });
}

// --- 安全退出逻辑 ---

async function shutdown(code = 0) {
    if (isShuttingDown) {
        return;
    }
    isShuttingDown = true;
    staticWatcher?.close();
    await stopApp();
    await Promise.allSettled([mainCtx.dispose(), rendererCtx.dispose()]);
    process.exit(code);
}

process.once('SIGINT', () => shutdown(0));
process.once('SIGTERM', () => shutdown(0));
