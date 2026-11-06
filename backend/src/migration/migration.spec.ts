import { describe, expect, it } from 'vitest';
import { getTable, MEMBER_TABLE_KEY } from '../metadata/table-registry';
import { coerceValue } from './coercion';
import { buildMergeStatement } from './merge-builder';
import { prepareChunk } from './prepare-chunk';

const memberTable = getTable(MEMBER_TABLE_KEY);
if (!memberTable) throw new Error('Member table metadata is missing');

describe('migration validation and SQL generation', () => {
  it('coerces supported spreadsheet dates to ISO dates', () => {
    const column = memberTable.columns.find((item) => item.name === 'date_of_birth');
    if (!column) throw new Error('Date column metadata is missing');
    expect(coerceValue(column, '31/12/2000')).toEqual({ ok: true, value: '2000-12-31' });
    expect(coerceValue(column, 36526)).toEqual({ ok: true, value: '2000-01-01' });
  });

  it('rejects duplicate old_id values within a batch', () => {
    const oldId = memberTable.columns.find((column) => column.name === 'old_id');
    if (!oldId) throw new Error('Business-key metadata is missing');
    const result = prepareChunk(memberTable, [oldId], [
      { sourceRow: 2, values: { old_id: '19' } },
      { sourceRow: 3, values: { old_id: 19 } },
    ]);
    expect(result.rows).toHaveLength(0);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].field).toBe('old_id');
  });

  it('generates a bound JSON_TABLE merge keyed by old_id', () => {
    const oldId = memberTable.columns.find((column) => column.name === 'old_id');
    const name = memberTable.columns.find((column) => column.name === 'name');
    if (!oldId || !name) throw new Error('Member column metadata is missing');
    const sql = buildMergeStatement(memberTable, [oldId, name]);
    expect(sql).toContain('MERGE INTO "02_Temp_members_master_data"');
    expect(sql).toContain('ON (t."old_id" = s.c_old_id)');
    expect(sql).toContain('WHEN MATCHED THEN UPDATE SET');
    expect(sql).toContain('JSON_TABLE(:payload');
  });
});
