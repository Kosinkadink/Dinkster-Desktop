# Desktop process and native boundaries

## Shared process

Desktop verifies the native tools and starts or adopts Dinkster Home at
`http://127.0.0.1:3638`. Its windows load the pages served by that process.
The process owns projects, the library, installation selection and engine
opening. Desktop has no project registry, library bridge, static server or
engine gateway, and does not import an old Desktop `projects.json`.

Acquisition identifies the process by its PID and opaque instance identity.
Desktop stops only the process it started. An adopted process remains running
after Desktop quits. Shutdown checks identity and sends its request over the
same connection so it cannot reconnect to a replacement process. A competing
launcher stops its losing child before adopting the winner.

Closing the primary window normally quits Desktop. **Keep running when the
window closes** hides it instead, preserving its process. **Quit** stops the
owned process and exits; an uncertain stop leaves Desktop open with an error.
Additional workspace and detached workflow/panel windows close independently.
Window placement and grouping are native shell state, not a project catalog.

## Tools and development

Packaged builds include the native tools manifest and ZIP pinned in
`packages/desktop/src/environment-tools-release.json`. Extraction verifies
sizes and SHA256 hashes, rejects links and escaping or duplicate paths, and
preserves executable modes. Verified extractions are reused by archive digest
under the shell's `environment-tools` cache. Desktop does not install missing
tools with pip or uv or embed an engine source checkout.

For native environment-command development, `DINKSTER_TOOLS_PYTHON` selects an
interpreter containing the tools, or `DINKSTER_ENV` selects the environment
executable. These do not override the Home launcher, which uses its verified
native tools pin. Python launches use `-I`, remove inherited Python
configuration and put the tools' scripts directory first on the child PATH.
Environment-command acquisition can instead use
`DINKSTER_TOOLS_MANIFEST`, `DINKSTER_TOOLS_MANIFEST_SHA256` (or
`DINKSTER_TOOLS_SHA256`) and `DINKSTER_TOOLS_RELEASE`. Locations must be absolute
local paths or credential-free HTTPS. Downloads reject TLS downgrades and
enforce declared sizes; tools metadata is bounded to 8 MiB.

The process-ownership check is
`pnpm --filter @dinkster/e2e exec node --import tsx scripts/verify-home-process.mjs`.
It uses the real pinned native tools to exercise startup, adoption, competing
launchers, identity changes and owned-only shutdown. Set
`DINKSTER_DESKTOP_VERIFY_ROOT` to a new owned evidence directory.

The native-window check is
`node packages/e2e/scripts/verify-window-chrome.mjs` after building. It uses the
real shared Home and needs a display; on Linux use a private Xvfb display with
Openbox and xdotool. It checks native drag/no-drag, maximize/restore/fullscreen,
Keep running and owned shutdown. Its non-Windows WSL checks call the retained
preload methods and verify unavailable operations and cancelled folder choice.
These checks do not establish project-opening or successful Windows WSL setup.

## Native capabilities

The trusted shared page receives the Desktop preload for locale, app/update
information, window grouping, deep links, connection credentials, native files,
save dialogs and WSL operations. Renderer permissions are denied by default;
Node integration is disabled and context isolation and sandboxing stay enabled.
Unregistered windows and subframes cannot invoke native capabilities merely by
loading the same origin. Credentials are encrypted through Electron safeStorage,
not stored in the frontend or passed in a URL.

Project-file requests require an explicit valid `dinksterProject` parameter
on the trusted main frame's current URL, including for `default`. The Projects
page with no project parameter has no native project-file authority. Requests
check the selected Home process, root and engine plus the tools' ready snapshot,
generation and URL. Awaited operations recheck the document and engine before
returning a path or opening the file manager. A loopback URL alone grants no
native project-file access.

File reveal accepts an asset identity rather than a renderer-selected path.
The backend supplies the exact location and active mount or vault grant. The
file and grant are canonicalized; escaping symlinks are rejected. Windows and
macOS select the file; Linux opens its containing folder. Native drops use
Electron's File lookup and the backend's mounted-path resolver, not an upload
fallback after a failed lookup. Shared model-folder reveal accepts a registered
location ID and rechecks registration before opening the directory. Native save
dialogs remain separate from project-file folder grants.

## WSL2 on Windows x64

Desktop retains `wslStatus`, `prepareWsl`, `wslProjectRoot` and `copyWslModels`
for the shared page. Desktop has no separate setup page or installation menu.
Preparation downloads Ubuntu 24.04 and creates a private Desktop-owned
distribution, without adopting or reconfiguring existing user distributions.
It disables Windows drive automount and executable interop and runs tools as
a non-root Linux user. Desktop does not change the Windows version.

Projects use `/home/dinkster/projects` on that distribution's disk. Verified
Linux tools are cached independently by immutable pin under
`/home/dinkster/tools`, so a new pin does not remove a running interpreter.
Windows Python and development-executable overrides do not run WSL commands.
Copying models makes a separate copy under `/home/dinkster/models`; originals
stay in place, and links and existing destination names are refused. Windows
and Linux path spellings translate only within the owned private distribution,
not arbitrary Windows drives or another user's distribution.

## QA hosted services

Launch with `--services=qa` to select QA hosted services for this process.
Omitting it selects production even when inherited `DINKSTER_SERVICES` is set.
`--services=production` is also accepted; other values refuse startup. There
is no saved project field or UI switch, and a second launch cannot change the
running process's selection. QA windows and tray identify the shell as
`Dinkster Desktop [QA]`. Engine-provided service labeling belongs to the shared
frontend and process, not a Desktop project manager.

## Native identity and window controls

`pnpm prepare:frontend` verifies the published frontend wheel and copies its
application, native branding and shared chrome resources. Windows/NSIS use
its ICO, macOS its ICNS and Linux its PNG; Desktop maintains no second icon
set. Linux uses `dinkster-desktop.desktop` and `StartupWMClass=Dinkster Desktop`.
The tray uses the color symbol on Windows/Linux and the monochrome template
with Retina representation on macOS. About uses the shared `ProductAbout`
page, bundled Noto fonts and stylesheet with a restricted local renderer.

Windows/Linux retain native controls over the application bar; macOS uses
inset traffic lights. `desktop-chrome.json` and `desktop-chrome.js` from the
verified wheel define overlay colors, height and button placement. The
DOM-only installer runs in an isolated world without Electron or Node. It
preserves interactive header controls, follows replaced headers and supplies
a fallback bar where needed. Chrome follows the page theme and removes the
native-button inset in fullscreen without broadening page CSP or IPC policy.

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
The desk can dispatch the publisher for recovery; owners do not dispatch or
rerun release workflows during validation.

The reusable installer builds retain Windows Artifact Signing, signature and
isolated-install checks and the unsigned Mac archive's source/byte binding.
Only publication has `contents: write`. Releases carry the Windows NSIS
installer, Linux x64 AppImage and unsigned Apple Silicon ZIP, source metadata
and shared `SHA256SUMS`. Windows/Linux updater manifests and the Windows
blockmap publish with the verified installer bytes. An `X.Y.Z-rc.N` version
publishes a prerelease without moving latest; stable versions become latest.
Existing releases and assets are not overwritten. See
[Desktop signing](desktop-signing.md) for signing configuration.

## Shell updates

Shell updates are separate from engine updates. Installed Windows/Linux builds
use `https://github.com/Kosinkadink/Dinkster-Desktop/releases/latest/download`.
Stable requests `latest.yml` or `latest-linux.yml`. RC builds select the
highest published matching prerelease and request `rc.yml` or `rc-linux.yml`
from its tag. Neither channel allows downgrades. Missing feeds leave the app
usable. Downloads require electron-updater SHA512 checks; Windows also checks
the existing publisher signature. macOS self-update remains disabled until
signed/notarized releases exist.

`DINKSTER_UPDATE_FEED_URL` accepts credential-free HTTPS or loopback HTTP for
validation without changing the channel. On Linux run the AppImage from a
user-writable directory; package-manager installs are not this update target.
The updater checks at startup, downloads without installing on quit and records
the downloaded version for the next startup. It records installation attempts
before handing off, stops after three unsuccessful launches for that version,
and clears attempts after successful startup. Corrupt metadata fails closed.
Manual update IPC reports status only; it does not check or install.
