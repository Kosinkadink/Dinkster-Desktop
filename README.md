# Dinkster Desktop

Electron host for the shared Dinkster process and its pages. Desktop verifies
the native tools, starts or adopts Home, and retains native window, file,
credential and update capabilities. Projects and engines belong to the shared
process, not a second Desktop manager. See [Desktop boundaries](docs/desktop.md).

## Inputs

The desktop shell and its external inputs are pinned independently:

- `scripts/frontend-release.json` pins the permanent `dinkster-frontend` PyPI wheel by version, URL, size and SHA256. `pnpm prepare:frontend` verifies that wheel and copies its application and native branding into the package inputs. The engine selects the same published frontend release; Desktop does not build frontend source.
- `packages/desktop/src/backend-release.json` records backend identity in shell release metadata. Shell packaging does not download or embed that source archive or native wheels. Project snapshots are acquired by the environment tools, not by the shell's package builder; Desktop has no separate single-engine launcher.

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

## WSL2 engine on Windows x64

Desktop offers WSL status, preparation, project-root and model-copy operations
to the shared page without a separate installation manager. Preparation creates
a private Ubuntu 24.04 distribution, disables Windows drive automount and
executable interop, and does not adopt other distributions. Tools run through
`wsl.exe` as a non-root user. Model copying leaves the Windows originals in
place. See [WSL2 boundaries](docs/desktop.md#wsl2-on-windows-x64).

## Windows native pack sandbox

Windows packages build the MXC executor from source at commit
`c66201839d63cae2239db5e92f1f1d6076cf5181` using Rust 1.93 and the MSVC
x86-64 toolchain. `MXC_TELEMETRY_COMPONENT_PATH` is explicitly empty during
the release build, so diagnostics are not routed to Microsoft. Packaging
requires Rust and the Windows C++ build tools, in addition to Node and pnpm.
The signed package signs the executor through the same Artifact Signing hook
as Desktop, then records the signed bytes' SHA-256 in `mxc-build.json`.

The executor, build manifest, source provenance and MIT license ship together
under `resources/sandbox`. Packaged Windows Desktop sets the host-owned
`DINKSTER_MXC_EXECUTABLE` to that absolute executor path before running the
environment tools. The selected engine's readiness report and launcher use
that same input; neither searches PATH. Missing or unsupported native
isolation refuses a requested sandbox rather than launching it unjailed.
The selected engine must include native Windows launcher support. Windows 10
and Windows 11 without process isolation can use the explicit WSL2 option.

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
are separate from tools and engine setup, doctor, start, update and restore.
Local project commands use the native environment tools, not host Python or uv.

## Environment client development

Startup loads the shared Home page at `http://127.0.0.1:3638`, starting verified
native tools if the process is not already running. Desktop does not import
`projects.json`, select an engine snapshot or provide an installation manager.
The shared process owns those operations. Quit stops only a process Desktop
started; an adopted process is left running.

Development interpreter and manifest overrides, tools verification and the
real process/native-window checks are documented under
[Tools and development](docs/desktop.md#tools-and-development). Isolate HOME,
the shared library/model registry and Desktop data when running those checks.
Pull requests run formatting, types, unit tests, a Linux build, cross-platform
process ownership and Linux/Windows native-window checks. Installer and update
validation remain separate workflows; local checks never publish releases.
