/** Pure, browser-safe serializers for the content encoded in static QR codes. */
export type PayloadInput =
  | { type: 'url'; url: string }
  | { type: 'text'; text: string }
  | { type: 'wifi'; ssid: string; security: 'WPA' | 'WEP' | 'nopass'; password?: string; hidden?: boolean }
  | { type: 'email'; to: string; subject?: string; body?: string }
  | { type: 'phone'; number: string }
  | { type: 'sms'; number: string; message?: string }
  | {
      type: 'contact';
      fullName: string;
      givenName?: string;
      familyName?: string;
      organization?: string;
      title?: string;
      phone?: string;
      email?: string;
      url?: string;
      address?: string;
      note?: string;
    }
  | {
      type: 'calendar';
      title: string;
      /** ISO 8601 date-time with Z or an explicit numeric offset. */
      start: string;
      end: string;
      description?: string;
      location?: string;
      uid?: string;
      /** Creation time; defaults deterministically to start if omitted. */
      timestamp?: string;
    };

export interface PayloadIssue {
  field: string;
  message: string;
}

export interface PayloadResult {
  value: string;
  valid: boolean;
  errors: PayloadIssue[];
  warnings: PayloadIssue[];
}

const encoder = new TextEncoder();
function hasForbiddenControls(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127;
  });
}

function issue(field: string, message: string): PayloadIssue {
  return { field, message };
}

function required(value: string, field: string, errors: PayloadIssue[]): void {
  if (!value.trim()) errors.push(issue(field, 'This field is required.'));
  else if (hasForbiddenControls(value)) errors.push(issue(field, 'Remove control characters.'));
}

function optionalText(value: string | undefined, field: string, errors: PayloadIssue[]): void {
  if (value && hasForbiddenControls(value)) errors.push(issue(field, 'Remove control characters.'));
}

function checkedWebUrl(raw: string, field: string, errors: PayloadIssue[], warnings: PayloadIssue[]): string {
  required(raw, field, errors);
  if (!raw.trim() || hasForbiddenControls(raw)) return '';
  if (/[\r\n\t]/.test(raw)) {
    errors.push(issue(field, 'Remove line breaks and tabs from the website address.'));
    return '';
  }
  const input = raw.trim();
  if (input !== raw) warnings.push(issue(field, 'Surrounding whitespace was removed from the destination.'));
  const hostWithPort = /^[^/\s?#]+:\d+(?:[/?#]|$)/.test(input);
  const hasScheme = !hostWithPort && /^[a-z][a-z\d+.-]*:/i.test(input);
  if (hasScheme && !/^https?:\/\//i.test(input)) {
    errors.push(issue(field, 'Use an HTTP or HTTPS website URL.'));
    return '';
  }
  if (!hasScheme) warnings.push(issue(field, 'HTTPS was added to the website address.'));
  try {
    const parsed = new URL(hasScheme ? input : `https://${input}`);
    if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname || /\s/.test(parsed.hostname)) throw new Error('Invalid host');
    if (parsed.username || parsed.password) warnings.push(issue(field, 'This URL contains sign-in information. Check it before sharing.'));
    return parsed.href;
  } catch {
    errors.push(issue(field, 'Enter a valid website address.'));
    return '';
  }
}

function escapeWifi(value: string): string {
  return value.replace(/[\\;,:"]/g, '\\$&');
}

function emailValid(address: string): boolean {
  return /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/u.test(address) && !/[\r\n]/.test(address);
}

function phoneValue(raw: string, field: string, errors: PayloadIssue[]): string {
  required(raw, field, errors);
  if (!raw.trim()) return '';
  if (!/^\+?[\d\s().-]+$/.test(raw) || (raw.match(/\+/g) || []).length > 1) {
    errors.push(issue(field, 'Enter a phone number using digits and optional +, spaces, or punctuation.'));
    return '';
  }
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 3 || digits.length > 15) {
    errors.push(issue(field, 'Enter a number with 3 to 15 digits.'));
    return '';
  }
  return (raw.trim().startsWith('+') ? '+' : '') + digits;
}

function escapeStructuredText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
}

/** Fold content lines at 75 UTF-8 octets without splitting a Unicode character. */
function foldLine(line: string): string {
  let output = '';
  let width = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    if (width + bytes > 75) {
      output += '\r\n ';
      width = 1;
    }
    output += char;
    width += bytes;
  }
  return output;
}

function contentLines(lines: string[]): string {
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

function isoDate(raw: string, field: string, errors: PayloadIssue[]): Date | null {
  required(raw, field, errors);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(raw);
  if (!match) {
    if (raw.trim()) errors.push(issue(field, 'Include a date, time, and timezone offset (Z or ±HH:MM).'));
    return null;
  }
  const [, year, month, day, hour, minute, second = '0', , zone, sign, offsetHour, offsetMinute] = match;
  const y = Number(year), mo = Number(month), d = Number(day), h = Number(hour), mi = Number(minute), s = Number(second);
  const offsetH = Number(offsetHour || 0), offsetM = Number(offsetMinute || 0);
  const monthEnd = new Date(0);
  monthEnd.setUTCFullYear(y, mo, 0);
  const maxDay = monthEnd.getUTCDate();
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > maxDay || h > 23 || mi > 59 || s > 59 ||
      (zone !== 'Z' && (offsetH > 14 || offsetM > 59 || (offsetH === 14 && offsetM !== 0)))) {
    errors.push(issue(field, 'Enter a valid date, time, and timezone offset.'));
    return null;
  }
  const offset = zone === 'Z' ? 0 : (sign === '+' ? 1 : -1) * (offsetH * 60 + offsetM);
  const milliseconds = Number((match[7] || '').padEnd(3, '0'));
  const local = new Date(0);
  local.setUTCFullYear(y, mo - 1, d);
  local.setUTCHours(h, mi, s, milliseconds);
  const date = new Date(local.getTime() - offset * 60_000);
  if (Number.isNaN(date.getTime())) {
    errors.push(issue(field, 'Enter a valid date and time.'));
    return null;
  }
  return date;
}

function calendarTime(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function hashUid(value: string): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (const byte of encoder.encode(value)) {
    a = Math.imul(a ^ byte, 0x01000193);
    b = Math.imul(b ^ byte, 0x85ebca6b);
  }
  return `${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}@local.qr`;
}

/** Returns the exact value to encode. Invalid input yields an empty value and field errors. */
export function serializePayload(input: PayloadInput): PayloadResult {
  const errors: PayloadIssue[] = [];
  const warnings: PayloadIssue[] = [];
  let value = '';

  switch (input.type) {
    case 'url':
      value = checkedWebUrl(input.url, 'url', errors, warnings);
      break;
    case 'text':
      required(input.text, 'text', errors);
      value = input.text;
      break;
    case 'wifi': {
      required(input.ssid, 'ssid', errors);
      if (/[\r\n]/.test(input.ssid)) errors.push(issue('ssid', 'Remove line breaks from the network name.'));
      if (encoder.encode(input.ssid).length > 32) errors.push(issue('ssid', 'A Wi-Fi network name can use at most 32 UTF-8 bytes.'));
      if (!['WPA', 'WEP', 'nopass'].includes(input.security)) errors.push(issue('security', 'Choose WPA, WEP, or no password.'));
      if (input.security !== 'nopass') required(input.password || '', 'password', errors);
      optionalText(input.password, 'password', errors);
      if (input.password && /[\r\n]/.test(input.password)) errors.push(issue('password', 'Remove line breaks from the password.'));
      if (input.security === 'nopass' && input.password) warnings.push(issue('password', 'The password is ignored for an open network.'));
      value = `WIFI:T:${input.security};S:${escapeWifi(input.ssid)};${input.security === 'nopass' ? '' : `P:${escapeWifi(input.password || '')};`}${input.hidden ? 'H:true;' : ''};`;
      break;
    }
    case 'email':
      required(input.to, 'to', errors);
      if (input.to.trim() && !emailValid(input.to)) errors.push(issue('to', 'Enter one valid email address.'));
      optionalText(input.subject, 'subject', errors);
      if (input.subject && /[\r\n]/.test(input.subject)) errors.push(issue('subject', 'Remove line breaks from the subject.'));
      optionalText(input.body, 'body', errors);
      value = `mailto:${encodeURIComponent(input.to).replace('%40', '@')}${input.subject || input.body ? `?${[
        ...(input.subject ? [`subject=${encodeURIComponent(input.subject)}`] : []),
        ...(input.body ? [`body=${encodeURIComponent(input.body)}`] : []),
      ].join('&')}` : ''}`;
      break;
    case 'phone': {
      const number = phoneValue(input.number, 'number', errors);
      value = `tel:${number}`;
      break;
    }
    case 'sms': {
      const number = phoneValue(input.number, 'number', errors);
      optionalText(input.message, 'message', errors);
      value = `sms:${number}${input.message ? `?body=${encodeURIComponent(input.message)}` : ''}`;
      break;
    }
    case 'contact': {
      required(input.fullName, 'fullName', errors);
      for (const field of ['givenName', 'familyName', 'organization', 'title', 'address', 'note'] as const) optionalText(input[field], field, errors);
      if (input.email && !emailValid(input.email)) errors.push(issue('email', 'Enter a valid email address.'));
      if (input.phone) phoneValue(input.phone, 'phone', errors);
      const url = input.url ? checkedWebUrl(input.url, 'url', errors, warnings) : '';
      const n = `${escapeStructuredText(input.familyName || '')};${escapeStructuredText(input.givenName || (input.familyName ? '' : input.fullName))};;;`;
      const lines = ['BEGIN:VCARD', 'VERSION:3.0', `N:${n}`, `FN:${escapeStructuredText(input.fullName)}`];
      if (input.organization) lines.push(`ORG:${escapeStructuredText(input.organization)}`);
      if (input.title) lines.push(`TITLE:${escapeStructuredText(input.title)}`);
      if (input.phone) lines.push(`TEL;TYPE=CELL:${phoneValue(input.phone, 'phone', [])}`);
      if (input.email) lines.push(`EMAIL;TYPE=INTERNET:${input.email}`);
      if (url) lines.push(`URL:${url}`);
      if (input.address) lines.push(`ADR;TYPE=HOME:;;${escapeStructuredText(input.address)};;;;`);
      if (input.note) lines.push(`NOTE:${escapeStructuredText(input.note)}`);
      lines.push('END:VCARD');
      value = contentLines(lines);
      break;
    }
    case 'calendar': {
      required(input.title, 'title', errors);
      optionalText(input.description, 'description', errors);
      optionalText(input.location, 'location', errors);
      const start = isoDate(input.start, 'start', errors);
      const end = isoDate(input.end, 'end', errors);
      const stamp = input.timestamp ? isoDate(input.timestamp, 'timestamp', errors) : start;
      if (start && end && end.getTime() <= start.getTime()) errors.push(issue('end', 'The end must be after the start.'));
      if (input.uid && (!input.uid.trim() || /[\r\n]/.test(input.uid) || hasForbiddenControls(input.uid))) {
        errors.push(issue('uid', 'Enter a nonempty UID without line breaks or control characters.'));
      }
      if (start && end && stamp) {
        const uid = input.uid || hashUid(`${input.title}\0${input.start}\0${input.end}\0${input.location || ''}`);
        const lines = [
          'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//QR Studio//Static QR Generator//EN',
          'BEGIN:VEVENT', `UID:${escapeStructuredText(uid)}`, `DTSTAMP:${calendarTime(stamp)}`,
          `DTSTART:${calendarTime(start)}`, `DTEND:${calendarTime(end)}`,
          `SUMMARY:${escapeStructuredText(input.title)}`,
        ];
        if (input.description) lines.push(`DESCRIPTION:${escapeStructuredText(input.description)}`);
        if (input.location) lines.push(`LOCATION:${escapeStructuredText(input.location)}`);
        lines.push('END:VEVENT', 'END:VCALENDAR');
        value = contentLines(lines);
      }
      break;
    }
  }

  if (errors.length) value = '';
  return { value, valid: errors.length === 0, errors, warnings };
}

export function validatePayload(input: PayloadInput): PayloadIssue[] {
  return serializePayload(input).errors;
}

/** Treat content as private by default; save styling separately from payload data. */
export function isSensitivePayload(input: PayloadInput): boolean {
  return Boolean(input);
}
