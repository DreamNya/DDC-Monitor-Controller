export class AppCommandQueue {
    #tail: Promise<void> = Promise.resolve();
    #closed = false;

    run<T>(operation: () => T | Promise<T>): Promise<T> {
        if (this.#closed) {
            return Promise.reject(new Error('应用正在退出，无法继续执行操作'));
        }

        const result = this.#tail.then(operation, operation);
        this.#tail = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    async close(): Promise<void> {
        this.#closed = true;
        await this.#tail;
    }
}
