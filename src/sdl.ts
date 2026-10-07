// The GraphQL schema snapshot plays the role `.proto` plays for gRPC: the
// shared contract that tells the client which parent type a selection sits on
// (SDL arg names are recorded but unused: emitted `arg_names` come from the
// operation document, in document order). Only the AST is walked (`parse`), never
// `buildSchema` — a real federated schema snapshot is ~13 MB and validation would cost
// more than the whole extraction budget.
import { parse, Kind, type DocumentNode, type TypeNode } from 'graphql';

export interface SdlField {
  /** unwrapped named result type */
  type: string;
  /** SDL arg names in declaration order */
  args: string[];
}

export class Sdl {
  /** Type -> field -> info */
  readonly types = new Map<string, Map<string, SdlField>>();
  queryType = 'Query';
  mutationType = 'Mutation';
  subscriptionType = 'Subscription';

  get empty(): boolean {
    return this.types.size === 0;
  }

  field(type: string, name: string): SdlField | undefined {
    return this.types.get(type)?.get(name);
  }

  rootType(op: string): string {
    if (op === 'mutation') return this.mutationType;
    if (op === 'subscription') return this.subscriptionType;
    return this.queryType;
  }

  add(doc: DocumentNode): void {
    for (const def of doc.definitions) {
      if (def.kind === Kind.SCHEMA_DEFINITION || def.kind === Kind.SCHEMA_EXTENSION) {
        for (const ot of def.operationTypes ?? []) {
          if (ot.operation === 'query') this.queryType = ot.type.name.value;
          else if (ot.operation === 'mutation') this.mutationType = ot.type.name.value;
          else this.subscriptionType = ot.type.name.value;
        }
        continue;
      }
      if (
        def.kind !== Kind.OBJECT_TYPE_DEFINITION &&
        def.kind !== Kind.OBJECT_TYPE_EXTENSION &&
        def.kind !== Kind.INTERFACE_TYPE_DEFINITION &&
        def.kind !== Kind.INTERFACE_TYPE_EXTENSION
      ) {
        continue;
      }
      const tname = def.name.value;
      let m = this.types.get(tname);
      if (!m) this.types.set(tname, (m = new Map()));
      for (const f of def.fields ?? []) {
        m.set(f.name.value, {
          type: namedType(f.type),
          args: (f.arguments ?? []).map((a) => a.name.value),
        });
      }
    }
  }
}

function namedType(t: TypeNode): string {
  let n = t;
  while (n.kind === Kind.NON_NULL_TYPE || n.kind === Kind.LIST_TYPE) n = n.type;
  return n.name.value;
}

export function loadSdl(texts: string[]): Sdl {
  const s = new Sdl();
  for (const t of texts) {
    let doc: DocumentNode;
    try {
      doc = parse(t, { noLocation: true });
    } catch (e) {
      process.stderr.write(`schema-warn: cannot parse SDL: ${(e as Error).message}\n`);
      continue;
    }
    s.add(doc);
  }
  return s;
}
