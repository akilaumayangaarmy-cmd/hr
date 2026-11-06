import { BadRequestException } from '@nestjs/common';
import { TableDef } from '../metadata/types';

export function resolvePhysicalTable(
  table: TableDef,
  availableColumns: string[],
  requiredColumns: string[],
): TableDef {
  const resolvedByName = new Map<string, string>();
  const resolvedColumns = table.columns.map((column) => {
    const actualName =
      availableColumns.find((available) => available === column.physicalName) ??
      availableColumns.find((available) => available === column.name) ??
      availableColumns.find(
        (available) =>
          available.toUpperCase() === column.physicalName.toUpperCase() ||
          available.toUpperCase() === column.name.toUpperCase(),
      );
    if (actualName) resolvedByName.set(column.name, actualName);
    return actualName ? { ...column, physicalName: actualName } : column;
  });

  const missing = requiredColumns.filter((name) => !resolvedByName.has(name));
  if (missing.length > 0) {
    throw new BadRequestException(
      `Oracle table "${table.physicalName}" is missing required column(s): ${missing.join(', ')}.`,
    );
  }

  return {
    ...table,
    columns: resolvedColumns,
    quoteIdentifiers: table.surrogateKey ? true : table.quoteIdentifiers,
  };
}
