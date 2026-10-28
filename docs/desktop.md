# Desktop environment boundaries

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
tools and runs `-m dinkster_supervisor.environment`. Desktop does not install
missing tools by resolving packages at runtime.

The separate checkout-development launcher (`DINKSTER_ENGINE_SOURCE` or
`start:web`) requires a provisioned checkout with its `.venv` executables.
It does not download tools, sync dependencies, install native overlays, or
prepare catalogs. Prepare that checkout using Dinkster's development setup
before launching it. This path is not used to install project generations.

## Shell updates

Shell updates are separate from engine environment updates. The shell updater
checks only during startup, downloads without installing on quit, and records
the downloaded version for installation on the next startup. It records each
installation attempt before handing control to the installer and stops after
three unsuccessful launches for the same version. A successful launch at that
version clears the pending attempts; a different update remains eligible.
Corrupt attempt metadata fails closed. Previous installer files are retained.
Manual update IPC calls report status only; they do not check or install.
