# HR Excel Data Migration

Browser-based Excel/CSV mapping UI with a NestJS API that validates rows and upserts them into Oracle using native `MERGE` statements. The browser reads the first worksheet locally; only mapped cell values are sent to the API in batches.

## Requirements

- Node.js 20+
- Oracle Database with the target table and the lookup tables defined in `backend/src/metadata/table-registry.ts`
- Oracle Thin mode by default; Oracle Instant Client is optional

## Run locally

1. Install dependencies with `npm run install:all`.
2. Copy `backend/.env.example` to `backend/.env` and set `ORACLE_USER`, `ORACLE_PASSWORD`, and `ORACLE_CONNECT_STRING`.
3. Start the API and UI with `npm run dev`.
4. Open `http://localhost:5173`.

The UI defaults to the API at `http://localhost:3000/api/migration`. Set `VITE_API_URL` at frontend build time to use a different API URL. For Oracle Instant Client, set `ORACLE_CLIENT_LIB` in the backend environment.

## Import behavior

- Supported files: `.xlsx`, `.xls`, and `.csv`; the first worksheet is used.
- File limit: 50 MB and 250,000 data rows. Rows are sent in batches of 500.
- `old_id` must be explicitly mapped and numeric. The UI checks uniqueness across the whole uploaded file, and the API also checks each submitted batch.
- Column types, required insert fields, lookup values, and row errors are checked by the API.
- Lookup fields accept an existing UUID, an `old_id`, or an unambiguous code. A UUID is accepted as-is; numeric and code values are resolved against the corresponding lookup table.
- New lookup rows get generated UUIDs. Inserts and updates execute in a transaction per batch; rows that fail validation are reported while valid rows in that batch proceed.

## API

- `GET /api/migration/tables` returns target tables and column metadata.
- `POST /api/migration/upsert` accepts `{ "tableKey": "...", "mappings": [{ "sourceIndex": 0, "target": "old_id" }], "records": [{ "sourceRow": 2, "values": [123] }] }`.

## Commands

- `npm run build --prefix backend`
- `npm run build --prefix frontend`
- `npm test`
- `npm run ddl` generates the lookup-table DDL under `database/`.

The service has no authentication by design. Keep the API on a trusted network and apply appropriate network controls before deployment.
