import { AppController } from '../main/app-controller.ts';
import type { PublicApiResponse } from './public-api.ts';
import { PublicApiDispatcher } from './public-api-dispatcher.ts';

export interface HeadlessApiRunnerOptions {
    onLogEnabledChanged?: (enabled: boolean) => void;
}

/**
 * 在不创建 NativeShell / Tray / WebView / GlobalHotkey 的情况下执行一次 Public API 请求。
 * command 初始化模式只加载配置和刷新显示器，不会在目标命令前自动应用计划值或启动 scheduler。
 */
export async function executeHeadlessApiRequest(
    request: unknown,
    options: HeadlessApiRunnerOptions = {},
): Promise<PublicApiResponse> {
    const appController = new AppController({
        ...(options.onLogEnabledChanged ? { onLogEnabledChanged: options.onLogEnabledChanged } : {}),
    });
    const dispatcher = new PublicApiDispatcher(appController);
    let response: PublicApiResponse;

    try {
        await appController.initialize({ mode: 'command' });
        response = await dispatcher.execute(request);
    } catch (error) {
        response = {
            ok: false,
            error: {
                code: 'EXECUTION_FAILED',
                message: toErrorMessage(error),
            },
        };
    }

    try {
        await appController.dispose();
    } catch (error) {
        if (response.ok) {
            return {
                ok: false,
                error: {
                    code: 'EXECUTION_FAILED',
                    message: `释放命令模式资源失败：${toErrorMessage(error)}`,
                },
            };
        }
    }

    return response;
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
