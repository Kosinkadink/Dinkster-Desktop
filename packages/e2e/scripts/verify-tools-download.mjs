import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'

// Positive control for an independent process-tree endpoint observer. It must
// see actual runtime tools acquisition, not a synthetic unrelated connection.
const executablePath = process.env.DINKSTER_DESKTOP_EXECUTABLE
const root = process.env.DINKSTER_BUNDLED_VERIFY_ROOT
assert(executablePath && root)
assert.equal(resolve(root), root)
await mkdir(root)
const pin = JSON.parse(
  await readFile(
    new URL(
      '../../desktop/src/environment-tools-release.json',
      import.meta.url,
    ),
    'utf8',
  ),
)
const release = `https://github.com/${pin.repository}/releases/download/${pin.releaseTag}`
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name, value]) =>
      value !== undefined &&
      !/TOKEN|SECRET|PASSWORD|CREDENTIAL|ELECTRON_RUN_AS_NODE|^DINKSTER_|^UV_|^PYTHON|^VIRTUAL_ENV$|^GIT_/i.test(
        name,
      ),
  ),
)
env.DINKSTER_DESKTOP_DATA = join(root, 'desktop')
env.DINKSTER_TOOLS_MANIFEST = `${release}/${pin.manifest.name}`
env.DINKSTER_TOOLS_SHA256 = pin.manifest.sha256
env.DINKSTER_TOOLS_RELEASE = release
const app = await electron.launch({
  executablePath,
  args: ['--no-sandbox', `--user-data-dir=${join(root, 'electron')}`],
  env,
})
try {
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true)
  const receipt = await app.evaluate(
    async ({ app }, projectRoot) => {
      const path = process.getBuiltinModule('node:path')
      const require = process
        .getBuiltinModule('node:module')
        .createRequire(path.join(app.getAppPath(), 'package.json'))
      const { EnvironmentClient } = require(
        path.join(app.getAppPath(), 'dist/environment.js'),
      )
      const requests = []
      const original = globalThis.fetch
      globalThis.fetch = (input, init) => {
        requests.push(String(input))
        return original(input, init)
      }
      const client = new EnvironmentClient()
      try {
        const result = await client.run({
          root: projectRoot,
          operation: 'status',
        })
        return { requests, result }
      } finally {
        await client.dispose()
        globalThis.fetch = original
      }
    },
    join(root, 'project'),
  )
  assert(receipt.requests.some((url) => url.includes('release-manifest.json')))
  assert(receipt.requests.some((url) => url.includes('dinkster-tools-')))
  assert.equal(receipt.result.status, 'clean')
  await writeFile(
    join(root, 'tools-download-control.json'),
    JSON.stringify(receipt, null, 2),
  )
  console.log(
    'Positive control completed actual manifest and native tools ZIP downloads through installed EnvironmentClient',
  )
} finally {
  await app.close()
}
