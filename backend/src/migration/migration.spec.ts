import { describe, expect, it } from 'vitest';
import { renderTableDdl } from '../metadata/render-ddl';
import { getTable, MEMBER_TABLE_KEY } from '../metadata/table-registry';
import { coerceValue } from './coercion';
import { buildMergeStatement, toMergePayload } from './merge-builder';
import { prepareChunk } from './prepare-chunk';

const memberTable = getTable(MEMBER_TABLE_KEY);
if (!memberTable) throw new Error('Member table metadata is missing');

describe('migration validation and SQL generation', () => {
  it('generates DDL for the member table using its quoted identifiers', () => {
    const sql = renderTableDdl(memberTable);
    expect(sql).toContain('CREATE TABLE "02_Temp_members_master_data"');
    expect(sql).toContain('"is_active" NUMBER(1,0) DEFAULT 1 NOT NULL');
    expect(sql).toContain('"old_id" NUMBER NOT NULL');
    expect(sql).toContain('"regiment_number" VARCHAR2(100)');
    expect(sql).toContain('"address" VARCHAR2(1000)');
    expect(sql).toContain('"province_id" VARCHAR2(255)');
    expect(sql).not.toMatch(/"(?:address|regiment_number|name|e_number|regiment_id|blood_group_id|mother_unit_id|eye_colour_id)"[^,\n]* NOT NULL/);
    expect(memberTable.columns.filter((column) => column.requiredOnInsert).map((column) => column.name)).toEqual(['old_id']);
    expect(memberTable.columns.find((column) => column.name === 'is_active')?.nullable).toBe(false);
  });

  it('generates primary and business-key constraints for lookup tables', () => {
    const provinces = getTable('provinces');
    if (!provinces) throw new Error('Provinces table metadata is missing');
    const sql = renderTableDdl(provinces);
    expect(sql).toContain('CREATE TABLE "provinces"');
    expect(sql).toContain('CONSTRAINT PK_PROVINCES PRIMARY KEY (ID)');
    expect(sql).toContain('CONSTRAINT UQ_PROVINCES_OLD_ID UNIQUE (OLD_ID)');
    expect(sql).not.toContain(',,');
  });

  it('keeps long lookup constraint names within Oracle identifier limits', () => {
    const table = getTable('divisional_secretariats');
    if (!table) throw new Error('Divisional secretariats table metadata is missing');
    const sql = renderTableDdl(table);
    const constraintNames = [...sql.matchAll(/CONSTRAINT ([A-Z0-9_]+)/g)].map((match) => match[1]);
    expect(constraintNames).toHaveLength(2);
    expect(constraintNames.every((name) => name.length <= 30)).toBe(true);
    expect(sql).toContain('PRIMARY KEY (ID)');
    expect(sql).toContain('UNIQUE (OLD_ID)');
  });

  it('coerces supported spreadsheet dates to ISO dates', () => {
    const column = memberTable.columns.find((item) => item.name === 'date_of_birth');
    if (!column) throw new Error('Date column metadata is missing');
    expect(coerceValue(column, '31/12/2000')).toEqual({ ok: true, value: '2000-12-31' });
    expect(coerceValue(column, 36526)).toEqual({ ok: true, value: '2000-01-01' });
  });

  it('imports a row with a valid old_id when date_of_birth is not a real date', () => {
    const oldId = memberTable.columns.find((column) => column.name === 'old_id');
    const birthDate = memberTable.columns.find((column) => column.name === 'date_of_birth');
    if (!oldId || !birthDate) throw new Error('Member column metadata is missing');
    const result = prepareChunk(memberTable, [oldId, birthDate], [
      { sourceRow: 2, values: { old_id: '19', date_of_birth: '0708-02-20' } },
    ]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].oldId).toBe(19);
    expect(result.rows[0].values.date_of_birth).toBeNull();
    expect(result.rows[0].invalidFields).toEqual(['date_of_birth']);
    expect(result.errors).toHaveLength(0);
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

  it('keeps mapped lookup values as supplied for staging', () => {
    const oldId = memberTable.columns.find((column) => column.name === 'old_id');
    const province = memberTable.columns.find((column) => column.name === 'province_id');
    if (!oldId || !province) throw new Error('Member lookup metadata is missing');
    const result = prepareChunk(memberTable, [oldId, province], [
      { sourceRow: 2, values: { old_id: '19', province_id: ' Central Province ' } },
      { sourceRow: 3, values: { old_id: '20', province_id: '12345' } },
      { sourceRow: 4, values: { old_id: '21', province_id: 'N/A' } },
    ]);
    expect(result.rows.map((row) => row.values.province_id)).toEqual([' Central Province ', '12345', 'N/A']);
    expect(result.errors).toHaveLength(0);
  });

  it('generates a bound JSON_TABLE merge keyed by old_id', () => {
    const oldId = memberTable.columns.find((column) => column.name === 'old_id');
    const name = memberTable.columns.find((column) => column.name === 'name');
    const province = memberTable.columns.find((column) => column.name === 'province_id');
    const birthDate = memberTable.columns.find((column) => column.name === 'date_of_birth');
    if (!oldId || !name || !province || !birthDate) throw new Error('Member column metadata is missing');
    const sql = buildMergeStatement(memberTable, [oldId, name, province, birthDate]);
    expect(sql).toContain('MERGE INTO "02_Temp_members_master_data"');
    expect(sql).toContain('ON (t."old_id" = s.c_old_id)');
    expect(sql).toContain('t."name" = CASE WHEN NVL(s.c_invalid_name, 0) = 1 THEN t."name" ELSE s.c_name END');
    expect(sql).toContain('"province_id"');
    expect(sql).toContain("c_province_id VARCHAR2(255) PATH '$.province_id'");
    expect(sql).toContain('WHEN MATCHED THEN UPDATE SET');
    expect(sql).toContain('NVL(s.c_invalid_date_of_birth, 0) = 1');
    expect(sql).toContain("c_invalid_date_of_birth NUMBER PATH '$._invalidFields.date_of_birth'");
    expect(sql).toContain('JSON_TABLE(:payload');
  });

  it('marks invalid fields in the merge payload without changing valid values', () => {
    const dateOfBirth = memberTable.columns.find((column) => column.name === 'date_of_birth');
    if (!dateOfBirth) throw new Error('Date column metadata is missing');
    const payload = JSON.parse(toMergePayload([dateOfBirth], [{
      values: { date_of_birth: null },
      invalidFields: ['date_of_birth'],
    }]));
    expect(payload).toEqual([{ date_of_birth: null, _invalidFields: { date_of_birth: 1 } }]);
  });
});
