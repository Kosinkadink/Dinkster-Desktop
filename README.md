# Dinkster Desktop

Electron host for the Dinkster application and its local engine lifecycle.
The [Desktop engine boundaries](docs/desktop.md) document the release mirror,
project install-root bindings, and supervisor-per-generation swap contract.

## Inputs

The desktop shell and its two external inputs are pinned independently:

- Dinkster-Frontend is checked out at the 40-character `DINKSTER_FRONTEND_REF` in `.github/workflows/ci.yml`. The frontend checkout builds `@dinkster/app`; Desktop copies only the resulting `packages/app/dist` bundle into its package input. Desktop does not compile against frontend workspace source.
- The backend release, native profile, and checksums are pinned in `packages/desktop/src/backend-release.json`. Packaging accepts only the matching backend archive and Aimdo wheel supplied through `DINKSTER_ENGINE_ARCHIVE` and `DINKSTER_AIMDO_WHEEL`.

While Dinkster-Frontend is private, Actions requires a `DINKSTER_FRONTEND_READ_TOKEN` secret with read-only Contents access to that repository. The token is used only by the pinned frontend checkout and is not persisted by the checkout action.

For a local build, build the pinned Dinkster-Frontend checkout first and point `DINKSTER_FRONTEND_DIST` at its `packages/app/dist` directory:

```powershell
$env:DINKSTER_FRONTEND_DIST = '..\Dinkster-Frontend\packages\app\dist'
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
```

`pnpm --filter @dinkster/desktop package:win` additionally requires the two verified backend release artifacts. The private release workflows remain manual; local validation must not dispatch them or publish a release.

Pull requests run formatting, types, unit tests, and the Linux build with a
10-minute budget. Main adds the pinned frontend browser suite and Windows
packaging in parallel, with a 20-minute end-to-end budget. The `CI_RUNNERS`
repository variable is required. A pull request without private frontend
access reports that validation did not run and fails rather than appearing
green. The private-repository variable value is:

```json
{
  "linux": ["self-hosted", "linux", "x64"],
  "windows": ["self-hosted", "windows", "x64"],
  "macos": ["self-hosted", "macos", "arm64"]
}
```

After the repository is public, one variable change moves all eligible jobs to
GitHub-hosted runners:

```json
{
  "linux": ["ubuntu-latest"],
  "windows": ["windows-latest"],
  "macos": ["macos-latest"]
}
```

Every main run uploads `main-validation-status` with the Linux, browser, and
Windows results. The aggregate status fails unless every lane passed.
