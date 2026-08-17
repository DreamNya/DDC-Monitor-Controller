import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
    DDCMonitorController,
    type DdcClient,
} from './monitor-controller.ts';
import type { NativeMonitor, VcpValue } from './monitor/native-ddc-client.ts';

const VCP_BRIGHTNESS = 0x10;
const VCP_CONTRAST = 0x12;

describe('DDCMonitorController cache policy', () => {
    test('manual and live apply reuse refreshed values without extra reads', async () => {
        const client = new FakeDdcClient();
        const controller = new DDCMonitorController(client);

        await controller.getSnapshots();
        assert.equal(client.refreshCount, 1);
        assert.equal(client.readCount, 2);

        await controller.apply({
            monitorId: 'monitor-1',
            brightness: 40,
            contrast: 50,
        });
        assert.equal(client.readCount, 2);
        assert.equal(client.writes.length, 0);

        await controller.applyLive({
            monitorId: 'monitor-1',
            brightness: 45,
        });
        assert.equal(client.readCount, 2);
        assert.deepEqual(client.writes, [{ index: 0, code: VCP_BRIGHTNESS, value: 45 }]);

        await controller.dispose();
    });

    test('a low-frequency refresh detects external changes before auto-style apply', async () => {
        const client = new FakeDdcClient();
        const controller = new DDCMonitorController(client);

        await controller.getSnapshots();
        await controller.apply({
            monitorId: 'monitor-1',
            brightness: 40,
            contrast: 50,
        });
        assert.equal(client.writes.length, 0);

        client.setCurrent(VCP_BRIGHTNESS, 20);

        await controller.getSnapshots();
        await controller.apply({
            monitorId: 'monitor-1',
            brightness: 40,
            contrast: 50,
        });

        assert.equal(client.refreshCount, 2);
        assert.equal(client.readCount, 4);
        assert.deepEqual(client.writes, [{ index: 0, code: VCP_BRIGHTNESS, value: 40 }]);

        await controller.dispose();
    });

    test('apply requires the application layer to refresh topology first', async () => {
        const client = new FakeDdcClient();
        const controller = new DDCMonitorController(client);

        await assert.rejects(
            controller.apply({ monitorId: 'all', brightness: 40, contrast: 50 }),
            /未检测到支持 DDC\/CI 的物理显示器/,
        );

        assert.equal(client.refreshCount, 0);
        await controller.dispose();
    });

    test('an empty refreshed topology is not immediately refreshed again by apply', async () => {
        const client = new FakeDdcClient([]);
        const controller = new DDCMonitorController(client);

        await controller.getSnapshots();
        await assert.rejects(
            controller.apply({ monitorId: 'all', brightness: 40, contrast: 50 }),
            /未检测到支持 DDC\/CI 的物理显示器/,
        );

        assert.equal(client.refreshCount, 1);
        await controller.dispose();
    });

    test('capabilities are queried on demand for one concrete monitor', async () => {
        const client = new FakeDdcClient();
        const controller = new DDCMonitorController(client);

        await controller.getSnapshots();
        const result = controller.getCapabilities('monitor-1');

        assert.equal(client.capabilitiesCount, 1);
        assert.equal(result.monitorId, 'monitor-1');
        assert.equal(result.monitorName, 'Test Monitor');
        assert.deepEqual(result.vcpCodes, [
            { code: 0x10, supportedValues: null },
            { code: 0x60, supportedValues: [0x01, 0x03] },
        ]);

        assert.throws(() => controller.getCapabilities('all'), /需要选择一台具体显示器/);
        await controller.dispose();
    });

    test('batch VCP reads keep per-code failures without aborting the whole request', async () => {
        const client = new FakeDdcClient();
        const controller = new DDCMonitorController(client);

        await controller.getSnapshots();
        const results = controller.getVcpValues('monitor-1', [VCP_BRIGHTNESS, 0xfd, VCP_BRIGHTNESS]);

        assert.deepEqual(results[0], { code: VCP_BRIGHTNESS, current: 40, maximum: 100 });
        assert.deepEqual(results[1], {
            code: 0xfd,
            current: null,
            maximum: null,
            error: 'Unknown VCP code: 253',
        });
        assert.equal(results.length, 2);
        assert.throws(() => controller.getVcpValues('monitor-1', [0x100]), /0x00 到 0xFF/);
        await controller.dispose();
    });


    test('advanced VCP actions clamp relative percentage adjustment while always sending the boundary write', async () => {
        const client = new FakeDdcClient();
        const controller = new DDCMonitorController(client);

        await controller.getSnapshots();
        const read = controller.executeVcpAction('monitor-1', { type: 'read', code: VCP_BRIGHTNESS });
        assert.deepEqual(read, {
            monitorId: 'monitor-1',
            code: VCP_BRIGHTNESS,
            operation: 'read',
            current: 40,
            maximum: 100,
        });

        const adjusted = controller.executeVcpAction('monitor-1', {
            type: 'adjust-percent',
            code: VCP_BRIGHTNESS,
            direction: 'increase',
            percent: 15,
        });
        assert.deepEqual(adjusted, {
            monitorId: 'monitor-1',
            code: VCP_BRIGHTNESS,
            operation: 'write',
            previous: 40,
            maximum: 100,
            value: 55,
        });
        assert.deepEqual(client.writes.at(-1), { index: 0, code: VCP_BRIGHTNESS, value: 55 });

        const written = controller.executeVcpAction('monitor-1', { type: 'write', code: 0x60, value: 0x11 });
        assert.deepEqual(written, { monitorId: 'monitor-1', code: 0x60, operation: 'write', value: 0x11 });
        assert.deepEqual(client.writes.at(-1), { index: 0, code: 0x60, value: 0x11 });

        client.setCurrent(VCP_BRIGHTNESS, 4);
        const lowerBound = controller.executeVcpAction('monitor-1', {
            type: 'adjust-percent',
            code: VCP_BRIGHTNESS,
            direction: 'decrease',
            percent: 5,
        });
        assert.equal(lowerBound.value, 0);
        assert.deepEqual(client.writes.at(-1), { index: 0, code: VCP_BRIGHTNESS, value: 0 });

        const writesAtLowerBound = client.writes.length;
        const repeatedLowerBound = controller.executeVcpAction('monitor-1', {
            type: 'adjust-percent',
            code: VCP_BRIGHTNESS,
            direction: 'decrease',
            percent: 5,
        });
        assert.equal(repeatedLowerBound.value, 0);
        assert.equal(client.writes.length, writesAtLowerBound + 1);
        assert.deepEqual(client.writes.at(-1), { index: 0, code: VCP_BRIGHTNESS, value: 0 });

        client.setCurrent(VCP_BRIGHTNESS, 98);
        const upperBound = controller.executeVcpAction('monitor-1', {
            type: 'adjust-percent',
            code: VCP_BRIGHTNESS,
            direction: 'increase',
            percent: 5,
        });
        assert.equal(upperBound.value, 100);
        assert.deepEqual(client.writes.at(-1), { index: 0, code: VCP_BRIGHTNESS, value: 100 });

        const writesAtUpperBound = client.writes.length;
        const repeatedUpperBound = controller.executeVcpAction('monitor-1', {
            type: 'adjust-percent',
            code: VCP_BRIGHTNESS,
            direction: 'increase',
            percent: 5,
        });
        assert.equal(repeatedUpperBound.value, 100);
        assert.equal(client.writes.length, writesAtUpperBound + 1);
        assert.deepEqual(client.writes.at(-1), { index: 0, code: VCP_BRIGHTNESS, value: 100 });

        await controller.dispose();
    });
});

class FakeDdcClient implements DdcClient {
    readonly #monitors: NativeMonitor[];
    readonly #values = new Map<number, VcpValue>([
        [VCP_BRIGHTNESS, { current: 40, maximum: 100 }],
        [VCP_CONTRAST, { current: 50, maximum: 100 }],
    ]);

    refreshCount = 0;
    readCount = 0;
    capabilitiesCount = 0;
    writes: Array<{ index: number; code: number; value: number }> = [];

    constructor(monitors: NativeMonitor[] = [{ id: 'monitor-1', name: 'Test Monitor', index: 0 }]) {
        this.#monitors = monitors;
    }

    refreshMonitors(): NativeMonitor[] {
        this.refreshCount += 1;
        return structuredClone(this.#monitors);
    }

    readVcpValue(_index: number, code: number): VcpValue {
        this.readCount += 1;
        const value = this.#values.get(code);

        if (!value) {
            throw new Error(`Unknown VCP code: ${code}`);
        }

        return { ...value };
    }

    getCapabilities(_index: number): string {
        this.capabilitiesCount += 1;
        return '(prot(monitor)vcp(10 60(01 03)))';
    }

    writeVcpValue(index: number, code: number, value: number): void {
        this.writes.push({ index, code, value });
        const current = this.#values.get(code);
        this.#values.set(code, { current: value, maximum: current?.maximum ?? 100 });
    }

    setCurrent(code: number, current: number): void {
        const value = this.#values.get(code);
        this.#values.set(code, { current, maximum: value?.maximum ?? 100 });
    }

    dispose(): void {}
}
