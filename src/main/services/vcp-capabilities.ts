export interface VcpCodeCapability {
    code: number;
    values: number[];
}

export interface MonitorVcpCapabilities {
    id: string;
    name: string;
    index: number;
    capabilities: string | null;
    vcpCodes: VcpCodeCapability[];
    error: string | null;
}

const CAPABILITIES_REQUEST = 0xf3;
const CAPABILITIES_REPLY = 0xe3;
const HEX_BYTE = /^[0-9a-f]{2}$/i;

/**
 * 从 MCCS capabilities string 的 vcp(...) 段解析声明的 VCP Code。
 * 非连续型 VCP Code 后的 (...) 会作为该 Code 声明的可选值保留。
 */
export function parseVcpCodes(capabilities: string): VcpCodeCapability[] {
    const section = extractSection(capabilities, 'vcp');

    if (section === null) {
        return [];
    }

    const result = new Map<number, Set<number>>();
    let offset = 0;

    while (offset < section.length) {
        offset = skipWhitespace(section, offset);
        const token = section.slice(offset, offset + 2);

        if (!HEX_BYTE.test(token)) {
            offset += 1;
            continue;
        }

        const code = Number.parseInt(token, 16);
        offset += 2;
        offset = skipWhitespace(section, offset);
        let values = result.get(code);

        if (!values) {
            values = new Set<number>();
            result.set(code, values);
        }

        if (section[offset] !== '(') {
            continue;
        }

        const nested = readBalancedParentheses(section, offset);

        if (nested === null) {
            break;
        }

        for (const valueToken of nested.content.match(/[0-9a-f]{2}/gi) ?? []) {
            values.add(Number.parseInt(valueToken, 16));
        }

        offset = nested.end;
    }

    return [...result.entries()]
        .sort(([left], [right]) => left - right)
        .map(([code, values]) => ({
            code,
            values: [...values].sort((left, right) => left - right),
        }));
}

export function formatVcpCapabilitiesReport(monitors: readonly MonitorVcpCapabilities[], now = new Date()): string {
    const lines = [
        'DDC/CI VCP Code 枚举结果',
        `生成时间：${now.toLocaleString()}`,
        `Capabilities Request：${formatHexByte(CAPABILITIES_REQUEST)}`,
        `Capabilities Reply：${formatHexByte(CAPABILITIES_REPLY)}`,
        '',
        '说明：VCP Code 来自显示器返回的 capabilities string；部分显示器可能返回不完整或不准确的信息。',
    ];

    monitors.forEach((monitor, monitorIndex) => {
        lines.push('', '============================================================');
        lines.push(`[${monitorIndex + 1}] ${monitor.name || monitor.id}`);
        lines.push(`ID：${monitor.id}`);
        lines.push(`Index：${monitor.index}`);

        if (monitor.error !== null) {
            lines.push(`错误：${monitor.error}`);
            return;
        }

        lines.push('', 'Capabilities String：');
        lines.push(monitor.capabilities ?? '');
        lines.push('', `VCP Codes（${monitor.vcpCodes.length}）：`);

        if (monitor.vcpCodes.length === 0) {
            lines.push('未从 vcp(...) 段解析到 VCP Code。');
            return;
        }

        for (const item of monitor.vcpCodes) {
            lines.push(
                item.values.length > 0
                    ? `${formatHexByte(item.code)}    Values: ${item.values.map(formatHexByte).join(' ')}`
                    : formatHexByte(item.code),
            );
        }
    });

    return `${lines.join('\r\n')}\r\n`;
}

function extractSection(source: string, name: string): string | null {
    const match = new RegExp(`${name}\\s*\\(`, 'i').exec(source);

    if (!match) {
        return null;
    }

    const open = source.indexOf('(', match.index);
    const section = readBalancedParentheses(source, open);
    return section?.content ?? null;
}

function readBalancedParentheses(
    source: string,
    open: number,
): { content: string; end: number } | null {
    if (source[open] !== '(') {
        return null;
    }

    let depth = 1;

    for (let index = open + 1; index < source.length; index += 1) {
        if (source[index] === '(') {
            depth += 1;
        } else if (source[index] === ')') {
            depth -= 1;

            if (depth === 0) {
                return {
                    content: source.slice(open + 1, index),
                    end: index + 1,
                };
            }
        }
    }

    return null;
}

function skipWhitespace(source: string, offset: number): number {
    while (offset < source.length && /\s/.test(source[offset] ?? '')) {
        offset += 1;
    }

    return offset;
}

function formatHexByte(value: number): string {
    return `0x${value.toString(16).padStart(2, '0').toUpperCase()}`;
}
