import {
    CLI_EXIT_CODES,
    CliArgumentError,
    parseCliInvocation,
    runCliApiInvocation,
    type CliApiRuntime,
} from '../api/cli.ts';
import { executeHeadlessApiRequest } from '../api/headless-api-runner.ts';
import { sendLauncherCliResult } from '../api/launcher-result-channel.ts';
import { isPublicApiResponseSuccessful, type PublicApiResponse } from '../api/public-api.ts';
import { DesktopApplication } from './application';
import { resolveRuntimePaths } from './runtime-paths';
import { FileLogger } from './services/file-logger';
import { SingleInstanceLock } from './single-instance';

const paths = resolveRuntimePaths(import.meta.url);
process.chdir(paths.distributionRoot);

const fileLogger = new FileLogger(paths.distributionRoot);
fileLogger.install();

try {
    const invocation = parseCliInvocation(process.argv.slice(2));

    if (invocation.type === 'desktop') {
        await runDesktopStartup();
    } else {
        await runApiStartup(invocation);
    }
} catch (error) {
    if (error instanceof CliArgumentError) {
        await writeCliError(error.message, CLI_EXIT_CODES.invalidArguments);
        process.exitCode = CLI_EXIT_CODES.invalidArguments;
    } else {
        await writeCliError(`启动应用失败：${toErrorMessage(error)}`, CLI_EXIT_CODES.instanceError);
        process.exitCode = CLI_EXIT_CODES.instanceError;
    }
}

async function runDesktopStartup(): Promise<void> {
    const singleInstanceLock = new SingleInstanceLock();
    const acquired = await singleInstanceLock.acquire();

    if (!acquired) {
        return;
    }

    await startDesktopApplication(singleInstanceLock);
}

async function runApiStartup(
    invocation: Extract<ReturnType<typeof parseCliInvocation>, { type: 'api' }>,
): Promise<void> {
    const singleInstanceLock = new SingleInstanceLock();
    const runtime: CliApiRuntime = {
        acquireInstance: () => singleInstanceLock.acquire({ notifyExistingInstance: false }),
        forwardToExistingInstance: (request) => singleInstanceLock.requestApi(request),
        executeHeadless: (request) =>
            executeHeadlessApiRequest(request, {
                onLogEnabledChanged: (enabled) => fileLogger.setEnabled(enabled),
            }),
        startDesktopAndExecute: async (request) => {
            const desktopApplication = await startDesktopApplication(singleInstanceLock);
            return desktopApplication.executePublicApi(request);
        },
        releaseInstance: () => singleInstanceLock.close(),
    };

    const result = await runCliApiInvocation(invocation, runtime);

    if (result.type === 'error') {
        await writeCliError(result.message, result.exitCode);
        process.exitCode = result.exitCode;
        return;
    }

    const launcherExitCode = isPublicApiResponseSuccessful(result.response)
        ? CLI_EXIT_CODES.success
        : CLI_EXIT_CODES.apiError;
    await writeCliResponse(result.response, launcherExitCode);

    if (result.exitCode !== null) {
        process.exitCode = result.exitCode;
    }
}

async function startDesktopApplication(singleInstanceLock: SingleInstanceLock): Promise<DesktopApplication> {
    const desktopApplication = new DesktopApplication({
        paths,
        fileLogger,
        singleInstanceLock,
    });

    singleInstanceLock.setOpenRequestHandler(() => {
        desktopApplication.requestControlPanel();
    });

    await desktopApplication.start();
    return desktopApplication;
}

async function writeCliResponse(response: PublicApiResponse, exitCode: number): Promise<void> {
    const text = `${JSON.stringify(response)}\n`;

    if (await sendLauncherCliResult({ exitCode, stream: 'stdout', text })) {
        return;
    }

    process.stdout.write(text);
}

async function writeCliError(message: string, exitCode: number): Promise<void> {
    const text = `${message}\n`;

    if (await sendLauncherCliResult({ exitCode, stream: 'stderr', text })) {
        return;
    }

    process.stderr.write(text);
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
