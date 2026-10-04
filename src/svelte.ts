// Svelte -> TypeScript lowering. The two <script> blocks are concatenated and
// template facts are appended as ordinary statements, so the flow builder needs
// no template vocabulary of its own:
//   {@html e}            ->  __pc_html(e);            (call site "svelte:html")
//   bind:value={v}       ->  v = __pc_bind();         (call site "svelte:bind")
//   on:click={h} / {e}   ->  __pc_tpl(h);             (keeps the expression live)
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

interface Range {
  start: number;
  end: number;
}

/**
 * call shape 7 — the lowered unit is a concatenation of the two
 * `<script>` bodies plus synthesised template statements, so a position in it
 * is a few lines off the position in the .svelte file. `segs` maps a lowered
 * range back: a `point` segment (a synthesised `__pc_tpl(…)` statement, whose
 * text was whitespace-collapsed) collapses to the original expression's start.
 */
export interface SvelteMap {
  segs: Array<{ lo: number; hi: number; orig: number; point: boolean }>;
  /** offsets of the line starts of the ORIGINAL .svelte text */
  lineStarts: number[];
}

function lineStartsOf(src: string): number[] {
  const out = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}

/** lowered offset -> original .svelte offset */
export function mapSveltePos(m: SvelteMap, pos: number): number {
  let lo = 0;
  let hi = m.segs.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (m.segs[mid]!.lo <= pos) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (best < 0) return m.segs.length ? m.segs[0]!.orig : 0;
  const s = m.segs[best]!;
  if (s.point) return s.orig;
  return s.orig + Math.min(pos - s.lo, s.hi - s.lo);
}

function isRange(v: unknown): v is Range {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Range).start === 'number' &&
    typeof (v as Range).end === 'number'
  );
}

/**
 * Returns the lowered TS source for a .svelte file plus the offset in the
 * lowered text at which the instance script begins (spans stay approximate;
 * they are reporting-only in CGF).
 */
export function lowerSvelte(src: string): { code: string; warn?: string; map?: SvelteMap } {
  let ast: unknown;
  try {
    const { parse } = require_('svelte/compiler') as { parse: (s: string, o?: unknown) => unknown };
    try {
      ast = parse(src, { modern: true });
    } catch {
      ast = parse(src);
    }
  } catch (e) {
    return { code: '', warn: `svelte parse unavailable: ${(e as Error).message}` };
  }
  const lineStarts = lineStartsOf(src);

  const scripts: Range[] = [];
  const html: Range[] = [];
  const binds: Array<{ name: string; expr: Range }> = [];
  const tpl: Range[] = [];

  const root = ast as Record<string, unknown>;
  for (const key of ['module', 'instance']) {
    const blk = root[key] as Record<string, unknown> | undefined;
    const content = blk?.['content'];
    if (isRange(content)) scripts.push(content);
  }

  const seen = new Set<unknown>();
  const visit = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    if (seen.has(n)) return;
    seen.add(n);
    if (Array.isArray(n)) {
      for (const c of n) visit(c);
      return;
    }
    const o = n as Record<string, unknown>;
    const type = o['type'];
    if (type === 'Script' || type === 'Program') return; // already captured
    if (type === 'HtmlTag' || type === 'RawMustacheTag') {
      if (isRange(o['expression'])) html.push(o['expression'] as Range);
      return;
    }
    if (type === 'BindDirective' || (type === 'Binding' && typeof o['name'] === 'string')) {
      const ex = o['expression'];
      if (isRange(ex)) binds.push({ name: String(o['name'] ?? 'value'), expr: ex as Range });
      return;
    }
    if (type === 'ExpressionTag' || type === 'MustacheTag' || type === 'OnDirective') {
      if (isRange(o['expression'])) tpl.push(o['expression'] as Range);
      // fall through: on:click={() => …} bodies contain nested tags
    }
    for (const k of Object.keys(o).sort()) {
      if (k === 'parent' || k === 'loc') continue;
      visit(o[k]);
    }
  };
  visit(root['fragment'] ?? root['html']);

  const parts: string[] = [];
  const segs: SvelteMap['segs'] = [];
  let at = 0;
  const push = (text: string, orig: number, point: boolean): void => {
    if (!text) return;
    segs.push({ lo: at, hi: at + text.length, orig, point });
    parts.push(text);
    at += text.length + 1; // the '\n' the join adds
  };
  for (const s of scripts) push(src.slice(s.start, s.end), s.start, false);
  const cut = (r: Range): string => src.slice(r.start, r.end).replace(/\s+/g, ' ').trim();
  // dedupe by TEXT but keep the first range, so the span still points somewhere real
  const uniq = (rs: Range[]): Array<{ text: string; at: number }> => {
    const seen = new Set<string>();
    const out: Array<{ text: string; at: number }> = [];
    for (const r of rs) {
      const t = cut(r);
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push({ text: t, at: r.start });
    }
    return out;
  };
  for (const t of uniq(tpl)) push(`__pc_tpl(${t.text});`, t.at, true);
  for (const b of binds.sort((a, b2) => a.expr.start - b2.expr.start)) {
    const t = cut(b.expr);
    if (t && /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(t)) {
      push(`${t} = __pc_bind();`, b.expr.start, true);
    }
  }
  for (const h of uniq(html)) push(`__pc_html(${h.text});`, h.at, true);
  return { code: parts.join('\n'), map: { segs, lineStarts } };
}
