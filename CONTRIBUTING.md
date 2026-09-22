# Contributing to Dinkster Desktop

## Local checks

Install Node.js 22 and pnpm 10.31.0, then run the fast checks from the
repository root:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
```

To verify the production build, build the pinned Dinkster-Frontend revision
from `.github/workflows/ci.yml`, point `DINKSTER_FRONTEND_DIST` at its
`packages/app/dist` directory, and run `pnpm build`.

## Pull requests

- Keep each pull request focused and include tests for behavior changes.
- Keep Dinkster-Frontend and backend inputs pinned to immutable 40-character
  commits.
- Do not put repository credentials, release tokens, or backend credentials in
  source, build artifacts, fixtures, or installed applications.
- Update current documentation when behavior or supported platforms change.
- Use ASCII in source, tests, documentation, commit messages, and pull request
  text.

GitHub may hold workflows from fork pull requests until a maintainer approves
the run. That approval is the repository's fork CI security gate.
