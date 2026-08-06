import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AutoAdjustmentScheduler } from './auto-adjustment-scheduler.ts';

describe('AutoAdjustmentScheduler', () => {
    test('runs once for the latest missed boundary after sleep or event-loop blocking', async () => {
        const clock = new FakeClock('2026-08-06T15:51:20+08:00');
        let runCount = 0;
        let completedCount = 0;
        const scheduler = new AutoAdjustmentScheduler({
            run: async () => {
                runCount += 1;
            },
            onCycleCompleted: () => {
                completedCount += 1;
            },
            now: clock.now,
            setTimer: clock.setTimer,
            clearTimer: clock.clearTimer,
        });

        scheduler.schedule(10);
        assert.equal(scheduler.nextRunAt, '2026-08-06T08:00:00.000Z');

        clock.set('2026-08-06T17:07:00+08:00');
        await clock.fire();

        assert.equal(runCount, 1);
        assert.equal(completedCount, 1);
        assert.equal(scheduler.nextRunAt, '2026-08-06T09:10:00.000Z');

        clock.set('2026-08-06T17:08:00+08:00');
        await clock.fire();
        assert.equal(runCount, 1);

        clock.set('2026-08-06T17:31:00+08:00');
        await clock.fire();
        assert.equal(runCount, 2);
        assert.equal(completedCount, 2);
        assert.equal(scheduler.nextRunAt, '2026-08-06T09:40:00.000Z');

        scheduler.dispose();
    });

    test('does not immediately repeat the boundary handled before schedule', async () => {
        const clock = new FakeClock('2026-08-06T15:51:20+08:00');
        let runCount = 0;
        const scheduler = new AutoAdjustmentScheduler({
            run: async () => {
                runCount += 1;
            },
            onCycleCompleted: () => undefined,
            now: clock.now,
            setTimer: clock.setTimer,
            clearTimer: clock.clearTimer,
        });

        scheduler.schedule(10);

        clock.set('2026-08-06T15:59:59+08:00');
        await clock.fire();
        assert.equal(runCount, 0);

        clock.set('2026-08-06T16:00:01+08:00');
        await clock.fire();
        assert.equal(runCount, 1);

        scheduler.dispose();
    });

    test('does not chase boundaries crossed while an adjustment is still running', async () => {
        const clock = new FakeClock('2026-08-06T15:51:20+08:00');
        let runCount = 0;
        let finishRun: (() => void) | undefined;
        const scheduler = new AutoAdjustmentScheduler({
            run: async () => {
                runCount += 1;
                await new Promise<void>((resolve) => {
                    finishRun = resolve;
                });
            },
            onCycleCompleted: () => undefined,
            now: clock.now,
            setTimer: clock.setTimer,
            clearTimer: clock.clearTimer,
        });

        scheduler.schedule(10);
        clock.set('2026-08-06T16:00:01+08:00');
        const running = clock.fire();
        await Promise.resolve();
        assert.equal(runCount, 1);

        clock.set('2026-08-06T16:21:00+08:00');
        finishRun?.();
        await running;
        assert.equal(scheduler.nextRunAt, '2026-08-06T08:30:00.000Z');

        clock.set('2026-08-06T16:22:00+08:00');
        await clock.fire();
        assert.equal(runCount, 1);

        scheduler.dispose();
    });

    test('marks a failed boundary as attempted so it is not retried every minute', async () => {
        const clock = new FakeClock('2026-08-06T15:51:20+08:00');
        let runCount = 0;
        const originalConsoleError = console.error;
        console.error = () => undefined;

        try {
            const scheduler = new AutoAdjustmentScheduler({
                run: async () => {
                    runCount += 1;
                    throw new Error('test failure');
                },
                onCycleCompleted: () => undefined,
                now: clock.now,
                setTimer: clock.setTimer,
                clearTimer: clock.clearTimer,
            });

            scheduler.schedule(10);

            clock.set('2026-08-06T16:00:01+08:00');
            await clock.fire();
            assert.equal(runCount, 1);

            clock.set('2026-08-06T16:01:01+08:00');
            await clock.fire();
            assert.equal(runCount, 1);

            scheduler.dispose();
        } finally {
            console.error = originalConsoleError;
        }
    });
});

class FakeClock {
    #date: Date;
    #callback: (() => void | Promise<void>) | undefined;

    readonly now = (): Date => new Date(this.#date);

    readonly setTimer = (callback: () => void | Promise<void>, _delay: number): ReturnType<typeof setTimeout> => {
        this.#callback = callback;
        return {} as ReturnType<typeof setTimeout>;
    };

    readonly clearTimer = (_timer: ReturnType<typeof setTimeout>): void => {
        this.#callback = undefined;
    };

    constructor(value: string) {
        this.#date = new Date(value);
    }

    set(value: string): void {
        this.#date = new Date(value);
    }

    async fire(): Promise<void> {
        const callback = this.#callback;

        if (!callback) {
            throw new Error('没有待执行的定时器');
        }

        this.#callback = undefined;
        await callback();
    }
}
