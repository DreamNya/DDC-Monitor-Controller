import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createDefaultUiScaleSettings,
    isUiScalePercent,
    normalizeUiScalePercent,
    normalizeUiScaleSettings,
    scaleUiDimension,
    unscaleUiDimension,
} from './ui-scale.ts';

test('UI 缩放设置默认为两个面板 100%', () => {
    assert.deepEqual(createDefaultUiScaleSettings(), {
        quick: 100,
        control: 100,
    });
});

test('UI 缩放设置会迁移缺失值并修正越界或非步进值', () => {
    assert.deepEqual(normalizeUiScaleSettings(undefined), {
        quick: 100,
        control: 100,
    });
    assert.deepEqual(normalizeUiScaleSettings({ quick: 173, control: 999 }), {
        quick: 175,
        control: 200,
    });
    assert.deepEqual(normalizeUiScaleSettings({ quick: '125', control: 'invalid' }), {
        quick: 125,
        control: 100,
    });
    assert.equal(normalizeUiScalePercent(null), 100);
    assert.equal(normalizeUiScalePercent(''), 100);
});

test('UI 缩放比例只接受 75%–200% 范围内的 5% 步进', () => {
    assert.equal(isUiScalePercent(75), true);
    assert.equal(isUiScalePercent(175), true);
    assert.equal(isUiScalePercent(200), true);
    assert.equal(isUiScalePercent(74), false);
    assert.equal(isUiScalePercent(177), false);
    assert.equal(isUiScalePercent(205), false);
    assert.equal(normalizeUiScalePercent(177), 175);
});

test('窗口尺寸可在 UI 缩放尺寸和 100% 基准尺寸之间换算', () => {
    assert.equal(scaleUiDimension(760, 175), 1330);
    assert.equal(scaleUiDimension(720, 175), 1260);
    assert.equal(unscaleUiDimension(1330, 175), 760);
    assert.equal(unscaleUiDimension(1260, 175), 720);
});
