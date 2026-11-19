# Desktop environment boundaries

## QA hosted services

Launch with `--services=qa` to use QA hosted services for this process only.
Omitting the argument selects production, even if `DINKSTER_SERVICES` was set
in the launching environment. `--services=production` is also accepted;
other values refuse startup. On Windows append the argument to the shortcut
target after the executable path. On Linux append it to the AppImage command.
There is no saved project field or UI switch. A different-service second
launch cannot change the running instance.

QA windows and the tray identify the process as `Dinkster Desktop [QA]`.
The project manager, About content and engine window chrome also draw `[QA]`
inside the window. Engines started by Desktop receive the selected value;
a ready managed engine using different services is stopped and restarted
before its window opens. The Frontend independently names services from its
engine header, so a remotely connected engine can show its own service badge.

## Projects without an engine

Desktop opens a read-only Projects window. Choose a saved local installation,
then a library project to browse its workflows and recorded files. Each list
continues independently with More; Back returns immediately. Remote-only
connections remain in Installations and are not local library sources.
The tray and application menu share the Projects and Installations commands;
Installations opens the existing installation manager.

Browsing runs a short-lived environment-tools command, not an engine. Native
installations use the verified native tools; private WSL installations use the
same Linux tools path through wsl.exe. The command closes its library helper
before returning. No Desktop code opens a library database or inventories the
filesystem. A missing library is empty and is not created. An unreadable
library shows one plain by-the-way notice, not a storage approval question.

The frontend wheel supplies the Projects page, shared Product components and
bundled Noto fonts. Its isolated preload exposes only read-only library
operations. The main process accepts saved installation IDs, project IDs and
opaque page cursors, never renderer-selected paths or helper commands. The
library window retains the native title bar rather than injecting a second
content stylesheet.

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

After every regular publication, disposable GitHub-hosted Windows and Linux
jobs install the published NSIS installer or AppImage and create a fresh
project on the default Stable channel. They read back engine, inference,
frontend and default pack versions from the installed generation, verify the
matching tools and public git source acquisition, and open the local frontend.
The retained receipts and screenshot distinguish project setup from the
separate shell self-update checks. RC publications keep their update checks
without claiming fresh Stable acceptance.

## Native identity

`pnpm prepare:frontend` copies native branding from the hash-verified
frontend release wheel into generated Desktop resources. Windows and NSIS
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
a `stable` or `nightly` channel to one or more named engines. Additional local
engines need distinct explicit ports. Each engine records its assigned GPUs.
Two projects cannot bind the same install root.

Pack sandboxing is opt-in per local project. Check availability in the local
installation controls; Desktop displays the selected engine's readiness report
and disables enabling when a prerequisite is missing. Save the binding to retain
the choice. Opening a sandboxed local engine passes `--sandbox-packs`; a requested
sandbox never falls back to an unsandboxed launch. Use **Stop engine**, review and
confirm the operation, then change and save the choice before opening again.
In-process packs and remote workers are outside this setting. A saved enabled
request remains enabled when availability changes until explicitly turned off.

A remote-only project stores server URLs and no install root. Opening it loads
the server's frontend in an isolated window without a Desktop preload or Node
capabilities. It does not invoke environment commands or create a generation.

Desktop starts its provisioned local engine with `--allow-settings-changes`.
Runtime settings such as max running jobs can be edited in Backends and are
kept in the engine's library across app restarts. A plain `dinkster-serve`
without that flag still refuses settings edits.

## Managed source selection

In Projects, manage a local installation and choose Managed Git sources. Select
an engine, node pack, inference library, pack helpers or frontend repository.
The URL must be credential-free public HTTPS; a URL fragment can select a
repository-relative subdirectory. Choose a branch, tag, PR ref or full commit.
List repository refs and tags uses Git protocol without changing the project.
A pack update requires its installed name. Update selected source / change ref
retains its recorded URL and updates only the chosen component.

Git mirror base rewrites official Kosinkadink repositories to the mirror's
`Kosinkadink/repository.git` route without original-host fallback. Package index
is used only for missing wheels. Source operations keep the installed release
base and all unselected sources; they do not enable develop mode. Plans and
status disclose exact URL/ref/commit identities and unpublished,
non-reproducible status. Frontend Git prefers the exact official commit's
verified CI bundle; otherwise a local frozen build needs Node and pnpm.

Review the CLI plan before confirming. The main process retains the CLI-owned
source approval and consumes its one-shot confirmation token before applying.
A moved ref, changed project or changed frontend artifact refuses and requires
a new plan. Desktop never stores temporary fetched checkout paths or computes
its own source digest. Return all sources to a recorded release retains the
exact history entry shown in the plan; Rollback uses the environment's exact
recorded software history. Missing recovery inputs refuse without silently
selecting a different ref or release.

Install and Update also accept an exact published frontend version. Leave it
empty to retain the normal frontend selection. The environment tools verify
the permanent wheel hash and declared engine API range and bind confirmation
to the planned frontend identity. Unsupported older tools refuse rather than
applying an unbound selection. Frontend folder/dev-server development settings
are separate from managed source selection.

## Native asset files

Local engine windows receive only the file-capability, directory-choice,
asset-reveal, shared-model-folder reveal and native-drop methods, not project-manager, credential or shell
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

Model folder reveal supplies only a registered location id. Main reads the
operator-only shared model settings for the trusted window project, verifies
that the selected location is unique and an existing directory, then rereads
registration and rechecks the managed generation before opening its file URL.
Disabled project visibility does not prevent the operator from finding a shared
folder in Model management. Removed locations, changed paths, denied lookups
and remote or stale managed contexts never open the file manager. No model
files are moved or deleted.

Desktop bindings are not environment state. The environment tools own
`environment.json`, `builds/<n>/build.json`, `current`, `store`, journals,
dependency constraints, and private supervisor runtime metadata. Desktop never
writes those files or defines substitute formats for them. Desktop reads legacy
`project.json` settings only when `environment.json` is absent, before the
supervisor performs its one-time migration. Desktop's separate `projects.json`
registry stores shell bindings, not environment settings.

## Environment commands

Before setup, update or catalog inspection uses a release channel, Desktop
verifies its Ed25519 envelope with independently embedded public keys and
checks that its signed channel name matches the request. This applies to
local copies and every mirror, including Dinkster-operated hosts. Mirrors may
use credential-free HTTPS without a hostname allowlist; HTTP is restricted
to numeric loopback addresses. Referenced tools still require their pinned
hashes and sizes. Installed-engine operations do not consult moving channels.
For [normal rotation, lost keys and suspected leaks](https://github.com/Kosinkadink/Dinkster/blob/main/docs/channel-signing.md#normal-rotation),
update Desktop and environment tools through independently authenticated software
releases. Mirrors cannot replace their own trust roots. Existing security notices
retain their pack-artifact authority; they do not revoke channel keys or installed
engine generations. Removing a leaked key does not make an offline installation
aware of that compromise.

The project manager delegates setup, development, update, rollback, move, doctor,
garbage collection, and named engine start/stop to `dinkster-env`. Mutations show the
command's read-only plan first and require confirmation. The confirmation
token applies to exactly that request; it cannot authorize a changed root,
variant, channel, or destination.

Choose **Development - unpublished sources** to select an engine source and
optional inference, pack, helper and built frontend folders. Engine, inference,
helper and pack inputs accept an absolute local folder or a public HTTPS Git
URL; append `#ref=REF&subdirectory=PATH` to select a branch, tag, commit or pull
request ref and package directory. Each entered source opts into unpublished
code; blank optional fields keep the engine's defaults. Git sources are captured
through `dinkster-env` without system Git, never live temporary folders. Review
the command's requested refs and resolved commits before confirming the plan.
Desktop retains its source approval digest, so changed inputs require a new
review. Local engine and pack edits reload; local libraries require an engine
restart. Development sources are marked in the project list and active engine
window. Engine windows retain the same narrow local-file bridge, without
project-manager or shell access.
Instead of a built frontend folder, select a public HTTPS frontend Git URL/ref
or a frontend dev server origin for live reload. These three frontend choices
are exclusive. Git frontend assets are captured through the shared command's
verified CI-bundle or local-build path, and their exact selection is part of
source approval; Desktop does not fetch or build frontend sources itself.
Frontend dev servers allow loopback by default; another address requires the
separate **Explicitly allow a non-loopback frontend dev server** checkbox and
plan review. Dev server origins refuse credentials, paths, queries and fragments.
Use only trusted frontend code: it retains the project's existing narrow
local-file capabilities. The environment command retains the frontend choice
and permission across engine restarts, not Desktop-managed state.

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
tools and runs `-I -m dinkster_supervisor.environment` with bundled Python
first on child PATH and no inherited Python configuration. System tools such as
bubblewrap remain discoverable on the inherited PATH. The release-owned manifest inputs
in [README](../README.md#environment-client-development) enable extraction-only
bootstrap without a host interpreter. Desktop does not install missing tools
by resolving packages at runtime.

Desktop starts in the project manager in both development and installed builds.
Engine selection, updates and rollback belong to project generations managed by
the environment tools. Desktop has no separate single-engine launcher,
selection journal, follow-packaged update or install snapshot restore path.

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
