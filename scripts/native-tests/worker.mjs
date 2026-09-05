import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const directory = process.env.NATIVE_TEST_TMP;
const scenario = process.argv[2];
assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'x64');
assert.ok(directory, 'Use run.mjs to provide an isolated temporary directory');

function loadAddon(name, variable) {
    const file = fs.realpathSync(
        path.resolve(process.env[variable] ?? path.join(root, 'native/bin/win-x64', `${name}.node`)),
    );
    assert.equal(
        path.extname(file).toLowerCase(),
        '.node',
        'A real .node binary is required; JS fakes are not accepted',
    );
    process.env[variable] = file;
    const bytes = fs.readFileSync(file);
    console.log(
        JSON.stringify({
            node: process.version,
            file,
            bytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
        }),
    );
    return require(file);
}

function monitorAddon() {
    return loadAddon('MonitorNative', 'MONITOR_NATIVE_ADDON');
}

function webviewAddon() {
    return loadAddon('WebViewNative', 'WEBVIEW_NATIVE_ADDON');
}

function exportsMatch(addon, names) {
    assert.deepEqual(Object.keys(addon).sort(), [...names].sort());
    for (const name of names) {
        assert.equal(typeof addon[name], 'function', name);
    }
}

function monitorContract() {
    const addon = monitorAddon();
    exportsMatch(addon, ['refreshMonitors', 'getVcpValue', 'getCapabilities', 'setVcpValue', 'shutdown']);
    const invalidTypes = [undefined, null, '0', true, {}, [], 1n];
    const invalidNumbers = [NaN, Infinity, -Infinity, -1, 0.5, 0x1_0000_0000];
    const signatures = [
        ['getCapabilities', [0]],
        ['getVcpValue', [0, 0x10]],
        ['setVcpValue', [0, 0x10, 50]],
    ];
    // No refresh: g_monitors is empty, so valid input cannot write hardware.
    for (const [method, valid] of signatures) {
        for (let index = 0; index < valid.length; index++) {
            for (const [values, constructor] of [
                [invalidTypes, TypeError],
                [invalidNumbers, RangeError],
            ]) {
                for (const value of values) {
                    const args = [...valid];
                    args[index] = value;
                    assert.throws(
                        () => addon[method](...args),
                        constructor,
                        `${method} argument ${index}: ${String(value)}`,
                    );
                }
            }
            assert.throws(() => addon[method](...valid.slice(0, index)), TypeError);
        }
        assert.throws(() => addon[method](...valid), { name: 'RangeError', message: /显示器索引已失效/ });
    }
    for (const code of [0, 15, 16, 255]) {
        assert.throws(() => addon.getVcpValue(0, code), /显示器索引已失效/);
    }
    for (const code of [256, 0xffffffff]) {
        assert.throws(() => addon.getVcpValue(0, code), /code 必须位于/);
        assert.throws(() => addon.setVcpValue(0, code, 50), /code 必须位于/);
    }
    assert.throws(() => addon.setVcpValue(0xffffffff, 0x10, 0xffffffff), /显示器索引已失效/);
    addon.shutdown();
    addon.shutdown();
}

function validateMonitors(monitors) {
    assert.ok(Array.isArray(monitors));
    for (const [index, monitor] of monitors.entries()) {
        assert.equal(monitor.index, index);
        assert.equal(typeof monitor.id, 'string');
        assert.ok(monitor.id.length > 0);
        assert.equal(typeof monitor.name, 'string');
        assert.ok(monitor.name.length > 0);
    }
}

function monitorEnumeration(cleanupOnly = false) {
    const addon = monitorAddon();
    for (let iteration = 0; iteration < 3; iteration++) {
        const monitors = addon.refreshMonitors();
        validateMonitors(monitors);
        console.log(`Enumeration ${iteration}: ${JSON.stringify(monitors)}`);
        assert.throws(() => addon.getVcpValue(monitors.length, 0x10), /显示器索引已失效/);
        if (!cleanupOnly) {
            addon.shutdown();
            assert.throws(() => addon.getCapabilities(0), /显示器索引已失效/);
        }
    }
    // cleanupOnly intentionally relies on napi_add_env_cleanup_hook at normal
    // environment teardown. Exit alone does not prove absence of handle leaks.
    if (!cleanupOnly) {
        addon.shutdown();
    }
}

function config() {
    return {
        rendererRoot: path.join(directory, 'renderer'),
        webviewDataDirectory: path.join(directory, 'profile', 'nested', 'data'),
        iconPath: path.join(root, 'assets/tray-icon.ico'),
        trayTooltip: 'Native integration test 测试',
        development: false,
    };
}

function windowOptions(id) {
    return {
        id,
        pathname: `probe.html?instance=${id}`,
        title: `Native test ${id}`,
        width: 480,
        height: 320,
        minWidth: 240,
        minHeight: 160,
        uiScalePercent: 100,
        backgroundColor: { red: 240, green: 240, blue: 240 },
        anchorMargin: 8,
        resizable: true,
        alwaysOnTop: false,
        skipTaskbar: false,
        closeOnDeactivate: false,
        emitBoundsChanges: true,
        placement: 'center',
    };
}

function webviewContract() {
    const addon = webviewAddon();
    const methods = [
        'openWindow',
        'closeWindow',
        'startWindowDrag',
        'postWebMessage',
        'setWindowScale',
        'reload',
        'executeScript',
        'setTrayMenu',
        'setTheme',
        'setGlobalHotkeys',
        'openPath',
    ];
    exportsMatch(addon, ['initialize', ...methods, 'shutdown']);
    for (const method of methods) {
        assert.throws(() => addon[method](), /WebViewNative 尚未初始化/, method);
    }
    assert.throws(() => addon.initialize(), TypeError);
    assert.throws(() => addon.initialize(null, () => {}), TypeError);
    assert.throws(() => addon.initialize(config(), null), TypeError);
    for (const key of ['rendererRoot', 'webviewDataDirectory', 'iconPath', 'trayTooltip']) {
        assert.throws(() => addon.initialize({ ...config(), [key]: 123 }, () => {}), TypeError);
    }
    assert.throws(() => addon.initialize({ ...config(), development: 'false' }, () => {}), TypeError);
    addon.shutdown();
    addon.shutdown();
}

async function directoryError() {
    const addon = webviewAddon();
    const { NativeShell } = await import('../../src/main/native-shell.ts');
    const shell = new NativeShell();
    const file = path.join(directory, 'ordinary-file');
    fs.writeFileSync(file, 'not a directory');
    assert.throws(() => shell.initialize({ ...config(), webviewDataDirectory: file }, () => {}), {
        message: /创建 WebView data 目录失败/,
    });
    assert.throws(() => addon.closeWindow(), /尚未初始化/);
    shell.shutdown();
}

function selectMonitor(addon, requireSelection = false) {
    const monitors = addon.refreshMonitors();
    validateMonitors(monitors);
    console.log(`Available monitor IDs: ${JSON.stringify(monitors)}`);
    assert.ok(monitors.length > 0, 'No physical monitor: the DDC suite has not passed');
    const id = process.env.NATIVE_TEST_MONITOR_ID;
    const indexText = process.env.NATIVE_TEST_MONITOR_INDEX;
    assert.ok(!(id && indexText !== undefined), 'Specify a monitor ID or index, not both');
    if (indexText !== undefined) {
        assert.ok(/^(0|[1-9]\d*)$/.test(indexText) && Number(indexText) <= 0xffffffff, 'Invalid monitor index');
    }
    const hasSelection = Boolean(id) || indexText !== undefined;
    assert.ok(!requireSelection || hasSelection, 'Select the write target using --monitor-index or --monitor-id');
    assert.ok(hasSelection || monitors.length === 1, 'Multiple monitors: select one explicitly');
    const monitor = id
        ? monitors.find((item) => item.id === id)
        : indexText !== undefined
          ? monitors.find((item) => item.index === Number(indexText))
          : monitors[0];
    assert.ok(monitor, `Selected monitor not found: ${id ?? indexText}`);
    // Indices belong to this enumeration, so use an ID if topology may change
    // between inspecting the list and starting the test. Do not refresh during
    // the write/readback/restore sequence.
    console.log(`Selected monitor: ${JSON.stringify(monitor)}`);
    return monitor;
}

function validateVcp(value) {
    for (const key of ['current', 'maximum']) {
        assert.ok(Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 0xffffffff, key);
    }
}

async function ddcRead() {
    const addon = monitorAddon();
    try {
        const monitor = selectMonitor(addon);
        const codes = (process.env.NATIVE_TEST_VCP_CODES ?? '0x10,0x12').split(',').map(Number);
        assert.ok(codes.length > 0 && codes.every((code) => Number.isInteger(code) && code >= 0 && code <= 255));
        for (const code of codes) {
            const result = addon.getVcpValue(monitor.index, code);
            validateVcp(result);
            console.log(JSON.stringify({ id: monitor.id, code, ...result }));
            await delay(100);
        }
        const capabilities = addon.getCapabilities(monitor.index);
        assert.equal(typeof capabilities, 'string');
        assert.ok(capabilities.length > 0, 'This suite requires a monitor with readable Capabilities');
        assert.ok(capabilities.includes('(') && capabilities.includes(')'), 'Malformed Capabilities');
        console.log(`Capabilities: ${capabilities}`);
        // Optional deterministic error-path check on a code known to be
        // unsupported by this particular monitor. No universal such code exists.
        if (process.env.NATIVE_TEST_UNSUPPORTED_VCP) {
            const code = Number(process.env.NATIVE_TEST_UNSUPPORTED_VCP);
            assert.ok(Number.isInteger(code) && code >= 0 && code <= 255);
            const hex = code.toString(16).toUpperCase().padStart(2, '0');
            assert.throws(
                () => addon.getVcpValue(monitor.index, code),
                (error) => error instanceof Error && error.message.includes(`读取 VCP 0x${hex}失败（错误码 `),
            );
        }
    } finally {
        addon.shutdown();
    }
}

async function readBrightnessUntil(addon, index, expected) {
    let actual;
    for (let attempt = 0; attempt < 15; attempt++) {
        await delay(200);
        actual = addon.getVcpValue(index, 0x10).current;
        if (actual === expected) {
            return;
        }
    }
    assert.equal(actual, expected, 'Brightness readback did not settle to the requested value');
}

async function ddcWrite() {
    assert.equal(
        process.env.NATIVE_TEST_ALLOW_WRITE,
        '1',
        'Use npm run test:native:ddc-write -- --allow-write with an explicit monitor selector',
    );
    const addon = monitorAddon();
    try {
        const monitor = selectMonitor(addon, true);
        const before = addon.getVcpValue(monitor.index, 0x10);
        validateVcp(before);
        assert.ok(before.maximum >= 10 && before.current <= before.maximum, 'Unsuitable brightness range');
        const target = before.current < before.maximum ? before.current + 1 : before.current - 1;
        console.log(`WRITE/RESTORE PLAN: ${JSON.stringify({ id: monitor.id, original: before.current, target })}`);
        const errors = [];
        try {
            addon.setVcpValue(monitor.index, 0x10, target);
            await readBrightnessUntil(addon, monitor.index, target);
        } catch (error) {
            errors.push(error);
        } finally {
            // Attempt restoration even when the first write/read throws.
            // Process crashes, timeouts or unplugging cannot guarantee recovery.
            try {
                addon.setVcpValue(monitor.index, 0x10, before.current);
                await readBrightnessUntil(addon, monitor.index, before.current);
                console.log('Original brightness restored and read back');
            } catch (error) {
                errors.push(new Error(`Restore failed; original brightness was ${before.current}`, { cause: error }));
            }
        }
        if (errors.length) {
            throw new AggregateError(errors, 'DDC write/readback/restore failed');
        }
    } finally {
        addon.shutdown();
    }
}

async function webviewLifecycle(queuedShutdown = false, interactive = false) {
    const addon = webviewAddon();
    const { NativeShell } = await import('../../src/main/native-shell.ts');
    const shell = new NativeShell();
    const options = config();
    fs.mkdirSync(options.rendererRoot, { recursive: true });
    fs.writeFileSync(
        path.join(options.rendererRoot, 'probe.html'),
        `<!doctype html><meta charset="utf-8">
<title>Native integration probe</title><p>Native integration test</p><script>
const send = (data) => chrome.webview.postMessage(JSON.stringify(data));
chrome.webview.addEventListener('message', (event) => send({kind:'echo', value:event.data}));
send({kind:'ready', instance:new URL(location.href).searchParams.get('instance'), token:crypto.randomUUID()});
</script>`,
    );
    const events = [];
    const receive = (event) => events.push(event);
    async function waitFor(predicate, label, after = 0) {
        const deadline = Date.now() + (interactive ? 120_000 : 20_000);
        while (Date.now() < deadline) {
            const error = events.find((event) => event.type === 'error');
            assert.equal(error, undefined, JSON.stringify(error));
            const event = events.slice(after).find(predicate);
            if (event) {
                return event;
            }
            await delay(25);
        }
        assert.fail(`Timed out: ${label}; events=${JSON.stringify(events)}`);
    }
    const messageIs = (kind, instance) => (event) => {
        if (event.type !== 'web-message') {
            return false;
        }
        const message = JSON.parse(event.message);
        return message.kind === kind && (instance === undefined || message.instance === instance);
    };
    try {
        assert.equal(fs.existsSync(options.webviewDataDirectory), false);
        shell.initialize(options, receive);
        assert.ok(fs.statSync(options.webviewDataDirectory).isDirectory());
        shell.initialize(options, receive); // Idempotent TS initialization.
        if (queuedShutdown) {
            // Shutdown with pending UI commands, without waiting for async WebView
            // creation to finish. Parent checks for crash/deadlock during exit.
            shell.openWindow(windowOptions('pending'));
            for (let sequence = 0; sequence < 128; sequence++) {
                // These messages need not reach a page that is still being
                // created. This checks command ownership and destruction when
                // draining/closing, including string and vector captures.
                shell.postWebMessage(`pending-${sequence}:${'待释放消息🙂'.repeat(64)}`);
                shell.setTrayMenu([
                    { type: 'item', id: `pending-${sequence}`, label: `Pending menu ${sequence}` },
                ]);
            }
            shell.closeWindow();
            return;
        }

        assert.throws(
            () => addon.openWindow({ ...windowOptions('bad'), backgroundColor: { red: 256, green: 0, blue: 0 } }),
            RangeError,
        );
        assert.throws(() => addon.openWindow({ ...windowOptions('bad'), placement: 'invalid' }), TypeError);
        assert.throws(() => addon.postWebMessage({}), TypeError);
        assert.throws(() => addon.executeScript(123), TypeError);
        assert.throws(() => addon.setWindowScale('150'), TypeError);
        assert.throws(() => addon.setTheme('invalid'), TypeError);
        assert.throws(() => addon.setTrayMenu([{ type: 'invalid' }]), TypeError);
        let nested = [{ type: 'item', id: 'leaf', label: 'Leaf' }];
        for (let depth = 0; depth < 10; depth++) {
            nested = [{ type: 'submenu', label: 'Nested', items: nested }];
        }
        assert.throws(() => addon.setTrayMenu(nested), RangeError);
        assert.throws(() => addon.setGlobalHotkeys(Array(129).fill({})), RangeError);
        assert.throws(
            () => addon.setGlobalHotkeys([{ id: 'bad', label: 'Bad', modifiers: 0, virtualKey: 65 }]),
            RangeError,
        );
        assert.throws(() => addon.openPath(123), TypeError);

        // Parsing/queue smoke tests only; this does not open/click the tray menu
        // or prove that the OS theme/hotkey registration visually took effect.
        shell.setTrayMenu([
            {
                type: 'submenu',
                label: '测试菜单',
                items: [
                    { type: 'item', id: 'checked', label: 'Checked', checked: true },
                    { type: 'separator' },
                    { type: 'item', id: 'disabled', label: 'Disabled', enabled: false },
                ],
            },
        ]);
        shell.setGlobalHotkeys([]);
        shell.setTheme('dark');
        shell.setTheme('light');

        if (interactive) {
            shell.setTrayMenu([
                {
                    type: 'submenu',
                    label: '测试菜单',
                    items: [
                        { type: 'item', id: 'checked', label: 'Checked', checked: true },
                        { type: 'separator' },
                        { type: 'item', id: 'disabled', label: 'Disabled', enabled: false },
                        {
                            type: 'submenu',
                            label: 'Nested',
                            items: [{ type: 'item', id: 'confirm-测试🙂', label: 'Confirm 测试🙂' }],
                        },
                    ],
                },
            ]);
            shell.setGlobalHotkeys([
                { id: 'native-test-hotkey', label: 'Ctrl+Alt+Shift+F10', modifiers: 7, virtualKey: 0x79 },
            ]);
            shell.openWindow(windowOptions('interactive'));
            await waitFor(messageIs('ready', 'interactive'), 'interactive page ready');
            const click = await waitFor((event) => event.type === 'tray-primary-click', 'left-click tray icon');
            assert.ok(Number.isFinite(click.x) && Number.isFinite(click.y));
            const command = await waitFor(
                (event) => event.type === 'tray-command' && event.id === 'confirm-测试🙂',
                'nested tray command',
            );
            assert.ok(Number.isFinite(command.x) && Number.isFinite(command.y));
            await waitFor(
                (event) => event.type === 'global-hotkey' && event.id === 'native-test-hotkey',
                'Ctrl+Alt+Shift+F10',
            );
            shell.setGlobalHotkeys([]);
            // Event IDs exercise the real OS -> UI thread -> TSFN -> JS path.
            return;
        }

        for (let cycle = 0; cycle < 3; cycle++) {
            const id = `cycle-${cycle}`;
            let mark = events.length;
            shell.openWindow(windowOptions(id));
            const ready = JSON.parse((await waitFor(messageIs('ready', id), 'page ready', mark)).message);

            mark = events.length;
            const payload = `往返中文🙂 "quotes" \\ newline\n${cycle}`;
            shell.postWebMessage(payload);
            const echo = JSON.parse((await waitFor(messageIs('echo'), 'Node -> WebView -> Node', mark)).message);
            assert.equal(echo.value, payload);

            // Submit a burst without awaiting each reply. Small and large
            // strings exercise captured parameter ownership during queue moves.
            // A final echo acts as a fence; check the entire observed sequence,
            // rather than accepting receipt of only the last numbered message.
            mark = events.length;
            const burst = Array.from({ length: 512 }, (_, sequence) =>
                `${id}:burst:${sequence}:${sequence % 2 === 0 ? '中文🙂'.repeat(64) : 'short'}`,
            );
            for (const message of burst) {
                shell.postWebMessage(message);
            }
            const fence = `${id}:burst:complete`;
            shell.postWebMessage(fence);
            await waitFor(
                (event) => messageIs('echo')(event) && JSON.parse(event.message).value === fence,
                'ordered burst of 512 messages',
                mark,
            );
            const received = events
                .slice(mark)
                .filter(messageIs('echo'))
                .map((event) => JSON.parse(event.message).value);
            assert.deepEqual(received, [...burst, fence], 'Messages must arrive exactly once, in order, with intact text');

            mark = events.length;
            shell.executeScript("chrome.webview.postMessage(JSON.stringify({kind:'script', value:6*7}))");
            assert.equal(JSON.parse((await waitFor(messageIs('script'), 'ExecuteScript', mark)).message).value, 42);

            mark = events.length;
            shell.setWindowScale(150);
            const bounds = await waitFor(
                (event) => event.type === 'window-bounds' && event.id === id,
                'bounds after scaling',
                mark,
            );
            for (const value of Object.values(bounds.bounds)) {
                assert.ok(Number.isFinite(value));
            }
            assert.ok(bounds.bounds.width > 0 && bounds.bounds.height > 0);

            mark = events.length;
            shell.reload();
            const reloaded = JSON.parse((await waitFor(messageIs('ready', id), 'Reload', mark)).message);
            assert.notEqual(reloaded.token, ready.token);

            mark = events.length;
            shell.closeWindow();
            await waitFor((event) => event.type === 'window-closed' && event.id === id, 'window closed', mark);
        }
        shell.shutdown();
        assert.throws(() => addon.closeWindow(), /尚未初始化/);
        shell.initialize(options, receive); // Existing directory + fresh UI thread.
        const mark = events.length;
        shell.openWindow(windowOptions('reinitialized'));
        await waitFor(messageIs('ready', 'reinitialized'), 'reinitialization', mark);
    } finally {
        shell.shutdown();
        shell.shutdown();
    }
    await delay(100);
    assert.deepEqual(events.filter((event) => event.type === 'error'), []);
}

const scenarios = {
    'monitor-contract': monitorContract,
    'monitor-enumeration': () => monitorEnumeration(false),
    'monitor-env-cleanup': () => monitorEnumeration(true),
    'webview-contract': webviewContract,
    'directory-error': directoryError,
    'ddc-read': ddcRead,
    'ddc-write': ddcWrite,
    'webview-lifecycle': () => webviewLifecycle(false),
    'webview-queued-shutdown': () => webviewLifecycle(true),
    'webview-interactive': () => webviewLifecycle(false, true),
};
try {
    assert.ok(Object.hasOwn(scenarios, scenario), `Unknown scenario: ${scenario}`);
    await scenarios[scenario]();
    console.log(`NATIVE_SCENARIO_COMPLETE:${scenario}`);
} catch (error) {
    console.error(error);
    process.exitCode = 1;
}
