import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    LAUNCHER_RESULT_PIPE_ENV,
    encodeLauncherCliResult,
    sendLauncherCliResult,
} from './launcher-result-channel.ts';

const RESULT_MAGIC = 0x31434d44;

test('encodeLauncherCliResult encodes exit code, stream and UTF-8 payload', () => {
    const packet = encodeLauncherCliResult({
        exitCode: 4,
        stream: 'stderr',
        text: '已有实例\n',
    });

    assert.equal(packet.readUInt32LE(0), RESULT_MAGIC);
    assert.equal(packet.readUInt32LE(4), 4);
    assert.equal(packet.readUInt32LE(8), 2);
    assert.equal(packet.readUInt32LE(12), Buffer.byteLength('已有实例\n'));
    assert.equal(packet.subarray(16).toString('utf8'), '已有实例\n');
});

test('sendLauncherCliResult returns false when no Launcher channel is configured', async () => {
    const previous = process.env[LAUNCHER_RESULT_PIPE_ENV];
    delete process.env[LAUNCHER_RESULT_PIPE_ENV];

    try {
        assert.equal(
            await sendLauncherCliResult({ exitCode: 0, stream: 'stdout', text: '{}\n' }),
            false,
        );
    } finally {
        restoreEnvironment(previous);
    }
});

test('sendLauncherCliResult writes one packet and clears the inherited environment variable', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ddcmc-launcher-result-'));
    const socketPath =
        process.platform === 'win32'
            ? String.raw`\\.\pipe\DreamNya.DDCMonitorController.Test.${process.pid}.${Date.now()}`
            : path.join(tempDirectory, 'result.sock');
    const previous = process.env[LAUNCHER_RESULT_PIPE_ENV];
    const chunks: Buffer[] = [];

    const server = net.createServer((socket) => {
        socket.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
        });
    });

    await new Promise<void>((resolvePromise, rejectPromise) => {
        server.once('error', rejectPromise);
        server.listen(socketPath, resolvePromise);
    });

    process.env[LAUNCHER_RESULT_PIPE_ENV] = socketPath;

    try {
        assert.equal(
            await sendLauncherCliResult({
                exitCode: 0,
                stream: 'stdout',
                text: '{"ok":true}\n',
            }),
            true,
        );
        assert.equal(process.env[LAUNCHER_RESULT_PIPE_ENV], undefined);

        await new Promise<void>((resolvePromise) => {
            setImmediate(resolvePromise);
        });

        const packet = Buffer.concat(chunks);
        assert.equal(packet.readUInt32LE(0), RESULT_MAGIC);
        assert.equal(packet.readUInt32LE(4), 0);
        assert.equal(packet.readUInt32LE(8), 1);
        assert.equal(packet.subarray(16).toString('utf8'), '{"ok":true}\n');
    } finally {
        await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
        restoreEnvironment(previous);
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
});

function restoreEnvironment(previous: string | undefined): void {
    if (previous === undefined) {
        delete process.env[LAUNCHER_RESULT_PIPE_ENV];
    } else {
        process.env[LAUNCHER_RESULT_PIPE_ENV] = previous;
    }
}
