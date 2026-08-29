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

test('PublicApiDispatcher exposes read-only state and list methods', async () => {
    const controller = new FakePublicApiController();
    const dispatcher = new PublicApiDispatcher(controller);

    assert.deepEqual(await dispatcher.execute({ method: 'system.ping' }), {
        ok: true,
        result: { apiVersion: 1 },
    });
    assert.deepEqual(await dispatcher.execute({ method: 'state.get' }), {
        ok: true,
        result: controller.state,
    });
    assert.deepEqual(await dispatcher.execute({ method: 'monitor.list' }), {
        ok: true,
        result: controller.state.monitors,
    });
    assert.deepEqual(await dispatcher.execute({ method: 'schedule.list' }), {
        ok: true,
        result: {
            activeProfileId: controller.state.settings.activeScheduleProfileId,
            profiles: controller.state.settings.scheduleProfiles,
        },
    });
    assert.deepEqual(await dispatcher.execute({ method: 'command.list' }), {
        ok: true,
        result: controller.state.settings.advancedVcpCommands,
    });
});

test('PublicApiDispatcher maps public commands to AppController without leaking renderer-only VCP fields', async () => {
    const controller = new FakePublicApiController();
    const dispatcher = new PublicApiDispatcher(controller);

    await assertSuccess(dispatcher.execute({ method: 'monitor.refresh' }), null);
    await assertSuccess(
        dispatcher.execute({
            method: 'monitor.set',
            params: { monitorId: 'all', brightness: 35 },
        }),
        null,
    );
    await assertSuccess(dispatcher.execute({ method: 'auto.setEnabled', params: { enabled: false } }), null);
    await assertSuccess(dispatcher.execute({ method: 'auto.setInterval', params: { intervalMinutes: 15 } }), null);
    await assertSuccess(dispatcher.execute({ method: 'auto.setTarget', params: { monitorId: 'monitor-1' } }), null);
    await assertSuccess(dispatcher.execute({ method: 'auto.applyNow' }), null);
    await assertSuccess(dispatcher.execute({ method: 'schedule.activate', params: { profileId: 'default' } }), null);
    await assertSuccess(dispatcher.execute({ method: 'app.setTheme', params: { theme: 'dark' } }), null);
    await assertSuccess(dispatcher.execute({ method: 'app.setLogEnabled', params: { enabled: true } }), null);

    assert.deepEqual(
        await dispatcher.execute({ method: 'vcp.capabilities', params: { monitorId: 'monitor-1' } }),
        {
            ok: true,
            result: controller.capabilities,
        },
    );
    assert.deepEqual(
        await dispatcher.execute({ method: 'vcp.read', params: { monitorId: 'monitor-1', codes: [0x10, 0x60] } }),
        {
            ok: true,
            result: controller.vcpValues,
        },
    );
    assert.deepEqual(
        await dispatcher.execute({
            method: 'vcp.write',
            params: { monitorId: 'monitor-1', code: 0x60, value: 0x11 },
        }),
        {
            ok: true,
            result: {
                monitorId: 'monitor-1',
                code: 0x60,
                operation: 'write',
                previous: 1,
                value: 0x11,
            },
        },
    );
    assert.deepEqual(
        await dispatcher.execute({
            method: 'vcp.adjust',
            params: { monitorId: 'monitor-1', code: 0x10, direction: 'increase', percent: 5 },
        }),
        {
            ok: true,
            result: {
                monitorId: 'monitor-1',
                code: 0x10,
                operation: 'write',
                previous: 1,
                value: 2,
            },
        },
    );
    assert.deepEqual(await dispatcher.execute({ method: 'command.execute', params: { commandId: 'command-1' } }), {
        ok: true,
        result: {
            monitorId: 'monitor-1',
            code: 0x60,
            operation: 'write',
            previous: 1,
            value: 0x11,
        },
    });

    assert.deepEqual(controller.calls, [
        ['refreshMonitors'],
        ['applyLive', { monitorId: 'all', brightness: 35 }],
        ['setAutoEnabled', false],
        ['setAutoInterval', 15],
        ['setTargetMonitor', 'monitor-1'],
        ['applyAutoNow'],
        ['setActiveScheduleProfile', 'default'],
        ['setTheme', 'dark'],
        ['setLogEnabled', true],
        ['getMonitorCapabilities', 'monitor-1'],
        ['getMonitorVcpValues', 'monitor-1', [0x10, 0x60]],
        [
            'executeAdvancedVcp',
            {
                monitorId: 'monitor-1',
                action: { type: 'write', code: 0x60, value: 0x11 },
            },
        ],
        [
            'executeAdvancedVcp',
            {
                monitorId: 'monitor-1',
                action: { type: 'adjust-percent', code: 0x10, direction: 'increase', percent: 5 },
            },
        ],
        ['executeAdvancedVcpCommand', 'command-1'],
    ]);
});

test('PublicApiDispatcher rejects malformed requests before calling AppController', async () => {
    const controller = new FakePublicApiController();
    const dispatcher = new PublicApiDispatcher(controller);

    await assertApiError(dispatcher.execute(null), 'INVALID_REQUEST');
    await assertApiError(dispatcher.execute({ method: 'unknown.method' }), 'METHOD_NOT_FOUND');
    await assertApiError(dispatcher.execute({ method: 'state.get', params: { unexpected: true } }), 'INVALID_PARAMS');
    await assertApiError(
        dispatcher.execute({ method: 'monitor.set', params: { monitorId: 'all' } }),
        'INVALID_PARAMS',
    );
    await assertApiError(
        dispatcher.execute({ method: 'monitor.set', params: { monitorId: 'all', brightness: 101 } }),
        'INVALID_PARAMS',
    );
    await assertApiError(
        dispatcher.execute({ method: 'auto.setInterval', params: { intervalMinutes: 17 } }),
        'INVALID_PARAMS',
    );
    await assertApiError(
        dispatcher.execute({ method: 'vcp.read', params: { monitorId: 'monitor-1', codes: [] } }),
        'INVALID_PARAMS',
    );
    await assertApiError(
        dispatcher.execute({ method: 'vcp.write', params: { monitorId: 'monitor-1', code: 0x100, value: 1 } }),
        'INVALID_PARAMS',
    );
    await assertApiError(
        dispatcher.execute({
            method: 'vcp.adjust',
            params: { monitorId: 'monitor-1', code: 0x10, direction: 'up', percent: 5 },
        }),
        'INVALID_PARAMS',
    );
    await assertApiError(
        dispatcher.execute({ method: 'app.setTheme', params: { theme: 'system' } }),
        'INVALID_PARAMS',
    );

    assert.deepEqual(controller.calls, []);
});

test('PublicApiDispatcher converts AppController failures into stable API errors', async () => {
    const controller = new FakePublicApiController();
    controller.nextError = new Error('monitor offline');
    const dispatcher = new PublicApiDispatcher(controller);

    assert.deepEqual(
        await dispatcher.execute({
            method: 'monitor.set',
            params: { monitorId: 'monitor-1', contrast: 50 },
        }),
        {
            ok: false,
            error: {
                code: 'EXECUTION_FAILED',
                message: 'monitor offline',
            },
        },
    );
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

    nextError: Error | undefined;

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

    refreshMonitors(): Promise<void> {
        return this.#record('refreshMonitors');
    }

    applyLive(request: LiveApplyRequest): Promise<void> {
        return this.#record('applyLive', request);
    }

    setAutoEnabled(enabled: boolean): Promise<void> {
        return this.#record('setAutoEnabled', enabled);
    }

    setAutoInterval(intervalMinutes: IntervalMinutes | null): Promise<void> {
        return this.#record('setAutoInterval', intervalMinutes);
    }

    setTargetMonitor(monitorId: string): Promise<void> {
        return this.#record('setTargetMonitor', monitorId);
    }

    applyAutoNow(): Promise<void> {
        return this.#record('applyAutoNow');
    }

    setActiveScheduleProfile(profileId: string): Promise<void> {
        return this.#record('setActiveScheduleProfile', profileId);
    }

    executeAdvancedVcpCommand(commandId: string): Promise<AdvancedVcpExecutionOutcome> {
        this.#throwIfNeeded();
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
        this.#throwIfNeeded();
        this.calls.push(['getMonitorCapabilities', monitorId]);
        return Promise.resolve(this.capabilities);
    }

    getMonitorVcpValues(monitorId: string, codes: readonly number[]): Promise<MonitorVcpReadResult[]> {
        this.#throwIfNeeded();
        this.calls.push(['getMonitorVcpValues', monitorId, [...codes]]);
        return Promise.resolve(this.vcpValues);
    }

    executeAdvancedVcp(request: AdvancedVcpExecuteRequest): Promise<AdvancedVcpExecutionOutcome> {
        this.#throwIfNeeded();
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

    setTheme(theme: AppState['settings']['theme']): Promise<void> {
        return this.#record('setTheme', theme);
    }

    setLogEnabled(enabled: boolean): Promise<void> {
        return this.#record('setLogEnabled', enabled);
    }

    #record(name: string, ...args: unknown[]): Promise<void> {
        this.#throwIfNeeded();
        this.calls.push([name, ...args]);
        return Promise.resolve();
    }

    #throwIfNeeded(): void {
        if (this.nextError) {
            const error = this.nextError;
            this.nextError = undefined;
            throw error;
        }
    }
}

async function assertSuccess<T>(responsePromise: Promise<unknown>, expected: T): Promise<void> {
    assert.deepEqual(await responsePromise, { ok: true, result: expected });
}

async function assertApiError(responsePromise: Promise<unknown>, code: string): Promise<void> {
    const response = await responsePromise;
    assert.ok(isRecord(response));
    assert.equal(response.ok, false);
    assert.ok('error' in response && typeof response.error === 'object' && response.error !== null);
    assert.equal('code' in response.error ? response.error.code : undefined, code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
