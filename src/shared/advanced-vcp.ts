import type { AdvancedVcpAction } from './model.ts';

export const VCP_CODE_BRIGHTNESS = 0x10;
export const VCP_CODE_CONTRAST = 0x12;
export const VCP_CODE_INPUT_SOURCE = 0x60;
export const VCP_CODE_POWER_MODE = 0xd6;
export const MAX_ADVANCED_VCP_COMMANDS = 128;

export function validateAdvancedVcpAction(action: AdvancedVcpAction): AdvancedVcpAction {
    assertVcpCode(action.code);

    switch (action.type) {
        case 'read':
            return { type: 'read', code: action.code };

        case 'write':
            assertUint32(action.value, 'VCP Value');
            return { type: 'write', code: action.code, value: action.value };

        case 'adjust-percent':
            if (action.direction !== 'increase' && action.direction !== 'decrease') {
                throw new RangeError(`不支持的调节方向：${String(action.direction)}`);
            }
            if (!Number.isFinite(action.percent) || action.percent <= 0) {
                throw new RangeError(`调节百分比必须是大于 0 的有限数值：${String(action.percent)}`);
            }
            return {
                type: 'adjust-percent',
                code: action.code,
                direction: action.direction,
                percent: action.percent,
            };
    }
}

export function normalizeAdvancedVcpAction(value: unknown): AdvancedVcpAction | undefined {
    if (!isRecord(value) || typeof value.type !== 'string') {
        return undefined;
    }

    const code = Number(value.code);

    try {
        if (value.type === 'read') {
            return validateAdvancedVcpAction({ type: 'read', code });
        }
        if (value.type === 'write') {
            return validateAdvancedVcpAction({ type: 'write', code, value: Number(value.value) });
        }
        if (value.type === 'adjust-percent') {
            return validateAdvancedVcpAction({
                type: 'adjust-percent',
                code,
                direction: value.direction === 'decrease' ? 'decrease' : value.direction === 'increase' ? 'increase' : ('' as never),
                percent: Number(value.percent),
            });
        }
    } catch {
        return undefined;
    }

    return undefined;
}

export function assertVcpCode(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
        throw new RangeError(`VCP Code 必须位于 0x00 到 0xFF：${String(value)}`);
    }
}

export function assertUint32(value: number, name = '数值'): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
        throw new RangeError(`${name} 必须是 0 到 0xFFFFFFFF 之间的整数：${String(value)}`);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
