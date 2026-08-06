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
}

function assertFile(path, message) {
    if (!fs.existsSync(path)) {
        throw new Error(message);
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
        throw new Error('找不到 MSVC x64 工具链；请安装‘使用 C++ 的桌面开发’工作负载');
    }

    return installationPath;
}

function quote(value) {
    if (value.includes('"')) {
        throw new Error(`路径中包含不支持的双引号：${value}`);
    }

    return `"${value}"`;
}

function runBuildCommands(commands) {
    const commandProcessor = process.env.ComSpec ?? 'cmd.exe';
    const command = commands.join(' && ');
    const result = spawnSync(command, {
        cwd: root,
        stdio: 'inherit',
        windowsHide: true,
        shell: commandProcessor,
    });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        throw new Error(`MSVC 编译失败，退出码：${result.status ?? '未知'}`);
    }
}

function main() {
    assertWindows();

    const programFilesX86 = process.env['ProgramFiles(x86)'];
    if (!programFilesX86) {
        throw new Error('找不到 ProgramFiles(x86) 环境变量');
    }

    const buildDir = path.join(root, 'native', 'build', 'win-x64');
    const outputDir = path.join(root, 'native', 'bin', 'win-x64');
    const vswhere = path.join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');

    assertFile(vswhere, '找不到 vswhere.exe；请安装 Visual Studio 2022 Build Tools，并勾选‘使用 C++ 的桌面开发’');

    const visualStudioPath = findVisualStudio(vswhere);
    const vcvars = path.join(visualStudioPath, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');

    const ddcSource = path.join(root, 'native', 'MonitorDdc', 'monitor_ddc.cpp');
    const ddcObject = path.join(buildDir, 'monitor_ddc.obj');
    const ddcDll = path.join(outputDir, 'MonitorDdc.dll');
    const ddcLib = path.join(buildDir, 'monitor_ddc.lib');
    const launcherSource = path.join(root, 'native', 'Launcher', 'launcher.cpp');
    const launcherObject = path.join(buildDir, 'launcher.obj');
    const launcherExe = path.join(outputDir, 'DDCMonitorController.exe');
    const launcherRc = path.join(root, 'native', 'Launcher', 'resource.rc');
    const launcherRes = path.join(root, 'native', 'Launcher', 'resource.res');

    assertFile(vcvars, '找不到 vcvars64.bat；Visual Studio C++ 工具链可能未完整安装');
    assertFile(ddcSource, `找不到源文件：${ddcSource}`);
    assertFile(launcherSource, `找不到源文件：${launcherSource}`);
    assertFile(launcherRc, `找不到资源脚本：${launcherRc}`);

    fs.mkdirSync(buildDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });

    const commands = [
        `call ${quote(vcvars)}`,
        `rc /nologo /fo ${quote(launcherRes)} ${quote(launcherRc)}`,
        [
            'cl /nologo /utf-8 /std:c++20 /EHsc /O2 /W4 /permissive- /MT',
            '/DUNICODE /D_UNICODE /DMONITOR_DDC_EXPORTS /LD',
            quote(ddcSource),
            `/Fo:${quote(ddcObject)}`,
            '/link',
            `/OUT:${quote(ddcDll)}`,
            `/IMPLIB:${quote(ddcLib)}`,
            'Dxva2.lib User32.lib',
        ].join(' '),
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
    ];

    runBuildCommands(commands);

    console.log('原生桥接和无控制台启动器已生成：');
    console.log(`  ${ddcDll}`);
    console.log(`  ${launcherExe}`);
}

try {
    main();
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`原生构建失败：${message}`);
    process.exitCode = 1;
}
