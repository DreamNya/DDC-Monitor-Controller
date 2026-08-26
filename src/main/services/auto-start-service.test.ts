import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
    AutoStartService,
    createScheduledTaskXml,
    decodeWindowsCommandOutput,
    encodeScheduledTaskXml,
    type AutoStartCommandResult,
} from './auto-start-service.ts';

const TEST_ACCOUNT = 'desktop\\tester';
const TEST_SID = 'S-1-5-21-1000-2000-3000-1001';

function taskName(): string {
    return `DDCMonitorController-AutoStart-${TEST_SID}`;
}

test('current-user task XML uses interactive logon, least privilege, and priority 4', () => {
    const xml = createScheduledTaskXml({
        launcherPath: path.join('/portable', 'DDC & Monitor', 'DDCMonitorController.exe'),
        sid: TEST_SID,
    });

    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-16"\?>/);
    assert.match(xml, new RegExp(`<UserId>${TEST_SID}</UserId>`));
    assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
    assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
    assert.match(xml, /<Priority>4<\/Priority>/);
    assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
    assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
    assert.match(xml, /DDC &amp; Monitor/);
    assert.doesNotMatch(xml, /<GroupId>|HighestAvailable|BootTrigger/);
});

test('scheduled task XML is encoded as UTF-16LE with BOM for schtasks import', () => {
    const xml = createScheduledTaskXml({
        launcherPath: path.resolve('/portable/DDCMonitorController.exe'),
        sid: TEST_SID,
    });
    const encoded = encodeScheduledTaskXml(xml);

    assert.equal(encoded[0], 0xff);
    assert.equal(encoded[1], 0xfe);
    assert.equal(encoded.subarray(2).toString('utf16le'), xml);
});

test('Windows command output decoder handles CP936 diagnostics', () => {
    const cp936Error = Buffer.from('b4edcef33a20c8cecef120584d4c20b8f1cabdb4edcef3', 'hex');
    assert.equal(decodeWindowsCommandOutput(cp936Error, 936), '错误: 任务 XML 格式错误');
});

test('AutoStartService creates and deletes only the current-user task without querying Task Scheduler', async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ddc-auto-start-test-'));
    const launcherPath = path.join(temporaryDirectory, 'DDC & Monitor', 'DDCMonitorController.exe');
    const commands: Array<{ executable: string; args: readonly string[] }> = [];

    const runCommand = async (executable: string, args: readonly string[]): Promise<AutoStartCommandResult> => {
        commands.push({ executable, args: [...args] });

        if (executable === 'whoami.exe') {
            return success(`"${TEST_ACCOUNT}","${TEST_SID}"\r\n`);
        }
        if (executable === 'schtasks.exe' && args[0] === '/Create') {
            const xmlIndex = args.indexOf('/XML');
            assert.notEqual(xmlIndex, -1);
            const xmlPath = args[xmlIndex + 1]!;
            const raw = await fs.readFile(xmlPath);
            assert.equal(raw[0], 0xff);
            assert.equal(raw[1], 0xfe);
            const xml = raw.subarray(2).toString('utf16le');
            assert.match(xml, new RegExp(escapeForRegExp(path.basename(launcherPath))));
            return success();
        }
        if (executable === 'schtasks.exe' && args[0] === '/Delete') {
            return success();
        }
        return failure('unexpected command');
    };

    try {
        const service = new AutoStartService({
            launcherPath,
            platform: 'win32',
            temporaryDirectory,
            runCommand,
        });

        await service.setEnabled(true);
        await service.setEnabled(false);

        assert.deepEqual(
            commands.map(({ executable, args }) => [executable, args[0], args[2]]),
            [
                ['whoami.exe', '/user', 'csv'],
                ['schtasks.exe', '/Create', taskName()],
                ['schtasks.exe', '/Delete', taskName()],
            ],
        );
        assert.equal(
            commands.some(({ args }) => args[0] === '/Query'),
            false,
        );
    } finally {
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
});

test('AutoStartService surfaces create failures without running a verification query', async () => {
    const commands: Array<{ executable: string; args: readonly string[] }> = [];
    const service = new AutoStartService({
        launcherPath: path.resolve('/portable/DDCMonitorController.exe'),
        platform: 'win32',
        runCommand: async (executable, args) => {
            commands.push({ executable, args: [...args] });
            if (executable === 'whoami.exe') {
                return success(`"${TEST_ACCOUNT}","${TEST_SID}"\r\n`);
            }
            return failure('创建失败');
        },
    });

    await assert.rejects(service.setEnabled(true), /创建当前用户登录计划任务失败.*创建失败/);
    assert.equal(
        commands.some(({ args }) => args[0] === '/Query'),
        false,
    );
});

function escapeForRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function success(stdout = ''): AutoStartCommandResult {
    return { exitCode: 0, stdout, stderr: '' };
}

function failure(stderr = ''): AutoStartCommandResult {
    return { exitCode: 1, stdout: '', stderr };
}
