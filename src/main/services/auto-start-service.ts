import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const USER_TASK_NAME_PREFIX = 'DDCMonitorController-AutoStart-';
const TASK_SCHEMA = 'http://schemas.microsoft.com/windows/2004/02/mit/task';

export interface AutoStartCommandResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

export interface AutoStartServiceOptions {
    launcherPath: string | null;
    platform?: NodeJS.Platform;
    temporaryDirectory?: string;
    runCommand?: (executable: string, args: readonly string[]) => Promise<AutoStartCommandResult>;
}

interface TaskIdentity {
    sid: string;
    taskName: string;
}

/**
 * 管理当前 Windows 用户的登录计划任务
 *
 * settings.json 记录用户是否开启自动启动；这里仅在用户切换开关时负责创建或删除任务，
 * 不通过 schtasks /Query 反向同步或验证任务状态
 */
export class AutoStartService {
    readonly #launcherPath: string | null;
    readonly #platform: NodeJS.Platform;
    readonly #temporaryDirectory: string;
    readonly #runCommand: (executable: string, args: readonly string[]) => Promise<AutoStartCommandResult>;

    #identityPromise: Promise<TaskIdentity> | undefined;

    constructor(options: AutoStartServiceOptions) {
        this.#launcherPath = options.launcherPath ? path.resolve(options.launcherPath) : null;
        this.#platform = options.platform ?? process.platform;
        this.#temporaryDirectory = options.temporaryDirectory ?? os.tmpdir();
        this.#runCommand = options.runCommand ?? runCommand;
    }

    async setEnabled(enabled: boolean): Promise<void> {
        const unsupportedReason = this.#getUnsupportedReason();

        if (unsupportedReason) {
            throw new Error(unsupportedReason);
        }

        const identity = await this.#getIdentity();

        if (enabled) {
            await this.#createTask(identity);
        } else {
            await this.#deleteTask(identity);
        }
    }

    #getUnsupportedReason(): string | null {
        if (this.#platform !== 'win32') {
            return '登录计划任务仅支持 Windows';
        }
        if (!this.#launcherPath) {
            return '当前运行目录中找不到 DDCMonitorController.exe；开发模式不支持配置自动启动';
        }
        return null;
    }

    async #getIdentity(): Promise<TaskIdentity> {
        this.#identityPromise ??= this.#loadIdentity();
        return this.#identityPromise;
    }

    async #loadIdentity(): Promise<TaskIdentity> {
        const result = await this.#runCommand('whoami.exe', ['/user', '/fo', 'csv', '/nh']);

        if (result.exitCode !== 0) {
            throw commandError('读取当前 Windows 用户信息失败', result);
        }

        const match = /^"(?:[^"]|"")*","(S-\d+(?:-\d+)+)"\s*$/i.exec(result.stdout.trim());
        if (!match?.[1]) {
            throw new Error('无法从 whoami 输出中识别当前 Windows 用户 SID');
        }

        const sid = match[1];
        return {
            sid,
            taskName: `${USER_TASK_NAME_PREFIX}${sid}`,
        };
    }

    async #createTask(identity: TaskIdentity): Promise<void> {
        const xmlPath = path.join(this.#temporaryDirectory, `ddc-monitor-autostart-${randomUUID()}.xml`);
        const xml = createScheduledTaskXml({
            launcherPath: this.#launcherPath!,
            sid: identity.sid,
        });

        try {
            await fs.writeFile(xmlPath, encodeScheduledTaskXml(xml));
            const result = await this.#runCommand('schtasks.exe', [
                '/Create',
                '/TN',
                identity.taskName,
                '/XML',
                xmlPath,
                '/F',
            ]);

            if (result.exitCode !== 0) {
                throw commandError(
                    '创建当前用户登录计划任务失败；请检查当前账户或系统策略是否允许创建计划任务',
                    result,
                );
            }
        } finally {
            await fs.rm(xmlPath, { force: true }).catch(() => undefined);
        }
    }

    async #deleteTask(identity: TaskIdentity): Promise<void> {
        const result = await this.#runCommand('schtasks.exe', ['/Delete', '/TN', identity.taskName, '/F']);

        if (result.exitCode !== 0) {
            throw commandError('删除当前用户登录计划任务失败', result);
        }
    }
}

export function createScheduledTaskXml(options: { launcherPath: string; sid: string }): string {
    const launcherPath = path.resolve(options.launcherPath);
    const workingDirectory = path.dirname(launcherPath);
    const command = escapeXml(launcherPath);
    const directory = escapeXml(workingDirectory);
    const sid = escapeXml(options.sid);

    return [
        '<?xml version="1.0" encoding="UTF-16"?>',
        `<Task version="1.3" xmlns="${TASK_SCHEMA}">`,
        '  <RegistrationInfo>',
        '    <Description>Start DDC Monitor Controller when the current user signs in.</Description>',
        '  </RegistrationInfo>',
        '  <Triggers>',
        '    <LogonTrigger>',
        '      <Enabled>true</Enabled>',
        `      <UserId>${sid}</UserId>`,
        '    </LogonTrigger>',
        '  </Triggers>',
        '  <Principals>',
        '    <Principal id="LogonUser">',
        `      <UserId>${sid}</UserId>`,
        '      <LogonType>InteractiveToken</LogonType>',
        '      <RunLevel>LeastPrivilege</RunLevel>',
        '    </Principal>',
        '  </Principals>',
        '  <Settings>',
        '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
        '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
        '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
        '    <AllowHardTerminate>true</AllowHardTerminate>',
        '    <StartWhenAvailable>true</StartWhenAvailable>',
        '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
        '    <AllowStartOnDemand>true</AllowStartOnDemand>',
        '    <Enabled>true</Enabled>',
        '    <Hidden>false</Hidden>',
        '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
        '    <WakeToRun>false</WakeToRun>',
        '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
        '    <Priority>4</Priority>',
        '  </Settings>',
        '  <Actions Context="LogonUser">',
        '    <Exec>',
        `      <Command>${command}</Command>`,
        `      <WorkingDirectory>${directory}</WorkingDirectory>`,
        '    </Exec>',
        '  </Actions>',
        '</Task>',
        '',
    ].join('\r\n');
}

export function encodeScheduledTaskXml(xml: string): Buffer {
    return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
}

export function decodeWindowsCommandOutput(buffer: Buffer, legacyCodePage = 65001): string {
    if (buffer.length === 0) {
        return '';
    }
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
        return buffer.subarray(2).toString('utf16le');
    }
    if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
        return buffer.subarray(3).toString('utf8');
    }

    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
        const encoding = windowsCodePageToEncoding(legacyCodePage);
        try {
            return new TextDecoder(encoding).decode(buffer);
        } catch {
            return buffer.toString('latin1');
        }
    }
}

function escapeXml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}

function commandError(context: string, result: AutoStartCommandResult): Error {
    const detail = (result.stderr || result.stdout).trim();
    return new Error(detail ? `${context}：${detail}` : `${context}（退出码 ${result.exitCode}）`);
}

let legacyCodePagePromise: Promise<number> | undefined;

async function runCommand(executable: string, args: readonly string[]): Promise<AutoStartCommandResult> {
    const [result, legacyCodePage] = await Promise.all([runRawCommand(executable, args), getLegacyCodePage()]);

    return {
        exitCode: result.exitCode,
        stdout: decodeWindowsCommandOutput(result.stdout, legacyCodePage),
        stderr: decodeWindowsCommandOutput(result.stderr, legacyCodePage),
    };
}

interface RawCommandResult {
    exitCode: number;
    stdout: Buffer;
    stderr: Buffer;
}

function runRawCommand(executable: string, args: readonly string[]): Promise<RawCommandResult> {
    return new Promise((resolvePromise, rejectPromise) => {
        execFile(
            executable,
            [...args],
            { encoding: 'buffer', windowsHide: true, maxBuffer: 1024 * 1024 },
            (error, stdout, stderr) => {
                if (error && typeof error.code !== 'number') {
                    rejectPromise(new Error(`无法执行 ${executable}：${error.message}`, { cause: error }));
                    return;
                }

                resolvePromise({
                    exitCode: error && typeof error.code === 'number' ? error.code : 0,
                    stdout,
                    stderr,
                });
            },
        );
    });
}

async function getLegacyCodePage(): Promise<number> {
    legacyCodePagePromise ??= loadLegacyCodePage();
    return legacyCodePagePromise;
}

async function loadLegacyCodePage(): Promise<number> {
    try {
        const result = await runRawCommand('reg.exe', [
            'query',
            'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage',
            '/v',
            'OEMCP',
        ]);
        const ascii = Buffer.concat([result.stdout, result.stderr]).toString('latin1').replaceAll('\0', '');
        const match = /REG_SZ\s+(\d+)/i.exec(ascii);
        const codePage = match?.[1] ? Number.parseInt(match[1], 10) : Number.NaN;
        return Number.isFinite(codePage) ? codePage : 65001;
    } catch {
        return 65001;
    }
}

function windowsCodePageToEncoding(codePage: number): string {
    const knownEncodings: Record<number, string> = {
        866: 'ibm866',
        932: 'shift_jis',
        936: 'gbk',
        949: 'euc-kr',
        950: 'big5',
        1250: 'windows-1250',
        1251: 'windows-1251',
        1252: 'windows-1252',
        1253: 'windows-1253',
        1254: 'windows-1254',
        1255: 'windows-1255',
        1256: 'windows-1256',
        1257: 'windows-1257',
        1258: 'windows-1258',
        65001: 'utf-8',
    };
    return knownEncodings[codePage] ?? 'windows-1252';
}
