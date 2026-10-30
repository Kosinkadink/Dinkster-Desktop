# Desktop environment boundaries

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
Mirror discovery, artifact verification, generation construction, activation,
recovery, and retention are responsibilities of the environment tools.

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

Shell updates are separate from engine environment updates. The shell updater
checks only during startup, downloads without installing on quit, and records
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
