import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    CLI_EXIT_CODES,
    CliArgumentError,
    parseCliInvocation,
    runCliApiInvocation,
    type CliApiRuntime,
} from './cli.ts';
import type { PublicApiResponse } from './public-api.ts';

test('parseCliInvocation preserves the normal no-argument desktop startup', () => {
    assert.deepEqual(parseCliInvocation([]), { type: 'desktop' });
});

test('parseCliInvocation builds a generic Public API request with optional JSON params and silent mode', () => {
    assert.deepEqual(
        parseCliInvocation([
            '--silent',
            '--api',
            'monitor.set',
            '--params',
            '{"monitorId":"all","brightness":30}',
        ]),
        {
            type: 'api',
            silent: true,
            request: {
                method: 'monitor.set',
                params: {
                    monitorId: 'all',
                    brightness: 30,
                },
            },
        },
    );

    assert.deepEqual(parseCliInvocation(['--api', 'system.ping']), {
        type: 'api',
        silent: false,
        request: {
            method: 'system.ping',
        },
    });
});

test('parseCliInvocation rejects incomplete, duplicate, and unknown CLI arguments', () => {
    assert.throws(() => parseCliInvocation(['--silent']), CliArgumentError);
    assert.throws(() => parseCliInvocation(['--params', '{}']), CliArgumentError);
    assert.throws(() => parseCliInvocation(['--api']), CliArgumentError);
    assert.throws(() => parseCliInvocation(['--api', '--silent']), CliArgumentError);
    assert.throws(() => parseCliInvocation(['--api', 'state.get', '--api', 'system.ping']), CliArgumentError);
    assert.throws(() => parseCliInvocation(['--api', 'state.get', '--params', '{']), CliArgumentError);
    assert.throws(() => parseCliInvocation(['--unknown']), CliArgumentError);
});

test('runCliApiInvocation forwards a normal CLI request to an existing instance', async () => {
    const runtime = new FakeCliRuntime(false);
    const response: PublicApiResponse = { ok: true, result: { apiVersion: 1 } };
    runtime.forwardResponse = response;

    const result = await runCliApiInvocation(
        {
            type: 'api',
            request: { method: 'system.ping' },
            silent: false,
        },
        runtime,
    );

    assert.deepEqual(result, {
        type: 'response',
        response,
        exitCode: CLI_EXIT_CODES.success,
    });
    assert.deepEqual(runtime.calls, ['acquire', 'forward']);
});

test('runCliApiInvocation rejects --silent when an existing instance is running', async () => {
    const runtime = new FakeCliRuntime(false);

    const result = await runCliApiInvocation(
        {
            type: 'api',
            request: { method: 'system.ping' },
            silent: true,
        },
        runtime,
    );

    assert.equal(result.type, 'error');
    if (result.type === 'error') {
        assert.equal(result.exitCode, CLI_EXIT_CODES.silentInstanceConflict);
        assert.match(result.message, /已在运行.*--silent/);
    }
    assert.deepEqual(runtime.calls, ['acquire']);
});

test('runCliApiInvocation executes headless and always releases the instance lock in silent mode', async () => {
    const runtime = new FakeCliRuntime(true);
    runtime.headlessResponse = {
        ok: false,
        error: {
            code: 'EXECUTION_FAILED',
            message: 'test failure',
        },
    };

    const result = await runCliApiInvocation(
        {
            type: 'api',
            request: { method: 'auto.applyNow' },
            silent: true,
        },
        runtime,
    );

    assert.deepEqual(result, {
        type: 'response',
        response: runtime.headlessResponse,
        exitCode: CLI_EXIT_CODES.apiError,
    });
    assert.deepEqual(runtime.calls, ['acquire', 'headless', 'release']);
});

test('runCliApiInvocation releases the instance lock when headless execution throws', async () => {
    const runtime = new FakeCliRuntime(true);
    runtime.headlessError = new Error('headless failed');

    await assert.rejects(
        runCliApiInvocation(
            {
                type: 'api',
                request: { method: 'state.get' },
                silent: true,
            },
            runtime,
        ),
        /headless failed/,
    );
    assert.deepEqual(runtime.calls, ['acquire', 'headless', 'release']);
});

test('runCliApiInvocation starts the desktop instance and keeps it resident for a cold non-silent CLI request', async () => {
    const runtime = new FakeCliRuntime(true);
    const response: PublicApiResponse = { ok: true, result: null };
    runtime.desktopResponse = response;

    const result = await runCliApiInvocation(
        {
            type: 'api',
            request: {
                method: 'monitor.set',
                params: {
                    monitorId: 'all',
                    brightness: 30,
                },
            },
            silent: false,
        },
        runtime,
    );

    assert.deepEqual(result, {
        type: 'response',
        response,
        exitCode: null,
    });
    assert.deepEqual(runtime.calls, ['acquire', 'desktop']);
});

class FakeCliRuntime implements CliApiRuntime {
    readonly calls: string[] = [];
    readonly #acquired: boolean;

    forwardResponse: PublicApiResponse = { ok: true, result: null };
    headlessResponse: PublicApiResponse = { ok: true, result: null };
    desktopResponse: PublicApiResponse = { ok: true, result: null };
    headlessError: Error | undefined;

    constructor(acquired: boolean) {
        this.#acquired = acquired;
    }

    async acquireInstance(): Promise<boolean> {
        this.calls.push('acquire');
        return this.#acquired;
    }

    async forwardToExistingInstance(_request: unknown): Promise<PublicApiResponse> {
        this.calls.push('forward');
        return this.forwardResponse;
    }

    async executeHeadless(_request: unknown): Promise<PublicApiResponse> {
        this.calls.push('headless');
        if (this.headlessError) {
            throw this.headlessError;
        }
        return this.headlessResponse;
    }

    async startDesktopAndExecute(_request: unknown): Promise<PublicApiResponse> {
        this.calls.push('desktop');
        return this.desktopResponse;
    }

    async releaseInstance(): Promise<void> {
        this.calls.push('release');
    }
}
