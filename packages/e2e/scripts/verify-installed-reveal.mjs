import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect } from '@playwright/test'

// Reuse an installed generation without repeating setup or folder acceptance.
const installed = resolve(process.env.DINKSTER_DESKTOP_INSTALLED_ROOT)
const root = resolve(process.env.DINKSTER_DESKTOP_VERIFY_ROOT)
const rendererOnly = process.env.DINKSTER_DESKTOP_VERIFY_RENDERER_ONLY === '1'
const projects = JSON.parse(
  await readFile(join(installed, 'desktop', 'projects.json'), 'utf8'),
)
assert.equal(projects.projects.length, 1)
const project = projects.projects[0]
await mkdir(root, { recursive: false })
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name, value]) =>
      value !== undefined &&
      !/TOKEN|SECRET|PASSWORD|CREDENTIAL|ELECTRON_RUN_AS_NODE|^DINKSTER_|^PYTHON|^VIRTUAL_ENV$/i.test(
        name,
      ),
  ),
)
env.DINKSTER_DESKTOP_DATA = join(root, 'desktop')
env.DINKSTER_TOOLS_PYTHON = process.env.DINKSTER_TOOLS_PYTHON
env.XDG_DATA_HOME = join(installed, 'user-data')
env.LOCALAPPDATA = join(installed, 'user-data')
let app
let page
let stage = 'launch'
const rendererErrors = []
const result = {
  complete: false,
  setupRepeated: false,
  reveal: rendererOnly ? null : false,
  revealSkipped: rendererOnly,
  loadedRenderer: false,
}
try {
  app = await electron.launch({
    executablePath: process.env.DINKSTER_DESKTOP_VERIFY_ELECTRON,
    args: [
      '--no-sandbox',
      `--user-data-dir=${join(root, 'chromium')}`,
      fileURLToPath(new URL('../../desktop', import.meta.url)),
    ],
    env,
    timeout: 60_000,
  })
  app.process().stdout.on('data', () => {})
  app.process().stderr.on('data', () => {})
  app.on('window', (window) =>
    window.on('pageerror', (error) => rendererErrors.push(error.message)),
  )
  const manager = await app.firstWindow()
  await manager
    .getByRole('heading', { name: 'Projects', exact: true })
    .waitFor()
  await manager.evaluate(
    (project) => window.dinksterProjects.save(project),
    project,
  )
  const opened = app.waitForEvent('window', { timeout: 600_000 })
  stage = 'open-installed'
  await manager.evaluate(
    ({ id }) => window.dinksterProjects.open(id, 'main'),
    project,
  )
  page = await opened
  await page.waitForLoadState('domcontentloaded')
  if (!rendererOnly) {
    const configured = JSON.parse(
      await readFile(join(installed, 'configured.json'), 'utf8'),
    )
    const output = configured.activeMounts.find(
      (mount) => mount.id === configured.outputMount,
    )
    assert.ok(output && output.mode === 'readwrite')
    const target = join(output.path, 'keep.txt')
    const marker = await readFile(target)
    stage = 'publish-media'
    const capabilities = await page.evaluate(() =>
      window.dinksterDesktop.fileCapabilities(location.origin),
    )
    assert.equal(capabilities.reveal, true)
    // Reveal accepts published asset identities, not arbitrary granted markers.
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGNUqzzzn4GBgQEADlQCbLCpUUgAAAAASUVORK5CYII=',
      'base64',
    )
    const asset = await page.evaluate(
      async (bytes) => {
        const query = new URLSearchParams({
          scope: 'local',
          project: 'default',
          kind: 'media/image',
          name: 'installed reveal.png',
        })
        const response = await fetch(`/api/assets/media?${query}`, {
          method: 'POST',
          headers: { 'content-type': 'image/png' },
          body: new Uint8Array(bytes),
        })
        if (response.status !== 201)
          throw new Error(`Media publication failed (HTTP ${response.status})`)
        return (await response.json()).asset
      },
      [...bytes],
    )
    const locations = await page.evaluate(async (digest) => {
      const query = new URLSearchParams({
        digest,
        scope: 'local',
        project: 'default',
      })
      const response = await fetch(`/api/mounts/locations?${query}`)
      if (!response.ok)
        throw new Error('Published asset location lookup failed')
      return (await response.json()).locations
    }, asset.digest)
    assert.equal(locations.length, 1)
    assert.deepEqual(await readFile(locations[0].path), bytes)
    stage = 'reveal'
    const revealed = await page.evaluate(
      (asset) =>
        window.dinksterDesktop.revealFile(location.origin, {
          digest: asset.digest,
          scope: 'local',
          project: 'default',
        }),
      asset,
    )
    assert.equal(
      revealed.mode,
      process.platform === 'linux' ? 'folder' : 'selected',
    )
    assert.deepEqual(await readFile(target), marker)
    result.reveal = true
    await writeFile(
      join(root, 'reveal.json'),
      JSON.stringify({ capabilities, asset, locations, revealed }, null, 2),
    )
  }
  stage = 'loaded-renderer'
  await expect(page.getByTestId('graph-canvas')).toBeVisible({
    timeout: 120_000,
  })
  result.loadedRenderer = true
  await page.screenshot({ path: join(root, 'installed-renderer.png') })
} catch (error) {
  if (page)
    await page
      .screenshot({ path: join(root, 'renderer-at-failure.png') })
      .catch(() => {})
  await writeFile(
    join(root, 'failure.json'),
    JSON.stringify(
      {
        stage,
        type: error.constructor.name,
        message: error.message,
        rendererErrors,
        result,
      },
      null,
      2,
    ),
  )
  throw error
} finally {
  if (app) await app.close()
}
result.complete = true
await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result))
