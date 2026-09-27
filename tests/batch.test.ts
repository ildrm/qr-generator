import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import {
  BATCH_LIMITS, CSV_TEMPLATE, generateBatchZip, mapCsvRows, parseCsv, safeBatchFilename,
  type BatchItem,
} from '../src/lib/batch';

describe('CSV parsing and mapping', () => {
  it('parses BOM, CRLF, quoted commas, escaped quotes, Unicode, and quoted newlines', () => {
    const parsed = parseCsv('\uFEFFtype,content,filename\r\nurl,"https://example.com/?q=a,b",Site\r\ntext,"سلام, ""دنیا""\nnext",Greeting\r\n');
    expect(parsed.errors).toEqual([]);
    expect(parsed.headers).toEqual(['type', 'content', 'filename']);
    expect(parsed.rows).toEqual([
      { line: 2, values: ['url', 'https://example.com/?q=a,b', 'Site'] },
      { line: 3, values: ['text', 'سلام, "دنیا"\nnext', 'Greeting'] },
    ]);
    expect(mapCsvRows(parsed, { type: 'type', content: 'content', filename: 'filename' }).items).toEqual([
      { rowNumber: 2, type: 'url', content: 'https://example.com/?q=a,b', filename: 'Site' },
      { rowNumber: 3, type: 'text', content: 'سلام, "دنیا"\nnext', filename: 'Greeting' },
    ]);
  });

  it('treats formula-like and HTML values as literal data', () => {
    const parsed = parseCsv('type,content\ntext,"=HYPERLINK(""https://evil.example""),<script>"');
    const mapped = mapCsvRows(parsed, { content: 'content', type: 'type' });
    expect(mapped.errors).toEqual([]);
    expect(mapped.items[0].content).toBe('=HYPERLINK("https://evil.example"),<script>');
  });

  it('reports malformed quotes, duplicate headers, uneven rows, invalid types, and empty content', () => {
    expect(parseCsv('type,type\ntext,x').errors.some((error) => error.code === 'headers')).toBe(true);
    expect(parseCsv('type,content\ntext,"unfinished').errors.some((error) => error.code === 'quotes')).toBe(true);
    const parsed = parseCsv('type,content\ntext\nunknown,hello\ntext,\n');
    const mapped = mapCsvRows(parsed, { type: 'type', content: 'content' });
    expect(mapped.errors.map((error) => error.code)).toEqual(expect.arrayContaining(['columns', 'type', 'required']));
    expect(mapped.items).toEqual([]);
  });

  it('supports a default type and reports missing mapped columns', () => {
    const parsed = parseCsv('Destination,Name\nhttps://example.com,Example');
    expect(mapCsvRows(parsed, { content: 'destination', filename: 'NAME', defaultType: 'url' }).items).toEqual([
      { rowNumber: 2, type: 'url', content: 'https://example.com', filename: 'Example' },
    ]);
    expect(mapCsvRows(parsed, { content: 'missing', defaultType: 'url' }).errors[0].code).toBe('mapping');
    expect(CSV_TEMPLATE).toContain('type,content,filename');
  });

  it('enforces CSV byte, row, and column limits', () => {
    expect(parseCsv('x'.repeat(BATCH_LIMITS.csvBytes + 1)).errors[0].code).toBe('size');
    expect(parseCsv(`content\n${'x\n'.repeat(BATCH_LIMITS.rows + 1)}`).errors.some((error) => error.code === 'rows')).toBe(true);
    expect(parseCsv(`${Array.from({ length: BATCH_LIMITS.columns + 1 }, (_, i) => `c${i}`).join(',')}\n`).errors.some((error) => error.code === 'columns')).toBe(true);
  });
});

describe('batch ZIP', () => {
  const items: BatchItem[] = [
    { rowNumber: 2, type: 'text', content: 'first', filename: '../unsafe/Name' },
    { rowNumber: 3, type: 'text', content: 'second', filename: '..\\unsafe\\Name' },
    { rowNumber: 4, type: 'text', content: 'third', filename: 'CON' },
  ];

  it('contains exactly the rendered files with safe, unique filenames and progress', async () => {
    const progress: number[] = [];
    const blob = await generateBatchZip(items, (item) => ({ data: new TextEncoder().encode(item.content), extension: 'svg' }), {
      onProgress: ({ completed }) => progress.push(completed),
    });
    const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob);
    });
    const zip = unzipSync(new Uint8Array(buffer));
    expect(Object.keys(zip)).toEqual(['-unsafe-Name.svg', '-unsafe-Name-2.svg', 'qr-003.svg']);
    expect(Object.values(zip).map((data) => new TextDecoder().decode(data))).toEqual(['first', 'second', 'third']);
    expect(progress).toEqual([1, 2, 3]);
    expect(safeBatchFilename('folder/../bad?.png', 'fallback')).not.toContain('/');
  });

  it('cancels before work and between rows', async () => {
    const before = new AbortController();
    before.abort();
    const render = () => ({ data: new Uint8Array([1]) });
    await expect(generateBatchZip(items, render, { signal: before.signal })).rejects.toMatchObject({ name: 'AbortError' });
    const during = new AbortController();
    let calls = 0;
    await expect(generateBatchZip(items, () => {
      calls += 1;
      if (calls === 1) during.abort();
      return render();
    }, { signal: during.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(1);
  });

  it('enforces output bounds and rejects unsupported extensions', async () => {
    await expect(generateBatchZip(items, () => ({ data: new Uint8Array(5) }), { maxFileBytes: 4 })).rejects.toThrow('file limit');
    await expect(generateBatchZip(items, () => ({ data: new Uint8Array(5) }), { maxTotalBytes: 9 })).rejects.toThrow('ZIP input limit');
    await expect(generateBatchZip(items, () => ({ data: new Uint8Array(1), extension: 'html' as 'svg' }))).rejects.toThrow('unsupported file format');
  });
});
