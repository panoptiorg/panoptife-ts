// LocalFlow builder: intraprocedural def-use over a name-based value graph,
// projected onto CGF ports. Mirrors the Go frontend's contract
// (frontend/internal/flow/flow.go):
//   - dense u32 vertex ids, local to the function;
//   - CALL_ARG_PORT / CALL_RESULT_PORT keyed by (callsite_id, index);
//   - calls are BARRIERS — an edge never runs through a call, only into an arg
//     port and out of a result port;
//   - edges connect vertices, never values.
//
// Aggregate taint (the flow model): any member of a tainted object is tainted, an
// object literal holding a tainted value is tainted, await/?./spread are
// transparent. The value graph is name-based and flow-INSENSITIVE inside one
// function, which is what makes inlined closures work for free.
import type { CallSite, FlowEdge, FlowVertex, LocalFlow, Span } from './model.js';
import { VertexKind } from './cgf.js';

export class FlowBuilder {
  readonly vertices: FlowVertex[] = [];
  readonly callsites: CallSite[] = [];
  private readonly succ = new Map<number, number[]>();
  private readonly srcVerts = new Map<number, number[]>();
  private readonly sinkVerts = new Map<number, number[]>();
  private readonly vars = new Map<string, number>();
  private nextVal = 0;
  private outReturn = -1;

  /** a fresh anonymous value node */
  val(): number {
    return this.nextVal++;
  }

  /** the value node standing for a variable name (aggregate, flow-insensitive) */
  varVal(name: string): number {
    let v = this.vars.get(name);
    if (v === undefined) this.vars.set(name, (v = this.val()));
    return v;
  }

  flow(from: number, to: number): void {
    if (from === to) return;
    let a = this.succ.get(from);
    if (!a) this.succ.set(from, (a = []));
    a.push(to);
  }

  addVertex(kind: number, index: number, callsiteId: number, span?: Span): number {
    const id = this.vertices.length;
    const v: FlowVertex = { id, kind };
    if (index) v.index = index;
    if (callsiteId) v.callsiteId = callsiteId;
    if (span) v.span = span;
    this.vertices.push(v);
    return id;
  }

  /** value `v` is READ FROM vertex `vid` (params, result ports) */
  source(v: number, vid: number): void {
    let a = this.srcVerts.get(v);
    if (!a) this.srcVerts.set(v, (a = []));
    a.push(vid);
  }

  /** value `v` FLOWS INTO vertex `vid` (arg ports, returns) */
  sink(v: number, vid: number): void {
    let a = this.sinkVerts.get(v);
    if (!a) this.sinkVerts.set(v, (a = []));
    a.push(vid);
  }

  /** the (single) OUT_RETURN vertex, created on demand */
  returnVertex(): number {
    if (this.outReturn < 0) this.outReturn = this.addVertex(VertexKind.OUT_RETURN, 0, 0);
    return this.outReturn;
  }

  addCallsite(cs: Omit<CallSite, 'id'>): number {
    const id = this.callsites.length;
    this.callsites.push({ id, ...cs });
    return id;
  }

  /**
   * Project the value graph onto the ports: for every source vertex, BFS the
   * values it can reach and emit an edge to every sink vertex on the way.
   */
  build(): LocalFlow {
    const edges = new Set<string>();
    const seen = new Uint8Array(this.nextVal);
    let stamp = 0;
    const mark = new Int32Array(this.nextVal);
    void seen;
    for (const [v0, srcs] of [...this.srcVerts.entries()].sort((a, b) => a[0] - b[0])) {
      stamp++;
      const work = [v0];
      mark[v0] = stamp;
      const reached: number[] = [];
      while (work.length) {
        const v = work.pop()!;
        const sinks = this.sinkVerts.get(v);
        if (sinks) reached.push(...sinks);
        for (const w of this.succ.get(v) ?? []) {
          if (mark[w] !== stamp) {
            mark[w] = stamp;
            work.push(w);
          }
        }
      }
      for (const s of srcs) for (const d of reached) if (s !== d) edges.add(`${s},${d}`);
    }
    const out: FlowEdge[] = [...edges]
      .map((s) => {
        const [a, b] = s.split(',');
        return { from: Number(a), to: Number(b) };
      })
      .sort((x, y) => x.from - y.from || x.to - y.to);
    return { vertices: this.vertices, edges: out, callsites: this.callsites };
  }
}
