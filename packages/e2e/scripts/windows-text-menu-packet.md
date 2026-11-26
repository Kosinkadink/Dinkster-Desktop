# Windows text context menu packet

Run in an isolated Windows clone at product head
`5e11f842925a1f95e713589f1e24b9f8b53c6d6c` plus these packet-only files.
The checkout must be the retained lane root's `desktop` child. Do not run
against another user's Desktop or a live backend. This packet does not change
product source, release pins, application menus, or context-menu handlers.

Install the package manager declared in package.json under the lane root's
`tools` directory and install the lockfile with a lane-local store. Scope
TEMP, TMP, TMPDIR, LOCALAPPDATA, APPDATA and ELECTRON_CACHE inside that root
while installing. Do not change global PATH or npm configuration.

From the checkout root, with `$env:DINKSTER_TEXT_MENU_ROOT` set to its parent:

```powershell
node packages/e2e/scripts/prepare-text-menu-packet.mjs
node node_modules/typescript/bin/tsc -p packages/desktop/tsconfig.json
node packages/desktop/node_modules/esbuild/bin/esbuild packages/desktop/src/preload.ts --bundle --platform=node --format=cjs --external:electron --outfile=packages/desktop/dist/preload.cjs
$env:DINKSTER_TEXT_MENU_RUN = 'run-new'
node packages/e2e/scripts/verify-windows-text-menu.mjs
```

Preparation refuses an existing extraction directory and retains the pinned
wheel and extracted content. Each execution refuses an existing run directory.
The application has isolated home, registry, Desktop and Chromium data paths;
no engine starts. CUDA is hidden and the accelerator is CPU.

The HTTP fixture serves the exact pinned editor unchanged and supplies one
schema-defined text node through `/api/nodes`. It is not an engine. Other
engine APIs return unavailable. The log text is the product's own real
connection-status log, not an inserted DOM control or a fabricated log row.
The node is added through its normal palette, placed, and edited. No test/debug
bridge is used. The helper requires the exact owned Desktop HWND and PID to
be foreground before every native operation. Right-click coordinates must hit
that window. Only Escape, Down and Return are permitted native keys.

Automated checks exercise actual native-menu Copy/Cut/Paste/Select All through
keyboard navigation. The ordinal includes disabled menu rows on Windows.
Clipboard readback waits for the exact text. A log Copy-only action and node
editor Copy are also checked through exact clipboard contents. Canvas menu
content and blank-space app-menu absence are observed through the editor DOM.

All acceptance pictures use the native screen capture API, cropped to the
owned Desktop window. `search-page-not-native.png` is a diagnostic comparison
only: renderer screenshots omit the popup. Inspect native images, including
disabled actions and absence of duplicate menus, before reporting acceptance.
The process exit code covers automated checks, not screenshot inspection or
the spelling criterion. `search-native-menu.png` must show actual dictionary
suggestions, and a suggestion must replace the word, before criterion 2 can
pass. No suggestions are injected or simulated by this packet.

The initial historical run found no search suggestions: this pinned editor's
real search field reports `spellcheck="false"`. That is a product acceptance
failure, not permission for this worker to alter the frontend pin or controls.
Do not treat an automated exit code of zero as all four criteria passing.
