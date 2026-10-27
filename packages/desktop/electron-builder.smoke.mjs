import manifest from './package.json' with { type: 'json' }

// Exercise the pinned source pair without publishing a backend release.
export default {
  ...manifest.build,
  linux: { executableName: 'dinkster-desktop-smoke' },
  extraResources: [
    { from: '../app/dist', to: 'app' },
    { from: '../../.smoke-backend', to: 'engine-source' },
  ],
}
