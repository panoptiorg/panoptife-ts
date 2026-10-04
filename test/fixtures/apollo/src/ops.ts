import { gql } from '@apollo/client';

export const LOGIN = gql`
  mutation Login($token: String!, $remember: Boolean) {
    login(token: $token, remember: $remember) {
      token
    }
  }
`;

export const GET_USER = gql`
  query GetUser($id: ID!) {
    user(id: $id) {
      name
    }
  }
`;
