import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseVcpCapabilities } from './capabilities-parser.ts';

describe('parseVcpCapabilities', () => {
    test('parses continuous and non-continuous VCP entries with nested groups', () => {
        const raw = '(prot(monitor)type(LCD)vcp(10 12 60(01 03 0F 11) D6(01 04 05)))';

        assert.deepEqual(parseVcpCapabilities(raw), [
            { code: 0x10, supportedValues: null },
            { code: 0x12, supportedValues: null },
            { code: 0x60, supportedValues: [0x01, 0x03, 0x0f, 0x11] },
            { code: 0xd6, supportedValues: [0x01, 0x04, 0x05] },
        ]);
    });

    test('is case-insensitive and ignores unrelated sections', () => {
        const raw = '(model(AB10) cmds(01 03) VCP(10 60(0f 11)))';

        assert.deepEqual(parseVcpCapabilities(raw), [
            { code: 0x10, supportedValues: null },
            { code: 0x60, supportedValues: [0x0f, 0x11] },
        ]);
    });

    test('returns an empty list when the VCP section is absent or malformed', () => {
        assert.deepEqual(parseVcpCapabilities('(prot(monitor)type(LCD))'), []);
        assert.deepEqual(parseVcpCapabilities('(vcp(10 12'), []);
    });
});
