/**
 * 将 MCCS Capabilities String 按括号层级格式化，便于在调试面板中阅读
 * 不解释字段语义，只调整空白和换行
 */
export function formatCapabilitiesString(raw: string): string {
    const source = raw.trim().replace(/\s+/g, ' ');

    if (!source) {
        return '';
    }

    if (source.startsWith('(')) {
        const closingIndex = findMatchingParenthesis(source, 0);

        if (closingIndex === source.length - 1) {
            const lines = ['('];
            appendFormattedCapabilities(source.slice(1, -1), 1, lines);
            lines.push(')');
            return lines.join('\n');
        }
    }

    const lines: string[] = [];
    appendFormattedCapabilities(source, 0, lines);
    return lines.join('\n');
}

function appendFormattedCapabilities(source: string, depth: number, lines: string[]): void {
    let index = 0;
    const indent = '  '.repeat(depth);

    while (index < source.length) {
        while (source[index] === ' ') {
            index += 1;
        }

        if (index >= source.length) {
            return;
        }

        const tokenStart = index;

        while (index < source.length && source[index] !== '(' && source[index] !== ' ') {
            index += 1;
        }

        const token = source.slice(tokenStart, index);

        if (source[index] !== '(') {
            if (token) {
                lines.push(`${indent}${token}`);
            }
            continue;
        }

        const closingIndex = findMatchingParenthesis(source, index);

        if (closingIndex < 0) {
            lines.push(`${indent}${source.slice(tokenStart).trim()}`);
            return;
        }

        const content = source.slice(index + 1, closingIndex).trim();

        if (content.includes('(')) {
            lines.push(`${indent}${token}(`);
            appendFormattedCapabilities(content, depth + 1, lines);
            lines.push(`${indent})`);
        } else {
            lines.push(`${indent}${token}(${content})`);
        }

        index = closingIndex + 1;
    }
}

function findMatchingParenthesis(source: string, openingIndex: number): number {
    let depth = 0;

    for (let index = openingIndex; index < source.length; index += 1) {
        if (source[index] === '(') {
            depth += 1;
        } else if (source[index] === ')') {
            depth -= 1;

            if (depth === 0) {
                return index;
            }
        }
    }

    return -1;
}
