# fixtures/reactapp

A minimal Vite + React Router single-page app, used by the tests. It has no
`node_modules`; `react` in `package.json` switches the `react` adapter on, and
its `^19` range selects the React 19 attribute names (`jsx:attr:href`).

- `src/pages/SearchPage.tsx`: `useSearchParams()` gives `q`, which
  - is passed as a prop through `Results` to `Highlight`, which renders it with
    `dangerouslySetInnerHTML` (`jsx:html`);
  - is assigned to `window.location.href` in an `onClick` handler;
  - reaches a second `dangerouslySetInnerHTML` through a `useState` setter.
- `src/pages/UserPage.tsx`: `useParams()` gives `id`, which goes into
  ``fetch(`${import.meta.env.VITE_API_URL}/api/users/${id}`)``, the client half of
  `http:GET /api/users/{}` with an unresolved base URL.
- `src/pages/SignupPage.tsx`: an input's value, kept in state, is the body of
  `axios.post('/api/users', …)`, the client half of `http:POST /api/users`.
- `src/main.tsx`: the router; `vite.config.ts` and `index.html` are not
  extracted (the walk starts at `src/`).

The extraction prints the "0 endpoints and 0 operations" warning: a browser app
has no server endpoints, its sources are the catalog's.
