// A deliberately small TOML reader for adapter files (`adapters/*.toml`).
//
// pc-fe-ts ships no TOML dependency: an adapter is DATA, and the subset an
// adapter needs is tiny and fully specified here, so the parser is ~100 lines
// instead of a package. Supported:
//
//   # comment
//   key = "string" | 'literal' | 123 | true | false
//   key = ["a", "b"]                       (arrays of the above, one line)
//   [[table]]                              (array of tables; scalars/arrays only)
//
// NOT supported (and rejected loudly, so unsupported syntax is never misread;
// a misspelled key is valid syntax and is ignored):
// `[table]`, nested/dotted keys, inline tables, multi-line arrays, datetimes.
// The adapter schema is designed to stay inside this subset.

export type TomlValue = string | number | boolean | Array<string | number | boolean>;
export type TomlTable = Record<string, TomlValue>;

export interface TomlDoc {
  /** root-level `key = value` pairs */
  root: TomlTable;
  /** `[[name]]` sections, in file order */
  tables: Map<string, TomlTable[]>;
}

function fail(file: string, line: number, msg: string): never {
  throw new Error(`${file}:${line}: ${msg}`);
}

/** Parse one scalar or one single-line array. */
function parseValue(file: string, ln: number, s0: string): TomlValue {
  const s = s0.trim();
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) fail(file, ln, 'multi-line arrays are not supported');
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    const out: Array<string | number | boolean> = [];
    let i = 0;
    for (;;) {
      while (i < inner.length && /[\s,]/.test(inner[i]!)) i++;
      if (i >= inner.length) break;
      const [v, next] = parseScalar(file, ln, inner, i);
      out.push(v);
      i = next;
    }
    return out;
  }
  const [v, next] = parseScalar(file, ln, s, 0);
  if (s.slice(next).trim()) fail(file, ln, `trailing text after value: ${s.slice(next)}`);
  return v;
}

function parseScalar(
  file: string,
  ln: number,
  s: string,
  i0: number,
): [string | number | boolean, number] {
  let i = i0;
  const q = s[i];
  if (q === '"' || q === "'") {
    i++;
    let out = '';
    while (i < s.length && s[i] !== q) {
      if (q === '"' && s[i] === '\\') {
        const c = s[++i];
        out +=
          c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c === '0' ? '\0' : (c ?? '');
        i++;
        continue;
      }
      out += s[i++];
    }
    if (s[i] !== q) fail(file, ln, 'unterminated string');
    return [out, i + 1];
  }
  const m = /^(true|false|-?\d+)/.exec(s.slice(i));
  if (!m) fail(file, ln, `not a scalar: ${s.slice(i, i + 20)}`);
  const t = m[1]!;
  return [t === 'true' ? true : t === 'false' ? false : Number(t), i + t.length];
}

/** Strip a trailing `# comment` that is not inside a string. */
function stripComment(s: string): string {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '#') return s.slice(0, i);
  }
  return s;
}

export function parseToml(text: string, file = '<toml>'): TomlDoc {
  const doc: TomlDoc = { root: {}, tables: new Map() };
  let cur: TomlTable = doc.root;
  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const raw = stripComment(lines[n]!).trim();
    if (!raw) continue;
    const ln = n + 1;
    if (raw.startsWith('[[')) {
      if (!raw.endsWith(']]')) fail(file, ln, 'malformed [[table]] header');
      const name = raw.slice(2, -2).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        fail(file, ln, `[[${name}]]: only flat array-of-table names are supported`);
      }
      cur = {};
      const list = doc.tables.get(name);
      if (list) list.push(cur);
      else doc.tables.set(name, [cur]);
      continue;
    }
    if (raw.startsWith('[')) fail(file, ln, '[table] is not supported; use [[table]]');
    const eq = raw.indexOf('=');
    if (eq < 0) fail(file, ln, `expected key = value, got: ${raw}`);
    const key = raw.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) fail(file, ln, `bad key: ${key}`);
    if (key in cur) fail(file, ln, `duplicate key: ${key}`);
    cur[key] = parseValue(file, ln, raw.slice(eq + 1));
  }
  return doc;
}

// --- typed accessors (an adapter typo must be an error, not a silent no-op) --

export function str(t: TomlTable, k: string, where: string): string | undefined {
  const v = t[k];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new Error(`${where}: ${k} must be a string`);
  return v;
}

export function num(t: TomlTable, k: string, where: string): number | undefined {
  const v = t[k];
  if (v === undefined) return undefined;
  if (typeof v !== 'number') throw new Error(`${where}: ${k} must be an integer`);
  return v;
}

export function bool(t: TomlTable, k: string, where: string): boolean | undefined {
  const v = t[k];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new Error(`${where}: ${k} must be true or false`);
  return v;
}

export function strs(t: TomlTable, k: string, where: string): string[] {
  const v = t[k];
  if (v === undefined) return [];
  if (typeof v === 'string') return [v];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new Error(`${where}: ${k} must be a string or an array of strings`);
  }
  return v as string[];
}
