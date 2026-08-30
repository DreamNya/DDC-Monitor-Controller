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

test('parseCliInvocation compiles ordered CLI shorthand commands into the same batch format', () => {
    assert.deepEqual(parseCliInvocation(['--brightness', '10', '--sleep', '1000', '--brightness', '0', '--silent']), {
        type: 'api',
        silent: true,
        request: [{ brightness: 10 }, { sleep: 1000 }, { brightness: 0 }],
    });
});

test('parseCliInvocation uses omitted shorthand values as getters and parses common value types', () => {
    assert.deepEqual(
        parseCliInvocation([
            '--brightness',
            '--contrast',
            '45',
            '--auto',
            'on',
            '--interval',
            '15',
            '--monitor',
            'monitor-1',
            '--schedule',
            '--apply',
        ]),
        {
            type: 'api',
            silent: false,
            request: [
                { brightness: null },
                { contrast: 45 },
                { auto: true },
                { interval: 15 },
                { monitor: 'monitor-1' },
                { schedule: null },
                { apply: null },
            ],
        },
    );
});

test('parseCliInvocation supports the merged monitor shorthand as getter or batch target', () => {
    assert.deepEqual(parseCliInvocation(['--state', '--monitor', '--monitor', 'monitor-1', '--apply']), {
        type: 'api',
        silent: false,
        request: [{ state: null }, { monitor: null }, { monitor: 'monitor-1' }, { apply: null }],
    });
});

test('parseCliInvocation accepts the same JSON command object or batch used by HTTP', () => {
    assert.deepEqual(parseCliInvocation(['--silent', '--api', '{"brightness":30,"auto":false}']), {
        type: 'api',
        silent: true,
        request: {
            brightness: 30,
            auto: false,
        },
    });

    assert.deepEqual(parseCliInvocation(['--api', '[{"brightness":20},{"sleep":50},{"brightness":40}]']), {
        type: 'api',
        silent: false,
        request: [{ brightness: 20 }, { sleep: 50 }, { brightness: 40 }],
    });
});

test('parseCliInvocation rejects invalid, ambiguous and mixed CLI arguments', () => {
    assert.throws(() => parseCliInvocation(['--silent']), CliArgumentError);
    assert.throws(() => parseCliInvocation(['--api']), CliArgumentError);
    assert.throws(() => parseCliInvocation(['--api', '{']), CliArgumentError);
    assert.throws(() => parseCliInvocation(['--api', '{}', '--api', '{}']), CliArgumentError);
    assert.throws(() => parseCliInvocation(['--api', '{}', '--params', '{}']), CliArgumentError);
    assert.throws(() => parseCliInvocation(['--api', '{"state":null}', '--brightness', '10']), CliArgumentError);
    assert.throws(() => parseCliInvocation(['--brightness', '10', '--api', '{"state":null}']), CliArgumentError);
    assert.throws(() => parseCliInvocation(['--sleep']), CliArgumentError);
    assert.throws(() => parseCliInvocation(['--sleep', 'abc']), CliArgumentError);
    assert.throws(() => parseCliInvocation(['--auto', 'maybe']), CliArgumentError);
    assert.throws(() => parseCliInvocation(['--monitors']), CliArgumentError);
    assert.throws(() => parseCliInvocation(['--target', 'monitor-1']), CliArgumentError);
    assert.throws(() => parseCliInvocation(['--ping']), CliArgumentError);
    assert.throws(() => parseCliInvocation(['--refresh']), CliArgumentError);
    assert.throws(() => parseCliInvocation(['--theme', 'dark']), CliArgumentError);
    assert.throws(() => parseCliInvocation(['--log', 'true']), CliArgumentError);
    assert.throws(() => parseCliInvocation(['--unknown']), CliArgumentError);
});

test('runCliApiInvocation forwards a normal CLI request to an existing instance', async () => {
    const runtime = new FakeCliRuntime(false);
    const response: PublicApiResponse = [{ method: 'state', ok: true, result: null }];
    runtime.forwardResponse = response;

    const result = await runCliApiInvocation(
        {
            type: 'api',
            request: { state: null },
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
            request: { state: null },
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
    runtime.headlessResponse = [
        {
            method: 'apply',
            ok: false,
            error: {
                code: 'EXECUTION_FAILED',
                message: 'test failure',
            },
        },
    ];

    const result = await runCliApiInvocation(
        {
            type: 'api',
            request: { apply: null },
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
                request: { state: null },
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
    const response: PublicApiResponse = [{ method: 'brightness', ok: true, result: null }];
    runtime.desktopResponse = response;

    const result = await runCliApiInvocation(
        {
            type: 'api',
            request: { brightness: 30 },
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

    forwardResponse: PublicApiResponse = [{ method: 'state', ok: true, result: null }];
    headlessResponse: PublicApiResponse = [{ method: 'state', ok: true, result: null }];
    desktopResponse: PublicApiResponse = [{ method: 'state', ok: true, result: null }];
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
