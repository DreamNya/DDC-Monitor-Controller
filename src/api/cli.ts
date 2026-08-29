import type { PublicApiResponse } from './public-api.ts';

export const CLI_EXIT_CODES = {
    success: 0,
    apiError: 1,
    invalidArguments: 2,
    instanceError: 3,
    silentInstanceConflict: 4,
} as const;

export type CliInvocation =
    | {
          type: 'desktop';
      }
    | {
          type: 'api';
          request: unknown;
          silent: boolean;
      };

export interface CliApiRuntime {
    acquireInstance(): Promise<boolean>;
    forwardToExistingInstance(request: unknown): Promise<PublicApiResponse>;
    executeHeadless(request: unknown): Promise<PublicApiResponse>;
    startDesktopAndExecute(request: unknown): Promise<PublicApiResponse>;
    releaseInstance(): Promise<void>;
}

export type CliApiRunResult =
    | {
          type: 'response';
          response: PublicApiResponse;
          /** null 表示桌面实例继续常驻，不设置当前 Node 进程的退出码 */
          exitCode: number | null;
      }
    | {
          type: 'error';
          message: string;
          exitCode: number;
      };

export class CliArgumentError extends Error {}

/**
 * 将公开 CLI 参数转换成与 HTTP 共用的 Public API 请求对象。
 *
 * 当前只提供稳定的通用入口：
 *   --api <method> [--params <json>] [--silent]
 */
export function parseCliInvocation(args: readonly string[]): CliInvocation {
    if (args.length === 0) {
        return { type: 'desktop' };
    }

    let method: string | undefined;
    let params: unknown;
    let hasParams = false;
    let silent = false;

    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];

        switch (argument) {
            case '--api': {
                if (method !== undefined) {
                    throw new CliArgumentError('--api 只能指定一次');
                }

                const value = args[index + 1];
                if (!value || value.startsWith('--')) {
                    throw new CliArgumentError('--api 后必须提供 API method');
                }

                method = value;
                index += 1;
                break;
            }

            case '--params': {
                if (hasParams) {
                    throw new CliArgumentError('--params 只能指定一次');
                }

                const value = args[index + 1];
                if (value === undefined) {
                    throw new CliArgumentError('--params 后必须提供 JSON');
                }

                try {
                    params = JSON.parse(value) as unknown;
                } catch (error) {
                    throw new CliArgumentError(`--params 不是有效 JSON：${toErrorMessage(error)}`);
                }

                hasParams = true;
                index += 1;
                break;
            }

            case '--silent':
                if (silent) {
                    throw new CliArgumentError('--silent 只能指定一次');
                }
                silent = true;
                break;

            default:
                throw new CliArgumentError(`未知参数：${String(argument)}`);
        }
    }

    if (!method) {
        if (silent) {
            throw new CliArgumentError('--silent 必须与 --api 一起使用');
        }
        throw new CliArgumentError('使用 CLI API 时必须指定 --api <method>');
    }

    const request = hasParams ? { method, params } : { method };

    return {
        type: 'api',
        request,
        silent,
    };
}

/**
 * 执行 API CLI 的实例分流。
 *
 * - 已有实例 + 普通模式：转发到主实例。
 * - 已有实例 + --silent：显式失败，禁止启动第二套 DDC/CI 执行链。
 * - 无实例 + --silent：当前进程独占命名管道并以 command 模式执行，随后释放实例锁。
 * - 无实例 + 普通模式：启动桌面实例，在同一实例中执行请求并继续常驻。
 */
export async function runCliApiInvocation(
    invocation: Extract<CliInvocation, { type: 'api' }>,
    runtime: CliApiRuntime,
): Promise<CliApiRunResult> {
    const acquired = await runtime.acquireInstance();

    if (!acquired) {
        if (invocation.silent) {
            return {
                type: 'error',
                message: 'DDC Monitor Controller 已在运行，无法使用 --silent；请移除 --silent 以转发到现有实例',
                exitCode: CLI_EXIT_CODES.silentInstanceConflict,
            };
        }

        const response = await runtime.forwardToExistingInstance(invocation.request);
        return {
            type: 'response',
            response,
            exitCode: response.ok ? CLI_EXIT_CODES.success : CLI_EXIT_CODES.apiError,
        };
    }

    if (invocation.silent) {
        try {
            const response = await runtime.executeHeadless(invocation.request);
            return {
                type: 'response',
                response,
                exitCode: response.ok ? CLI_EXIT_CODES.success : CLI_EXIT_CODES.apiError,
            };
        } finally {
            await runtime.releaseInstance();
        }
    }

    const response = await runtime.startDesktopAndExecute(invocation.request);
    return {
        type: 'response',
        response,
        exitCode: null,
    };
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
