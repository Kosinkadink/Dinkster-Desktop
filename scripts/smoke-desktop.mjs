import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const require = createRequire(
  new URL('../packages/e2e/package.json', import.meta.url),
)
const { _electron: electron } = require('@playwright/test')
const results = resolve('test-results/desktop-smoke')
await mkdir(results, { recursive: true })
const root = await mkdtemp(join(results, 'launch-'))
const executablePath = resolve(
  'packages/desktop/release/linux-unpacked/dinkster-desktop-smoke',
)
const resources = resolve('packages/desktop/release/linux-unpacked/resources')
const source = join(resources, 'engine-source')
assert.equal(
  (await readFile(join(source, 'desktop-smoke-commit.txt'), 'utf8')).trim(),
  process.env.DINKSTER_REF,
)
// No developer backend, cached selection, credentials or fixed port may satisfy this smoke.
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name, value]) =>
      value !== undefined &&
      !/TOKEN|SECRET|PASSWORD|CREDENTIAL|ELECTRON_RUN_AS_NODE|^DINKSTER_|^PYTHON|^VIRTUAL_ENV$/i.test(
        name,
      ),
  ),
)
env.DINKSTER_DESKTOP_DATA = join(root, 'data')
env.DINKSTER_ENGINE_SOURCE = source
env.DINKSTER_ACCELERATOR = 'cpu'
env.DINKSTER_UV = process.env.DINKSTER_UV ?? 'uv'
env.UV_TORCH_BACKEND = 'cpu'
const app = await electron.launch({
  executablePath,
  args: [`--user-data-dir=${join(root, 'electron')}`],
  env,
  timeout: 60_000,
})
let page
try {
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true)
  page = await app.firstWindow({ timeout: 60_000 })
  const deadline = Date.now() + 20 * 60_000
  let status
  let phase
  while (Date.now() < deadline) {
    status = await page.evaluate(() => window.dinksterDesktop?.status())
    if (status?.phase !== phase) {
      phase = status?.phase
      console.log(`Desktop startup: ${phase}`)
    }
    if (phase === 'running' || phase === 'failed') break
    await delay(1000)
  }
  assert.equal(status?.phase, 'running', JSON.stringify(status))
  const health = await page.evaluate(async () => {
    const response = await fetch('/supervisor/status')
    if (!response.ok) throw new Error(`Backend HTTP status ${response.status}`)
    return response.json()
  })
  assert.equal(health.state, 'ready')
  await page.waitForFunction(
    () => {
      const registry = window.__dinksterTest?.app.backends
        .get()[0]
        ?.registry.get()
      return registry !== undefined && registry.schemas.size > 0
    },
    undefined,
    { timeout: 120_000 },
  )
  await page.screenshot({ path: join(root, 'ready.png') })
  console.log(
    'Packaged Desktop launched its bundled backend and frontend registry is populated',
  )
} catch (error) {
  await page
    ?.screenshot({ path: join(root, 'failed.png') })
    .catch(() => undefined)
  throw error
} finally {
  await app.close()
}
