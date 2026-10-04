// The three `graphql-request` shapes the adapter declares.
import { GraphQLClient, request } from 'graphql-request';
import { LOGIN } from './ops';
import { getSdk } from './sdk';

const client = new GraphQLClient('/graphql');

/** `client.request(DOC, variables)` */
export async function viaClient(el: HTMLElement) {
  const token = new URLSearchParams(location.search).get('token');
  const res = await client.request(LOGIN, { token, remember: true });
  el.innerHTML = res.login.token;
}

/** `request(url, DOC, variables)` — the document is arg 1, not arg 0 */
export async function viaBare(el: HTMLElement) {
  const token = new URLSearchParams(location.search).get('token');
  const res = await request('/graphql', LOGIN, { token });
  el.innerHTML = res.login.token;
}

/** codegen SDK: the METHOD NAME is the operation name */
export async function viaSdk(el: HTMLElement) {
  const sdk = getSdk(client);
  const token = new URLSearchParams(location.search).get('token');
  const res = await sdk.Login({ token });
  el.innerHTML = res.login.token;
}
