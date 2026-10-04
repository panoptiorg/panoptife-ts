// A URL query parameter flows into a GraphQL mutation variable, and the
// response flows into a DOM sink. Nothing here is company-specific: it is the
// `@apollo/client` shape the adapter declares.
import { useMutation, useQuery } from '@apollo/client';
import { LOGIN, GET_USER } from './ops';

export async function loginPage(el: HTMLElement) {
  const [doLogin] = useMutation(LOGIN);
  const token = new URLSearchParams(location.search).get('token');
  const res = await doLogin({ variables: { token, remember: true } });
  el.innerHTML = res.data.login.token;
}

export function userPage(el: HTMLElement) {
  const id = new URLSearchParams(location.search).get('id');
  const { data } = useQuery(GET_USER, { variables: { id } });
  el.innerHTML = data.user.name;
}
