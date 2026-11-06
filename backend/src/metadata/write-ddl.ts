import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { renderLookupDdl } from './render-ddl';
import { listTables } from './table-registry';

const target = resolve(__dirname, '../../../database/002_lookup_tables.sql');
const sql = renderLookupDdl(listTables());
writeFileSync(target, sql, 'utf8');
console.log(`Wrote ${target}`);
