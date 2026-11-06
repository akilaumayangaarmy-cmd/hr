import { BadRequestException, Injectable } from '@nestjs/common';
import * as oracledb from 'oracledb';
import { assertLogicalName, quoteIdent } from '../metadata/identifiers';
import { getTable } from '../metadata/table-registry';
import { ColumnDef, TableDef } from '../metadata/types';
import { MAX_CHUNK_ROWS } from '../limits';
import { buildMergeStatement, toMergePayload } from './merge-builder';
import { IncomingRecord, NormalizedRecord, prepareChunk } from './prepare-chunk';
import { planChunk } from './plan-chunk';
import { resolvePhysicalTable } from './physical-columns';
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
    const { table: metadataTable, columns: mappedMetadataColumns, records } = this.validateRequest(input);
    return this.oracle.withConnection((connection) =>
      this.oracle.withTransaction(connection, async () => {
        const table = metadataTable.surrogateKey
          ? await this.resolveLookupTable(connection, metadataTable, mappedMetadataColumns)
          : metadataTable;
        const columns = mappedMetadataColumns.map((column) => {
          const resolved = table.columns.find((item) => item.name === column.name);
          if (!resolved) throw new Error(`Column metadata is missing for ${column.name}`);
          return resolved;
        });
        const prepared = prepareChunk(table, columns, records);
        const existingOldIds = await this.findExistingIds(connection, table, prepared.rows.map((row) => row.oldId));
        const plan = planChunk({
          table,
          mappedColumns: columns,
          rows: prepared.rows,
          existingOldIds,
        });

        if (plan.mergeRows.length > 0) {
          const sql = buildMergeStatement(table, plan.mergeColumns);
          await connection.execute(sql, {
            payload: {
              val: toMergePayload(plan.mergeColumns, plan.mergeRows),
              type: oracledb.CLOB,
            },
          });
        }

        return {
          tableKey: table.key,
          received: records.length,
          inserted: plan.inserted,
          updated: plan.updated,
          unchanged: plan.unchanged,
          errors: [...prepared.errors, ...plan.errors],
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
    const sql = `SELECT ${quoteIdent(table.quoteIdentifiers, businessColumn.physicalName)} AS "OLD_ID" FROM ${quoteIdent(table.quoteTableName ?? table.quoteIdentifiers, table.physicalName)} WHERE ${quoteIdent(table.quoteIdentifiers, businessColumn.physicalName)} IN (${placeholders.join(', ')})`;
    const result = await connection.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    const rows = (result.rows ?? []) as Array<{ OLD_ID?: unknown }>;
    return rows.map((row) => Number(row.OLD_ID)).filter(Number.isSafeInteger);
  }

  private async resolveLookupTable(
    connection: oracledb.Connection,
    table: TableDef,
    mappedColumns: ColumnDef[],
  ): Promise<TableDef> {
    const result = await connection.execute<{ COLUMN_NAME: string }>(
      'SELECT COLUMN_NAME AS "COLUMN_NAME" FROM USER_TAB_COLUMNS WHERE TABLE_NAME = :tableName',
      { tableName: table.physicalName },
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    const availableColumns = (result.rows ?? []).map((row) => row.COLUMN_NAME);
    const requiredColumns = new Set([
      ...mappedColumns.map((column) => column.name),
      table.businessKey,
      ...(table.surrogateKey ? [table.surrogateKey] : []),
      ...table.columns
        .filter((column) => column.databaseDefault !== undefined && !mappedColumns.some((item) => item.name === column.name))
        .map((column) => column.name),
    ]);
    return resolvePhysicalTable(table, availableColumns, [...requiredColumns]);
  }
}
