# Desktop engine boundaries

## Native identity

`pnpm prepare:frontend` copies native branding from the workflow-pinned
`.frontend/branding` source into generated Desktop resources. Windows and NSIS
use its ICO, macOS uses its ICNS, and Linux uses its color PNG. Do not maintain
or edit a second set of icons in Desktop. The accepted 16 and 24 px frames are
the exact-source renders without hand edits.

The packaged product name also sets Electron's application identity. Linux
uses `dinkster-desktop.desktop` for Wayland association and explicitly matches
`StartupWMClass` to Electron 37's X11 class, `Dinkster Desktop`, so running
windows associate with the installed desktop entry and its icon.

Window backgrounds follow the operating system's light or dark theme using
the same source's palette tokens. The tray uses the color symbol on Windows
and Linux and the monochrome template with Retina representation on macOS.
Open "About Dinkster Desktop" from the tray menu to see the accepted wordmark
and installed shell version. The about surface follows live OS-theme changes.
The first-run renderer and its installation controls remain Frontend-owned.
Managed windows retain the native title "Dinkster Desktop" rather than adopting
the embedded web page's browser title.

## Packaged backend

Desktop installs the checksum-pinned `dinkster-source-<version>.zip` from the
backend's commit-named `main-<commit>` prerelease. The ZIP has workspace files
at its root. Packaging verifies size, SHA-256, Git-free dependency manifests
and the Windows native profile before embedding it. Runtime consumes the
shipped immutable Python 3.12 lock with `uv sync --frozen`; it does not
re-resolve the project or validate its lock against `pyproject.toml`.

Backend prereleases before `13a07e2e10867eb6279fbed5abaa3033acdad77d` reference
deleted OpenTimelineIO wheel assets. Do not use those locks. The pinned
`2cedcbfb4ab631eaf8af823cd010893f549d9dbc` release uses
`dinkster-opentimelineio` from PyPI instead. Frozen installation cannot fix a
deleted dependency asset; moving the backend pin removes those dead URLs.

The backend's supported package contract is wheels plus `constraints.txt`;
source installation is transitional. Main prereleases retain the newest 50
commits. Never substitute an unchecked archive when a pinned input is absent.

## Release mirror

Desktop treats the configured release mirror as a security boundary. Production
mirror URLs use HTTPS, contain no credentials, and have no query string or
fragment. Loopback HTTP is accepted only for local tests. Release requests use
paths relative to that base URL; redirects are followed only while they remain
on the same origin and under the same base path.

The mirror client parses JSON without defining the engine document schema and
verifies downloaded bytes against a caller-supplied SHA-256 digest. The engine
release layer owns the channel and manifest schemas and supplies the expected
digests. Desktop also compares the running shell version with a numeric minimum
version before an update can proceed.

## Projects

Each Desktop project id, including `default`, binds to one absolute Dinkster
install root and one channel: `stable` or `github-live`. Two projects cannot
bind the same install root. The registry is stored atomically under the Desktop
shell data directory and rejects malformed documents, duplicate project ids,
relative roots, unsupported channels, and roots assigned more than once.

The registry does not own models, outputs, history, settings, generation files,
or install commands. Those remain outside this Desktop metadata boundary.

## Generation swap

Desktop coordinates an update through injected engine operations so it does not
duplicate the engine install implementation. For one project, it:

1. Writes a durable operation journal and builds the target generation while
   the previous supervisor continues serving.
2. Takes a pre-update snapshot, records the switching stage, and stops the
   previous supervisor.
3. Activates the target and starts that generation's supervisor on the
   project's port with a new instance id.
4. Persists the new selection and clears the journal only after readiness is
   reported for that exact instance id.

If build fails, the previous supervisor remains running. If activation, startup,
or readiness fails after the previous supervisor stops, Desktop stops the failed
candidate, reactivates the previous generation, starts its supervisor with
another new instance id, waits for readiness, and persists the previous
selection. The failed journal is retained for support diagnostics. A target
generation is not deleted by the coordinator.

Projects use separate coordinators, supervisors, and ports. Updating one project
does not stop or change another project's supervisor.
