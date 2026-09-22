# Dinkster Desktop

Dinkster Desktop is the Windows host for the Dinkster local workflow engine and
browser editor. Its Electron shell installs and supervises a pinned engine,
serves the bundled editor on loopback, and keeps application updates separate
from user projects, models, and generated files.

Status: in progress. There is no public installer or stable release yet.

The current implementation targets Windows x64. The
[Desktop engine boundaries](docs/desktop.md) document release inputs,
installation roots, process supervision, updates, and platform limits.

## Develop from source

Install Node.js 22 and pnpm 10.31.0. Build Dinkster-Frontend in a sibling
checkout, point Desktop at that bundle, then install and validate the workspace:

```powershell
cd ..\Dinkster-Frontend
pnpm install --frozen-lockfile
pnpm --filter @dinkster/app build

cd ..\Dinkster-Desktop
$env:DINKSTER_FRONTEND_DIST = '..\Dinkster-Frontend\packages\app\dist'
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Packaging an installer additionally requires the backend engine archive and
Aimdo wheel named by `packages/desktop/src/backend-release.json`. Ordinary
development, type checking, and unit tests do not publish or dispatch a release.

## Inputs

Desktop pins its application and engine inputs independently:

- Dinkster-Frontend is checked out at the immutable
  `DINKSTER_FRONTEND_REF` in `.github/workflows/ci.yml`. Desktop copies only
  its built `packages/app/dist` bundle and does not compile against frontend
  workspace source.
- The backend release, native profile, and checksums are pinned in
  `packages/desktop/src/backend-release.json`. Packaging accepts only matching
  artifacts supplied through `DINKSTER_ENGINE_ARCHIVE` and
  `DINKSTER_AIMDO_WHEEL`.

## Continuous integration

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
  "macos": ["self-hosted", "macos", "arm64"],
  "forkLinux": ["ubuntu-latest"]
}
```

After the repository is public, one variable change moves all eligible jobs to
GitHub-hosted runners:

```json
{
  "linux": ["ubuntu-latest"],
  "windows": ["windows-latest"],
  "macos": ["macos-latest"],
  "forkLinux": ["ubuntu-latest"]
}
```

Every main run uploads `main-validation-status` with the Linux, browser, and
Windows results. The aggregate status fails unless every lane passed.
