import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');

function assertWindows() {
    if (process.platform !== 'win32') {
        throw new Error('原生构建仅支持 Windows');
    }

    if (process.arch !== 'x64') {
        throw new Error(`当前只支持 Windows x64 构建，检测到架构：${process.arch}`);
    }
}

function assertFile(filePath, message) {
    if (!fs.existsSync(filePath)) {
        throw new Error(message);
    }
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: root,
        stdio: 'inherit',
        windowsHide: true,
        ...options,
    });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        throw new Error(`命令执行失败，退出码：${result.status ?? '未知'}`);
    }
}

function findVisualStudio(vswhere) {
    const result = spawnSync(
        vswhere,
        [
            '-latest',
            '-products',
            '*',
            '-requires',
            'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
            '-property',
            'installationPath',
        ],
        {
            cwd: root,
            encoding: 'utf8',
            windowsHide: true,
        },
    );

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        throw new Error(`vswhere.exe 执行失败，退出码：${result.status ?? '未知'}`);
    }

    const installationPath = result.stdout.trim();

    if (!installationPath) {
        throw new Error('找不到 MSVC x64 工具链；请安装“使用 C++ 的桌面开发”工作负载');
    }

    return installationPath;
}

function quote(value) {
    if (value.includes('"')) {
        throw new Error(`路径中包含不支持的双引号：${value}`);
    }

    return `"${value}"`;
}

function buildAddon(outputDir) {
    const addonRoot = path.join(root, 'native', 'MonitorNative');
    const bindingGyp = path.join(addonRoot, 'binding.gyp');
    const nodeGyp = path.join(root, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');

    assertFile(bindingGyp, `找不到 Node-API 构建配置：${bindingGyp}`);
    assertFile(nodeGyp, '找不到 node-gyp；请先执行 npm install');

    run(process.execPath, [nodeGyp, 'rebuild', '--release', '--arch=x64'], {
        cwd: addonRoot,
    });

    const builtAddon = path.join(addonRoot, 'build', 'Release', 'MonitorNative.node');
    const outputAddon = path.join(outputDir, 'MonitorNative.node');

    assertFile(builtAddon, `node-gyp 未生成预期文件：${builtAddon}`);
    fs.copyFileSync(builtAddon, outputAddon);
    return outputAddon;
}

function buildLauncher(outputDir) {
    const programFilesX86 = process.env['ProgramFiles(x86)'];

    if (!programFilesX86) {
        throw new Error('找不到 ProgramFiles(x86) 环境变量');
    }

    const vswhere = path.join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    assertFile(vswhere, '找不到 vswhere.exe；请安装 Visual Studio Build Tools，并勾选“使用 C++ 的桌面开发”');

    const visualStudioPath = findVisualStudio(vswhere);
    const vcvars = path.join(visualStudioPath, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
    const buildDir = path.join(root, 'native', 'build', 'win-x64');
    const launcherSource = path.join(root, 'native', 'Launcher', 'launcher.cpp');
    const launcherObject = path.join(buildDir, 'launcher.obj');
    const launcherExe = path.join(outputDir, 'DDCMonitorController.exe');
    const launcherRc = path.join(root, 'native', 'Launcher', 'resource.rc');
    const launcherRes = path.join(buildDir, 'launcher.res');

    assertFile(vcvars, '找不到 vcvars64.bat；Visual Studio C++ 工具链可能未完整安装');
    assertFile(launcherSource, `找不到源文件：${launcherSource}`);
    assertFile(launcherRc, `找不到资源脚本：${launcherRc}`);
    fs.mkdirSync(buildDir, { recursive: true });

    const commandProcessor = process.env.ComSpec ?? 'cmd.exe';
    const command = [
        `call ${quote(vcvars)}`,
        `rc /nologo /fo ${quote(launcherRes)} ${quote(launcherRc)}`,
        [
            'cl /nologo /utf-8 /std:c++20 /EHsc /O2 /W4 /permissive- /MT',
            '/DUNICODE /D_UNICODE',
            quote(launcherSource),
            quote(launcherRes),
            `/Fo:${quote(launcherObject)}`,
            '/link /SUBSYSTEM:WINDOWS',
            `/OUT:${quote(launcherExe)}`,
            'User32.lib',
        ].join(' '),
    ].join(' && ');

    run(command, [], { shell: commandProcessor });
    return launcherExe;
}

function main() {
    assertWindows();

    const outputDir = path.join(root, 'native', 'bin', 'win-x64');
    fs.mkdirSync(outputDir, { recursive: true });

    const addon = buildAddon(outputDir);
    const launcher = buildLauncher(outputDir);

    console.log('Node-API 原生模块和无控制台启动器已生成：');
    console.log(`  ${addon}`);
    console.log(`  ${launcher}`);
}

try {
    main();
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`原生构建失败：${message}`);
    process.exitCode = 1;
}
