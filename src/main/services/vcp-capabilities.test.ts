import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatVcpCapabilitiesReport, parseVcpCodes } from './vcp-capabilities.ts';

test('parseVcpCodes extracts VCP codes and declared non-continuous values', () => {
    assert.deepEqual(
        parseVcpCodes('(prot(monitor)type(LCD)vcp(10 12 60(01 03 0F 11) D6(01 04 05))mccs_ver(2.2))'),
        [
            { code: 0x10, values: [] },
            { code: 0x12, values: [] },
            { code: 0x60, values: [0x01, 0x03, 0x0f, 0x11] },
            { code: 0xd6, values: [0x01, 0x04, 0x05] },
        ],
    );
});

test('formatVcpCapabilitiesReport includes raw capabilities and 0xF3/0xE3 protocol markers', () => {
    const report = formatVcpCapabilitiesReport(
        [
            {
                id: 'monitor-1',
                name: 'Test Monitor',
                index: 0,
                capabilities: 'vcp(10 D6(01 05))',
                vcpCodes: [
                    { code: 0x10, values: [] },
                    { code: 0xd6, values: [0x01, 0x05] },
                ],
                error: null,
            },
        ],
        new Date('2026-08-08T00:00:00.000Z'),
    );

    assert.match(report, /Capabilities Request：0xF3/);
    assert.match(report, /Capabilities Reply：0xE3/);
    assert.match(report, /vcp\(10 D6\(01 05\)\)/);
    assert.match(report, /0xD6    Values: 0x01 0x05/);
});
