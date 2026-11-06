export type ColumnType = 'string' | 'number' | 'date' | 'flag';
export type TableGroup = 'master' | 'geography' | 'organisation' | 'reference';

export interface ColumnDef {
  name: string;
  physicalName: string;
  label: string;
  type: ColumnType;
  length?: number;
  precision?: number;
  scale?: number;
  nullable: boolean;
  requiredOnInsert: boolean;
  generateOnInsert?: boolean;
  databaseDefault?: number;
  lookup?: { table: string };
}

export interface TableDef {
  key: string;
  label: string;
  description: string;
  group: TableGroup;
  loadOrder: number;
  physicalName: string;
  quoteIdentifiers: boolean;
  quoteTableName?: boolean;
  businessKey: 'old_id';
  surrogateKey: 'id' | null;
  columns: ColumnDef[];
}

export interface ColumnMeta {
  name: string;
  label: string;
  type: ColumnType;
  typeLabel: string;
  nullable: boolean;
  requiredOnInsert: boolean;
  generateOnInsert: boolean;
  businessKey: boolean;
  lookupTable: string | null;
}

export interface TableMeta {
  key: string;
  label: string;
  description: string;
  group: TableGroup;
  loadOrder: number;
  displayName: string;
  businessKey: string;
  surrogateKey: string | null;
  columns: ColumnMeta[];
}
