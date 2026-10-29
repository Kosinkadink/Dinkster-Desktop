# Dinkster Desktop

Electron host for the Dinkster application and its local engine lifecycle.
The [Desktop engine boundaries](docs/desktop.md) document the release mirror,
project install-root bindings, and supervisor-per-generation swap contract.

## Inputs

The desktop shell and its external inputs are pinned independently:

- Dinkster-Frontend is checked out at the 40-character `DINKSTER_FRONTEND_REF` in `.github/workflows/ci.yml`. The frontend checkout builds `@dinkster/app`; Desktop copies only the resulting `packages/app/dist` bundle into its package input. Desktop does not compile against frontend workspace source.
- The checkout-development backend selection is pinned in `packages/desktop/src/backend-release.json`. Shell packaging does not download or embed that source archive or native wheels. Project generations are acquired by the environment tools, not by the shell's package builder.

For a local build, build the pinned Dinkster-Frontend checkout first and point `DINKSTER_FRONTEND_DIST` at its `packages/app/dist` directory:

```powershell
$env:DINKSTER_FRONTEND_DIST = '..\Dinkster-Frontend\packages\app\dist'
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
```

`pnpm --filter @dinkster/desktop package:win` produces an unsigned shell installer without backend source or native wheel inputs. The release workflow uses `package:win:signed`, which signs through the Artifact Signing account described in [Desktop signing](docs/desktop-signing.md). Version-tag release runs validate before signing; prerelease test tags keep artifacts without publishing a release. Local validation must not dispatch workflows or publish a release. Production local-project bootstrap remains incomplete until the standalone environment tools payload is packaged; a shell-only package is not a complete local installation.

Both signing workflows reference the `desktop-signing` GitHub environment. Its
approval gate is off while the program is being established: no required
reviewers, wait timer or deployment-branch restrictions. Signing uses the
existing repository-level `AZURE_*` secrets without moving them. To enable the
approval gate later, the owner adds themselves as a required reviewer under
Settings -> Environments -> desktop-signing; no workflow change is needed.
The desk pushes a version tag only after the user's approval on the issue.

## Environment client development

Normal startup opens the project manager. Remote projects use the frontend
served by their engine and do not invoke local environment commands. For local
project development, set `DINKSTER_TOOLS_PYTHON` to an explicit environment-tools
interpreter with `dinkster-supervisor` installed, or set `DINKSTER_ENV` to its
`dinkster-env` executable. Desktop does not install tools with pip or uv as a
fallback. Interpreter launches use `-I` and a child-only PATH containing the
bundled scripts directory, not host Python or package managers.

The release-owned standalone tools pin is a declared input, not a latest lookup:
`DINKSTER_TOOLS_MANIFEST` identifies the immutable `dinkster.engine/1` manifest,
`DINKSTER_TOOLS_MANIFEST_SHA256` pins its bytes, and `DINKSTER_TOOLS_RELEASE`
identifies its release directory. Locations are absolute local paths or
credential-free HTTPS. Desktop selects the existing native tools artifact row,
verifies its size and SHA256 before standard ZIP extraction into a new owned
directory, and preserves executable modes while rejecting links and escaping
paths. Tools are acquired only for a local command, reused during that session,
and removed after stopping local engines on normal shutdown. Explicit development
interpreter/command overrides take precedence. Production publication supplies
the pin; no production pin or separate tools manifest is invented here.

Local operations review the command's plan before confirmation. A saved engine
binding starts the existing generation through `dinkster-env start`; updates
and rollbacks route open windows to the newly returned supervisor URL, not the
previous port. Desktop metadata stores bindings only; the environment command
owns `project.json`, store discovery, generations and process identity.

The Linux Electron client boundary check runs with
`node packages/e2e/scripts/verify-environment-client.mjs` under a display (or
`xvfb-run --auto-servernum`). It uses subprocess response stubs to check plan
confirmation, changed-port handoff, rollback, remote-only routing and shutdown
delegation. It is not a substitute for real CLI/generation file comparisons.
`DINKSTER_ELECTRON_EXECUTABLE` optionally selects the installed Electron binary;
`DINKSTER_SMOKE_ARTIFACTS` optionally retains screenshots.

Pull requests run formatting, types, unit tests, and the Linux build with a
10-minute budget. Main adds the pinned frontend browser suite and Windows
packaging in parallel, with a 20-minute end-to-end budget. The `CI_RUNNERS`
repository variable is required and selects GitHub-hosted images for every
job:

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
