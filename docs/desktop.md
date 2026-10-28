# Desktop engine boundaries

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

## Native asset files

`fileCapabilities(backendUrl)` reports folder choice and exact-file reveal for
the running shell-managed connection. Unsupported or denied exact lookup does
not disable folder choice. Remote connections have neither capability.

`revealFile(backendUrl, {digest, scope, project})` accepts a BLAKE3 identity,
`local` scope, and the requesting window's project. It never accepts renderer
host paths or roots. The main process asks its backend for verified exact
locations, checks canonical containment under active grants, and rechecks
authorization before opening the file manager. Windows and macOS select the
file; other platforms open its containing folder. Missing copies and denied
or unsupported lookups reject rather than opening an unverified directory.

This requires the backend's scoped/project exact-location route. A successful
empty result is distinct from missing support or a failed request. Output
files without retained project observations are not reveal targets merely
because an output directory is granted.

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
