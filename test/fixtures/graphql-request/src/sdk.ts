// Stand-in for a `graphql-code-generator` SDK module: one method per operation.
export function getSdk(client: any) {
  return {
    Login: (variables: any) => client.request('Login', variables),
  };
}
