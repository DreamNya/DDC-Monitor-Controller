import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createDefaultFontSizeSettings,
    isFontSizePx,
    normalizeFontSizePx,
    normalizeFontSizeSettings,
} from './font-size.ts';

test('文字大小设置使用默认文字 14px 和提示文字 11px', () => {
    assert.deepEqual(createDefaultFontSizeSettings(), {
        default: 14,
        hint: 11,
    });
});

test('文字大小设置会迁移缺失值并修正越界值', () => {
    assert.deepEqual(normalizeFontSizeSettings(undefined), {
        default: 14,
        hint: 11,
    });
    assert.deepEqual(normalizeFontSizeSettings({ default: 999, hint: 3 }), {
        default: 24,
        hint: 8,
    });
    assert.deepEqual(normalizeFontSizeSettings({ default: '18', hint: '13' }), {
        default: 18,
        hint: 13,
    });
    assert.equal(normalizeFontSizePx('default', ''), 14);
    assert.equal(normalizeFontSizePx('hint', 'invalid'), 11);
});

test('文字大小只接受对应范围内的整数像素值', () => {
    assert.equal(isFontSizePx('default', 10), true);
    assert.equal(isFontSizePx('default', 24), true);
    assert.equal(isFontSizePx('default', 9), false);
    assert.equal(isFontSizePx('default', 14.5), false);
    assert.equal(isFontSizePx('hint', 8), true);
    assert.equal(isFontSizePx('hint', 18), true);
    assert.equal(isFontSizePx('hint', 19), false);
});
