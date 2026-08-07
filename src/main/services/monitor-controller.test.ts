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
