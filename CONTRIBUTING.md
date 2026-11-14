# Contributing to Dinkster Desktop

## Local checks

Install Node.js 26.12.0 and pnpm 11.28.8, then run the fast checks from the
repository root:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
```

Run `pnpm build` to verify the production build. It downloads the permanent
frontend wheel selected by `scripts/frontend-release.json`, verifies its size
and SHA256, and prepares application assets and native branding. A frontend
source checkout is not required.

## Pull requests

- Keep each pull request focused and include tests for behavior changes.
- Pin frontend inputs to permanent release wheels by version, URL, size and
  SHA256. Keep checkout-development backend inputs pinned to immutable
  40-character commits.
- Do not put repository credentials, release tokens, or backend credentials in
  source, build artifacts, fixtures, or installed applications.
- Update current documentation when behavior or supported platforms change.
- Use ASCII in source, tests, documentation, commit messages, and pull request
  text.

GitHub may hold workflows from fork pull requests until a maintainer approves
the run. That approval is the repository's fork CI security gate.

## License

Outside contributions are accepted under GPL-3.0-or-later with a grant to
relicense under AGPL-3.0.
