// GraphQL operation -> INVOKES_REMOTE call sites.
//
// The operation document plus the repo's `schema.graphql` snapshot are the only
// two inputs. Walking the selection set against the SDL gives the PARENT TYPE of
// every field, which is what makes the join key schema-native:
//   callee_iids = [ContractIID("graphql:<ParentType>.<field>")]
// byte-equal to what the Go frontend computes on the resolver side (the CGF contract).
import { Kind, parse, type DocumentNode, type ValueNode, type SelectionSetNode } from 'graphql';
import type { Sdl } from './sdl.js';

export interface RemoteField {
  /** "AuthMutations.login" */
  typeField: string;
  /** SDL arg names in document order */
  argNames: string[];
  /** parallel to argNames: does the argument value reference an operation $var? */
  argUsesVar: boolean[];
  /** true when the parent type came from the SDL, false when it was a fallback */
  viaSdl: boolean;
}

export interface OpDoc {
  /** operation name, "" when anonymous */
  name: string;
  fields: RemoteField[];
  warnings: string[];
}

function usesVariable(v: ValueNode): boolean {
  switch (v.kind) {
    case Kind.VARIABLE:
      return true;
    case Kind.LIST:
      return v.values.some(usesVariable);
    case Kind.OBJECT:
      // nested input objects: login(input: { pincode: $pincode }) — the whole
      // `input` arg carries the variable (known gap: k=2 field paths later)
      return v.fields.some((f) => usesVariable(f.value));
    default:
      return false;
  }
}

/** Parse an operation document and enumerate the fields that carry arguments. */
export function analyzeDocument(text: string, sdl: Sdl): OpDoc[] {
  let doc: DocumentNode;
  try {
    doc = parse(text, { noLocation: true });
  } catch (e) {
    return [{ name: '', fields: [], warnings: [`gql parse: ${(e as Error).message}`] }];
  }
  // fragment name -> (typeCondition, selectionSet)
  const frags = new Map<string, { on: string; sel: SelectionSetNode }>();
  for (const d of doc.definitions) {
    if (d.kind === Kind.FRAGMENT_DEFINITION) {
      frags.set(d.name.value, { on: d.typeCondition.name.value, sel: d.selectionSet });
    }
  }
  const out: OpDoc[] = [];
  for (const d of doc.definitions) {
    if (d.kind !== Kind.OPERATION_DEFINITION) continue;
    const op: OpDoc = { name: d.name?.value ?? '', fields: [], warnings: [] };
    const root = sdl.rootType(d.operation);
    const seen = new Set<string>();
    const walk = (parent: string, sel: SelectionSetNode, known: boolean, depth: number): void => {
      if (depth > 24) return;
      for (const s of sel.selections) {
        if (s.kind === Kind.FRAGMENT_SPREAD) {
          const f = frags.get(s.name.value);
          if (f && !seen.has(s.name.value)) {
            seen.add(s.name.value);
            walk(f.on, f.sel, !sdl.empty, depth + 1);
            seen.delete(s.name.value);
          }
          continue;
        }
        if (s.kind === Kind.INLINE_FRAGMENT) {
          walk(s.typeCondition?.name.value ?? parent, s.selectionSet, known, depth + 1);
          continue;
        }
        const fname = s.name.value;
        const info = sdl.field(parent, fname);
        if (s.arguments && s.arguments.length > 0) {
          if (known || depth === 0) {
            op.fields.push({
              typeField: `${parent}.${fname}`,
              argNames: s.arguments.map((a) => a.name.value),
              argUsesVar: s.arguments.map((a) => usesVariable(a.value)),
              viaSdl: known && !!info,
            });
          } else {
            op.warnings.push(
              `graphql-warn: no SDL parent type for ${parent}.${fname} — field skipped`,
            );
          }
        }
        if (s.selectionSet) {
          const child = info?.type;
          walk(child ?? `${parent}.${fname}`, s.selectionSet, known && !!child, depth + 1);
        }
      }
    };
    if (sdl.empty) {
      op.warnings.push(`graphql-warn: no SDL — root fields only for operation ${op.name || '?'}`);
      walk(root, d.selectionSet, false, 0);
    } else {
      walk(root, d.selectionSet, true, 0);
    }
    out.push(op);
  }
  return out;
}
