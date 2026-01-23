export function parseRaw(raw: any): Record<string, any> {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return { value: raw };
    }
  }
  if (typeof raw === 'object') return raw as Record<string, any>;
  return { value: raw };
}

export function getRawValue(raw: Record<string, any>, key: string): any {
  if (!raw) return null;
  // support dot notation
  const parts = key.split('.');
  let cur: any = raw;
  for (const p of parts) {
    if (cur == null) return null;
    cur = cur[p];
  }
  return cur === undefined ? null : cur;
}

export function asString(raw: Record<string, any>, key: string): string | null {
  const v = getRawValue(raw, key);
  if (v == null) return null;
  if (typeof v === 'object') return (v.name || v.nombre || JSON.stringify(v));
  return String(v);
}

export function asDate(raw: Record<string, any>, key: string): Date | null {
  const v = getRawValue(raw, key);
  if (v == null) return null;
  // Numbers are treated as epoch ms
  if (typeof v === 'number') {
    const dnum = new Date(v);
    return isNaN(dnum.getTime()) ? null : dnum;
  }
  if (typeof v === 'string') {
    const s = v.trim();
    // ISO date-only YYYY-MM-DD -> interpret as local date at midnight
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const [y, m, d] = s.split('-').map((n) => parseInt(n, 10));
      const dobj = new Date(y, m - 1, d, 0, 0, 0);
      return isNaN(dobj.getTime()) ? null : dobj;
    }
    // Common D/M/YYYY or D-M-YYYY formats -> day first
    if (/^\d{1,2}[\/-]\d{1,2}[\/-]\d{4}$/.test(s)) {
      const parts = s.includes('/') ? s.split('/') : s.split('-');
      const day = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10);
      const year = parseInt(parts[2], 10);
      const dobj = new Date(year, month - 1, day, 0, 0, 0);
      return isNaN(dobj.getTime()) ? null : dobj;
    }
    // Otherwise delegate to Date parser (handles ISO with time and timezone)
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export function stripHtml(input: string | null | undefined): string | null {
  if (input == null) return null;
  const s = typeof input === 'string' ? input : String(input);
  // remove tags
  const noTags = s.replace(/<[^>]*>/g, '');
  // collapse whitespace and trim
  const cleaned = noTags.replace(/\s+/g, ' ').trim();
  return cleaned.length ? cleaned : null;
}

export function asDateString(raw: Record<string, any>, key: string): string | null {
  const d = asDate(raw, key);
  if (!d) return null;
  return d.toISOString();
}

export function extractFields(raw: any, keys: string[]): Record<string, any> {
  const obj = parseRaw(raw);
  const out: Record<string, any> = {};
  for (const k of keys) {
    out[k] = getRawValue(obj, k) ?? null;
  }
  return out;
}

export default { parseRaw, getRawValue, asString, asDate, extractFields };
