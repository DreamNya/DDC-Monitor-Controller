import fs from 'node:fs/promises';
import path from 'node:path';

export async function copyRuntimeDependencies(target) {
    const projectRoot = path.resolve(import.meta.dirname, '..');
    const sourceRoot = path.join(projectRoot, 'node_modules');
    const outputRoot = path.join(projectRoot, 'dist', target, 'node_modules');

    const runtimeFiles = [
        // WebView 主包
        '@webviewjs/webview/package.json',
        '@webviewjs/webview/index.js',
        '@webviewjs/webview/js-bindings.js',
        '@webviewjs/webview/LICENSE',

        // WebView Windows x64 原生模块
        '@webviewjs/webview-win32-x64-msvc/package.json',
        '@webviewjs/webview-win32-x64-msvc/webview.win32-x64-msvc.node',
    ];

    await fs.rm(outputRoot, {
        recursive: true,
        force: true,
    });

    for (const relativePath of runtimeFiles) {
        const source = path.join(sourceRoot, relativePath);
        const destination = path.join(outputRoot, relativePath);

        await fs.mkdir(path.dirname(destination), {
            recursive: true,
        });

        await fs.copyFile(source, destination);
    }

    console.log(`已导出 ${runtimeFiles.length} 个运行时依赖文件`);
}
