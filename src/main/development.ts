interface RendererReloadMessage {
    type: 'renderer-reload';
    mode: 'css' | 'page';
}

interface ShutdownMessage {
    type: 'shutdown';
}

type DevelopmentMessage = RendererReloadMessage | ShutdownMessage;

export interface DevelopmentHandlers {
    reloadStylesheets(): void;
    reloadPage(): void;
    shutdown(): void;
}

export function registerDevelopmentMessageHandler(handlers: DevelopmentHandlers): () => void {
    if (process.env.NODE_ENV !== 'development') {
        return () => undefined;
    }

    const listener = (message: unknown): void => {
        if (!isDevelopmentMessage(message)) {
            return;
        }

        switch (message.type) {
            case 'renderer-reload':
                if (message.mode === 'css') {
                    handlers.reloadStylesheets();
                } else {
                    handlers.reloadPage();
                }
                break;

            case 'shutdown':
                handlers.shutdown();
                break;
        }
    };

    process.on('message', listener);

    return () => {
        process.off('message', listener);
    };
}

function isDevelopmentMessage(value: unknown): value is DevelopmentMessage {
    if (typeof value !== 'object' || value === null || !('type' in value)) {
        return false;
    }

    if (value.type === 'shutdown') {
        return true;
    }

    return value.type === 'renderer-reload' && 'mode' in value && (value.mode === 'css' || value.mode === 'page');
}
