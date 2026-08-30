import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
    AdvancedVcpExecuteRequest,
    AdvancedVcpExecutionOutcome,
    AppState,
    IntervalMinutes,
    LiveApplyRequest,
    MonitorCapabilities,
    MonitorVcpReadResult,
} from '../shared/model.ts';
import { createDefaultSettings } from '../main/services/settings-store.ts';
import { PublicApiDispatcher } from './public-api-dispatcher.ts';

test('PublicApiDispatcher accepts command objects, common aliases and always returns an array', async () => {
    const controller = new FakePublicApiController();
    const dispatcher = new PublicApiDispatcher(controller);

    const response = await dispatcher.execute({
        state: null,
        brightness: null,
        auto: null,
    });

    assert.deepEqual(response, [
        { method: 'state', ok: true, result: controller.getState() },
        {
            method: 'brightness',
            ok: true,
            result: [
                {
                    monitorId: 'monitor-1',
                    monitorName: 'Monitor 1',
                    value: 50,
                },
            ],
        },
        { method: 'auto', ok: true, result: false },
    ]);
});

test('PublicApiDispatcher uses monitor alias as a request-local target without changing app settings', async () => {
    const controller = new FakePublicApiController();
    const dispatcher = new PublicApiDispatcher(controller);

    const response = await dispatcher.execute({
        monitor: 'monitor-1',
        brightness: 35,
        contrast: 55,
        interval: 15,
        auto: true,
        schedule: 'default',
        apply: null,
    });

    assert.equal(
        response.every((item) => item.ok),
        true,
    );
    assert.equal(controller.state.settings.targetMonitorId, 'all');
    assert.deepEqual(controller.calls, [
        ['applyLive', { monitorId: 'monitor-1', brightness: 35 }],
        ['applyLive', { monitorId: 'monitor-1', contrast: 55 }],
        ['setAutoInterval', 15],
        ['setAutoEnabled', true],
        ['setActiveScheduleProfile', 'default'],
        ['applyAutoNow'],
    ]);
});

test('PublicApiDispatcher monitor getter marks the current request target in the monitor list', async () => {
    const controller = new FakePublicApiController();
    controller.state.monitors.push({
        id: 'monitor-2',
        index: 1,
        name: 'Monitor 2',
        brightness: 40,
        contrast: 50,
    });
    const dispatcher = new PublicApiDispatcher(controller);

    const response = await dispatcher.execute([{ monitor: 'monitor-2' }, { monitor: null }]);

    assert.deepEqual(response, [
        { method: 'monitor', ok: true, result: null },
        {
            method: 'monitor',
            ok: true,
            result: [
                {
                    id: 'monitor-1',
                    index: 0,
                    name: 'Monitor 1',
                    brightness: 50,
                    contrast: 60,
                    active: false,
                },
                {
                    id: 'monitor-2',
                    index: 1,
                    name: 'Monitor 2',
                    brightness: 40,
                    contrast: 50,
                    active: true,
                },
            ],
        },
    ]);
});

test('PublicApiDispatcher monitor.target scopes following targetable methods and explicit monitorId overrides it', async () => {
    const controller = new FakePublicApiController();
    controller.state.monitors.push({
        id: 'monitor-2',
        index: 1,
        name: 'Monitor 2',
        brightness: 40,
        contrast: 50,
    });
    const dispatcher = new PublicApiDispatcher(controller);

    const response = await dispatcher.execute([
        { 'monitor.target': 'monitor-1' },
        { 'monitor.set': { brightness: 25 } },
        { 'vcp.read': { codes: [0x10] } },
        { 'monitor.target': 'monitor-2' },
        { 'monitor.set': { brightness: 35 } },
        { 'monitor.set': { monitorId: 'monitor-1', contrast: 45 } },
        { 'vcp.write': { code: 0x60, value: 0x11 } },
    ]);

    assert.equal(
        response.every((item) => item.ok),
        true,
    );
    assert.deepEqual(controller.calls, [
        ['applyLive', { monitorId: 'monitor-1', brightness: 25 }],
        ['getMonitorVcpValues', 'monitor-1', [0x10]],
        ['applyLive', { monitorId: 'monitor-2', brightness: 35 }],
        ['applyLive', { monitorId: 'monitor-1', contrast: 45 }],
        [
            'executeAdvancedVcp',
            {
                monitorId: 'monitor-2',
                action: { type: 'write', code: 0x60, value: 0x11 },
            },
        ],
    ]);
});

test('PublicApiDispatcher supports full method names without aliases for advanced operations', async () => {
    const controller = new FakePublicApiController();
    const dispatcher = new PublicApiDispatcher(controller);

    const response = await dispatcher.execute({
        'vcp.capabilities': { monitorId: 'monitor-1' },
        'vcp.read': { monitorId: 'monitor-1', codes: [0x10, 0x60] },
        'vcp.write': { monitorId: 'monitor-1', code: 0x60, value: 0x11 },
        'command.execute': { commandId: 'command-1' },
    });

    assert.deepEqual(response, [
        { method: 'vcp.capabilities', ok: true, result: controller.capabilities },
        { method: 'vcp.read', ok: true, result: controller.vcpValues },
        {
            method: 'vcp.write',
            ok: true,
            result: {
                monitorId: 'monitor-1',
                code: 0x60,
                operation: 'write',
                previous: 1,
                value: 0x11,
            },
        },
        {
            method: 'command.execute',
            ok: true,
            result: {
                monitorId: 'monitor-1',
                code: 0x60,
                operation: 'write',
                previous: 1,
                value: 0x11,
            },
        },
    ]);
});

test('PublicApiDispatcher pre-validates the complete batch before executing any command', async () => {
    const controller = new FakePublicApiController();
    const dispatcher = new PublicApiDispatcher(controller);

    assert.deepEqual(await dispatcher.execute({ brightness: 30, contrast: 999, auto: true }), [
        {
            method: 'contrast',
            ok: false,
            error: {
                code: 'INVALID_PARAMS',
                message: 'contrast 必须是 0 到 100 的有限数值',
            },
        },
    ]);
    assert.deepEqual(controller.calls, []);
});

test('PublicApiDispatcher executes ordered arrays sequentially, supports sleep and repeated methods', async () => {
    const controller = new FakePublicApiController();
    const dispatcher = new PublicApiDispatcher(controller);
    const startedAt = Date.now();

    const response = await dispatcher.execute([{ brightness: 20 }, { sleep: 20 }, { brightness: 40 }]);

    assert.equal(Date.now() - startedAt >= 15, true);
    assert.deepEqual(response, [
        { method: 'brightness', ok: true, result: null },
        { method: 'sleep', ok: true, result: null },
        { method: 'brightness', ok: true, result: null },
    ]);
    assert.deepEqual(controller.calls, [
        ['applyLive', { monitorId: 'all', brightness: 20 }],
        ['applyLive', { monitorId: 'all', brightness: 40 }],
    ]);
});

test('PublicApiDispatcher keeps completed operations and stops after the first runtime failure', async () => {
    const controller = new FakePublicApiController();
    controller.failOnCall = 'applyLive';
    const dispatcher = new PublicApiDispatcher(controller);

    const response = await dispatcher.execute({
        auto: true,
        brightness: 30,
        apply: null,
    });

    assert.deepEqual(response, [
        { method: 'auto', ok: true, result: null },
        {
            method: 'brightness',
            ok: false,
            error: {
                code: 'EXECUTION_FAILED',
                message: 'monitor offline',
            },
        },
    ]);
    assert.deepEqual(controller.calls, [['setAutoEnabled', true]]);
});

test('PublicApiDispatcher rejects malformed request shapes and unknown methods before execution', async () => {
    const controller = new FakePublicApiController();
    const dispatcher = new PublicApiDispatcher(controller);

    assert.equal((await dispatcher.execute(null))[0]?.ok, false);
    assert.equal((await dispatcher.execute({}))[0]?.ok, false);
    assert.deepEqual(await dispatcher.execute({ unknown: null }), [
        {
            method: 'unknown',
            ok: false,
            error: {
                code: 'METHOD_NOT_FOUND',
                message: '不支持的 API 方法：unknown',
            },
        },
    ]);
    assert.equal((await dispatcher.execute([{ brightness: 10, contrast: 20 }]))[0]?.ok, false);
    assert.deepEqual(controller.calls, []);
});

test('PublicApiDispatcher rejects removed application-only and low-value API methods', async () => {
    const controller = new FakePublicApiController();
    const dispatcher = new PublicApiDispatcher(controller);

    for (const method of [
        'ping',
        'system.ping',
        'refresh',
        'monitor.refresh',
        'theme',
        'app.setTheme',
        'log',
        'app.setLogEnabled',
        'auto.setTarget',
        'monitors',
        'target',
    ]) {
        assert.deepEqual(await dispatcher.execute({ [method]: null }), [
            {
                method,
                ok: false,
                error: {
                    code: 'METHOD_NOT_FOUND',
                    message: `不支持的 API 方法：${method}`,
                },
            },
        ]);
    }

    assert.deepEqual(controller.calls, []);
});

class FakePublicApiController {
    readonly state: AppState;
    readonly calls: unknown[][] = [];
    readonly capabilities: MonitorCapabilities = {
        monitorId: 'monitor-1',
        monitorName: 'Monitor 1',
        raw: '(prot(monitor)type(LCD)vcp(10 60(0f 11)))',
        vcpCodes: [
            { code: 0x10, supportedValues: null },
            { code: 0x60, supportedValues: [0x0f, 0x11] },
        ],
    };
    readonly vcpValues: MonitorVcpReadResult[] = [
        { code: 0x10, current: 50, maximum: 100 },
        { code: 0x60, current: 0x0f, maximum: 0x11 },
    ];

    failOnCall: string | undefined;

    constructor() {
        const settings = createDefaultSettings();
        settings.autoEnabled = false;
        settings.advancedVcpCommands = [
            {
                id: 'command-1',
                name: 'HDMI',
                monitorId: 'monitor-1',
                monitorName: 'Monitor 1',
                action: { type: 'write', code: 0x60, value: 0x11 },
                shortcut: null,
                closeWebViewAfter: true,
            },
        ];

        this.state = {
            settings,
            monitors: [
                {
                    id: 'monitor-1',
                    index: 0,
                    name: 'Monitor 1',
                    brightness: 50,
                    contrast: 60,
                },
            ],
            calculatedValues: { brightness: 40, contrast: 50 },
            nextRunAt: null,
            lastOperation: 'ready',
            lastError: null,
        };
    }

    getState(): AppState {
        return structuredClone(this.state);
    }

    applyLive(request: LiveApplyRequest): Promise<void> {
        return this.#record('applyLive', request);
    }

    setAutoEnabled(enabled: boolean): Promise<void> {
        this.state.settings.autoEnabled = enabled;
        return this.#record('setAutoEnabled', enabled);
    }

    setAutoInterval(intervalMinutes: IntervalMinutes | null): Promise<void> {
        if (intervalMinutes !== null) {
            this.state.settings.intervalMinutes = intervalMinutes;
        }
        return this.#record('setAutoInterval', intervalMinutes);
    }

    applyAutoNow(): Promise<void> {
        return this.#record('applyAutoNow');
    }

    setActiveScheduleProfile(profileId: string): Promise<void> {
        this.state.settings.activeScheduleProfileId = profileId;
        return this.#record('setActiveScheduleProfile', profileId);
    }

    executeAdvancedVcpCommand(commandId: string): Promise<AdvancedVcpExecutionOutcome> {
        this.#throwIfNeeded('executeAdvancedVcpCommand');
        this.calls.push(['executeAdvancedVcpCommand', commandId]);
        return Promise.resolve({
            monitorId: 'monitor-1',
            code: 0x60,
            operation: 'write',
            previous: 1,
            value: 0x11,
            closeWebViewAfter: true,
        });
    }

    getMonitorCapabilities(monitorId: string): Promise<MonitorCapabilities> {
        this.#throwIfNeeded('getMonitorCapabilities');
        this.calls.push(['getMonitorCapabilities', monitorId]);
        return Promise.resolve(this.capabilities);
    }

    getMonitorVcpValues(monitorId: string, codes: readonly number[]): Promise<MonitorVcpReadResult[]> {
        this.#throwIfNeeded('getMonitorVcpValues');
        this.calls.push(['getMonitorVcpValues', monitorId, [...codes]]);
        return Promise.resolve(this.vcpValues);
    }

    executeAdvancedVcp(request: AdvancedVcpExecuteRequest): Promise<AdvancedVcpExecutionOutcome> {
        this.#throwIfNeeded('executeAdvancedVcp');
        this.calls.push(['executeAdvancedVcp', request]);

        return Promise.resolve({
            monitorId: request.monitorId,
            code: request.action.code,
            operation: 'write',
            previous: 1,
            value: request.action.type === 'write' ? request.action.value : 2,
            closeWebViewAfter: true,
        });
    }

    #record(name: string, ...args: unknown[]): Promise<void> {
        this.#throwIfNeeded(name);
        this.calls.push([name, ...args]);
        return Promise.resolve();
    }

    #throwIfNeeded(name: string): void {
        if (this.failOnCall === name) {
            this.failOnCall = undefined;
            throw new Error('monitor offline');
        }
    }
}
