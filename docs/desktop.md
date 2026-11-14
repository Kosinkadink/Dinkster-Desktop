# Desktop environment boundaries

## Publishing installers

The owner opens a version PR changing `packages/desktop/package.json`.
The desk applies the `Release` label when publication is wanted. After fresh
LOW verification and green checks, the owner lands the PR by squash. A merged
PR without the label or without a version change releases nothing.

**Release from version PR** tags the squash commit as `desktop-vX.Y.Z` and
dispatches **Publish Desktop release** at that existing tag. It refuses to
move an existing tag to another commit. The publisher refuses unrelated
prefixes, version/source mismatches and existing releases before building.
It creates no refs and uses `gh release create --verify-tag`, never `--target`.
The desk can dispatch that publisher at the tag for recovery; owners do not
dispatch or rerun release workflows.

The reusable **Desktop installer builds** definition is shared with main
validation. It retains Windows Artifact Signing, signature, isolated install
and installed-app checks, plus the unsigned Mac archive's source/byte binding.
Only final publication has `contents: write`. The release carries the signed
Windows NSIS installer, Linux x64 AppImage and unsigned Apple Silicon ZIP,
source metadata for each, and `SHA256SUMS` with all three installer hashes.
Windows and Linux also publish their channel-specific updater manifests;
Windows publishes its installer blockmap for differential downloads. The Linux
AppImage embeds its blockmap. The CLI verifies artifact and feed hashes and
uploads these files before making the release public.

An `X.Y.Z-rc.N` version PR follows the same chain but publishes a prerelease
with `--latest=false`; stable versions become latest. The desk retains RC
releases and tags, including failed RC tags, until the next stable release is
published and the test runs and assets are recorded. It then deletes the test
prereleases and their tags. Failed runs are recorded on the issue, never rerun
by the owner; existing releases and assets are not overwritten. There is no
manual asset or release step.

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

## Projects and engines

Desktop stores its project names and engine bindings in `projects.json` under
the shell data directory. A local project binds one absolute install root and
a `stable` or `main` channel to one or more named engines. Additional local
engines need distinct explicit ports. Each engine records its assigned GPUs.
Two projects cannot bind the same install root.

A remote-only project stores server URLs and no install root. Opening it loads
the server's frontend in an isolated window without a Desktop preload or Node
capabilities. It does not invoke environment commands or create a generation.

Desktop starts its provisioned local engine with `--allow-settings-changes`.
Runtime settings such as max running jobs can be edited in Backends and are
kept in the engine's library across app restarts. A plain `dinkster-serve`
without that flag still refuses settings edits.

## Native asset files

Local engine windows receive only the file-capability, directory-choice,
asset-reveal and native-drop methods, not project-manager, credential or shell
lifecycle privileges. Each request checks the saved local binding and the
environment tools' observed ready generation and URL. Requests from child
frames, remote engines and unrelated connections have no native authority.
Asynchronous file operations recheck ownership before returning a path or
opening a file manager; changing generation invalidates an outstanding request.
The folder-project context comes from the trusted main frame's document-load
`dinksterProject` URL parameter, not the Desktop installation id or later
same-document history edits. An absent
parameter means `default`; malformed ids are refused. Reveal identities must
match that context, and a context change invalidates an outstanding operation.

The frontend supplies an asset identity, not a filesystem path, for reveal.
The backend returns the exact location and active mount or vault grant. Both
the file and grant are canonicalized; an escaping symlink is rejected. Windows
and macOS select the file; Linux opens its containing folder. Native drops use
Electron's File lookup and the backend's advertised mounted-path resolver,
without treating transport failures as permission to upload instead.

Desktop bindings are not environment state. The environment tools own
`project.json`, generation records, `current`, `store`, journals, dependency
constraints, and private supervisor runtime metadata. Desktop never writes
those files or defines substitute formats for them.

## Environment commands

The project manager delegates setup, update, rollback, move, doctor, garbage
collection, and named engine start/stop to `dinkster-env`. Mutations show the
command's read-only plan first and require confirmation. The confirmation
token applies to exactly that request; it cannot authorize a changed root,
variant, channel, or destination.

Before setup or a variant change, select the project root, mirrors and assigned
GPU indexes, then use **Inspect hardware and variants**. Desktop calls the
read-only catalog command for that prospective root and compares the returned
base manifests with detected hardware. It displays the choice, reason and
reported download size. Every platform variant remains available as an explicit
override; CPU is never selected automatically. Editing the root, channel,
mirrors or assigned GPUs clears the choice and requires another inspection.
Setup passes the selected engine name, port and assigned devices to dinkster-env
so it starts only that binding. Changing a running binding's devices or port
requires stopping it first; the environment tools enforce that rule.

The client consumes `dinkster.environment-result/1`. An update may start a new
supervisor on a different port, so open local engine windows follow the ready
URL returned by the command rather than reconstructing it from saved ports.
The main-process command client also accepts supervisor `packs-plan` and
`packs-apply` operations. Pack planning takes exact pack/version selections and
an absolute host-owned review directory. Apply requires explicit confirmation
and the supervisor's `sha256:` approval digest, not a renderer-supplied plan.
These operations retain the current project's software settings and do not
accept channel, variant, store, engine or device overrides. Successful reviews
must identify the same project and current generation; successful apply results
must name the resulting generation and engine states.

Local project windows use a Desktop-owned loopback gateway for HTTP and
WebSocket connections. Desktop opts that gateway into the shared
`POST /api/packs/install/plan` and `POST /api/packs/install/apply` routes;
remote project windows do not receive this capability. The main process adds
an ephemeral request capability only for the bound top-level local window.
The gateway checks the actual loopback peer, exact host and origin, rejects
bearer credentials, and binds each single-use confirmation to its document
and project. No project root, executable, approval digest or review-directory
path is accepted from renderer code. Reviews expire after 900 seconds; replaced,
consumed, expired and closed-window reviews release their temporary inputs.

Both the gateway and managed engine expose `POST /api/packs/install/prepare`,
`POST /api/packs/install/preparation/status` and
`POST /api/packs/install/preparation/cancel`. Preparation acknowledges immediately
with an opaque document-bound identity. Status returns actual stage and batch
progress; a ready result contains the ordinary single-use confirmation/review.
The tools write progress atomically to a host-owned `--progress` file. A cancel
marker requests cooperative stop, while Desktop retains the lifecycle queue and
scratch files until the command exits. Cancelled, failed and late results cannot
be confirmed. No progress for 120 seconds fails as `preparation-stalled`; the
overall 30-minute bound fails as `preparation-expired`. Polling is not progress.
These routes use the same top-level capability checks as plan/apply and never
accept paths or executable choices from the renderer.

Successful pack installation switches the gateway to the supervisor's ready
engine URLs after checking health and pack composition. The window is not
navigated or re-imported, preserving its unsaved document. WebSockets reconnect
to the new engine. Whole-project operations retain their existing window reload.
The gateway port is saved per project/engine in Desktop's data directory so its
origin survives shell restarts; an occupied saved port fails opening rather than
silently changing the renderer's storage origin. Generation, history, rollback
and software integrity remain supervisor responsibilities. An opted-out gateway
returns 404; missing or untrusted capabilities return 403 before invoking tools.

The Electron client-boundary check is
`pnpm --filter @dinkster/e2e exec node scripts/verify-environment-client.mjs`.
It requires a built Desktop and its pinned branding resources plus a display
(a private Xvfb display is sufficient on Linux). It exercises real Electron
header injection and gateway routing with supervisor and engine fixtures:
top-level plan/apply, denied subframe and unrelated-window requests, replay
refusal, failed-health and failed-composition activation refusal, and backend
replacement without losing the document or origin. It also checks native file
permissions and whole-project update/rollback. This
does not replace real importer, generation assembly or registry acceptance.

Check drift shows the active base's variant, user-defined origin, torch version
and torch index when the environment tools return base metadata. It also shows
installed base and engine labels, and the engine version and full release
identity, when returned by the tools. Missing legacy descriptors and unlabelled
custom bases remain supported without inventing publication labels.
Mirror discovery, artifact verification, generation construction, activation,
recovery, and retention are responsibilities of the environment tools.

Select **Disk space (read-only)** to show the environment tools' managed-software
report. It shows allocated and shared space, generation retention reasons,
shared stores, cleanup savings, and the current automatic-cleanup preferences.
User data is excluded. Unknown sizes stay unavailable, not zero; shared row
sizes overlap and must not be added. The report has no confirmation action.
Change automatic cleanup and the previous-generation count using **Generation
cleanup / retry**, reviewing its plan before confirmation.

For development, `DINKSTER_ENV` selects an installed environment executable.
Alternatively, `DINKSTER_TOOLS_PYTHON` selects an interpreter containing the
tools and runs `-I -m dinkster_supervisor.environment` with bundled-only child
PATH and no inherited Python configuration. The release-owned manifest inputs
in [README](../README.md#environment-client-development) enable extraction-only
bootstrap without a host interpreter. Desktop does not install missing tools
by resolving packages at runtime.

The separate checkout-development launcher (`DINKSTER_ENGINE_SOURCE` or
`start:web`) requires a provisioned checkout with its `.venv` executables.
It does not download tools, sync dependencies, install native overlays, or
prepare catalogs. Prepare that checkout using Dinkster's development setup
before launching it. This path is not used to install project generations.

The retained backend metadata pins the Git-free `main-<commit>` source release
and `dinkster-source-<version>.zip` checksum for checkout release identity.
Desktop does not embed or install that source archive. Environment tools own
the wheel and constraints installation contract; a missing pinned artifact
must not fall back to an unchecked archive or runtime package resolution.

## Shell updates

Shell updates are separate from engine environment updates. Installed Windows
and Linux builds use the public GitHub Releases feed without user configuration:
`https://github.com/Kosinkadink/Dinkster-Desktop/releases/latest/download`.
Stable builds request `latest.yml` (Windows) or `latest-linux.yml` (Linux).
RC builds resolve the highest published `desktop-vX.Y.Z-rc.N` prerelease through
the public GitHub API, then request `rc.yml` or `rc-linux.yml` from that tag.
They never use stable's latest redirect and neither channel allows downgrades.
A missing feed or network error leaves the installed application usable.
Downloads are verified by electron-updater's SHA512 check; Windows also checks
the existing installer publisher signature. macOS self-update is disabled until
signed and notarized releases are available; unsigned ZIP publication remains.

`DINKSTER_UPDATE_FEED_URL` overrides the feed for validation. It accepts
credential-free HTTPS or loopback HTTP only; it does not change the channel.
On Linux, keep the AppImage executable in a user-writable directory and run it
directly. Package-manager installations are not this update target.

The shell updater checks only during startup, downloads without installing on quit, and records
the downloaded version for installation on the next startup. It records each
installation attempt before handing control to the installer and stops after
three unsuccessful launches for the same version. A successful launch at that
version clears the pending attempts; a different update remains eligible.
Corrupt attempt metadata fails closed. Previous installer files are retained.
Manual update IPC calls report status only; they do not check or install.

## Window controls

Project, engine and managed workspace windows hide the separate native title
bar. Windows and Linux retain native window controls over the application bar;
macOS uses inset traffic lights. Desktop reserves the control area in the
frontend's existing `.topbar` and the project manager's header and makes the
remaining bar draggable. Bar controls remain interactive. Pages without an
application bar receive a small host drag strip instead. Styling is reapplied
after navigation, including generation updates, without giving remote pages
a Desktop preload or Node access.
