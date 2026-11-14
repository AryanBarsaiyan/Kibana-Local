/**
 * Dictionary encoding for low-cardinality string fields (level, service, host, method, …).
 *
 * JSON.parse allocates a fresh string for every value of every line, so 200k rows with
 * `"level":"INFO"` hold 200k copies of "INFO". Routing values through a per-field dictionary
 * makes every row point at one shared instance, and remembers its lowercase form so ingest
 * does not lowercase it again.
 *
 * A field stops being encoded (permanently) once it shows more than {@link DICT_MAX_DISTINCT}
 * distinct values: ids and timestamps would only fill the dictionary with strings nobody shares.
 * The total size is bounded too, so the dictionary itself never becomes the memory problem.
 */

/** longer values are never encoded (messages, stack traces, payloads) */
export const DICT_MAX_VALUE = 64;
/** a field with more distinct values than this is high-cardinality and is left alone */
export const DICT_MAX_DISTINCT = 1024;
/** total values across all fields */
const DICT_MAX_TOTAL = 64 * 1024;
/** fields tracked (encoded or rejected) */
const DICT_MAX_FIELDS = 4096;

export interface DictEntry {
  /** the shared instance */
  s: string;
  lower: string;
}

export class ValueDict {
  /** null: the field turned out to be high-cardinality */
  private fields = new Map<string, Map<string, DictEntry> | null>();
  private total = 0;

  /**
   * The shared entry for `v` in `field`, or undefined when the value is not encoded
   * (too long, high-cardinality field, or dictionary full).
   */
  lookup(field: string, v: string): DictEntry | undefined {
    if (v.length > DICT_MAX_VALUE) return undefined;
    let d = this.fields.get(field);
    if (d === null) return undefined;
    if (d === undefined) {
      if (this.fields.size >= DICT_MAX_FIELDS) return undefined;
      d = new Map();
      this.fields.set(field, d);
    }
    const hit = d.get(v);
    if (hit) return hit;
    if (d.size >= DICT_MAX_DISTINCT) {
      // high-cardinality: drop its values (rows keep theirs) and stop tracking it
      this.total -= d.size;
      this.fields.set(field, null);
      return undefined;
    }
    if (this.total >= DICT_MAX_TOTAL) return undefined;
    const e: DictEntry = { s: v, lower: v.toLowerCase() };
    d.set(v, e);
    this.total++;
    return e;
  }

  /** number of values held (for tests) */
  get size() { return this.total; }
}
