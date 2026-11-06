import { ColumnDef } from './types';

export function labelize(name: string): string {
  return name
    .split('_')
    .map((part) => {
      if (part === 'id') return 'ID';
      if (part === 'nic') return 'NIC';
      if (part === 'gn') return 'GN';
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');
}

export function typeLabel(column: ColumnDef): string {
  switch (column.type) {
    case 'string':
      return `VARCHAR2(${column.length ?? 4000})`;
    case 'date':
      return 'DATE';
    case 'flag':
      return 'NUMBER(1,0)';
    case 'number':
      if (column.precision === 38 && column.scale === 0) return 'NUMBER';
      if (column.precision != null && column.scale != null) {
        return `NUMBER(${column.precision},${column.scale})`;
      }
      return 'NUMBER';
  }
}
