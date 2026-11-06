import { assertLogicalName, quoteIdent } from '../metadata/identifiers';
import { ColumnDef, TableDef } from '../metadata/types';
import { Scalar } from './coercion';

export interface PayloadRow {
  values: Record<string, Scalar>;
  invalidFields?: string[];
}

export function buildMergeStatement(table: TableDef, mapped: ColumnDef[]): string {
  if (!mapped.some((column) => column.name === table.businessKey)) {
    throw new Error('MERGE requires old_id');
  }
  const ordered = table.columns.filter((column) => mapped.some((item) => item.name === column.name));
  for (const column of ordered) assertLogicalName(column.name);

  const jsonColumns = ordered
    .flatMap((column) => [
      `      c_${column.name} ${jsonType(column)} PATH '$.${column.name}'`,
      `      c_invalid_${column.name} NUMBER PATH '$._invalidFields.${column.name}'`,
    ])
    .join(',\n');
  const updateColumns = ordered.filter(
    (column) => column.name !== table.businessKey && column.name !== table.surrogateKey,
  );
  const defaults = table.columns.filter(
    (column) => column.databaseDefault !== undefined && !ordered.some((item) => item.name === column.name),
  );
  const tableName = quoteIdent(table.quoteTableName ?? table.quoteIdentifiers, table.physicalName);
  const business = ordered.find((column) => column.name === table.businessKey);
  if (!business) throw new Error('MERGE requires old_id');

  const updateSql =
    updateColumns.length === 0
      ? ''
      : `WHEN MATCHED THEN UPDATE SET
      ${updateColumns.map((column) => `  t.${quoteIdent(table.quoteIdentifiers, column.physicalName)} = CASE WHEN NVL(s.c_invalid_${column.name}, 0) = 1 THEN t.${quoteIdent(table.quoteIdentifiers, column.physicalName)} ELSE ${sqlValue(column)} END`).join(',\n')}
`;
  const insertColumns = [...ordered, ...defaults];
  const insertSql = `WHEN NOT MATCHED THEN INSERT (
${insertColumns.map((column) => `  ${quoteIdent(table.quoteIdentifiers, column.physicalName)}`).join(',\n')}
) VALUES (
${insertColumns
  .map((column) => {
    if (column.databaseDefault !== undefined && !ordered.some((item) => item.name === column.name)) {
      if (!Number.isSafeInteger(column.databaseDefault)) throw new Error(`Bad default for ${column.name}`);
      return `  ${column.databaseDefault}`;
    }
    return `  ${sqlValue(column)}`;
  })
  .join(',\n')}
)`;

  return `MERGE INTO ${tableName} t
USING (
  SELECT *
  FROM JSON_TABLE(:payload, '$[*]'
    COLUMNS (
${jsonColumns}
    )
  )
) s
ON (t.${quoteIdent(table.quoteIdentifiers, business.physicalName)} = s.c_${business.name})
${updateSql}${insertSql}`;
}

export function toMergePayload(columns: ColumnDef[], rows: PayloadRow[]): string {
  return JSON.stringify(
    rows.map((row) => {
      const payload: Record<string, unknown> = {};
      for (const column of columns) {
        const value = row.values[column.name];
        payload[column.name] = value == null ? null : value;
      }
      if (row.invalidFields?.length) {
        payload._invalidFields = Object.fromEntries(row.invalidFields.map((field) => [field, 1]));
      }
      return payload;
    }),
  );
}

function sqlValue(column: ColumnDef): string {
  if (column.type === 'date') {
    return `CASE WHEN s.c_${column.name} IS NULL THEN NULL ELSE TO_DATE(s.c_${column.name}, 'YYYY-MM-DD') END`;
  }
  return `s.c_${column.name}`;
}

function jsonType(column: ColumnDef): string {
  switch (column.type) {
    case 'string':
      return `VARCHAR2(${Math.min(column.length ?? 4000, 4000)})`;
    case 'date':
      return 'VARCHAR2(10)';
    case 'number':
    case 'flag':
      return 'NUMBER';
  }
}
