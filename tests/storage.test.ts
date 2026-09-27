import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STYLE,
  clearLocalData,
  deleteSavedDesign,
  exportDesignConfig,
  listSavedDesigns,
  loadBrandKit,
  parseDesignConfig,
  saveBrandKit,
  saveDesign,
  validateRasterDataUrl,
  validateStyle,
} from '../src/lib/storage';

class MemoryStorage implements Storage {
  private entries = new Map<string, string>();
  get length() { return this.entries.size; }
  clear() { this.entries.clear(); }
  getItem(key: string) { return this.entries.get(key) ?? null; }
  key(index: number) { return [...this.entries.keys()][index] ?? null; }
  removeItem(key: string) { this.entries.delete(key); }
  setItem(key: string, value: string) { this.entries.set(key, value); }
}

const png = `data:image/png;base64,${btoa(String.fromCharCode(137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0))}`;

describe('portable design configuration', () => {
  it('round trips a validated style and strips unrecognized fields', () => {
    const json = JSON.stringify({
      schemaVersion: 1,
      style: { ...DEFAULT_STYLE, frame: { label: '<script>alert(1)</script>', password: 'secret' }, password: 'secret' },
      password: 'secret',
    });
    const parsed = parseDesignConfig(json);
    expect(parsed.style.frame?.label).toBe('<script>alert(1)</script>');
    expect(exportDesignConfig(parsed.style)).not.toContain('secret');
    expect(parseDesignConfig(exportDesignConfig(parsed.style)).style).toEqual(parsed.style);
  });

  it('excludes content by default and never exports sensitive payload types', () => {
    const url = { type: 'url' as const, value: 'https://example.org/' };
    expect(parseDesignConfig(exportDesignConfig(DEFAULT_STYLE, url)).content).toBeUndefined();
    expect(parseDesignConfig(exportDesignConfig(DEFAULT_STYLE, url, true)).content).toEqual(url);
    const wifi = { type: 'wifi', value: 'WIFI:T:WPA;S:Office;P:secret;;' };
    expect(parseDesignConfig(JSON.stringify({ schemaVersion: 1, style: DEFAULT_STYLE, content: wifi })).content).toBeUndefined();
    expect(exportDesignConfig(DEFAULT_STYLE, wifi as never, true)).not.toContain('secret');
  });

  it('rejects invalid schema, style, credentialed URL, and oversized input', () => {
    expect(() => parseDesignConfig('{')).toThrow('valid JSON');
    expect(() => parseDesignConfig(JSON.stringify({ schemaVersion: 2, style: DEFAULT_STYLE }))).toThrow('version');
    expect(() => validateStyle({ ...DEFAULT_STYLE, size: 99999 })).toThrow('Size');
    expect(() => validateStyle({ ...DEFAULT_STYLE, foreground: 'red' })).toThrow('hex');
    expect(() => parseDesignConfig(JSON.stringify({
      schemaVersion: 1, style: DEFAULT_STYLE,
      content: { type: 'url', value: 'https://user:pass@example.org/' },
    }))).toThrow('credentials');
    expect(() => parseDesignConfig('x'.repeat(1_600_001))).toThrow('too large');
  });

  it('accepts signed raster logos and rejects SVG and mismatched signatures', () => {
    expect(validateRasterDataUrl(png)).toBe(png);
    expect(() => validateRasterDataUrl('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')).toThrow('PNG');
    expect(() => validateRasterDataUrl(png.replace('image/png', 'image/jpeg'))).toThrow('signature');
  });
});

describe('local storage', () => {
  it('saves, lists, deletes, and clears designs without saving content by default', () => {
    const storage = new MemoryStorage();
    const saved = saveDesign({ name: ' Poster ', style: DEFAULT_STYLE, content: { type: 'text', value: 'private' } }, storage);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value.name).toBe('Poster');
    expect(saved.value.content).toBeUndefined();
    expect(storage.getItem(storage.key(0)!)).not.toContain('private');
    const listed = listSavedDesigns(storage);
    expect(listed.ok && listed.value).toHaveLength(1);
    expect(deleteSavedDesign(saved.value.id, storage).ok).toBe(true);
    expect(listSavedDesigns(storage)).toMatchObject({ ok: true, value: [] });
    expect(clearLocalData(storage).ok).toBe(true);
  });

  it('persists only an explicitly opted-in nonsensitive URL', () => {
    const storage = new MemoryStorage();
    const result = saveDesign({
      name: 'Site', style: DEFAULT_STYLE, includeContent: true,
      content: { type: 'url', value: 'https://example.org/' },
    }, storage);
    expect(result.ok && result.value.content).toEqual({ type: 'url', value: 'https://example.org/' });
  });

  it('stores a brand kit with a raster logo and handles quota failure', () => {
    const storage = new MemoryStorage();
    const kit = { primary: '#123456', secondary: '#abcdef', logo: png };
    expect(saveBrandKit(kit, storage)).toMatchObject({ ok: true, value: { secondary: '#ABCDEF' } });
    expect(loadBrandKit(storage)).toMatchObject({ ok: true, value: { logo: png } });
    expect(clearLocalData(storage).ok).toBe(true);
    expect(loadBrandKit(storage)).toEqual({ ok: true, value: null });
    const full = new MemoryStorage();
    full.setItem = () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); };
    expect(saveDesign({ name: 'Test', style: DEFAULT_STYLE }, full)).toMatchObject({ ok: false });
  });
});
