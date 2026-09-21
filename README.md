# Dinkster Desktop

Electron host for the Dinkster application and its local engine lifecycle.

## Inputs

The desktop shell and its two external inputs are pinned independently:

- Dinkster-Frontend is checked out at the 40-character `DINKSTER_FRONTEND_REF` in `.github/workflows/ci.yml`. The frontend checkout builds `@dinkster/app`; Desktop copies only the resulting `packages/app/dist` bundle into its package input. Desktop does not compile against frontend workspace source.
- The backend release, wheel-manifest checksum, native profile, and commit are pinned in `packages/desktop/src/backend-release.json`. Packaging accepts only the matching release manifest, constraints, complete wheel set, and Aimdo wheel supplied through `DINKSTER_ENGINE_RELEASE` and `DINKSTER_AIMDO_WHEEL`.

While Dinkster-Frontend is private, Actions requires a `DINKSTER_FRONTEND_READ_TOKEN` secret with read-only Contents access to that repository. The token is used only by the pinned frontend checkout and is not persisted by the checkout action.

For a local build, build the pinned Dinkster-Frontend checkout first and point `DINKSTER_FRONTEND_DIST` at its `packages/app/dist` directory:

```powershell
$env:DINKSTER_FRONTEND_DIST = '..\Dinkster-Frontend\packages\app\dist'
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
```

`pnpm --filter @dinkster/desktop package:win` additionally requires the verified backend release directory and Aimdo wheel. First-run provisioning creates a managed Python environment and installs the pinned release with `uv pip install --no-deps --require-hashes`; it does not extract backend source or run `uv sync`. The private release workflows remain manual; local validation must not dispatch them or publish a release.
