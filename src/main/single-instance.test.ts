import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { SingleInstanceLock } from './single-instance.ts';

function createPipeName(): string {
    const id = randomUUID();
    return process.platform === 'win32'
        ? String.raw`\\.\pipe\DreamNya.DDCMonitorController.Test.${id}`
        : path.join(tmpdir(), `ddc-monitor-controller-${id}.sock`);
}

test('SingleInstanceLock keeps existing duplicate-launch open behavior', async () => {
    const pipeName = createPipeName();
    const primary = new SingleInstanceLock(pipeName);
    const secondary = new SingleInstanceLock(pipeName);
    let opened = 0;

    try {
        assert.equal(await primary.acquire(), true);
        primary.setOpenRequestHandler(() => {
            opened += 1;
        });

        assert.equal(await secondary.acquire(), false);
        await waitFor(() => opened === 1);
        assert.equal(opened, 1);
    } finally {
        await Promise.allSettled([secondary.close(), primary.close()]);
    }
});

test('SingleInstanceLock can detect an existing instance without opening its control panel', async () => {
    const pipeName = createPipeName();
    const primary = new SingleInstanceLock(pipeName);
    const secondary = new SingleInstanceLock(pipeName);
    let opened = 0;

    try {
        assert.equal(await primary.acquire(), true);
        primary.setOpenRequestHandler(() => {
            opened += 1;
        });

        assert.equal(await secondary.acquire({ notifyExistingInstance: false }), false);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
        assert.equal(opened, 0);
    } finally {
        await Promise.allSettled([secondary.close(), primary.close()]);
    }
});

test('SingleInstanceLock forwards Public API requests and returns structured responses', async () => {
    const pipeName = createPipeName();
    const primary = new SingleInstanceLock(pipeName);
    const secondary = new SingleInstanceLock(pipeName);

    try {
        assert.equal(await primary.acquire(), true);
        primary.setApiRequestHandler(async (request) => ({
            ok: true,
            result: request,
        }));

        assert.equal(await secondary.acquire({ notifyExistingInstance: false }), false);
        assert.deepEqual(await secondary.requestApi({ method: 'system.ping' }), {
            ok: true,
            result: { method: 'system.ping' },
        });
    } finally {
        await Promise.allSettled([secondary.close(), primary.close()]);
    }
});

test('SingleInstanceLock returns an API error while the primary dispatcher is not ready', async () => {
    const pipeName = createPipeName();
    const primary = new SingleInstanceLock(pipeName);
    const secondary = new SingleInstanceLock(pipeName);

    try {
        assert.equal(await primary.acquire(), true);
        assert.equal(await secondary.acquire({ notifyExistingInstance: false }), false);

        assert.deepEqual(await secondary.requestApi({ method: 'system.ping' }), {
            ok: false,
            error: {
                code: 'EXECUTION_FAILED',
                message: '主实例 Public API 尚未准备完成',
            },
        });
    } finally {
        await Promise.allSettled([secondary.close(), primary.close()]);
    }
});

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 1000;

    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error('Timed out waiting for single-instance IPC');
        }

        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
}
