export function viaPush(el: HTMLElement) {
  const q = new URLSearchParams(location.search).get('q') ?? '';
  const parts: string[] = [];
  parts.push(q);
  el.innerHTML = parts.join(',');
}

export function viaMap(el: HTMLElement) {
  const q = new URLSearchParams(location.search).get('q') ?? '';
  const m = new Map<string, string>();
  m.set('k', q);
  el.innerHTML = m.get('k') ?? '';
}

export function viaSet(el: HTMLElement) {
  const q = new URLSearchParams(location.search).get('q') ?? '';
  const s = new Set<string>();
  s.add(q);
  el.innerHTML = Array.from(s).join(',');
}

export function viaAssign(el: HTMLElement) {
  const q = new URLSearchParams(location.search).get('q') ?? '';
  const target: { v?: string } = {};
  Object.assign(target, { v: q });
  el.innerHTML = target.v ?? '';
}

export function viaParams() {
  const q = new URLSearchParams(location.search).get('q') ?? '';
  const p = new URLSearchParams();
  p.append('q', q);
  fetch('/api?' + p.toString());
}

// precision: the request goes into one array, the sink reads another
export function cleanPush(el: HTMLElement) {
  const q = new URLSearchParams(location.search).get('q') ?? '';
  const tainted: string[] = [];
  const clean: string[] = [];
  tainted.push(q);
  clean.push('safe');
  el.innerHTML = clean.join(',');
}

// precision: `.push` on a receiver of unknown type is not assumed to be Array
declare function router(): { push(u: string): void; toString(): string };
export function untypedPush(el: HTMLElement) {
  const q = new URLSearchParams(location.search).get('q') ?? '';
  const r = router();
  r.push(q);
  el.innerHTML = r.toString();
}
