import type { VcpCapability } from '../../../shared/model.ts';

/**
 * 从 MCCS Capabilities String 的 vcp(...) 段中提取 VCP Code
 *
 * 不能用简单的 /vcp\((.*?)\)/ 正则，因为非连续型 VCP 会包含嵌套括号，
 * 例如 vcp(10 12 60(01 03 0F 11) D6(01 04 05))
 */
export function parseVcpCapabilities(raw: string): VcpCapability[] {
    const section = extractNamedSection(raw, 'vcp');

    if (section === null) {
        return [];
    }

    const result: VcpCapability[] = [];
    let index = 0;

    while (index < section.length) {
        index = skipSeparators(section, index);

        const codeMatch = /^[0-9a-f]{2}(?![0-9a-f])/i.exec(section.slice(index));

        if (!codeMatch) {
            index += 1;
            continue;
        }

        const code = Number.parseInt(codeMatch[0], 16);
        index += codeMatch[0].length;
        index = skipWhitespace(section, index);

        let supportedValues: number[] | null = null;

        if (section[index] === '(') {
            const group = extractBalancedGroup(section, index);

            if (group) {
                supportedValues = parseHexValues(group.content);
                index = group.endIndex;
            }
        }

        result.push({ code, supportedValues });
    }

    return deduplicateCapabilities(result);
}

function extractNamedSection(source: string, name: string): string | null {
    const match = new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, 'i').exec(source);

    if (!match) {
        return null;
    }

    const openIndex = match.index + match[0].lastIndexOf('(');
    return extractBalancedGroup(source, openIndex)?.content ?? null;
}

function extractBalancedGroup(source: string, openIndex: number): { content: string; endIndex: number } | null {
    if (source[openIndex] !== '(') {
        return null;
    }

    let depth = 0;

    for (let index = openIndex + 1; index < source.length; index += 1) {
        const character = source[index];

        if (character === '(') {
            depth += 1;
            continue;
        }

        if (character !== ')') {
            continue;
        }

        if (depth === 0) {
            return {
                content: source.slice(openIndex + 1, index),
                endIndex: index + 1,
            };
        }

        depth -= 1;
    }

    return null;
}

function parseHexValues(source: string): number[] {
    const values: number[] = [];
    const pattern = /(?:^|[^0-9a-f])([0-9a-f]{2})(?![0-9a-f])/gi;

    for (const match of source.matchAll(pattern)) {
        const value = match[1];

        if (value !== undefined) {
            values.push(Number.parseInt(value, 16));
        }
    }

    return [...new Set(values)];
}

function deduplicateCapabilities(capabilities: VcpCapability[]): VcpCapability[] {
    const result = new Map<number, VcpCapability>();

    for (const capability of capabilities) {
        const existing = result.get(capability.code);

        if (!existing) {
            result.set(capability.code, capability);
            continue;
        }

        if (existing.supportedValues === null && capability.supportedValues !== null) {
            result.set(capability.code, capability);
            continue;
        }

        if (existing.supportedValues !== null && capability.supportedValues !== null) {
            existing.supportedValues = [...new Set([...existing.supportedValues, ...capability.supportedValues])];
        }
    }

    return [...result.values()];
}

function skipSeparators(source: string, startIndex: number): number {
    let index = startIndex;

    while (index < source.length && /[\s,;]/.test(source[index] ?? '')) {
        index += 1;
    }

    return index;
}

function skipWhitespace(source: string, startIndex: number): number {
    let index = startIndex;

    while (index < source.length && /\s/.test(source[index] ?? '')) {
        index += 1;
    }

    return index;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
