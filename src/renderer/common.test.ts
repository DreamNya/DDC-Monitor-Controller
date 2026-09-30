import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitForBridge } from './common.ts';

test('native recorded shortcuts reach the recorder without resolving unrelated RPC requests', async () => {
    let receive: ((event: MessageEvent<unknown>) => void) | undefined;
    const sent: string[] = [];
    const captured: string[] = [];
    const mockWindow = {
        chrome: {
            webview: {
                postMessage: (message: string) => sent.push(message),
                addEventListener: (_type: string, handler: (event: MessageEvent<unknown>) => void) => {
                    receive = handler;
                },
            },
        },
        __monitorGlobalHotkeyCaptured: (shortcut: string) => captured.push(shortcut),
    };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: mockWindow });
    try {
        const bridge = await waitForBridge();
        const request = bridge.setGlobalHotkeyCaptureActive({ active: true });
        assert.ok(receive);
        const deliver = (data: unknown) => receive!({ data } as MessageEvent<unknown>);
        deliver('global-hotkey-captured:"Ctrl+Alt+A"');
        deliver('global-hotkey-captured:42');
        deliver({ shortcut: 'Ctrl+Alt+B' });
        assert.deepEqual(captured, ['Ctrl+Alt+A']);
        assert.equal(sent.length, 1);
        const rpc = JSON.parse(sent[0]!.slice('rpc:'.length)) as { id: number };
        deliver(`rpc-result:${JSON.stringify({ id: rpc.id, ok: true, value: null })}`);
        assert.equal(await request, null);
    } finally {
        Reflect.deleteProperty(globalThis, 'window');
    }
});
