import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    DEFAULT_SCHEDULE,
    calculateAutoSettings,
    formatTime,
    normalizeSchedule,
    parseTime,
} from "./schedule.ts";

describe("calculateAutoSettings", () => {
    test("首节点之前使用末节点值", () => {
        assert.deepEqual(calculateAutoSettings(at(4, 30), DEFAULT_SCHEDULE), {
            brightness: 0,
            contrast: 30,
        });
    });

    test("节点之间按原脚本线性插值并向下取整", () => {
        assert.deepEqual(calculateAutoSettings(at(8, 30), DEFAULT_SCHEDULE), {
            brightness: 20,
            contrast: 44,
        });
    });

    test("末节点之后使用末节点值", () => {
        assert.deepEqual(calculateAutoSettings(at(23, 0), DEFAULT_SCHEDULE), {
            brightness: 0,
            contrast: 30,
        });
    });
});

describe("schedule helpers", () => {
    test("时间字符串可往返转换", () => {
        assert.equal(formatTime(parseTime("08:30")), "08:30");
    });

    test("拒绝重复时间节点", () => {
        assert.throws(
            () =>
                normalizeSchedule([
                    { time: 8, brightness: 20, contrast: 40 },
                    { time: 8, brightness: 30, contrast: 50 },
                ]),
            /重复/,
        );
    });
});

function at(hours: number, minutes: number): Date {
    return new Date(2026, 0, 1, hours, minutes, 0, 0);
}
