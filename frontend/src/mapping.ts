export interface TargetColumn {
  name: string;
  label: string;
  typeLabel: string;
  requiredOnInsert: boolean;
  businessKey: boolean;
  lookupTable: string | null;
  generateOnInsert: boolean;
}

export interface TargetTable {
  key: string;
  label: string;
  description: string;
  group: string;
  columns: TargetColumn[];
}

export function normalizeHeader(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function suggestTarget(source: string, columns: TargetColumn[]): string | null {
  const normalized = normalizeHeader(source);
  if (!normalized) return null;
  let best: { name: string; score: number } | null = null;
  for (const column of columns) {
    if (column.generateOnInsert) continue;
    const name = normalizeHeader(column.name);
    const label = normalizeHeader(column.label);
    const score = Math.max(
      similarity(normalized, name),
      similarity(normalized, label),
      tokenSimilarity(normalized, name),
    );
    if (!best || score > best.score) best = { name: column.name, score };
  }
  return best && best.score >= 0.72 ? best.name : null;
}

function similarity(left: string, right: string): number {
  if (left === right) return 1;
  const width = Math.max(left.length, right.length);
  if (width === 0) return 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return 1 - previous[right.length] / width;
}

function tokenSimilarity(left: string, right: string): number {
  const leftTokens = new Set(left.split('_').filter(Boolean));
  const rightTokens = new Set(right.split('_').filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return intersection / new Set([...leftTokens, ...rightTokens]).size;
}
