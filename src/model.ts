// Plain-object mirrors of cgf.proto (camelCase — protobufjs' default field
// naming). Only the fields the TS frontend actually emits are modelled.

export interface Span {
  file: string;
  line: number;
  col: number;
}

export interface FlowVertex {
  id: number;
  kind: number;
  index?: number;
  callsiteId?: number;
  type?: string;
  span?: Span;
}

export interface FlowEdge {
  from: number;
  to: number;
}

export interface CallSite {
  id: number;
  kind?: number;
  calleeIids?: Uint8Array[];
  opaque?: boolean;
  calleeFqn: string;
  argc?: number;
  arg0IsReceiver?: boolean;
  resultc?: number;
  span?: Span;
  dispatchConfidence?: number;
  /** WS-A addition; emitted only when the loaded descriptor has the field. */
  argNames?: string[];
  /** coverage wave 1 §3.4 — set only on a synthetic HTTP client site */
  httpCall?: HttpCall;
}

export interface HttpCall {
  /** upper case; "" = unknown */
  method: string;
  /** canonical template; leading `{}` segments = an unresolved base URL */
  path: string;
}

export interface LocalFlow {
  vertices: FlowVertex[];
  edges: FlowEdge[];
  callsites: CallSite[];
}

export interface Param {
  name: string;
  type: string;
}

export interface Signature {
  params: Param[];
  hasReceiver?: boolean;
  returns: { type: string }[];
}

export interface Fn {
  id: { iid: Uint8Array; bid: Uint8Array };
  fqn: string;
  package: string;
  origin?: number;
  generated?: boolean;
  hasBody: boolean;
  span: Span;
  signature: Signature;
  flow?: LocalFlow;
  bindsTo?: Uint8Array[];
  sourceParams?: number[];
}

export interface Endpoint {
  iid: Uint8Array;
  kind: number;
  untrustedInput?: boolean;
  name: string;
}

/** coverage wave 1 §3.3 — a server-side route, the contract an HttpCall links to */
export interface HttpRoute {
  iid: Uint8Array;
  method: string;
  path: string;
  display: string;
  handlerIid: Uint8Array;
  endpointIid: Uint8Array;
  requestParams: number[];
  framework: string;
}

export interface CgfPackage {
  repo: string;
  commitSha: string;
  packagePath: string;
  schemaVersion: number;
  language: string;
  functions: Fn[];
  endpoints?: Endpoint[];
  httpRoutes?: HttpRoute[];
}
