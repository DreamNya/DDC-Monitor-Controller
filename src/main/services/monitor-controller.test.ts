import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DDCMonitorController, type DdcClient } from './monitor-controller.ts';
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
    test('VCP enumeration parses capabilities and continues after an individual monitor fails', async () => {
        const client = new FakeDdcClient([
            { id: 'monitor-1', name: 'Monitor 1', index: 0 },
            { id: 'monitor-2', name: 'Monitor 2', index: 1 },
        ]);
        client.capabilitiesByIndex.set(0, 'vcp(10 12 60(01 03 0F) D6(01 05))');
        client.failedCapabilitiesIndexes.add(1);
        const controller = new DDCMonitorController(client);
        const originalConsoleError = console.error;
        const errors: unknown[][] = [];
        console.error = (...args: unknown[]) => {
            errors.push(args);
        };

        try {
            await controller.getSnapshots();
            const result = controller.enumerateVcpCodes('all');

            assert.deepEqual(result[0]?.vcpCodes, [
                { code: 0x10, values: [] },
                { code: 0x12, values: [] },
                { code: 0x60, values: [0x01, 0x03, 0x0f] },
                { code: 0xd6, values: [0x01, 0x05] },
            ]);
            assert.equal(result[0]?.error, null);
            assert.equal(result[1]?.capabilities, null);
            assert.match(result[1]?.error ?? '', /Capabilities failed/);
        } finally {
            console.error = originalConsoleError;
        }

        assert.equal(errors.length, 1);
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
    writes: Array<{ index: number; code: number; value: number }> = [];
    failedCapabilitiesIndexes = new Set<number>();
    capabilitiesByIndex = new Map<number, string>();

    constructor(monitors: NativeMonitor[] = [{ id: 'monitor-1', name: 'Test Monitor', index: 0 }]) {
        this.#monitors = monitors;
    }

    refreshMonitors(): NativeMonitor[] {
        this.refreshCount += 1;
        return structuredClone(this.#monitors);
    }

    readCapabilities(index: number): string {
        if (this.failedCapabilitiesIndexes.has(index)) {
            throw new Error(`Capabilities failed for monitor index ${index}`);
        }

        return this.capabilitiesByIndex.get(index) ?? 'vcp(10 12)';
    }

    readVcpValue(_index: number, code: number): VcpValue {
        this.readCount += 1;
        const value = this.#values.get(code);

        if (!value) {
            throw new Error(`Unknown VCP code: ${code}`);
        }

        return { ...value };
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
