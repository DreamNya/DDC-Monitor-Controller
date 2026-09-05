import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// These are integration tests of real Windows binaries, independent of npm test.
// No silent skips: a requested suite must have its required platform/hardware.
assert.equal(process.platform, 'win32', 'Native integration tests require Windows');
assert.equal(process.arch, 'x64', 'Native integration tests require Node x64');

const suites = {
    contracts: [
        'monitor-contract',
        'monitor-enumeration',
        'monitor-env-cleanup',
        'webview-contract',
        'directory-error',
    ],
    ddc: ['ddc-read'],
    'ddc-write': ['ddc-write'],
    webview: ['webview-lifecycle', 'webview-queued-shutdown'],
    interactive: ['webview-interactive'],
};
const mode = process.argv[2];
assert.ok(Object.hasOwn(suites, mode), `Unknown suite: ${mode}`);
const workerEnvironment = { ...process.env };
let selectorProvided = false;
for (let index = 3; index < process.argv.length; index++) {
    const argument = process.argv[index];
    if (argument === '--allow-write' && mode === 'ddc-write') {
        workerEnvironment.NATIVE_TEST_ALLOW_WRITE = '1';
    } else if (['--monitor-index', '--monitor-id'].includes(argument) && ['ddc', 'ddc-write'].includes(mode)) {
        assert.equal(selectorProvided, false, 'Specify only one monitor selector');
        selectorProvided = true;
        const value = process.argv[++index];
        assert.ok(value && !value.startsWith('--'), `${argument} requires a value`);
        // An explicit CLI selector takes precedence over any inherited selector.
        delete workerEnvironment.NATIVE_TEST_MONITOR_ID;
        delete workerEnvironment.NATIVE_TEST_MONITOR_INDEX;
        if (argument === '--monitor-index') {
            assert.ok(/^(0|[1-9]\d*)$/.test(value) && Number(value) <= 0xffffffff, 'Invalid monitor index');
            workerEnvironment.NATIVE_TEST_MONITOR_INDEX = value;
        } else {
            workerEnvironment.NATIVE_TEST_MONITOR_ID = value;
        }
    } else {
        throw new Error(`Unknown option for ${mode}: ${argument}`);
    }
}
if (mode === 'ddc-write') {
    if (workerEnvironment.NATIVE_TEST_ALLOW_WRITE !== '1') {
        throw new Error(
            'DDC 写入测试尚未执行：请显式传入 --allow-write。' +
                '示例：npm run test:native:ddc-write -- --allow-write --monitor-index 0。' +
                '请先运行 npm run test:native，确认目标显示器的 index；0 仅为示例。',
        );
    }
    if (!workerEnvironment.NATIVE_TEST_MONITOR_ID && workerEnvironment.NATIVE_TEST_MONITOR_INDEX === undefined) {
        throw new Error(
            'DDC 写入测试尚未执行：先运行 npm run test:native 查看显示器 index，' +
                '然后传入 --monitor-index 编号，或使用 --monitor-id "完整 ID"。',
        );
    }
}
const worker = fileURLToPath(new URL('./worker.mjs', import.meta.url));

async function removeTemporaryDirectory(directory) {
    const deadline = performance.now() + 15_000;
    for (;;) {
        try {
            // Use an explicit retry window instead of rm's increasing backoff.
            await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 0 });
            return;
        } catch (error) {
            if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(error.code)) {
                throw error;
            }
            const remaining = deadline - performance.now();
            if (remaining <= 0) {
                throw new Error(
                    `临时目录清理失败：${directory}；最后错误：${error.message}。` +
                        '可能仍被 WebView2 子进程或其他程序占用，或存在权限问题；' +
                        '这与 Native 功能断言的结果分开报告。',
                    { cause: error },
                );
            }
            await delay(Math.min(250, remaining));
        }
    }
}

for (const scenario of suites[mode]) {
    test(`${mode}: ${scenario}`, async (t) => {
        if (mode === 'interactive') {
            console.log('INTERACTIVE TEST: wait for the Native integration test window and tray icon.');
            console.log(
                'Visual check (manual, not asserted): hover over the test tray icon to see Native integration test 测试.',
            );
            console.log('1. Left-click the test tray icon. This checks the click event, not tooltip visibility.');
            console.log('2. Right-click it, open 测试菜单 -> Nested -> Confirm 测试🙂.');
            console.log('3. Press Ctrl+Alt+Shift+F10. Complete all steps within two minutes.');
        }
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ddcmc-native-'));
        try {
            await t.test('Native behavior and worker exit', () => {
                // A parent-process deadline also catches synchronous DDC hangs and
                // native shutdown deadlocks, which a child JS timer cannot interrupt.
                const result = spawnSync(process.execPath, ['--experimental-strip-types', worker, scenario], {
                    env: { ...workerEnvironment, NATIVE_TEST_TMP: directory },
                    encoding: 'utf8',
                    windowsHide: true,
                    timeout: mode === 'contracts' ? 30_000 : mode === 'interactive' ? 180_000 : 120_000,
                    maxBuffer: 4 * 1024 * 1024,
                });
                const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
                assert.ifError(result.error && new Error(`${result.error.message}\n${output}`, { cause: result.error }));
                assert.equal(result.signal, null, output);
                assert.equal(result.status, 0, output);
                assert.ok(output.includes(`NATIVE_SCENARIO_COMPLETE:${scenario}`), output);
                // Successful exit is required in addition to the completion marker.
                // The worker must not use process.exit() to mask live TSFN/UI threads.
                console.log(output.trim());
            });
        } finally {
            // A browser subprocess can outlive the Node worker. Report cleanup
            // separately instead of marking the entire scenario green on EPERM.
            await t.test('Temporary directory released', () => removeTemporaryDirectory(directory));
        }
    });
}
