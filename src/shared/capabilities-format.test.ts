import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { formatCapabilitiesString } from './capabilities-format.ts';

describe('formatCapabilitiesString', () => {
    test('keeps simple sections compact and expands nested VCP entries', () => {
        const raw = '(prot(monitor)type(LCD)model(Test Display)vcp(10 12 60(01 03 0F 11) D6(01 04 05) FD FF)mccs_ver(2.2))';

        assert.equal(
            formatCapabilitiesString(raw),
            [
                '(',
                '  prot(monitor)',
                '  type(LCD)',
                '  model(Test Display)',
                '  vcp(',
                '    10',
                '    12',
                '    60(01 03 0F 11)',
                '    D6(01 04 05)',
                '    FD',
                '    FF',
                '  )',
                '  mccs_ver(2.2)',
                ')',
            ].join('\n'),
        );
    });

    test('normalizes whitespace without changing simple content', () => {
        assert.equal(formatCapabilitiesString('  prot( monitor )   '), 'prot(monitor)');
        assert.equal(formatCapabilitiesString('   '), '');
    });
});
