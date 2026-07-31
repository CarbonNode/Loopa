/**
 * Parse cookies out of whatever someone managed to copy.
 *
 * Instagram's `sessionid` is HttpOnly, so no bookmarklet or page script can
 * read it — it has to come out of the browser by hand. Rather than demanding
 * one specific format, accept every shape that copying it plausibly produces
 * and work out which is which.
 *
 * Supported, in detection order:
 *   1. A `curl` command (DevTools → Network → right-click → Copy as cURL)
 *   2. A cookie-editor extension's JSON export
 *   3. Netscape cookies.txt contents
 *   4. A raw Cookie header:  `sessionid=abc; ds_user_id=123`
 *   5. A single `name=value` pair
 *   6. A bare value
 */

export type ParsedCookies = {
  values: Record<string, string>;
  /** Which shape was recognised, for a confirming message in the UI. */
  format: 'curl' | 'json' | 'netscape' | 'header' | 'pair' | 'value';
};

/** Cookie values are percent-encoded and contain `:` and `%` — keep them intact. */
function clean(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '').trim();
}

function parseHeaderString(header: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = clean(part.slice(index + 1));
    // Attributes of a Set-Cookie, not cookies themselves.
    if (/^(path|domain|expires|max-age|samesite|secure|httponly|version)$/i.test(name)) continue;
    if (name && value) values[name] = value;
  }
  return values;
}

function fromCurl(text: string): Record<string, string> | null {
  // Windows "Copy as cURL (cmd)" uses ^ continuations and doubled quotes.
  const normalised = text.replace(/\^\r?\n/g, ' ').replace(/\\\r?\n/g, ' ').replace(/\^"/g, '"');

  const values: Record<string, string> = {};

  // -H 'cookie: ...' / --header "Cookie: ..."
  for (const match of normalised.matchAll(/(?:-H|--header)\s+(['"])\s*cookie\s*:\s*([\s\S]*?)\1/gi)) {
    Object.assign(values, parseHeaderString(match[2] ?? ''));
  }
  // -b '...' / --cookie '...'
  for (const match of normalised.matchAll(/(?:-b|--cookie)\s+(['"])([\s\S]*?)\1/gi)) {
    Object.assign(values, parseHeaderString(match[2] ?? ''));
  }

  return Object.keys(values).length > 0 ? values : null;
}

function fromJson(text: string): Record<string, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const values: Record<string, string> = {};

  // Cookie-editor style: [{ name, value, domain, ... }]
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      if (entry && typeof entry === 'object') {
        const record = entry as { name?: unknown; value?: unknown };
        if (typeof record.name === 'string' && typeof record.value === 'string') {
          values[record.name] = record.value;
        }
      }
    }
  } else if (parsed && typeof parsed === 'object') {
    // A plain { sessionid: "…" } object.
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') values[name] = value;
    }
  }

  return Object.keys(values).length > 0 ? values : null;
}

function fromNetscape(text: string): Record<string, string> | null {
  const values: Record<string, string> = {};

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    // domain, includeSubdomains, path, secure, expiry, name, value
    const fields = line.split('\t');
    if (fields.length < 7) continue;
    const name = fields[5]?.trim();
    const value = fields[6]?.trim();
    if (name && value) values[name] = value;
  }

  return Object.keys(values).length > 0 ? values : null;
}

export function parseCookieBlob(raw: string): ParsedCookies | null {
  const text = raw.trim();
  if (!text) return null;

  if (/^\s*curl[\s'"]/i.test(text) || /(?:-H|--header)\s+['"]\s*cookie\s*:/i.test(text)) {
    const values = fromCurl(text);
    if (values) return { values, format: 'curl' };
  }

  if (text.startsWith('[') || text.startsWith('{')) {
    const values = fromJson(text);
    if (values) return { values, format: 'json' };
  }

  if (text.includes('\t')) {
    const values = fromNetscape(text);
    if (values) return { values, format: 'netscape' };
  }

  if (text.includes(';') && text.includes('=')) {
    const values = parseHeaderString(text);
    if (Object.keys(values).length > 0) return { values, format: 'header' };
  }

  // A single pair. Split on the FIRST '=' only — the value itself contains
  // '=' padding and percent-encoded separators.
  const equals = text.indexOf('=');
  if (equals > 0 && !/\s/.test(text.slice(0, equals))) {
    const name = text.slice(0, equals).trim();
    const value = clean(text.slice(equals + 1));
    if (name && value) return { values: { [name]: value }, format: 'pair' };
  }

  // A bare value. The caller knows which cookie it was asking for.
  if (!/\s/.test(text)) return { values: { __bare__: text }, format: 'value' };

  return null;
}
