import { LOGIN } from './ops';

export async function directLogin(client: any, el: HTMLElement) {
  const token = new URLSearchParams(location.search).get('token');
  const res = await client.mutate({ mutation: LOGIN, variables: { token } });
  el.innerHTML = res.data.login.token;
}
