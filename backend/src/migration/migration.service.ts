import { BadRequestException, Injectable } from '@nestjs/common';
import * as oracledb from 'oracledb';
import { assertLogicalName, quoteIdent } from '../metadata/identifiers';
import { getTable } from '../metadata/table-registry';
import { ColumnDef, TableDef } from '../metadata/types';
import { MAX_CHUNK_ROWS } from '../limits';
import { applyLookups, canonicalOldIdKey, classifyLookupValue, LookupDictionary } from './lookup-resolver';
import { buildMergeStatement, toMergePayload } from './merge-builder';
import { IncomingRecord, NormalizedRecord, prepareChunk } from './prepare-chunk';
import { planChunk } from './plan-chunk';
import { OracleService } from '../oracle/oracle.service';

export interface ColumnMapping {
  sourceIndex: number;
  target: string;
}

export interface MigrationInputRecord {
  sourceRow: number;
  values: unknown[];
}

export interface UpsertRequest {
  tableKey: string;
  mappings: ColumnMapping[];
  records: MigrationInputRecord[];
}

@Injectable()
export class MigrationService {
  constructor(private readonly oracle: OracleService) {}

  async upsert(input: UpsertRequest) {
    const { table, columns, records } = this.validateRequest(input);
    return this.oracle.withConnection((connection) =>
      this.oracle.withTransaction(connection, async () => {
        const prepared = prepareChunk(table, columns, records);
        const dictionaries = await this.loadLookupDictionaries(connection, columns, prepared.rows);
        const resolved = applyLookups(table, columns, prepared.rows, dictionaries);
        const validRows = resolved.rows;
        const existingOldIds = await this.findExistingIds(connection, table, validRows.map((row) => row.oldId));
        const plan = planChunk({
          table,
          mappedColumns: columns,
          rows: validRows,
          existingOldIds,
        });

        if (plan.mergeRows.length > 0) {
          const sql = buildMergeStatement(table, plan.mergeColumns);
          await connection.execute(sql, {
            payload: toMergePayload(plan.mergeColumns, plan.mergeRows),
          });
        }

        return {
          tableKey: table.key,
          received: records.length,
          inserted: plan.inserted,
          updated: plan.updated,
          unchanged: plan.unchanged,
          errors: [...prepared.errors, ...resolved.errors, ...plan.errors],
        };
      }),
    );
  }

  private validateRequest(input: UpsertRequest): {
    table: TableDef;
    columns: ColumnDef[];
    records: IncomingRecord[];
  } {
    if (!input || typeof input !== 'object') throw new BadRequestException('Request body must be an object.');
    if (typeof input.tableKey !== 'string') throw new BadRequestException('tableKey is required.');
    const table = getTable(input.tableKey);
    if (!table) throw new BadRequestException(`Unknown target table "${input.tableKey}".`);
    if (!Array.isArray(input.mappings) || input.mappings.length === 0) {
      throw new BadRequestException('At least one source-to-target mapping is required.');
    }
    if (!Array.isArray(input.records) || input.records.length === 0) {
      throw new BadRequestException('At least one record is required.');
    }
    if (input.records.length > MAX_CHUNK_ROWS) {
      throw new BadRequestException(`A request may contain at most ${MAX_CHUNK_ROWS} records.`);
    }

    const targets = new Set<string>();
    const sources = new Set<number>();
    const columns: ColumnDef[] = [];
    for (const mapping of input.mappings) {
      if (!mapping || !Number.isSafeInteger(mapping.sourceIndex) || mapping.sourceIndex < 0) {
        throw new BadRequestException('Each mapping must have a non-negative integer sourceIndex.');
      }
      if (sources.has(mapping.sourceIndex)) throw new BadRequestException('A source column may only be mapped once.');
      if (typeof mapping.target !== 'string') throw new BadRequestException('Each mapping must specify a target column.');
      const column = table.columns.find((item) => item.name === mapping.target);
      if (!column || column.generateOnInsert) {
        throw new BadRequestException(`Invalid target column "${mapping.target}".`);
      }
      assertLogicalName(column.name);
      if (targets.has(column.name)) throw new BadRequestException('A target column may only be mapped once.');
      sources.add(mapping.sourceIndex);
      targets.add(column.name);
      columns.push(column);
    }
    if (!targets.has(table.businessKey)) {
      throw new BadRequestException(`${table.businessKey} must be explicitly mapped.`);
    }

    const records: IncomingRecord[] = input.records.map((record, index) => {
      if (!record || !Number.isSafeInteger(record.sourceRow) || record.sourceRow < 1) {
        throw new BadRequestException(`Record ${index + 1} must have a positive integer sourceRow.`);
      }
      if (!Array.isArray(record.values)) {
        throw new BadRequestException(`Record ${index + 1} values must be an array.`);
      }
      const values: Record<string, unknown> = {};
      for (const mapping of input.mappings) {
        values[mapping.target] = record.values[mapping.sourceIndex];
      }
      return { sourceRow: record.sourceRow, values };
    });
    return { table, columns, records };
  }

  private async loadLookupDictionaries(
    connection: oracledb.Connection,
    columns: ColumnDef[],
    records: NormalizedRecord[],
  ): Promise<Record<string, LookupDictionary | null>> {
    const lookupColumns = new Map<string, ColumnDef[]>();
    for (const column of columns) {
      if (!column.lookup) continue;
      const grouped = lookupColumns.get(column.lookup.table) ?? [];
      grouped.push(column);
      lookupColumns.set(column.lookup.table, grouped);
    }
    const result: Record<string, LookupDictionary | null> = {};
    for (const [lookupTableKey, mappedColumns] of lookupColumns) {
      const table = getTable(lookupTableKey);
      if (!table) {
        result[lookupTableKey] = null;
        continue;
      }
      const values = records
        .flatMap((record) => mappedColumns.map((column) => record.values[column.name]))
        .filter((value): value is string | number => typeof value === 'string' || typeof value === 'number')
        .map((value) => String(value).trim())
        .filter(Boolean);
      result[lookupTableKey] = await this.lookupDictionary(connection, table, values);
    }
    return result;
  }

  private async lookupDictionary(
    connection: oracledb.Connection,
    table: TableDef,
    rawValues: string[],
  ): Promise<LookupDictionary> {
    const byOldId = new Map<string, string>();
    const byCode = new Map<string, string>();
    const oldIds = new Set<string>();
    const codes = new Set<string>();
    for (const value of rawValues) {
      const kind = classifyLookupValue(value);
      if (kind === 'old_id') {
        const key = canonicalOldIdKey(value);
        if (key) oldIds.add(key);
      } else if (kind === 'code') {
        codes.add(value.toUpperCase());
      }
    }
    const oldIdValues = [...oldIds];
    const codeValues = [...codes];
    for (let offset = 0; offset < Math.max(oldIdValues.length, codeValues.length); offset += 900) {
      const oldBatch = oldIdValues.slice(offset, offset + 900);
      const codeBatch = codeValues.slice(offset, offset + 900);
      const binds: Record<string, string | number> = {};
      const predicates: string[] = [];
      if (oldBatch.length > 0) {
        const names = oldBatch.map((value, index) => {
          const name = `old${index}`;
          binds[name] = Number(value);
          return `:${name}`;
        });
        predicates.push(`${quoteIdent(table.quoteIdentifiers, 'OLD_ID')} IN (${names.join(', ')})`);
      }
      if (codeBatch.length > 0) {
        const names = codeBatch.map((value, index) => {
          const name = `code${index}`;
          binds[name] = value;
          return `:${name}`;
        });
        predicates.push(`UPPER(${quoteIdent(table.quoteIdentifiers, 'CODE')}) IN (${names.join(', ')})`);
      }
      const sql = `SELECT ${quoteIdent(table.quoteIdentifiers, 'ID')} AS "ID", ${quoteIdent(table.quoteIdentifiers, 'OLD_ID')} AS "OLD_ID", ${quoteIdent(table.quoteIdentifiers, 'CODE')} AS "CODE" FROM ${quoteIdent(table.quoteIdentifiers, table.physicalName)} WHERE ${predicates.join(' OR ')}`;
      const query = await connection.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      const rows = (query.rows ?? []) as Array<{ ID?: unknown; OLD_ID?: unknown; CODE?: unknown }>;
      for (const row of rows) {
        const id = typeof row.ID === 'string' ? row.ID : row.ID == null ? '' : String(row.ID);
        if (id && row.OLD_ID != null) {
          const key = canonicalOldIdKey(String(row.OLD_ID));
          if (key) byOldId.set(key, id);
        }
        if (id && typeof row.CODE === 'string') {
          const key = row.CODE.toUpperCase();
          const previous = byCode.get(key);
          byCode.set(key, previous && previous !== id ? '' : id);
        }
      }
    }
    return { byOldId, byCode };
  }

  private async findExistingIds(
    connection: oracledb.Connection,
    table: TableDef,
    oldIds: number[],
  ): Promise<number[]> {
    const uniqueIds = [...new Set(oldIds)];
    if (uniqueIds.length === 0) return [];
    const binds: Record<string, number> = {};
    const placeholders = uniqueIds.map((id, index) => {
      const name = `id${index}`;
      binds[name] = id;
      return `:${name}`;
    });
    const businessColumn = table.columns.find((column) => column.name === table.businessKey);
    if (!businessColumn) throw new Error(`Table ${table.key} has no business-key metadata.`);
    const sql = `SELECT ${quoteIdent(table.quoteIdentifiers, businessColumn.physicalName)} AS "OLD_ID" FROM ${quoteIdent(table.quoteIdentifiers, table.physicalName)} WHERE ${quoteIdent(table.quoteIdentifiers, businessColumn.physicalName)} IN (${placeholders.join(', ')})`;
    const result = await connection.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    const rows = (result.rows ?? []) as Array<{ OLD_ID?: unknown }>;
    return rows.map((row) => Number(row.OLD_ID)).filter(Number.isSafeInteger);
  }
}
