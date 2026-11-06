import { randomUUID } from 'crypto';
import { ColumnDef, TableDef } from '../metadata/types';
import { NormalizedRecord, RowError, missingRequired } from './prepare-chunk';

export interface ChunkPlan {
  mergeRows: NormalizedRecord[];
  mergeColumns: ColumnDef[];
  inserted: number;
  updated: number;
  unchanged: number;
  errors: RowError[];
}

export function planChunk(input: {
  table: TableDef;
  mappedColumns: ColumnDef[];
  rows: NormalizedRecord[];
  existingOldIds: number[];
  createId?: () => string;
}): ChunkPlan {
  const createId = input.createId ?? (() => randomUUID());
  const existing = new Set(input.existingOldIds);
  const updateColumns = input.mappedColumns.filter(
    (column) => column.name !== input.table.businessKey && column.name !== input.table.surrogateKey,
  );
  const errors: RowError[] = [];
  const inserts: NormalizedRecord[] = [];
  const updates: NormalizedRecord[] = [];
  let unchanged = 0;

  for (const row of input.rows) {
    if (!existing.has(row.oldId)) {
      const missing = missingRequired(input.table, row.values);
      if (missing.length > 0) {
        for (const column of missing) {
          errors.push({
            sourceRow: row.sourceRow,
            oldId: String(row.oldId),
            field: column.name,
            message: `${column.label} is required for a new row`,
          });
        }
        continue;
      }
      const values = { ...row.values };
      if (input.table.surrogateKey) {
        const surrogate = input.table.columns.find((column) => column.name === input.table.surrogateKey);
        if (surrogate && values[surrogate.name] == null) values[surrogate.name] = createId();
      }
      inserts.push({ ...row, values });
    } else if (updateColumns.length === 0) {
      unchanged += 1;
    } else {
      updates.push(row);
    }
  }

  const mergeRows = [...inserts, ...updates];
  const mergeColumns = input.mappedColumns.filter((column) => {
    if (input.table.surrogateKey && column.name === input.table.surrogateKey) {
      return mergeRows.some((row) => row.values[column.name] != null);
    }
    return true;
  });
  if (input.table.surrogateKey) {
    const surrogate = input.table.columns.find((column) => column.name === input.table.surrogateKey);
    if (
      surrogate &&
      mergeRows.some((row) => row.values[surrogate.name] != null) &&
      !mergeColumns.some((column) => column.name === surrogate.name)
    ) {
      mergeColumns.push(surrogate);
    }
  }

  return {
    mergeRows,
    mergeColumns,
    inserted: inserts.length,
    updated: updates.length,
    unchanged,
    errors,
  };
}
