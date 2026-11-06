import { ColumnDef, TableDef } from '../metadata/types';
import { NormalizedRecord, RowError } from './prepare-chunk';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface LookupDictionary {
  byOldId: Map<string, string>;
  byCode: Map<string, string>;
}

export function classifyLookupValue(value: string): 'uuid' | 'old_id' | 'code' {
  if (UUID_RE.test(value)) return 'uuid';
  if (/^\d+$/.test(value)) return 'old_id';
  return 'code';
}

export function canonicalOldIdKey(value: string): string | null {
  if (!/^\d+$/.test(value)) return null;
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) return null;
  return String(numeric);
}

export function applyLookups(
  table: TableDef,
  columns: ColumnDef[],
  rows: NormalizedRecord[],
  dictionaries: Record<string, LookupDictionary | null>,
): { rows: NormalizedRecord[]; errors: RowError[] } {
  const lookupColumns = columns.filter((column) => column.lookup);
  if (lookupColumns.length === 0) return { rows, errors: [] };

  const errors: RowError[] = [];
  const kept: NormalizedRecord[] = [];
  for (const row of rows) {
    const values = { ...row.values };
    const rowErrors: RowError[] = [];
    for (const column of lookupColumns) {
      const current = values[column.name];
      if (current == null) continue;
      const raw = String(current).trim();
      if (!raw) {
        values[column.name] = null;
        continue;
      }
      const kind = classifyLookupValue(raw);
      if (kind === 'uuid') continue;
      const lookupTable = column.lookup?.table;
      if (!lookupTable) continue;
      const dictionary = dictionaries[lookupTable];
      if (!dictionary) {
        rowErrors.push({
          sourceRow: row.sourceRow,
          oldId: String(row.oldId),
          field: column.name,
          message: `Lookup table "${lookupTable}" is unavailable, so "${raw}" could not be resolved to an id.`,
        });
        continue;
      }
      if (kind === 'old_id') {
        const key = canonicalOldIdKey(raw);
        const resolved = key ? dictionary.byOldId.get(key) : undefined;
        if (!resolved) {
          rowErrors.push({
            sourceRow: row.sourceRow,
            oldId: String(row.oldId),
            field: column.name,
            message: `No ${lookupTable} row found with old_id ${raw}.`,
          });
        } else {
          values[column.name] = resolved;
        }
      } else {
        const resolved = dictionary.byCode.get(raw.toUpperCase());
        if (resolved === '') {
          rowErrors.push({
            sourceRow: row.sourceRow,
            oldId: String(row.oldId),
            field: column.name,
            message: `Code "${raw}" matches more than one ${lookupTable} row.`,
          });
        } else if (!resolved) {
          rowErrors.push({
            sourceRow: row.sourceRow,
            oldId: String(row.oldId),
            field: column.name,
            message: `No ${lookupTable} row found with old_id or code "${raw}".`,
          });
        } else {
          values[column.name] = resolved;
        }
      }
    }
    if (rowErrors.length > 0) errors.push(...rowErrors);
    else kept.push({ ...row, values });
  }
  return { rows: kept, errors };
}
