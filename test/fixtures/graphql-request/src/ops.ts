import { gql } from 'graphql-request';

export const LOGIN = gql`
  mutation Login($token: String!, $remember: Boolean) {
    login(token: $token, remember: $remember) {
      token
    }
  }
`;
