export function runBackground(context: string, operation: () => Promise<unknown>): void {
    void operation().catch((error) => {
        console.error(`${context}失败：`, error);
    });
}
