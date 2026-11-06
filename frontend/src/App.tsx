import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { suggestTarget, TargetTable } from './mapping';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/migration';
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_ROWS = 250_000;
const BATCH_SIZE = 500;

interface SourceRow {
  sourceRow: number;
  values: unknown[];
}

interface UploadData {
  headers: string[];
  rows: SourceRow[];
  sheetName: string;
}

interface ImportError {
  sourceRow: number;
  oldId: string | null;
  field?: string;
  message: string;
}

interface BatchResult {
  received: number;
  inserted: number;
  updated: number;
  unchanged: number;
  errors: ImportError[];
}

function App() {
  const [tables, setTables] = useState<TargetTable[]>([]);
  const [selectedTable, setSelectedTable] = useState('');
  const [upload, setUpload] = useState<UploadData | null>(null);
  const [mapping, setMapping] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<BatchResult | null>(null);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const table = tables.find((item) => item.key === selectedTable);
  const availableColumns = useMemo(
    () => table?.columns.filter((column) => !column.generateOnInsert) ?? [],
    [table],
  );
  const mappedTargets = new Set(Object.values(mapping).filter(Boolean));
  const oldIdMapped = Boolean(table && Object.values(mapping).includes(table.columns.find((column) => column.businessKey)?.name ?? 'old_id'));

  useEffect(() => {
    fetch(`${API_URL}/tables`)
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseMessage(response));
        return (await response.json()) as TargetTable[];
      })
      .then((items) => {
        setTables(items);
        const preferred = items.find((item) => item.key === '02_Temp_members_master_data') ?? items[0];
        if (preferred) setSelectedTable(preferred.key);
      })
      .catch((cause: unknown) => setError(errorMessage(cause, 'Unable to load target tables.')));
  }, []);

  useEffect(() => {
    setMapping(() => {
      if (!upload || !table) return {};
      const next: Record<number, string> = {};
      const used = new Set<string>();
      upload.headers.forEach((header, index) => {
        const suggestion = suggestTarget(header, availableColumns);
        if (suggestion && !used.has(suggestion)) {
          next[index] = suggestion;
          used.add(suggestion);
        }
      });
      return next;
    });
    setResult(null);
  }, [selectedTable, upload, table, availableColumns]);

  async function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    setError('');
    setResult(null);
    if (!file) return;
    setUpload(null);
    if (file.size > MAX_FILE_BYTES) {
      setError('File exceeds the 50 MB limit.');
      return;
    }
    try {
      const XLSX = await import('xlsx');
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) throw new Error('The workbook contains no sheets.');
      const sheet = workbook.Sheets[sheetName];
      const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        raw: true,
        defval: null,
        blankrows: false,
      });
      if (grid.length === 0) throw new Error('The first sheet is empty.');
      const headerIndex = grid.findIndex((row) => row.some((value) => value != null && String(value).trim() !== ''));
      if (headerIndex < 0) throw new Error('Could not find a header row in the first sheet.');
      const headerValues = grid[headerIndex];
      const width = grid.reduce((maximum, row) => Math.max(maximum, row.length), 0);
      const headers = Array.from({ length: width }, (_, index) => {
        const value = headerValues[index];
        return value == null || String(value).trim() === '' ? `Column ${index + 1}` : String(value).trim();
      });
      const dataRows = grid.slice(headerIndex + 1);
      if (dataRows.length > MAX_ROWS) throw new Error(`The workbook exceeds the ${MAX_ROWS.toLocaleString()} row limit.`);
      const rows = dataRows
        .map((values, index) => ({ sourceRow: headerIndex + index + 2, values }))
        .filter((record) => record.values.some((value) => value != null && String(value).trim() !== ''));
      if (rows.length === 0) throw new Error('No data rows were found below the header.');
      setUpload({ headers, rows, sheetName });
      setProgress(0);
    } catch (cause) {
      setUpload(null);
      setError(errorMessage(cause, 'Could not read this spreadsheet.'));
    }
  }

  function changeMapping(sourceIndex: number, target: string) {
    setMapping((current) => {
      const next = { ...current };
      if (!target) delete next[sourceIndex];
      else {
        for (const [index, value] of Object.entries(next)) {
          if (value === target) delete next[Number(index)];
        }
        next[sourceIndex] = target;
      }
      return next;
    });
    setResult(null);
  }

  async function startImport() {
    if (!upload || !table || !oldIdMapped) return;
    setBusy(true);
    setError('');
    setResult({ received: 0, inserted: 0, updated: 0, unchanged: 0, errors: [] });
    setProgress(0);
    const mappings = Object.entries(mapping)
      .filter(([, target]) => Boolean(target))
      .map(([sourceIndex, target]) => ({ sourceIndex: Number(sourceIndex), target }));
    const aggregate: BatchResult = { received: 0, inserted: 0, updated: 0, unchanged: 0, errors: [] };
    try {
      const oldIdSource = Number(Object.entries(mapping).find(([, target]) => target === (table.columns.find((column) => column.businessKey)?.name ?? 'old_id'))?.[0]);
      const ids = new Map<string, number>();
      const duplicates = new Set<number>();
      for (const row of upload.rows) {
        const value = row.values[oldIdSource];
        const text = value == null ? '' : String(value).trim().replace(/,/g, '');
        if (!/^\+?\d+(?:\.0+)?$/.test(text)) continue;
        const canonical = String(Number(text.replace(/^\+/, '').replace(/\.0+$/, '')));
        const previous = ids.get(canonical);
        if (previous !== undefined) {
          duplicates.add(previous);
          duplicates.add(row.sourceRow);
        } else {
          ids.set(canonical, row.sourceRow);
        }
      }
      if (duplicates.size > 0) {
        aggregate.errors = [...duplicates].sort((a, b) => a - b).map((sourceRow) => ({
          sourceRow,
          oldId: null,
          field: 'old_id',
          message: 'Duplicate old_id in the uploaded file.',
        }));
        setResult(aggregate);
        setError('Duplicate old_id values must be resolved before import. No rows were sent.');
        return;
      }
      for (let offset = 0; offset < upload.rows.length; offset += BATCH_SIZE) {
        const records = upload.rows.slice(offset, offset + BATCH_SIZE).map((row) => {
          const values = Array<unknown>(upload.headers.length).fill(null);
          for (const { sourceIndex } of mappings) values[sourceIndex] = row.values[sourceIndex] ?? null;
          return { ...row, values };
        });
        const response = await fetch(`${API_URL}/upsert`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tableKey: table.key, mappings, records }),
        });
        if (!response.ok) throw new Error(await responseMessage(response));
        const batch = (await response.json()) as BatchResult;
        aggregate.received += batch.received;
        aggregate.inserted += batch.inserted;
        aggregate.updated += batch.updated;
        aggregate.unchanged += batch.unchanged;
        aggregate.errors.push(...batch.errors);
        setProgress(Math.round((Math.min(offset + records.length, upload.rows.length) / upload.rows.length) * 100));
        setResult({ ...aggregate, errors: [...aggregate.errors] });
      }
    } catch (cause) {
      setError(errorMessage(cause, 'Import stopped before all batches finished.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="HR migration home">
          <span className="brand-mark">H</span>
          <span>HR <b>DATA OPS</b></span>
        </a>
        <div className="topbar-right"><span className="status-dot" /> Migration workspace</div>
      </header>

      <div className="page">
        <div className="page-heading">
          <div>
            <div className="eyebrow">DATA MANAGEMENT <span>/</span> IMPORT</div>
            <h1>Excel data migration</h1>
            <p>Map spreadsheet columns to Oracle fields, validate your data, and safely upsert records.</p>
          </div>
          <div className="secure-pill"><span>●</span> Direct database import</div>
        </div>

        {error && <div className="alert error-alert" role="alert"><span>!</span><div>{error}</div><button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}

        <section className="step-card">
          <div className="section-title"><span className="step-number">1</span><div><h2>Choose destination</h2><p>Select the table to receive your spreadsheet rows.</p></div></div>
          <label className="field-label" htmlFor="table-select">TARGET TABLE</label>
          <select id="table-select" value={selectedTable} onChange={(event) => { setSelectedTable(event.target.value); setResult(null); }}>
            {tables.map((item) => <option key={item.key} value={item.key}>{item.label} · {item.key}</option>)}
          </select>
          {table && <div className="table-note"><span className="info-icon">i</span><span>{table.description} <b>Upsert key: {table.columns.find((column) => column.businessKey)?.name ?? 'old_id'}</b></span></div>}
        </section>

        <section className="step-card">
          <div className="section-title"><span className="step-number">2</span><div><h2>Upload spreadsheet</h2><p>Choose an Excel workbook or CSV file. Only the first sheet is used.</p></div></div>
          <button className={`upload-zone ${upload ? 'has-file' : ''}`} onClick={() => fileInput.current?.click()} disabled={busy}>
            <span className="upload-icon">{upload ? '✓' : '↑'}</span>
            <span className="upload-copy"><b>{upload ? upload.headers.length + ' columns · ' + upload.rows.length.toLocaleString() + ' rows' : 'Click to choose a file'}</b><small>{upload ? `Loaded from “${upload.sheetName}”` : 'XLSX, XLS, or CSV · up to 50 MB'}</small></span>
            {upload && <span className="replace-file">Replace file</span>}
          </button>
          <input ref={fileInput} className="visually-hidden" type="file" accept=".xlsx,.xls,.csv" onChange={onFileChange} />
        </section>

        {upload && table && <section className="step-card mapping-card">
          <div className="mapping-head">
            <div className="section-title"><span className="step-number">3</span><div><h2>Map your columns</h2><p>Match each spreadsheet column to a destination field. Suggestions are applied automatically.</p></div></div>
            <div className="mapped-count">{Object.values(mapping).filter(Boolean).length} mapped <span>of {upload.headers.length}</span></div>
          </div>
          <div className="mapping-columns"><span>SOURCE COLUMN <small>{upload.headers.length} columns</small></span><span></span><span>DATABASE FIELD <small>{availableColumns.length} available</small></span></div>
          <div className="mapping-list">
            {upload.headers.map((header, index) => {
              const target = availableColumns.find((column) => column.name === mapping[index]);
              return <div className="mapping-row" key={`${index}-${header}`}>
                <div className="source-cell"><span className="source-icon">▤</span><span className="truncate">{header}</span><small>Column {index + 1}</small></div>
                <div className="mapping-arrow">→</div>
                <div className="target-cell">
                  <select value={mapping[index] ?? ''} onChange={(event) => changeMapping(index, event.target.value)} aria-label={`Map ${header}`}>
                    <option value="">Skip this column</option>
                    {availableColumns.map((column) => <option key={column.name} value={column.name} disabled={mappedTargets.has(column.name) && mapping[index] !== column.name}>{column.label} · {column.name}{column.businessKey ? ' · required key' : ''}</option>)}
                  </select>
                  {target && <span className="type-tag">{target.typeLabel}{target.requiredOnInsert ? ' · required on insert' : ''}</span>}
                </div>
              </div>;
            })}
          </div>
          <div className={`key-warning ${oldIdMapped ? 'key-ok' : ''}`}>
            <span>{oldIdMapped ? '✓' : '!'}</span>
            {oldIdMapped ? <span><b>old_id is mapped</b> — records will be inserted or updated using this identifier.</span> : <span><b>Map old_id to continue.</b> This identifier is required, numeric, and unique across the uploaded file.</span>}
          </div>
          <details className="preview">
            <summary>Preview first 5 rows</summary>
            <div className="table-scroll"><table><thead><tr>{upload.headers.map((header, index) => <th key={`${header}-${index}`}>{header}</th>)}</tr></thead><tbody>{upload.rows.slice(0, 5).map((row) => <tr key={row.sourceRow}>{upload.headers.map((_, index) => <td key={index}>{displayValue(row.values[index])}</td>)}</tr>)}</tbody></table></div>
          </details>
          <div className="import-footer">
            <div className="batch-note"><span className="info-icon">i</span> Imported in batches of {BATCH_SIZE.toLocaleString()} rows</div>
            <button className="primary-button" onClick={startImport} disabled={busy || !oldIdMapped || !upload.rows.length}>
              {busy ? <><span className="spinner" /> Importing {progress}%</> : <>Start import <span>→</span></>}
            </button>
          </div>
          {busy && <div className="progress-track"><div style={{ width: `${progress}%` }} /></div>}
        </section>}

        {result && <section className="result-card" aria-live="polite">
          <div className="result-heading"><div className="result-check">{result.errors.length ? '!' : '✓'}</div><div><h2>{busy ? 'Import in progress' : result.errors.length ? 'Import completed with row errors' : 'Import completed'}</h2><p>{result.received.toLocaleString()} of {upload?.rows.length.toLocaleString()} rows processed</p></div></div>
          <div className="result-stats"><div><b>{result.inserted.toLocaleString()}</b><span>Inserted</span></div><div><b>{result.updated.toLocaleString()}</b><span>Updated</span></div><div><b>{result.unchanged.toLocaleString()}</b><span>Unchanged</span></div><div className={result.errors.length ? 'stat-error' : ''}><b>{result.errors.length.toLocaleString()}</b><span>Row errors</span></div></div>
          {result.errors.length > 0 && <details className="error-details"><summary>View row errors</summary><div className="error-list">{result.errors.slice(0, 100).map((item, index) => <div key={`${item.sourceRow}-${item.field}-${index}`}><b>Row {item.sourceRow}{item.field ? ` · ${item.field}` : ''}</b><span>{item.message}</span></div>)}{result.errors.length > 100 && <p>Showing first 100 errors.</p>}</div></details>}
        </section>}
        <footer className="page-footer"><span>HR DATA MIGRATION</span><span>Excel import utility <i>·</i> Oracle merge</span></footer>
      </div>
    </main>
  );
}

function displayValue(value: unknown): string {
  if (value == null) return '—';
  if (value instanceof Date) return value.toLocaleDateString();
  return String(value);
}

async function responseMessage(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  if (body && typeof body === 'object' && 'message' in body) {
    const message = (body as { message: unknown }).message;
    if (Array.isArray(message)) return message.join(', ');
    if (typeof message === 'string') return message;
  }
  return `Request failed (${response.status}).`;
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

export default App;
