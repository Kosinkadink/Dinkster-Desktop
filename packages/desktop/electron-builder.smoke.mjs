import manifest from './package.json' with { type: 'json' }

// Exercise the installed shell without bundling a checkout or publishing.
export default {
  ...manifest.build,
  linux: { ...manifest.build.linux, executableName: 'dinkster-desktop-smoke' },
}
