# fixtures/nextapp

A minimal Next.js app (App Router plus one Pages Router API route), used by the
tests. It has no `node_modules`; the `next` dependency in `package.json` is
what switches the Next.js route conventions on.

- `app/api/run/route.ts`: `GET /api/run` reads `request.nextUrl.searchParams`
  and passes it to `child_process.exec`.
- `app/api/users/[id]/route.ts`: `GET` and (through `export { remove as DELETE }`)
  `DELETE /api/users/[id]`; the awaited `params` reach a `pg` query.
- `app/actions.ts`: a `'use server'` module; `renameUser`'s parameters reach a
  `pg` query.
- `app/users/[id]/page.tsx`: a page whose `params`/`searchParams` props are
  untrusted; it renders `Profile`.
- `app/users/[id]/Profile.tsx`: a client component that calls
  `fetch('/api/users/' + id)` (which links to the route above) and the server
  action.
- `app/(marketing)/about/page.tsx`: a route group, served at `/about`.
- `app/_components/Hidden/page.tsx`: a private folder, not routable.
- `pages/api/legacy.ts`: `* /api/legacy`, a redirect from `req.query`.
