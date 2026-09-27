import { describe, expect, it } from 'vitest';
import { isSensitivePayload, serializePayload, validatePayload } from '../src/lib/payload';

describe('website and plain text payloads', () => {
  it('makes the HTTPS assumption visible and retains the exact final destination', () => {
    const result = serializePayload({ type: 'url', url: 'example.com/a?q=مرحبا' });
    expect(result.valid).toBe(true);
    expect(result.value).toBe('https://example.com/a?q=%D9%85%D8%B1%D8%AD%D8%A8%D8%A7');
    expect(result.warnings).toContainEqual(expect.objectContaining({ field: 'url', message: expect.stringContaining('HTTPS') }));
  });

  it('rejects malformed and non-web destinations', () => {
    for (const url of ['', 'https://', 'javascript:alert(1)', 'https://bad host/', 'https://exa\nmple.com']) {
      const result = serializePayload({ type: 'url', url });
      expect(result.valid, url).toBe(false);
      expect(result.value).toBe('');
      expect(result.errors.some((error) => error.field === 'url')).toBe(true);
    }
  });

  it('accepts a bare host with a port', () => {
    expect(serializePayload({ type: 'url', url: 'example.com:8443/path' }).value).toBe('https://example.com:8443/path');
  });

  it('preserves text including Unicode and intended spaces', () => {
    expect(serializePayload({ type: 'text', text: '  שלום 🌿\nline  ' }).value).toBe('  שלום 🌿\nline  ');
    expect(validatePayload({ type: 'text', text: ' \n  ' })).toContainEqual(expect.objectContaining({ field: 'text' }));
  });
});

it('marks content private by default so design history can save styling alone', () => {
  expect(isSensitivePayload({ type: 'url', url: 'https://example.com/private?token=secret' })).toBe(true);
  expect(isSensitivePayload({ type: 'wifi', ssid: 'Home', security: 'WPA', password: 'secret' })).toBe(true);
});

describe('Wi-Fi payload', () => {
  it('escapes delimiters, quotes, backslashes, spaces, and Unicode', () => {
    const result = serializePayload({ type: 'wifi', security: 'WPA', ssid: 'Café ;,:\\"', password: 'p a;,:\\"字', hidden: true });
    expect(result).toMatchObject({ valid: true, value: 'WIFI:T:WPA;S:Café \\;\\,\\:\\\\\\";P:p a\\;\\,\\:\\\\\\"字;H:true;;' });
  });

  it('supports open networks and validates protected networks', () => {
    expect(serializePayload({ type: 'wifi', security: 'nopass', ssid: 'Guest' }).value).toBe('WIFI:T:nopass;S:Guest;;');
    expect(validatePayload({ type: 'wifi', security: 'WEP', ssid: 'Office', password: '' })).toContainEqual(expect.objectContaining({ field: 'password' }));
    expect(validatePayload({ type: 'wifi', security: 'WPA', ssid: '字'.repeat(11), password: 'password' })).toContainEqual(expect.objectContaining({ field: 'ssid' }));
    expect(validatePayload({ type: 'wifi', security: 'WPA', ssid: 'Office\nGuest', password: 'password' })).toContainEqual(expect.objectContaining({ field: 'ssid' }));
  });
});

describe('message and calling payloads', () => {
  it('serializes email subject and body as URI parameters', () => {
    const result = serializePayload({ type: 'email', to: 'hello@example.com', subject: 'Hi & سلام', body: 'Line 1\nLine 2' });
    expect(result.valid).toBe(true);
    expect(result.value).toContain('subject=Hi%20%26%20%D8%B3%D9%84%D8%A7%D9%85');
    expect(result.value).toContain('body=Line%201%0ALine%202');
    expect(result.value.startsWith('mailto:')).toBe(true);
    expect(validatePayload({ type: 'email', to: 'bad@', body: 'x' })).toContainEqual(expect.objectContaining({ field: 'to' }));
    expect(validatePayload({ type: 'email', to: 'a@example.com', subject: 'Hi\nBcc: bad@example.com' }))
      .toContainEqual(expect.objectContaining({ field: 'subject' }));
  });

  it('normalizes dial formatting and rejects non-phone characters', () => {
    expect(serializePayload({ type: 'phone', number: '+1 (415) 555-1234' }).value).toBe('tel:+14155551234');
    expect(serializePayload({ type: 'sms', number: '+1 (415) 555-1234', message: 'Meet at 6:00 & bring ☕' }).value)
      .toBe('sms:+14155551234?body=Meet%20at%206%3A00%20%26%20bring%20%E2%98%95');
    expect(validatePayload({ type: 'phone', number: '+12;DROP' })).toContainEqual(expect.objectContaining({ field: 'number' }));
    expect(validatePayload({ type: 'sms', number: '12' })).toContainEqual(expect.objectContaining({ field: 'number' }));
  });
});

describe('contact vCard 3.0', () => {
  it('uses CRLF, escapes text, and folds Unicode lines without splitting bytes', () => {
    const result = serializePayload({
      type: 'contact', fullName: 'آوا; Doe', givenName: 'آوا', familyName: 'Doe',
      organization: 'Studio, Inc.', note: 'first\\second\n' + '字'.repeat(40),
      phone: '+1 555 123 4567', email: 'ava@example.com',
    });
    expect(result.valid).toBe(true);
    expect(result.value).toContain('BEGIN:VCARD\r\nVERSION:3.0\r\n');
    expect(result.value).toContain('FN:آوا\\; Doe\r\n');
    expect(result.value).toContain('ORG:Studio\\, Inc.\r\n');
    expect(result.value).toContain('NOTE:first\\\\second\\n');
    expect(result.value.endsWith('END:VCARD\r\n')).toBe(true);
    for (const line of result.value.split('\r\n')) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
  });

  it('requires a name and validates optional contact destinations', () => {
    const errors = validatePayload({ type: 'contact', fullName: '', email: 'nope', url: 'ftp://example.com' });
    expect(errors.map((error) => error.field)).toEqual(expect.arrayContaining(['fullName', 'email', 'url']));
  });
});

describe('calendar iCalendar VEVENT', () => {
  const base = {
    type: 'calendar' as const, title: 'Design, review',
    start: '2026-09-27T12:30:00+03:30', end: '2026-09-27T13:30:00+03:30',
  };

  it('converts timezone offsets to UTC, includes UID and DTSTAMP, and escapes fields', () => {
    const result = serializePayload({ ...base, location: 'Floor 2; Tehran', description: 'Bring notes\nمرحبا' });
    expect(result.valid).toBe(true);
    expect(result.value).toContain('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n');
    expect(result.value).toMatch(/UID:[^\r\n]+@local\.qr\r\n/);
    expect(result.value).toContain('DTSTAMP:20260927T090000Z\r\n');
    expect(result.value).toContain('DTSTART:20260927T090000Z\r\n');
    expect(result.value).toContain('DTEND:20260927T100000Z\r\n');
    expect(result.value).toContain('SUMMARY:Design\\, review\r\n');
    expect(result.value).toContain('LOCATION:Floor 2\\; Tehran\r\n');
    expect(result.value).toContain('DESCRIPTION:Bring notes\\nمرحبا\r\n');
    expect(result.value.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(serializePayload(base).value).toBe(serializePayload(base).value);
  });

  it('rejects ambiguous, impossible, and inverted times', () => {
    expect(validatePayload({ ...base, start: '2026-09-27T12:30' })).toContainEqual(expect.objectContaining({ field: 'start' }));
    expect(validatePayload({ ...base, start: '2026-02-30T12:30Z' })).toContainEqual(expect.objectContaining({ field: 'start' }));
    expect(validatePayload({ ...base, end: '2026-09-27T11:30:00+03:30' })).toContainEqual(expect.objectContaining({ field: 'end' }));
    expect(validatePayload({ ...base, uid: 'bad\nSUMMARY:injected' })).toContainEqual(expect.objectContaining({ field: 'uid' }));
  });
});
