# Dinkster Desktop

Electron host for the Dinkster application and its local engine lifecycle.
The [Desktop engine boundaries](docs/desktop.md) document the release mirror,
project install-root bindings, and supervisor-per-generation swap contract.

## Inputs

The desktop shell and its external inputs are pinned independently:

- `scripts/frontend-release.json` pins the permanent `dinkster-frontend` PyPI wheel by version, URL, size and SHA256. `pnpm prepare:frontend` verifies that wheel and copies its application and native branding into the package inputs. The engine selects the same published frontend release; Desktop does not build frontend source.
- The checkout-development backend selection is pinned in `packages/desktop/src/backend-release.json`. Shell packaging does not download or embed that source archive or native wheels. Project generations are acquired by the environment tools, not by the shell's package builder.

A local build uses the same verified release as CI, without a frontend checkout:

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
```

`pnpm --filter @dinkster/desktop package:win` produces an unsigned Windows installer; `package:linux` produces a Linux AppImage; `package:mac` produces an unsigned Apple Silicon ZIP. All include the native standalone environment tools ZIP and its tools manifest, not backend source, engine wheels or base bundles. `packages/desktop/src/environment-tools-release.json` pins the independent tools publication label, sizes, SHA256 digests and pin date independently of the checkout-development backend. Build preparation downloads and verifies those public inputs from `https://releases.dinkster.org/tools/<label>` before packaging. The Windows release uses `package:win:signed` through the Artifact Signing account described in [Desktop signing](docs/desktop-signing.md). A merged version PR carrying the desk-applied `Release` label tags its squash commit and dispatches the shared installer/publisher chain. The verified installers, source metadata, checksums, Windows/Linux updater manifests and Windows blockmap publish on that existing `desktop-v<version>` tag. Release candidates publish without moving latest. See [Publishing installers](docs/desktop.md#publishing-installers). Local validation must not dispatch workflows or publish a release.

Both signing workflows reference the `desktop-signing` GitHub environment. Its
approval gate is off while the program is being established: no required
reviewers, wait timer or deployment-branch restrictions. Signing uses the
existing repository-level `AZURE_*` secrets without moving them. To enable the
approval gate later, the owner adds themselves as a required reviewer under
Settings -> Environments -> desktop-signing; no workflow change is needed.
The desk controls release timing through the `Release` label; the tag job creates the version ref and the publisher creates its release without moving that ref.

## Apple Silicon macOS

Apple Silicon on macOS 14 or newer is the supported Mac target. Intel Macs
are not supported. `pnpm --filter @dinkster/desktop package:mac` builds an
arm64 ZIP containing an unsigned `.app`, without an Apple signing identity
or notarization. The engine uses the `mac-arm64` base and MPS, not CUDA.
Local project setup selects the Apple Silicon base from the channel catalog
without requiring an NVIDIA GPU or an explicit CPU fallback.

The Desktop release workflow builds this ZIP on hosted `macos-latest`,
checks the extracted executable's arm64 architecture, and retains the ZIP,
source metadata and SHA256 in `desktop-unsigned-macos-arm64`. Packaging
changes also run this job on pull requests without signing credentials.
Publication on the existing version tag uploads the same verified Mac ZIP alongside the signed
Windows installer, with separate source metadata and shared `SHA256SUMS`.
The extracted Mac app's bundled tools archive and manifest are checked against
the same immutable pin used by Windows and Linux packaging. Engine and base
payloads are acquired during setup, not included in the app.

Verify the ZIP's checksum, extract it with app permissions preserved, and
copy the app to a directory you control. Gatekeeper may require right-click
**Open** or removal of `com.apple.quarantine` from that verified app before
launch. This unsigned-build procedure does not establish a signature or
notarization. [Apple signing and notarization](https://github.com/Kosinkadink/comfy-vibe-station/issues/501)
are separate from tools and engine setup, doctor, start, update and rollback.
Local project commands use the native environment tools, not host Python or uv.

## Environment client development

Normal startup opens the project manager. Remote projects use the frontend
served by their engine and do not invoke local environment commands. For local
project development, set `DINKSTER_TOOLS_PYTHON` to an explicit environment-tools
interpreter with `dinkster-supervisor` installed, or set `DINKSTER_ENV` to its
`dinkster-env` executable. Desktop does not install tools with pip or uv as a
fallback. Interpreter launches use `-I` and a child-only PATH containing the
bundled scripts directory, not host Python or package managers. Inherited
`PYTHON*` configuration is removed from that child and its engine descendants.

Packaged Desktop uses the bundled tools for local operations without a runtime
tools download. Extraction verifies the manifest and native ZIP, rejects links
and escaping or duplicate paths, and preserves executable modes. The completed
tree lives under the Desktop user-data
`environment-tools/<tools-date>-<version>-<os>-<arch>` directory, survives normal
shutdown, and is reused by full archive SHA256, even if its label changes.
Different archives sharing a label receive `--2`, `--3` suffixes. Existing
digest-named extractions are reused in place. A different pinned archive is
fully checked before the previous payload is removed; small identity records
reserve those paths for later reuse. Remote projects never acquire tools. First
setup and engine updates still acquire their engine and base artifacts from the
configured mirrors.

For development the runtime-download pin remains an explicit input:
`DINKSTER_TOOLS_MANIFEST` identifies the immutable `dinkster.tools/1` manifest,
`DINKSTER_TOOLS_MANIFEST_SHA256` (or `DINKSTER_TOOLS_SHA256`) pins its bytes, and `DINKSTER_TOOLS_RELEASE`
identifies its release directory. Locations are absolute local paths or
credential-free HTTPS. Desktop selects the existing native tools artifact row,
verifies its size and SHA256 before standard ZIP extraction into a new owned
temporary directory. These overrides take precedence over the bundled payload;
their temporary trees are removed after commands drain and local engines stop.
A failed stop retains those tools and records a diagnostic. Downloads reject TLS
downgrades and stop at the artifact's declared size; tools metadata is bounded
to 8 MiB. Explicit development interpreter/command overrides take precedence.

Before setup, update or catalog invokes an environment command, packaged Desktop
reads the selected channel and enforces `minimumDesktopVersion`, reporting
`DesktopVersionTooOld` when the shell must update first. Status, doctor, start,
stop and other installed-generation operations do not fetch channel metadata.
A trusted channel may explicitly supply a `tools` object with `label`, `manifest`,
`sha256` and `release` to select newer tools through the same verified acquisition
path. A newer engine alone does not force a tools download.

Local operations review the command's plan before confirmation. A saved engine
binding starts the existing generation through `dinkster-env start`; updates
and rollbacks route open windows to the newly returned supervisor URL, not the
previous port. Desktop metadata stores bindings only; the environment command
owns `project.json`, store discovery, generations and process identity.

The local manager's **Cleanup status (read-only)** operation displays backend
retention reasons, automatic-cleanup preference, quarantined generations and
persistent retry warnings. **Generation cleanup / retry** reviews a plan before
confirmation. Keep the preference to retry generation-only cleanup, or select
on/off to change the backend preference without collecting immediately. The
adjacent previous-generations field accepts 1-100 (default 1), in addition to
current; leave it blank to keep the saved count. Both settings use the backend's
project policy. A count change takes effect on the next eligible cleanup, not
while saving it. Preview and status show the effective count. Shared
caches remain under the separate **Garbage collection** operation. Desktop
does not duplicate retention policy, delete generation files or stop engines
for cleanup. Older tools without cleanup details report that they are unavailable;
this UI does not update the immutable bundled tools pin.

The Linux Electron client boundary check runs with
`node packages/e2e/scripts/verify-environment-client.mjs` under a display (or
`xvfb-run --auto-servernum`). It uses subprocess response stubs to check plan
confirmation, changed-port handoff, rollback, remote-only routing and shutdown
delegation. It is not a substitute for real CLI/generation file comparisons.
`DINKSTER_ELECTRON_EXECUTABLE` optionally selects the installed Electron binary;
`DINKSTER_SMOKE_ARTIFACTS` optionally retains screenshots.

The Linux cleanup integration check uses the real Electron IPC and backend
command on a newly generated disposable CPU installation. After preparing the
pinned frontend/branding and installing dependencies, set `DINKSTER_BACKEND_ROOT` to a
backend checkout with its development `.venv` and run
`node packages/e2e/scripts/verify-cleanup-integration.mjs`. It checks read-only
status, disabled retry, preference persistence, lock deferral with persistent
warnings, and confirmed collection while the current engine stays responsive.
History, user-data sentinels, bindings and a shared-cache sentinel must remain
byte-identical. It requires a display (or `xvfb-run`), accepts no existing
installation root, and stops only its generated fixture during teardown. The printed fixture path
is retained for inspection; `DINKSTER_SMOKE_ARTIFACTS` retains screenshots and
the result report. The faster `verify-cleanup-dialog.mjs` uses protocol fixtures
instead; `DINKSTER_CHROMIUM_PATH` can select an installed Chromium binary.
The real integration requires clean source checkouts before and after the run,
rebuilds Desktop before launch, and verifies that the backend interpreter imports
the specified source tree. Its report identifies source commits, not a verified
packaged release; installed dependencies and prepared branding are not attested.

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
