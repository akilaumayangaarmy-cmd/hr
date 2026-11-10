import { BadRequestException, Injectable } from '@nestjs/common';
import * as oracledb from 'oracledb';
import { randomUUID } from 'crypto';
import { quoteIdent } from '../metadata/identifiers';
import { getTable, MEMBER_TABLE_KEY } from '../metadata/table-registry';
import { ColumnDef, TableDef } from '../metadata/types';
import { MAX_CHUNK_ROWS } from '../limits';
import { buildMergeStatement, PayloadRow, toMergePayload } from '../migration/merge-builder';
import { formatDateOnly, Scalar } from '../migration/coercion';
import { OracleService } from '../oracle/oracle.service';

const DESTINATION_TABLE = 'temp_members';
const DEFAULT_OLD_ID = 999999999;

interface DatabaseColumn {
  name: string;
  dataType: string;
  dataLength: number;
  nullable: boolean;
  defaultLength: number | null;
}

interface DatabaseTable {
  name: string;
  columns: Map<string, DatabaseColumn>;
}

interface LookupValue {
  key: string;
  kind: 'number' | 'name';
  text: string;
  number: number | null;
}

interface LookupState {
  table: DatabaseTable;
  idColumn: string;
  nameColumn: string;
  oldIdColumn: string;
  parentColumn?: string;
  parentLookupTable?: string;
  resolved: Map<string, string>;
  fallbackId: string | null;
}

interface LookupRequest {
  value: LookupValue;
  resolutionKey: string;
  parentId: string | null;
}

@Injectable()
export class MemberMergeService {
  constructor(private readonly oracle: OracleService) {}

  async mergeMembers() {
    const memberTable = getTable(MEMBER_TABLE_KEY);
    if (!memberTable) throw new Error(`Table metadata is missing for ${MEMBER_TABLE_KEY}`);

    return this.oracle.withConnection((connection) =>
      this.oracle.withTransaction(connection, async () => {
        const source = await this.resolveTable(connection, [memberTable.physicalName]);
        const destination = await this.resolveTable(connection, [DESTINATION_TABLE]);
        const sourceColumns = this.resolveColumns(memberTable.columns, source);
        const destinationColumns = this.resolveColumns(memberTable.columns, destination);
        const sourceOldId = sourceColumns.get(memberTable.businessKey);
        const destinationOldId = destinationColumns.get(memberTable.businessKey);
        if (!sourceOldId || !destinationOldId) {
          throw new BadRequestException('Both staging and temp_members must contain old_id.');
        }

        const columns = memberTable.columns
          .filter((column) => sourceColumns.has(column.name) && destinationColumns.has(column.name))
          .map((column) => ({ ...column, physicalName: destinationColumns.get(column.name)!.name }));
        const targetId = destination.columns.get('id');
        let surrogateKey: TableDef['surrogateKey'] = null;
        if (
          targetId &&
          ['CHAR', 'NCHAR', 'VARCHAR', 'VARCHAR2', 'NVARCHAR2'].includes(targetId.dataType.toUpperCase()) &&
          !columns.some((column) => column.name === 'id')
        ) {
          columns.push({
            name: 'id',
            physicalName: targetId.name,
            label: 'ID',
            type: 'string',
            length: Math.max(targetId.dataLength, 36),
            nullable: targetId.nullable,
            requiredOnInsert: !targetId.nullable,
            generateOnInsert: true,
          });
          surrogateKey = 'id';
        }
        if (!columns.some((column) => column.name === memberTable.businessKey)) {
          throw new BadRequestException('temp_members does not have a compatible old_id column.');
        }

        const target: TableDef = {
          ...memberTable,
          physicalName: destination.name,
          quoteIdentifiers: true,
          quoteTableName: true,
          surrogateKey,
          columns,
        };
        const mergeColumns = columns;
        const sourceColumnList = memberTable.columns.filter((column) => sourceColumns.has(column.name));
        const sourceSql = `SELECT ${sourceColumnList
          .map((column) => `${quoteIdent(true, sourceColumns.get(column.name)!.name)} AS ${quoteIdent(true, column.name)}`)
          .join(', ')} FROM ${quoteIdent(true, source.name)} ORDER BY ${quoteIdent(true, sourceOldId.name)}`;

        await this.rejectDuplicateSourceIds(connection, source.name, sourceOldId.name);

        const lookups = new Map<string, LookupState>();
        const result = await connection.execute<Record<string, unknown>>(sourceSql, {}, {
          resultSet: true,
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        });
        if (!result.resultSet) throw new Error('Oracle did not return a result set for staged members.');

        let sourceRows = 0;
        let inserted = 0;
        let updated = 0;
        let unchanged = 0;
        let lookupDefaultsCreated = 0;
        const resultSet = result.resultSet;
        try {
          while (true) {
            const rows = (await resultSet.getRows(MAX_CHUNK_ROWS)) as Array<Record<string, unknown>>;
            if (rows.length === 0) break;

            const lookupInputs = await this.resolveBatchLookups(
              connection,
              rows,
              columns.filter((column) => column.lookup),
              lookups,
            );
            lookupDefaultsCreated += lookupInputs.defaultsCreated;

            const payloadRows = rows.map((row) => {
              const values: Record<string, Scalar> = {};
              for (const column of mergeColumns) {
                if (column.name === surrogateKey) continue;
                const raw = row[column.name];
                if (column.lookup) {
                  const key = normalizeLookupValue(raw);
                  if (!key) {
                    values[column.name] = null;
                  } else {
                    const state = lookupInputs.states.get(column.lookup.table);
                    let parentId: string | null = null;
                    if (state?.parentColumn && state.parentLookupTable) {
                      const parentValue = normalizeLookupValue(row[state.parentColumn]);
                      const parentState = lookupInputs.states.get(state.parentLookupTable);
                      if (parentValue && parentState) {
                        parentId = parentState.resolved.get(parentValue.key) ?? null;
                      }
                    }
                    const resolved = state?.resolved.get(lookupResolutionKey(key, parentId));
                    if (!resolved) throw new Error(`Lookup value ${key.text} was not resolved for ${column.name}.`);
                    values[column.name] = resolved;
                  }
                } else {
                  values[column.name] = normalizeColumnValue(column, raw);
                }
              }
              if (surrogateKey) values[surrogateKey] = randomUUID();
              return { values } satisfies PayloadRow;
            });

            const oldIds = payloadRows.map((row) => {
              const value = row.values[memberTable.businessKey];
              return value == null || (typeof value === 'string' && value.trim() === '') ? Number.NaN : Number(value);
            });
            if (oldIds.some((id) => !Number.isSafeInteger(id))) {
              throw new BadRequestException('Staging contains an invalid old_id; no members were merged.');
            }
            const existingIds = await this.findExistingIds(connection, destination.name, destinationOldId.name, oldIds);
            const hasUpdates = mergeColumns.some(
              (column) => column.name !== memberTable.businessKey && column.name !== surrogateKey,
            );
            for (const oldId of oldIds) {
              if (existingIds.has(oldId)) {
                if (hasUpdates) updated += 1;
                else unchanged += 1;
              } else {
                inserted += 1;
              }
            }

            const sql = buildMergeStatement(target, mergeColumns);
            await connection.execute(sql, {
              payload: { val: toMergePayload(mergeColumns, payloadRows), type: oracledb.CLOB },
            });
            sourceRows += rows.length;
          }
        } finally {
          await resultSet.close();
        }

        return {
          sourceRows,
          inserted,
          updated,
          unchanged,
          lookupDefaultsCreated,
          mergedColumns: mergeColumns.filter((column) => column.name !== surrogateKey).map((column) => column.name),
        };
      }),
    );
  }

  private async resolveBatchLookups(
    connection: oracledb.Connection,
    rows: Array<Record<string, unknown>>,
    lookupColumns: ColumnDef[],
    states: Map<string, LookupState>,
  ): Promise<{ states: Map<string, LookupState>; defaultsCreated: number }> {
    let defaultsCreated = 0;
    for (const column of lookupColumns) {
      if (!column.lookup) continue;
      const rawValues = rows.map((row) => ({ row, value: normalizeLookupValue(row[column.name]) }));
      if (rawValues.every(({ value }) => value === null)) continue;
      const state = await this.getLookupState(connection, column.lookup.table, states);

      const requested = new Map<string, LookupRequest>();
      for (const { row, value } of rawValues) {
        if (!value) continue;
        let parentId: string | null = null;
        if (state.parentColumn && state.parentLookupTable) {
          const parentValue = normalizeLookupValue(row[state.parentColumn]);
          const parentState = states.get(state.parentLookupTable);
          if (parentValue && parentState) {
            parentId = parentState.resolved.get(parentValue.key) ?? null;
          }
          if (!parentId) {
            const fallback = await this.ensureFallback(connection, state);
            if (fallback.created) defaultsCreated += 1;
            state.fallbackId = fallback.id;
            state.resolved.set(lookupResolutionKey(value, null), fallback.id);
            continue;
          }
        }
        const key = lookupResolutionKey(value, parentId);
        if (!state.resolved.has(key)) requested.set(key, { value, resolutionKey: key, parentId });
      }

      if (requested.size === 0) continue;
      const matches = await this.findLookupMatches(connection, state, [...requested.values()]);
      for (const [key, id] of matches) state.resolved.set(key, id);

      const missing = [...requested.values()].filter((request) => !state.resolved.has(request.resolutionKey));
      if (missing.length > 0) {
        const fallback = await this.ensureFallback(connection, state);
        if (fallback.created) defaultsCreated += 1;
        state.fallbackId = fallback.id;
        for (const request of missing) state.resolved.set(request.resolutionKey, fallback.id);
      }
    }
    return { states, defaultsCreated };
  }

  private async getLookupState(
    connection: oracledb.Connection,
    lookupName: string,
    states: Map<string, LookupState>,
  ): Promise<LookupState> {
    const cached = states.get(lookupName);
    if (cached) return cached;
    const knownTable = getTable(lookupName);
    const candidateNames = [lookupName, knownTable?.physicalName, knownTable?.key];
    if (lookupName === 'bank_branches') candidateNames.push('branches');
    const table = await this.resolveTable(
      connection,
      candidateNames.filter((name): name is string => Boolean(name)),
    );
    const existing = states.get(table.name);
    if (existing) return existing;

    const idColumn = table.columns.get('id')?.name;
    const nameColumn = table.columns.get('name')?.name;
    const oldIdColumn = table.columns.get('old_id')?.name;
    if (!idColumn || !nameColumn || !oldIdColumn) {
      throw new BadRequestException(`Lookup table "${table.name}" must contain id, name, and old_id columns.`);
    }
    const parentColumn = lookupName === 'bank_branches' ? table.columns.get('bank_id')?.name : undefined;
    if (lookupName === 'bank_branches' && !parentColumn) {
      throw new BadRequestException(`Lookup table "${table.name}" must contain bank_id to resolve branches.`);
    }
    const state: LookupState = {
      table,
      idColumn,
      nameColumn,
      oldIdColumn,
      parentColumn,
      parentLookupTable: parentColumn ? 'banks' : undefined,
      resolved: new Map<string, string>(),
      fallbackId: null,
    };
    states.set(table.name, state);
    states.set(lookupName, state);
    return state;
  }

  private async findLookupMatches(
    connection: oracledb.Connection,
    state: LookupState,
    requests: LookupRequest[],
  ): Promise<Map<string, string>> {
    const payload = JSON.stringify(requests.map((request) => ({
      key: request.resolutionKey,
      kind: request.value.kind,
      text: request.value.text,
      number: request.value.number,
      parentId: request.parentId,
    })));
    const sql = `SELECT s.c_key AS "LOOKUP_KEY", l.${quoteIdent(true, state.idColumn)} AS "ID"
FROM JSON_TABLE(:payload, '$[*]'
  COLUMNS (
    c_key VARCHAR2(4000) PATH '$.key',
    c_kind VARCHAR2(10) PATH '$.kind',
    c_text VARCHAR2(4000) PATH '$.text',
    c_number NUMBER PATH '$.number',
    c_parent_id VARCHAR2(36) PATH '$.parentId'
  )
) s
JOIN ${quoteIdent(true, state.table.name)} l
  ON (s.c_kind = 'number' AND l.${quoteIdent(true, state.oldIdColumn)} = s.c_number)
  OR (s.c_kind = 'name' AND UPPER(TRIM(l.${quoteIdent(true, state.nameColumn)})) = UPPER(TRIM(s.c_text)))
${state.parentColumn ? `WHERE l.${quoteIdent(true, state.parentColumn)} = s.c_parent_id` : ''}`;
    const result = await connection.execute<Record<string, unknown>>(
      sql,
      { payload: { val: payload, type: oracledb.CLOB } },
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    const matches = new Map<string, string>();
    for (const row of (result.rows ?? []) as Array<{ LOOKUP_KEY?: unknown; ID?: unknown }>) {
      const key = String(row.LOOKUP_KEY);
      const id = String(row.ID);
      const previous = matches.get(key);
      if (previous && previous !== id) {
        throw new BadRequestException(`Lookup value "${key.split('|')[0].slice(2)}" is ambiguous in "${state.table.name}".`);
      }
      matches.set(key, id);
    }
    return matches;
  }

  private async ensureFallback(
    connection: oracledb.Connection,
    state: LookupState,
  ): Promise<{ id: string; created: boolean }> {
    if (state.fallbackId) return { id: state.fallbackId, created: false };
    const fallbackName = `Default_${state.table.name}`;
    const result = await connection.execute<Record<string, unknown>>(
      `SELECT ${quoteIdent(true, state.idColumn)} AS "ID", ${quoteIdent(true, state.nameColumn)} AS "NAME"
FROM ${quoteIdent(true, state.table.name)}
WHERE ${quoteIdent(true, state.oldIdColumn)} = :oldId`,
      { oldId: DEFAULT_OLD_ID },
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    const rows = (result.rows ?? []) as Array<{ ID?: unknown; NAME?: unknown }>;
    if (rows.length > 1) throw new BadRequestException(`Lookup table "${state.table.name}" has duplicate fallback old_id values.`);
    if (rows.length === 1) {
      const id = String(rows[0].ID);
      state.fallbackId = id;
      return { id, created: false };
    }

    const codeColumn = state.table.columns.get('code')?.name;
    if (!codeColumn) throw new BadRequestException(`Lookup table "${state.table.name}" must contain a code column for its fallback.`);
    const id = randomUUID();
    const requiredColumns = [...state.table.columns.values()].filter(
      (column) =>
        !column.nullable &&
        column.defaultLength == null &&
        ![state.idColumn, state.nameColumn, codeColumn, state.oldIdColumn].includes(column.name),
    );
    const binds: Record<string, string | number | Date> = {
      id,
      name: fallbackName,
      code: 'DTN',
      oldId: DEFAULT_OLD_ID,
    };
    const insertColumns = [state.idColumn, state.nameColumn, codeColumn, state.oldIdColumn];
    const insertValues = [':id', ':name', ':code', ':oldId'];
    for (const [index, column] of requiredColumns.entries()) {
      const bindName = `required${index}`;
      const type = column.dataType.toUpperCase();
      if (type === 'NUMBER' || type === 'FLOAT' || type.startsWith('BINARY_')) {
        binds[bindName] = 0;
      } else if (type === 'DATE' || type.startsWith('TIMESTAMP')) {
        binds[bindName] = new Date();
      } else if (/^(CHAR|NCHAR|VARCHAR|VARCHAR2|NVARCHAR2|CLOB|NCLOB)$/.test(type)) {
        binds[bindName] = fallbackName;
      } else {
        throw new BadRequestException(
          `Cannot create a fallback record in "${state.table.name}": required column "${column.name}" has unsupported type ${type}.`,
        );
      }
      insertColumns.push(column.name);
      insertValues.push(`:${bindName}`);
    }
    await connection.execute(
      `INSERT INTO ${quoteIdent(true, state.table.name)} (
  ${insertColumns.map((column) => quoteIdent(true, column)).join(',\n  ')}
) VALUES (${insertValues.join(', ')})`,
      binds,
    );
    state.fallbackId = id;
    return { id, created: true };
  }

  private async resolveTable(connection: oracledb.Connection, candidates: string[]): Promise<DatabaseTable> {
    let tableName: string | undefined;
    for (const candidate of [...new Set(candidates)]) {
      if (!/^[A-Za-z0-9_]+$/.test(candidate)) throw new Error(`Unsafe Oracle table name: ${candidate}`);
      const result = await connection.execute<{ TABLE_NAME: string }>(
        `SELECT TABLE_NAME AS "TABLE_NAME" FROM USER_TABLES
WHERE UPPER(TABLE_NAME) = UPPER(:tableName)
ORDER BY CASE WHEN TABLE_NAME = :tableName THEN 0 ELSE 1 END
FETCH FIRST 1 ROWS ONLY`,
        { tableName: candidate },
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      );
      const found = result.rows?.[0]?.TABLE_NAME;
      if (found) {
        tableName = found;
        break;
      }
    }
    if (!tableName) throw new BadRequestException(`Oracle table "${candidates[0]}" was not found in the current schema.`);

    const result = await connection.execute<{
      name: string;
      dataType: string;
      dataLength: number;
      nullable: string;
      defaultLength: number | null;
    }>(
      `SELECT COLUMN_NAME AS "name", DATA_TYPE AS "dataType", DATA_LENGTH AS "dataLength", NULLABLE AS "nullable",
  DEFAULT_LENGTH AS "defaultLength"
FROM USER_TAB_COLUMNS WHERE TABLE_NAME = :tableName`,
      { tableName },
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    const columns = new Map<string, DatabaseColumn>();
    for (const column of result.rows ?? []) {
      columns.set(column.name.toLowerCase(), {
        name: column.name,
        dataType: column.dataType,
        dataLength: column.dataLength,
        nullable: column.nullable === 'Y',
        defaultLength: column.defaultLength,
      });
    }
    return { name: tableName, columns };
  }

  private resolveColumns(columns: ColumnDef[], table: DatabaseTable): Map<string, DatabaseColumn> {
    const resolved = new Map<string, DatabaseColumn>();
    for (const column of columns) {
      const actual = table.columns.get(column.name.toLowerCase());
      if (actual) resolved.set(column.name, actual);
    }
    return resolved;
  }

  private async rejectDuplicateSourceIds(
    connection: oracledb.Connection,
    tableName: string,
    oldIdColumn: string,
  ): Promise<void> {
    const result = await connection.execute<Record<string, unknown>>(
      `SELECT ${quoteIdent(true, oldIdColumn)} AS "OLD_ID", COUNT(*) AS "ROW_COUNT"
FROM ${quoteIdent(true, tableName)}
GROUP BY ${quoteIdent(true, oldIdColumn)}
HAVING COUNT(*) > 1
FETCH FIRST 1 ROWS ONLY`,
      {},
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    const duplicate = result.rows?.[0] as { OLD_ID?: unknown } | undefined;
    if (duplicate) {
      throw new BadRequestException(`Staging contains duplicate old_id ${String(duplicate.OLD_ID)}; no members were merged.`);
    }
  }

  private async findExistingIds(
    connection: oracledb.Connection,
    tableName: string,
    oldIdColumn: string,
    oldIds: number[],
  ): Promise<Set<number>> {
    const binds: Record<string, number> = {};
    const placeholders = [...new Set(oldIds)].map((id, index) => {
      const bindName = `id${index}`;
      binds[bindName] = id;
      return `:${bindName}`;
    });
    const result = await connection.execute<Record<string, unknown>>(
      `SELECT ${quoteIdent(true, oldIdColumn)} AS "OLD_ID" FROM ${quoteIdent(true, tableName)}
WHERE ${quoteIdent(true, oldIdColumn)} IN (${placeholders.join(', ')})`,
      binds,
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    return new Set(
      ((result.rows ?? []) as Array<{ OLD_ID?: unknown }>)
        .map((row) => Number(row.OLD_ID))
        .filter((value) => Number.isSafeInteger(value)),
    );
  }
}

export function normalizeLookupValue(raw: unknown): LookupValue | null {
  if (raw == null) return null;
  if (typeof raw === 'number' && !Number.isSafeInteger(raw)) {
    throw new BadRequestException(`Lookup old_id "${raw}" is outside the supported numeric range.`);
  }
  const text = String(raw).trim();
  if (!text || /^(null|n\/a|na)$/i.test(text)) return null;
  const numericText = text.replace(/^\+/, '').replace(/\.0+$/, '');
  if (/^\d+$/.test(numericText)) {
    const value = Number(numericText);
    if (!Number.isSafeInteger(value)) {
      throw new BadRequestException(`Lookup old_id "${text}" is outside the supported numeric range.`);
    }
    return { key: `n:${value}`, kind: 'number', text, number: value };
  }
  return { key: `s:${text.toLocaleLowerCase()}`, kind: 'name', text, number: null };
}

export function lookupResolutionKey(value: LookupValue, parentId: string | null): string {
  return parentId ? `${value.key}|parent:${parentId}` : value.key;
}

function normalizeColumnValue(column: ColumnDef, raw: unknown): Scalar {
  if (raw == null || (typeof raw === 'string' && raw.trim() === '')) return null;
  if (column.type === 'date') {
    if (raw instanceof Date) return formatDateOnly(raw);
    return String(raw).slice(0, 10);
  }
  if (column.type === 'number' || column.type === 'flag') {
    const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
    if (!Number.isFinite(value)) {
      throw new BadRequestException(`Staging contains an invalid numeric value for ${column.name}.`);
    }
    return value;
  }
  return String(raw);
}
