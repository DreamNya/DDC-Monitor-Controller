import { isPublicApiResponseSuccessful, type PublicApiResponse } from './public-api.ts';

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
 * 将公开 CLI 参数转换成与 HTTP 共用的 Public API 请求
 *
 * 完整 JSON 入口：
 *   --api <json> [--silent]
 *
 * 常用命令 shorthand：
 *   --monitor monitor-1 --brightness 10 --sleep 1000 --brightness 0
 *   --monitor --brightness --auto --silent
 *
 * shorthand 会按命令行出现顺序编译成 ordered batch
 * --api 与 shorthand 不允许混用
 * 高级命令继续通过 --api JSON 调用，避免 CLI 再维护一套复杂参数协议
 */
export function parseCliInvocation(args: readonly string[]): CliInvocation {
    if (args.length === 0) {
        return { type: 'desktop' };
    }

    let request: unknown;
    let hasApi = false;
    let silent = false;
    const shorthandCommands: Array<Record<string, unknown>> = [];

    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];

        if (argument === '--silent') {
            if (silent) {
                throw new CliArgumentError('--silent 只能指定一次');
            }
            silent = true;
            continue;
        }

        if (argument === '--api') {
            if (hasApi) {
                throw new CliArgumentError('--api 只能指定一次');
            }
            if (shorthandCommands.length > 0) {
                throw new CliArgumentError('--api 不能与 CLI shorthand 命令混用');
            }

            const value = args[index + 1];
            if (value === undefined) {
                throw new CliArgumentError('--api 后必须提供 JSON 请求');
            }

            try {
                request = JSON.parse(value) as unknown;
            } catch (error) {
                throw new CliArgumentError(`--api 不是有效 JSON：${toErrorMessage(error)}`);
            }

            hasApi = true;
            index += 1;
            continue;
        }

        if (isCliShorthandArgument(argument)) {
            if (hasApi) {
                throw new CliArgumentError('--api 不能与 CLI shorthand 命令混用');
            }

            const parsed = parseCliShorthandCommand(argument, args, index);
            shorthandCommands.push(parsed.command);
            index += parsed.consumedValues;
            continue;
        }

        throw new CliArgumentError(`未知参数：${String(argument)}`);
    }

    if (hasApi) {
        return {
            type: 'api',
            request,
            silent,
        };
    }

    if (shorthandCommands.length > 0) {
        return {
            type: 'api',
            request: shorthandCommands,
            silent,
        };
    }

    if (silent) {
        throw new CliArgumentError('--silent 必须与 --api 或 CLI shorthand 命令一起使用');
    }

    throw new CliArgumentError('使用 CLI API 时必须指定 --api <json> 或 CLI shorthand 命令');
}

interface ParsedCliShorthandCommand {
    command: Record<string, unknown>;
    consumedValues: number;
}

const CLI_SHORTHAND_ARGUMENTS = new Set([
    '--state',
    '--monitor',
    '--brightness',
    '--contrast',
    '--auto',
    '--interval',
    '--apply',
    '--schedule',
    '--sleep',
]);

function isCliShorthandArgument(argument: string | undefined): argument is string {
    return argument !== undefined && CLI_SHORTHAND_ARGUMENTS.has(argument);
}

function parseCliShorthandCommand(argument: string, args: readonly string[], index: number): ParsedCliShorthandCommand {
    switch (argument) {
        case '--state':
            return parseNoValueCommand('state', argument, args, index);
        case '--apply':
            return parseNoValueCommand('apply', argument, args, index);

        case '--brightness':
            return parseOptionalNumberCommand('brightness', argument, args, index);
        case '--contrast':
            return parseOptionalNumberCommand('contrast', argument, args, index);
        case '--interval':
            return parseOptionalNumberCommand('interval', argument, args, index);

        case '--auto':
            return parseOptionalBooleanCommand('auto', argument, args, index);
        case '--monitor':
            return parseOptionalStringCommand('monitor', args, index);
        case '--schedule':
            return parseOptionalStringCommand('schedule', args, index);
        case '--sleep': {
            const value = getRequiredCliValue(argument, args, index);
            return {
                command: { sleep: parseCliNumber(value, argument) },
                consumedValues: 1,
            };
        }

        default:
            throw new CliArgumentError(`未知 CLI shorthand：${argument}`);
    }
}

function parseNoValueCommand(
    method: string,
    argument: string,
    args: readonly string[],
    index: number,
): ParsedCliShorthandCommand {
    const value = getOptionalCliValue(args, index);
    if (value !== undefined) {
        throw new CliArgumentError(`${argument} 不接受参数`);
    }

    return {
        command: { [method]: null },
        consumedValues: 0,
    };
}

function parseOptionalNumberCommand(
    method: string,
    argument: string,
    args: readonly string[],
    index: number,
): ParsedCliShorthandCommand {
    const value = getOptionalCliValue(args, index);
    return {
        command: { [method]: value === undefined ? null : parseCliNumber(value, argument) },
        consumedValues: value === undefined ? 0 : 1,
    };
}

function parseOptionalBooleanCommand(
    method: string,
    argument: string,
    args: readonly string[],
    index: number,
): ParsedCliShorthandCommand {
    const value = getOptionalCliValue(args, index);
    return {
        command: { [method]: value === undefined ? null : parseCliBoolean(value, argument) },
        consumedValues: value === undefined ? 0 : 1,
    };
}

function parseOptionalStringCommand(method: string, args: readonly string[], index: number): ParsedCliShorthandCommand {
    const value = getOptionalCliValue(args, index);
    return {
        command: { [method]: value ?? null },
        consumedValues: value === undefined ? 0 : 1,
    };
}

function getOptionalCliValue(args: readonly string[], index: number): string | undefined {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
        return undefined;
    }
    return value;
}

function getRequiredCliValue(argument: string, args: readonly string[], index: number): string {
    const value = getOptionalCliValue(args, index);
    if (value === undefined) {
        throw new CliArgumentError(`${argument} 后必须提供参数`);
    }
    return value;
}

function parseCliNumber(value: string, argument: string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        throw new CliArgumentError(`${argument} 的参数必须是有限数值`);
    }
    return parsed;
}

function parseCliBoolean(value: string, argument: string): boolean {
    switch (value.toLowerCase()) {
        case 'true':
        case '1':
        case 'on':
            return true;
        case 'false':
        case '0':
        case 'off':
            return false;
        default:
            throw new CliArgumentError(`${argument} 的参数必须是 true/false、1/0 或 on/off`);
    }
}

/**
 * 执行 API CLI 的实例分流
 *
 * - 已有实例 + 普通模式：转发到主实例
 * - 已有实例 + --silent：显式失败，禁止启动第二套 DDC/CI 执行链
 * - 无实例 + --silent：当前进程独占命名管道并以 command 模式执行，随后释放实例锁
 * - 无实例 + 普通模式：启动桌面实例，在同一实例中执行请求并继续常驻
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
            exitCode: isPublicApiResponseSuccessful(response) ? CLI_EXIT_CODES.success : CLI_EXIT_CODES.apiError,
        };
    }

    if (invocation.silent) {
        try {
            const response = await runtime.executeHeadless(invocation.request);
            return {
                type: 'response',
                response,
                exitCode: isPublicApiResponseSuccessful(response) ? CLI_EXIT_CODES.success : CLI_EXIT_CODES.apiError,
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
