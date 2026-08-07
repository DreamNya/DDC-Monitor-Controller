import type { IntervalMinutes } from '../../shared/model';

const DEFAULT_POLL_INTERVAL_MS = 60_000;

type TimerHandle = ReturnType<typeof setTimeout>;
type TimerCallback = () => void | Promise<void>;

export interface AutoAdjustmentSchedulerOptions {
    run(): Promise<void>;
    onCycleCompleted(): void;
    now?: () => Date;
    setTimer?: (callback: TimerCallback, delay: number) => TimerHandle;
    clearTimer?: (timer: TimerHandle) => void;
    pollIntervalMs?: number;
}

/**
 * 自动调节定时器
 *
 * 每分钟检查一次最近的自动调节边界
 */
export class AutoAdjustmentScheduler {
    readonly #run: () => Promise<void>;
    readonly #onCycleCompleted: () => void;
    readonly #now: () => Date;
    readonly #setTimer: (callback: TimerCallback, delay: number) => TimerHandle;
    readonly #clearTimer: (timer: TimerHandle) => void;
    readonly #pollIntervalMs: number;

    #timer: TimerHandle | undefined;
    #intervalMinutes: IntervalMinutes | undefined;
    #lastHandledBoundaryMs: number | undefined;
    #nextRunAt: string | null = null;
    #generation = 0;
    #running = false;
    #disposed = false;

    constructor(options: AutoAdjustmentSchedulerOptions) {
        this.#run = options.run;
        this.#onCycleCompleted = options.onCycleCompleted;
        this.#now = options.now ?? (() => new Date());
        this.#setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
        this.#clearTimer = options.clearTimer ?? clearTimeout;
        this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

        if (!Number.isFinite(this.#pollIntervalMs) || this.#pollIntervalMs <= 0) {
            throw new RangeError('自动调节巡检间隔必须是大于 0 的有限数值');
        }
    }

    get nextRunAt(): string | null {
        return this.#nextRunAt;
    }

    schedule(intervalMinutes: IntervalMinutes): void {
        this.#generation += 1;
        this.#intervalMinutes = intervalMinutes;

        const now = this.#now();

        // 调用 schedule() 前，AppController 已在需要时立即应用过一次自动设置
        // 因此把当前边界标记为已处理，避免启用或切换方案后立即重复执行
        this.#lastHandledBoundaryMs = getBoundaryAtOrBefore(intervalMinutes, now).getTime();
        this.#nextRunAt = getNextBoundary(intervalMinutes, now).toISOString();
        this.#restartPolling();
    }

    stop(): void {
        this.#generation += 1;
        this.#intervalMinutes = undefined;
        this.#lastHandledBoundaryMs = undefined;
        this.#nextRunAt = null;
        this.#clearScheduledTimer();
    }

    dispose(): void {
        this.#disposed = true;
        this.stop();
    }

    #restartPolling(): void {
        this.#clearScheduledTimer();

        if (this.#disposed || this.#intervalMinutes === undefined) {
            return;
        }

        this.#scheduleNextCheck();
    }

    #scheduleNextCheck(): void {
        if (this.#disposed || this.#intervalMinutes === undefined || this.#timer !== undefined) {
            return;
        }

        const delay = getDelayUntilNextPoll(this.#now(), this.#pollIntervalMs);

        this.#timer = this.#setTimer(async () => {
            this.#timer = undefined;
            await this.#checkDueBoundary();
        }, delay);
    }

    async #checkDueBoundary(): Promise<void> {
        const intervalMinutes = this.#intervalMinutes;
        const generation = this.#generation;

        if (this.#disposed || intervalMinutes === undefined) {
            return;
        }

        if (this.#running) {
            this.#scheduleNextCheck();
            return;
        }

        const now = this.#now();
        const dueBoundaryMs = getBoundaryAtOrBefore(intervalMinutes, now).getTime();
        const lastHandledBoundaryMs = this.#lastHandledBoundaryMs;

        if (lastHandledBoundaryMs === undefined || dueBoundaryMs <= lastHandledBoundaryMs) {
            this.#nextRunAt = getNextBoundary(intervalMinutes, now).toISOString();
            this.#scheduleNextCheck();
            return;
        }

        this.#running = true;

        try {
            await this.#run();
        } catch (error) {
            // 兜底处理 AppController 错误，避免出现未处理 Promise 拒绝
            console.error('自动调节任务执行失败：', error);
        } finally {
            this.#running = false;

            const isCurrentSchedule =
                !this.#disposed && this.#intervalMinutes === intervalMinutes && this.#generation === generation;

            if (isCurrentSchedule) {
                // 无论本轮成功与否，都把执行结束时已经跨过的最新边界记为已处理
                // 这样即使单次 DDC/CI 操作耗时较长，也不会在随后几分钟连续追赶旧周期
                const completedAt = this.#now();
                const completedBoundaryMs = getBoundaryAtOrBefore(intervalMinutes, completedAt).getTime();
                this.#lastHandledBoundaryMs = Math.max(dueBoundaryMs, completedBoundaryMs);
                this.#nextRunAt = getNextBoundary(intervalMinutes, completedAt).toISOString();

                try {
                    this.#onCycleCompleted();
                } catch (error) {
                    console.error('发布自动调节状态失败：', error);
                } finally {
                    this.#scheduleNextCheck();
                }
            }
        }
    }

    #clearScheduledTimer(): void {
        if (this.#timer === undefined) {
            return;
        }

        this.#clearTimer(this.#timer);
        this.#timer = undefined;
    }
}

function getBoundaryAtOrBefore(intervalMinutes: IntervalMinutes, date: Date): Date {
    const boundary = new Date(date);
    const minute = Math.floor(date.getMinutes() / intervalMinutes) * intervalMinutes;

    boundary.setMinutes(minute, 0, 0);
    return boundary;
}

/** 计算下一次自动设置时间 */
function getNextBoundary(intervalMinutes: IntervalMinutes, date: Date): Date {
    const next = getBoundaryAtOrBefore(intervalMinutes, date);

    next.setMinutes(next.getMinutes() + intervalMinutes);
    return next;
}

/** 计算到下一轮（分钟）所需时间 */
function getDelayUntilNextPoll(date: Date, pollIntervalMs: number): number {
    const remainder = date.getTime() % pollIntervalMs;

    return pollIntervalMs - remainder;
}
