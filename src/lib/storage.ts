/** Versioned, local-only design persistence. Never pass an unvalidated import to the editor. */
export type ModuleStyle = 'square' | 'rounded' | 'dots';
export type FinderStyle = 'square' | 'rounded';
export type ErrorCorrection = 'L' | 'M' | 'Q' | 'H';

export interface DesignStyle {
  foreground: string;
  background: string;
  moduleStyle: ModuleStyle;
  finderStyle: FinderStyle;
  gradient?: { from: string; to: string };
  logo?: string;
  frame?: { label: string };
  size: number;
  transparent: boolean;
  ecl: ErrorCorrection;
}

export interface SafeContent {
  type: 'url' | 'text';
  value: string;
}

export interface DesignConfig {
  schemaVersion: 1;
  style: DesignStyle;
  content?: SafeContent;
}

export interface SavedDesign extends DesignConfig {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface BrandKit {
  primary: string;
  secondary: string;
  logo?: string;
}

export type StorageResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export const DEFAULT_STYLE: DesignStyle = {
  foreground: '#172421',
  background: '#FFFFFF',
  moduleStyle: 'square',
  finderStyle: 'square',
  size: 1024,
  transparent: false,
  ecl: 'M',
};

const DESIGN_KEY = 'qr-studio-designs-v1';
const BRAND_KEY = 'qr-studio-brand-v1';
const MAX_DESIGNS = 30;
const MAX_LOGO_BYTES = 1024 * 1024;
const MAX_IMPORT_CHARS = 1_600_000;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected an object.');
  }
  return value as Record<string, unknown>;
}

function color(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^#[\da-fA-F]{6}$/.test(value)) {
    throw new Error(`${field} must be a six-digit hex color.`);
  }
  return value.toUpperCase();
}

function choice<T extends string>(value: unknown, options: readonly T[], field: string): T {
  if (typeof value !== 'string' || !options.includes(value as T)) {
    throw new Error(`Invalid ${field}.`);
  }
  return value as T;
}

function boundedString(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) {
    throw new Error(`${field} must be ${allowEmpty ? 'at most' : 'between 1 and'} ${max} characters.`);
  }
  return value;
}

/** Logo data is limited to real raster file signatures; SVG/HTML cannot be imported. */
export function validateRasterDataUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_LOGO_BYTES * 1.38 + 64) {
    throw new Error('Logo must be a PNG, JPEG, or WebP image under 1 MB.');
  }
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new Error('Logo must be a base64 PNG, JPEG, or WebP image.');
  const decoded = atob(match[2]);
  if (decoded.length > MAX_LOGO_BYTES || decoded.length < 12) {
    throw new Error('Logo must be a PNG, JPEG, or WebP image under 1 MB.');
  }
  const bytes = Array.from(decoded.slice(0, 12), (character) => character.charCodeAt(0));
  const png = bytes.slice(0, 8).join(',') === '137,80,78,71,13,10,26,10';
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = decoded.startsWith('RIFF') && decoded.slice(8, 12) === 'WEBP';
  if (!(match[1] === 'png' && png || match[1] === 'jpeg' && jpeg || match[1] === 'webp' && webp)) {
    throw new Error('Logo file signature does not match its image type.');
  }
  return value;
}

export function validateStyle(input: unknown): DesignStyle {
  const source = record(input);
  const size = source.size;
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 256 || size > 4096) {
    throw new Error('Size must be an integer from 256 to 4096 pixels.');
  }
  if (typeof source.transparent !== 'boolean') throw new Error('Transparency must be true or false.');

  const style: DesignStyle = {
    foreground: color(source.foreground, 'Foreground'),
    background: color(source.background, 'Background'),
    moduleStyle: choice(source.moduleStyle, ['square', 'rounded', 'dots'], 'module style'),
    finderStyle: choice(source.finderStyle, ['square', 'rounded'], 'finder style'),
    size,
    transparent: source.transparent,
    ecl: choice(source.ecl, ['L', 'M', 'Q', 'H'], 'error correction level'),
  };
  if (source.gradient !== undefined) {
    const gradient = record(source.gradient);
    style.gradient = { from: color(gradient.from, 'Gradient start'), to: color(gradient.to, 'Gradient end') };
  }
  if (source.logo !== undefined) style.logo = validateRasterDataUrl(source.logo);
  if (source.frame !== undefined) {
    const frame = record(source.frame);
    style.frame = { label: boundedString(frame.label, 'Frame label', 60, true) };
  }
  return style;
}

function validateSafeContent(input: unknown): SafeContent | undefined {
  if (input === undefined) return undefined;
  const source = record(input);
  if (source.type !== 'url' && source.type !== 'text') return undefined;
  const value = boundedString(source.value, 'Content', 4096);
  if (source.type === 'url') {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error('Saved URL is invalid.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Saved URL must use HTTP or HTTPS without credentials.');
    }
  }
  return { type: source.type, value };
}

export function parseDesignConfig(json: string): DesignConfig {
  if (typeof json !== 'string' || json.length > MAX_IMPORT_CHARS) throw new Error('Design file is too large.');
  let source: Record<string, unknown>;
  try { source = record(JSON.parse(json)); } catch { throw new Error('Design file is not valid JSON.'); }
  if (source.schemaVersion !== 1) throw new Error('Unsupported design version.');
  const config: DesignConfig = { schemaVersion: 1, style: validateStyle(source.style) };
  const content = validateSafeContent(source.content);
  if (content) config.content = content;
  return config;
}

/** Content is excluded unless a caller deliberately opts in. Sensitive types remain excluded. */
export function exportDesignConfig(style: DesignStyle, content?: SafeContent, includeContent = false): string {
  const config: DesignConfig = { schemaVersion: 1, style: validateStyle(style) };
  if (includeContent) {
    const safe = validateSafeContent(content);
    if (safe) config.content = safe;
  }
  return JSON.stringify(config, null, 2);
}

function browserStorage(storage?: Storage): Storage {
  const selected = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
  if (!selected) throw new Error('Browser storage is unavailable.');
  return selected;
}

function fail<T>(error: unknown): StorageResult<T> {
  return { ok: false, error: error instanceof Error ? error.message : 'Browser storage is unavailable.' };
}

function storedDesigns(storage: Storage): SavedDesign[] {
  const raw = storage.getItem(DESIGN_KEY);
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('Saved designs are damaged.'); }
  if (!Array.isArray(parsed)) throw new Error('Saved designs are damaged.');
  return parsed.slice(0, MAX_DESIGNS).map((entry) => {
    const row = record(entry);
    const config = parseDesignConfig(JSON.stringify(row));
    return {
      ...config,
      id: boundedString(row.id, 'Design ID', 100),
      name: boundedString(row.name, 'Design name', 80),
      createdAt: boundedString(row.createdAt, 'Created date', 40),
      updatedAt: boundedString(row.updatedAt, 'Updated date', 40),
    };
  });
}

export function listSavedDesigns(storage?: Storage): StorageResult<SavedDesign[]> {
  try { return { ok: true, value: storedDesigns(browserStorage(storage)) }; }
  catch (error) { return fail(error); }
}

export function saveDesign(
  input: { name: string; style: DesignStyle; content?: SafeContent; includeContent?: boolean },
  storage?: Storage,
): StorageResult<SavedDesign> {
  try {
    const target = browserStorage(storage);
    const config = parseDesignConfig(exportDesignConfig(input.style, input.content, input.includeContent));
    const now = new Date().toISOString();
    const design: SavedDesign = {
      ...config,
      id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: boundedString(input.name.trim(), 'Design name', 80),
      createdAt: now,
      updatedAt: now,
    };
    const designs = [design, ...storedDesigns(target)].slice(0, MAX_DESIGNS);
    target.setItem(DESIGN_KEY, JSON.stringify(designs));
    return { ok: true, value: design };
  } catch (error) { return fail(error); }
}

export function deleteSavedDesign(id: string, storage?: Storage): StorageResult<void> {
  try {
    const target = browserStorage(storage);
    target.setItem(DESIGN_KEY, JSON.stringify(storedDesigns(target).filter((design) => design.id !== id)));
    return { ok: true, value: undefined };
  } catch (error) { return fail(error); }
}

export function clearLocalData(storage?: Storage): StorageResult<void> {
  try {
    const target = browserStorage(storage);
    target.removeItem(DESIGN_KEY);
    target.removeItem(BRAND_KEY);
    return { ok: true, value: undefined };
  } catch (error) { return fail(error); }
}

export function validateBrandKit(input: unknown): BrandKit {
  const source = record(input);
  const kit: BrandKit = { primary: color(source.primary, 'Primary color'), secondary: color(source.secondary, 'Secondary color') };
  if (source.logo !== undefined) kit.logo = validateRasterDataUrl(source.logo);
  return kit;
}

export function loadBrandKit(storage?: Storage): StorageResult<BrandKit | null> {
  try {
    const raw = browserStorage(storage).getItem(BRAND_KEY);
    return { ok: true, value: raw ? validateBrandKit(JSON.parse(raw)) : null };
  } catch (error) { return fail(error); }
}

export function saveBrandKit(kit: BrandKit, storage?: Storage): StorageResult<BrandKit> {
  try {
    const validated = validateBrandKit(kit);
    browserStorage(storage).setItem(BRAND_KEY, JSON.stringify(validated));
    return { ok: true, value: validated };
  } catch (error) { return fail(error); }
}
