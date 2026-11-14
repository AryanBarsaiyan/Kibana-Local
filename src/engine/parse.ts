import { DetectedFields, Primitive } from './types';

/**
 * Store a field as an own data property. A plain `out[key] = v` with key `__proto__` would call
 * the prototype setter (dropping the field, or swapping the prototype); defineProperty never does.
 * Plain objects (not Object.create(null)) on purpose: V8 keeps those in fast mode, which the
 * memory budget is calibrated against. Read fields with {@link own}, never `flat[key]`.
 */
export function setField(out: Record<string, Primitive>, key: string, v: Primitive) {
  if (key === '__proto__') Object.defineProperty(out, key, { value: v, writable: true, enumerable: true, configurable: true });
  else out[key] = v;
}

/** Flatten nested objects into dotted keys (keys from untrusted lines are stored via {@link setField}). */
export function flatten(obj: unknown, prefix = '', out: Record<string, Primitive> = {}, depth = 0): Record<string, Primitive> {
  if (obj === null || typeof obj !== 'object') {
    setField(out, prefix || 'value', obj as Primitive);
    return out;
  }
  if (Array.isArray(obj)) {
    setField(out, prefix || 'value', safeStringify(obj));
    return out;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && depth < 6) {
      flatten(v, key, out, depth + 1);
    } else if (Array.isArray(v) || (v !== null && typeof v === 'object')) {
      setField(out, key, safeStringify(v));
    } else {
      setField(out, key, v as Primitive);
    }
  }
  return out;
}

/** JSON.stringify recurses; a pathologically deep value must not abort the whole batch. */
function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return '[unserializable]';
  }
}

/** Own-property lookup on a flattened row: `constructor`, `toString` etc. are not fields. */
export function own(flat: Record<string, Primitive>, key: string): Primitive | undefined {
  return Object.prototype.hasOwnProperty.call(flat, key) ? flat[key] : undefined;
}

/** Parse a line that may be JSON, or JSON with a non-JSON prefix (e.g. "pod | {...}"). */
export function parseLine(line: string): Record<string, unknown> | null {
  const t = line.trim();
  if (!t) return null;
  const start = t.indexOf('{');
  if (start < 0 || t[t.length - 1] !== '}') return null;
  try {
    const v = JSON.parse(start === 0 ? t : t.slice(start));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export function parseTimestamp(v: Primitive | undefined): number | null {
  if (v === null || v === undefined || typeof v === 'boolean') return null;
  if (typeof v === 'number') {
    if (!isFinite(v) || v <= 0) return null;
    if (v < 1e11) return v * 1000; // seconds
    if (v < 1e14) return v; // ms
    if (v < 1e17) return v / 1000; // µs
    return v / 1e6; // ns
  }
  let s = String(v).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return parseTimestamp(Number(s));
  s = s.replace(/ UTC$/, 'Z').replace(/^(\d{4}-\d\d-\d\d) (\d)/, '$1T$2');
  // trim sub-millisecond precision, JS Date only handles 3 digits reliably
  s = s.replace(/(\.\d{3})\d+/, '$1');
  const n = Date.parse(s);
  return isNaN(n) ? null : n;
}

const TS_CANDIDATES = ['@timestamp', 'timestamp', 'ts', 'time', 'datetime', 'date', 'logged_at', 'created_at', 'eventTime', 'log_time'];
const LEVEL_CANDIDATES = ['level', 'log_level', 'loglevel', 'severity', 'lvl', 'levelname', 'log.level', 'level_name', 'severity_text'];
const MSG_CANDIDATES = ['message', 'msg', 'log', 'text', 'body', 'event', 'description'];

export function detectFields(samples: Record<string, Primitive>[], overrides: Partial<DetectedFields> = {}): DetectedFields {
  const keys = new Map<string, string>(); // lower -> actual
  for (const s of samples) for (const k of Object.keys(s)) if (!keys.has(k.toLowerCase())) keys.set(k.toLowerCase(), k);
  const pick = (cands: string[], check?: (k: string) => boolean): string | null => {
    for (const c of cands) {
      const k = keys.get(c.toLowerCase());
      if (k && (!check || check(k))) return k;
    }
    // suffix match for nested, e.g. "meta.timestamp"
    for (const c of cands) {
      for (const [lk, k] of keys) if (lk.endsWith('.' + c.toLowerCase()) && (!check || check(k))) return k;
    }
    return null;
  };
  const tsOk = (k: string) => samples.some((s) => parseTimestamp(s[k]) !== null);
  return {
    ts: overrides.ts || pick(TS_CANDIDATES, tsOk),
    level: overrides.level || pick(LEVEL_CANDIDATES),
    msg: overrides.msg || pick(MSG_CANDIDATES),
  };
}
