import { Zip, ZipPassThrough } from 'fflate';

export const CSV_TEMPLATE = 'type,content,filename\nurl,https://example.com,Example\ntext,Hello world,Greeting\n';

export const BATCH_LIMITS = {
  csvBytes: 1024 * 1024,
  rows: 500,
  columns: 32,
  cellCharacters: 32_768,
  fileBytes: 2 * 1024 * 1024,
  zipInputBytes: 32 * 1024 * 1024,
} as const;

export type BatchType = 'url' | 'text' | 'wifi' | 'email' | 'phone' | 'sms' | 'contact' | 'calendar';

export interface CsvIssue {
  row: number;
  column?: string;
  code: 'size' | 'rows' | 'columns' | 'cell' | 'quotes' | 'headers' | 'mapping' | 'required' | 'type';
  message: string;
}

export interface CsvRow {
  /** One-based physical line number in the source CSV. */
  line: number;
  values: string[];
}

export interface ParsedCsv {
  headers: string[];
  rows: CsvRow[];
  errors: CsvIssue[];
}

export interface CsvColumnMapping {
  content: string;
  type?: string;
  filename?: string;
  defaultType?: BatchType;
}

export interface BatchItem {
  rowNumber: number;
  type: BatchType;
  content: string;
  filename?: string;
}

export interface MappedCsv {
  items: BatchItem[];
  errors: CsvIssue[];
}

export interface BatchRenderedFile {
  data: Uint8Array | ArrayBuffer | Blob;
  extension?: 'png' | 'svg';
}

export interface BatchProgress {
  completed: number;
  total: number;
  rowNumber: number;
}

export interface BatchZipOptions {
  signal?: AbortSignal;
  onProgress?: (progress: BatchProgress) => void;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

function issue(row: number, code: CsvIssue['code'], message: string, column?: string): CsvIssue {
  return { row, code, message, ...(column ? { column } : {}) };
}

/** Parse RFC 4180 style CSV, including quoted newlines, without interpreting cell contents. */
export function parseCsv(text: string): ParsedCsv {
  const result: ParsedCsv = { headers: [], rows: [], errors: [] };
  if (new TextEncoder().encode(text).byteLength > BATCH_LIMITS.csvBytes) {
    result.errors.push(issue(1, 'size', 'CSV exceeds the 1 MB limit.'));
    return result;
  }

  const input = text.replace(/^\uFEFF/, '');
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let afterQuote = false;
  let line = 1;
  let rowStart = 1;
  let cellTooLong = false;

  const endCell = () => {
    if (cell.length > BATCH_LIMITS.cellCharacters && !cellTooLong) {
      result.errors.push(issue(rowStart, 'cell', 'A cell exceeds the 32,768 character limit.'));
      cellTooLong = true;
    }
    cells.push(cell);
    cell = '';
    afterQuote = false;
    cellTooLong = false;
  };
  const endRow = () => {
    endCell();
    if (cells.length === 1 && cells[0].trim() === '') {
      cells = [];
      return;
    }
    if (cells.length > BATCH_LIMITS.columns) {
      result.errors.push(issue(rowStart, 'columns', 'A row exceeds the 32-column limit.'));
    }
    if (result.headers.length === 0) {
      result.headers = cells.map((header) => header.trim());
      const names = new Set<string>();
      for (const header of result.headers) {
        const key = header.toLocaleLowerCase();
        if (!key || names.has(key)) {
          result.errors.push(issue(rowStart, 'headers', 'Column names must be nonempty and unique.'));
          break;
        }
        names.add(key);
      }
    } else if (result.rows.length >= BATCH_LIMITS.rows) {
      if (!result.errors.some((error) => error.code === 'rows')) {
        result.errors.push(issue(rowStart, 'rows', 'CSV exceeds the 500-row limit.'));
      }
    } else {
      if (cells.length !== result.headers.length) {
        result.errors.push(issue(rowStart, 'columns', `Expected ${result.headers.length} columns; found ${cells.length}.`));
      }
      result.rows.push({ line: rowStart, values: cells });
    }
    cells = [];
  };

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        cell += char;
        if (char === '\n') line += 1;
        else if (char === '\r') {
          line += 1;
          if (input[i + 1] === '\n') cell += input[++i];
        }
      }
      continue;
    }
    if (char === '"') {
      if (cell === '' && !afterQuote) quoted = true;
      else {
        result.errors.push(issue(rowStart, 'quotes', 'A quote must start a quoted cell or be doubled inside one.'));
        cell += char;
      }
    } else if (char === ',') {
      endCell();
    } else if (char === '\n' || char === '\r') {
      endRow();
      if (char === '\r' && input[i + 1] === '\n') i += 1;
      line += 1;
      rowStart = line;
    } else {
      if (afterQuote) {
        result.errors.push(issue(rowStart, 'quotes', 'Unexpected text after a closing quote.'));
        afterQuote = false;
      }
      cell += char;
    }
    if (cell.length > BATCH_LIMITS.cellCharacters && !cellTooLong) {
      result.errors.push(issue(rowStart, 'cell', 'A cell exceeds the 32,768 character limit.'));
      cellTooLong = true;
    }
  }
  if (quoted) result.errors.push(issue(rowStart, 'quotes', 'A quoted cell is missing its closing quote.'));
  if (cell !== '' || cells.length > 0 || afterQuote) endRow();
  if (result.headers.length === 0) result.errors.push(issue(1, 'headers', 'CSV needs a header row.'));
  else if (result.rows.length === 0) result.errors.push(issue(line, 'required', 'CSV needs at least one data row.'));
  return result;
}

const TYPE_ALIASES: Record<string, BatchType> = {
  url: 'url', website: 'url', text: 'text', 'plain text': 'text', wifi: 'wifi', 'wi-fi': 'wifi',
  email: 'email', phone: 'phone', sms: 'sms', contact: 'contact', calendar: 'calendar',
};

/** Map selected columns to batch items. All CSV values remain literal strings. */
export function mapCsvRows(parsed: ParsedCsv, mapping: CsvColumnMapping): MappedCsv {
  const errors = [...parsed.errors];
  const index = (name: string | undefined) => name === undefined ? -1 : parsed.headers.findIndex((header) => header.toLocaleLowerCase() === name.trim().toLocaleLowerCase());
  const contentIndex = index(mapping.content);
  const typeIndex = index(mapping.type);
  const filenameIndex = index(mapping.filename);
  if (contentIndex < 0) errors.push(issue(1, 'mapping', `Content column "${mapping.content}" was not found.`));
  if (mapping.type && typeIndex < 0) errors.push(issue(1, 'mapping', `Type column "${mapping.type}" was not found.`));
  if (!mapping.type && !mapping.defaultType) errors.push(issue(1, 'mapping', 'Choose a type column or a default type.'));
  if (mapping.filename && filenameIndex < 0) errors.push(issue(1, 'mapping', `Filename column "${mapping.filename}" was not found.`));
  if (errors.some((error) => error.code === 'mapping' || error.code === 'size' || error.code === 'headers')) return { items: [], errors };

  const items: BatchItem[] = [];
  for (const row of parsed.rows) {
    if (row.values.length !== parsed.headers.length) continue;
    const content = row.values[contentIndex];
    const rawType = typeIndex >= 0 ? row.values[typeIndex].trim() : mapping.defaultType ?? '';
    const type = TYPE_ALIASES[rawType.toLocaleLowerCase()];
    if (content.trim() === '') errors.push(issue(row.line, 'required', 'Content is required.', mapping.content));
    if (!type) errors.push(issue(row.line, 'type', `Unsupported type "${rawType}".`, mapping.type));
    if (content.trim() === '' || !type) continue;
    items.push({ rowNumber: row.line, type, content, ...(filenameIndex >= 0 ? { filename: row.values[filenameIndex] } : {}) });
  }
  return { items, errors };
}

/** Remove path syntax, control characters, and cross-platform unsafe filename characters. */
export function safeBatchFilename(value: string | undefined, fallback: string): string {
  const basename = (value ?? '').replace(/\.(png|svg)$/i, '');
  let safe = basename.normalize('NFKC')
    .replace(/[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069<>:"/\\|?*]/gu, '-')
    .replace(/\s+/g, ' ').replace(/^\.+|[. ]+$/g, '').trim().slice(0, 80);
  if (!safe || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(safe)) safe = fallback;
  return safe;
}

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Batch cancelled.', 'AbortError');
}

function uniqueName(base: string, extension: string, used: Set<string>): string {
  let candidate = `${base}.${extension}`;
  let suffix = 2;
  while (used.has(candidate.toLocaleLowerCase())) candidate = `${base}-${suffix++}.${extension}`;
  used.add(candidate.toLocaleLowerCase());
  return candidate;
}

/** Render one item at a time and assemble a bounded, cancellable ZIP in the browser. */
export async function generateBatchZip(
  items: readonly BatchItem[],
  render: (item: BatchItem, signal?: AbortSignal) => Promise<BatchRenderedFile> | BatchRenderedFile,
  options: BatchZipOptions = {},
): Promise<Blob> {
  if (items.length === 0 || items.length > BATCH_LIMITS.rows) throw new Error('Batch must contain 1 to 500 valid rows.');
  const maxFileBytes = Math.min(options.maxFileBytes ?? BATCH_LIMITS.fileBytes, BATCH_LIMITS.fileBytes);
  const maxTotalBytes = Math.min(options.maxTotalBytes ?? BATCH_LIMITS.zipInputBytes, BATCH_LIMITS.zipInputBytes);
  if (maxFileBytes <= 0 || maxTotalBytes <= 0) throw new Error('Batch size limits must be positive.');

  const chunks: Uint8Array[] = [];
  let resolveZip!: (blob: Blob) => void;
  let rejectZip!: (error: Error) => void;
  const finished = new Promise<Blob>((resolve, reject) => { resolveZip = resolve; rejectZip = reject; });
  const zip = new Zip((error, chunk, final) => {
    if (error) { rejectZip(error); return; }
    chunks.push(chunk);
    if (final) resolveZip(new Blob(chunks.map((part) => new Uint8Array(part).buffer), { type: 'application/zip' }));
  });
  const used = new Set<string>();
  let totalBytes = 0;
  for (let i = 0; i < items.length; i += 1) {
    abortIfRequested(options.signal);
    const item = items[i];
    const rendered = await render(item, options.signal);
    abortIfRequested(options.signal);
    const size = rendered.data instanceof Blob ? rendered.data.size : rendered.data.byteLength;
    if (size > maxFileBytes) throw new Error(`Row ${item.rowNumber} exceeds the 2 MB file limit.`);
    if (totalBytes + size > maxTotalBytes) throw new Error('Batch exceeds the 32 MB ZIP input limit.');
    const bytes = rendered.data instanceof Blob
      ? new Uint8Array(await rendered.data.arrayBuffer())
      : rendered.data instanceof ArrayBuffer ? new Uint8Array(rendered.data) : rendered.data;
    abortIfRequested(options.signal);
    totalBytes += bytes.byteLength;
    const extension = rendered.extension ?? 'png';
    if (extension !== 'png' && extension !== 'svg') throw new Error(`Row ${item.rowNumber} has an unsupported file format.`);
    const fallback = `qr-${String(i + 1).padStart(3, '0')}`;
    const filename = uniqueName(safeBatchFilename(item.filename, fallback), extension, used);
    const entry = new ZipPassThrough(filename);
    zip.add(entry);
    entry.push(bytes, true);
    options.onProgress?.({ completed: i + 1, total: items.length, rowNumber: item.rowNumber });
    if (i % 8 === 7) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  abortIfRequested(options.signal);
  zip.end();
  return finished;
}
