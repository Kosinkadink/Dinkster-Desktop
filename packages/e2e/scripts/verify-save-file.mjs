import assert from 'node:assert/strict'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'

const root = resolve(import.meta.dirname, '../../..')
const artifacts = process.env.DINKSTER_SMOKE_ARTIFACTS
if (!artifacts)
  throw new Error(
    'Set DINKSTER_SMOKE_ARTIFACTS to an isolated absolute directory',
  )
await mkdir(artifacts, { recursive: true })
const require = createRequire(join(root, 'packages/desktop/package.json'))
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|ELECTRON_RUN_AS_NODE/i.test(
        key,
      ),
  ),
)
const app = await electron.launch({
  executablePath: require('electron'),
  args: [join(import.meta.dirname, 'save-file-fixture.mjs')],
  env,
})
try {
  const page = await app.firstWindow()
  await page.waitForFunction(
    () => typeof window.dinksterDesktop?.saveFile === 'function',
  )
  const destination = join(artifacts, 'chosen-output.bin')
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async (_parent, options) => {
      if (options.defaultPath !== 'suggested.bin')
        throw new Error('Incorrect suggested name')
      return { canceled: false, filePath }
    }
  }, destination)
  const saved = await page.evaluate(() =>
    window.dinksterDesktop.saveFile(
      new Uint8Array([91, 0, 255, 13, 10, 128, 92]).subarray(1, 6),
      'suggested.bin',
    ),
  )
  assert.deepEqual(saved, { status: 'saved', name: 'chosen-output.bin' })
  assert.deepEqual(
    await readFile(destination),
    Buffer.from([0, 255, 13, 10, 128]),
  )
  const before = await readdir(artifacts)
  await app.evaluate(
    ({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: true, filePath })
    },
    join(artifacts, 'must-not-exist.bin'),
  )
  assert.deepEqual(
    await page.evaluate(() =>
      window.dinksterDesktop.saveFile(new Uint8Array([9]), 'closed.bin'),
    ),
    { status: 'closed' },
  )
  assert.deepEqual(await readdir(artifacts), before)
  for (const name of ['../escape.bin', 'C:\\escape.bin']) {
    const rejected = await page.evaluate(async (name) => {
      try {
        await window.dinksterDesktop.saveFile(new Uint8Array([9]), name)
        return false
      } catch {
        return true
      }
    }, name)
    assert.equal(rejected, true)
  }
  await app.evaluate(
    ({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath })
    },
    join(artifacts, 'missing', 'output.bin'),
  )
  assert.equal(
    await page.evaluate(async () => {
      try {
        await window.dinksterDesktop.saveFile(new Uint8Array([9]), 'output.bin')
        return false
      } catch {
        return true
      }
    }),
    true,
  )
  console.log(
    'PASS: real Electron preload/IPC preserves byte views, reports renamed saves and closed dialogs, and rejects paths and failed writes. Dialog selections are stubbed in the main process.',
  )
} finally {
  await app.close()
}
