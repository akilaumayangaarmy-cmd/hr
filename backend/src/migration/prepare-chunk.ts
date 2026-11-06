import { ColumnDef, TableDef } from '../metadata/types';
import { coerceValue, Scalar } from './coercion';

export interface IncomingRecord {
  sourceRow: number;
  values: Record<string, unknown>;
}

export interface NormalizedRecord {
  sourceRow: number;
  oldId: number;
  values: Record<string, Scalar>;
}

export interface RowError {
  sourceRow: number;
  oldId: string | null;
  field?: string;
  message: string;
}

export function prepareChunk(
  table: TableDef,
  columns: ColumnDef[],
  records: IncomingRecord[],
): { rows: NormalizedRecord[]; errors: RowError[] } {
  const errors: RowError[] = [];
  const normalized: NormalizedRecord[] = [];

  for (const record of records) {
    const values: Record<string, Scalar> = {};
    const rowErrors: RowError[] = [];
    for (const column of columns) {
      const parsed = coerceValue(column, record.values[column.name]);
      if (!parsed.ok) {
        rowErrors.push({
          sourceRow: record.sourceRow,
          oldId: null,
          field: column.name,
          message: parsed.message,
        });
      } else {
        values[column.name] = parsed.value;
      }
    }
    const oldValue = values[table.businessKey];
    const oldIdText = typeof oldValue === 'number' ? String(oldValue) : null;
    if (rowErrors.length > 0) {
      for (const error of rowErrors) error.oldId = oldIdText;
      errors.push(...rowErrors);
      continue;
    }
    if (typeof oldValue !== 'number') {
      errors.push({
        sourceRow: record.sourceRow,
        oldId: null,
        field: table.businessKey,
        message: 'Old ID is required',
      });
      continue;
    }
    normalized.push({ sourceRow: record.sourceRow, oldId: oldValue, values });
  }

  const counts = new Map<number, number>();
  for (const row of normalized) counts.set(row.oldId, (counts.get(row.oldId) ?? 0) + 1);
  const unique: NormalizedRecord[] = [];
  for (const row of normalized) {
    if ((counts.get(row.oldId) ?? 0) > 1) {
      errors.push({
        sourceRow: row.sourceRow,
        oldId: String(row.oldId),
        field: table.businessKey,
        message: `Duplicate old_id ${row.oldId} in this chunk`,
      });
    } else {
      unique.push(row);
    }
  }
  return { rows: unique, errors };
}

export function missingRequired(table: TableDef, values: Record<string, Scalar>): ColumnDef[] {
  return table.columns.filter((column) => column.requiredOnInsert && values[column.name] == null);
}
