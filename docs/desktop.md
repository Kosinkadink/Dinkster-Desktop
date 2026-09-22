# Desktop engine boundaries

## Release mirror

Desktop treats the configured release mirror as a security boundary. Production
mirror URLs use HTTPS, contain no credentials, and have no query string or
fragment. Loopback HTTP is accepted only for local tests. Release requests use
paths relative to that base URL; redirects are followed only while they remain
on the same origin and under the same base path. The shell reads the mirror
base from `DINKSTER_ENGINE_MIRROR_URL`; without it, project installation is
disabled while installed generations remain manageable.

The mirror client parses JSON without defining the engine document schema and
verifies downloaded bytes against a caller-supplied SHA-256 digest. The engine
release layer owns the channel and manifest schemas and supplies the expected
digests. Desktop also compares the running shell version with a numeric minimum
version before an update can proceed.

## Packaging inputs

The installer bundles no engine. Packaging accepts two explicit file inputs
through environment variables: `DINKSTER_CONTROL_RUNTIME_DESCRIPTOR` (the
bundled control-runtime descriptor JSON) and `DINKSTER_CONTROL_RUNTIME_ARCHIVE`
(the `.tar.gz` archive named by that descriptor).
`scripts/prepare-control-runtime.mjs` verifies the descriptor's strict shape,
its value and path invariants, and that the archive bytes match the digest and
size the descriptor declares, then stages exactly two files:
`resources/control-runtime/descriptor.json` and
`resources/control-runtime/<archive basename>`. electron-builder copies that
directory into the installed application as `resources/control-runtime`.
Verification runs before anything in the staging directory changes, and failed
verification preserves both the inputs and any existing staged content. The
script never fetches anything from the network and never extracts the archive;
Desktop discovers the bundled runtime only through `process.resourcesPath`.
At startup Desktop re-verifies the compressed archive, rejects unsafe tar
entries and links, extracts it atomically into content-addressed application
data, and requires the descriptor-named interpreter to resolve to an executable
file inside that directory. The bootstrap invocation is the descriptor-relative
interpreter followed by `-I -m dinkster.cli`.

Main-branch packaging builds native Windows x64 and Linux x64 installers from
the pinned Dinkster and frontend commits. Each job builds and verifies its
native control-runtime pair, runs the update-feed check, launches the packaged
application twice with an isolated data root, and uploads the installer,
`latest.yml` metadata, and bounded screenshots and JSON evidence. macOS remains
not run while its signing and notarization secrets are unavailable; the
workflow reports that condition without exposing secret values.

## Projects

Each Desktop project id, including `default`, binds to one absolute Dinkster
install root and one channel: `stable` or `github-live`. Two projects cannot
bind the same install root. The registry is stored atomically under the Desktop
shell data directory and rejects malformed documents, duplicate project ids,
relative roots, unsupported channels, and roots assigned more than once.

The registry does not own models, outputs, history, settings, generation files,
or install commands. Those remain outside this Desktop metadata boundary.

Each project gets its own loopback port and supervisor. Desktop invokes install
through the bundled control runtime, then uses the generation-reported control
interpreter for activation and serving. Renderer requests are bound to the
calling window's project; they cannot select another project's controller.

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
