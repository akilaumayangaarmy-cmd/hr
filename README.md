# HR Excel Data Migration

Browser-based Excel/CSV mapping UI with a NestJS API that validates rows and upserts them into Oracle using native `MERGE` statements. The browser reads the first worksheet locally; only mapped cell values are sent to the API in batches.

## Requirements

- Node.js 20+
- Oracle Database; the Oracle user must have permission to create tables, and the backend creates only `02_Temp_members_master_data` on startup if it does not exist. Lookup tables are not created automatically.
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
- Column types, required insert fields, and row errors are checked by the API.
- A row with a valid `old_id` is still inserted or updated when another mapped field is invalid. Invalid fields are stored as `NULL` on insert and left unchanged on update; row-level validation errors are returned. Invalid `date_of_birth` values specifically become `NULL` without a row error. Invalid or duplicate `old_id` values cannot be upserted.
- The selected database field is the staging column receiving each source value. Lookup values are not resolved or replaced; string values are preserved as supplied, and only type validation/conversion needed for Oracle number and date columns is applied. Lookup columns allow up to 255 bytes to hold names as well as IDs.
- New lookup rows get generated UUIDs. Inserts and updates execute in a transaction per batch; rows that fail validation are reported while valid rows in that batch proceed.
- Use **Merge staged members** at any time to merge the rows currently in `02_Temp_members_master_data` into `temp_members`, keyed by `old_id`; a new upload is not required. Lookup fields are resolved by `old_id` when numeric and by `name` when text. Branch lookup scopes matches by the resolved `bank_id`; when the bank is blank or unresolved, the branch field uses the default branch record. Blank lookup fields are skipped. Unmatched non-blank values use a per-lookup fallback record named `Default_<table>`, with code `DTN` and old_id `999999999`; required lookup columns without database defaults are populated when creating fallback records. Any fallback records and the member merge run in one transaction.

## API

- `GET /api/migration/tables` returns target tables and column metadata.
- `POST /api/migration/upsert` accepts `{ "tableKey": "...", "mappings": [{ "sourceIndex": 0, "target": "old_id" }], "records": [{ "sourceRow": 2, "values": [123] }] }`.
- `POST /api/migration/merge-members` resolves staged member lookups and merges all rows from `02_Temp_members_master_data` into `temp_members`.

## Commands

- `npm run build --prefix backend`
- `npm run build --prefix frontend`
- `npm test`
- `npm run ddl` generates the lookup-table DDL under `database/`.

The service has no authentication by design. Keep the API on a trusted network and apply appropriate network controls before deployment.
