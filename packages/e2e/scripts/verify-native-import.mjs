import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'

const root = resolve(import.meta.dirname, '../../..')
const artifacts = process.env.DINKSTER_SMOKE_ARTIFACTS
const backend = process.env.DINKSTER_IMPORT_TEST_BACKEND
const project = process.env.DINKSTER_IMPORT_TEST_PROJECT || 'default'
if (!artifacts || !backend)
  throw new Error(
    'Set DINKSTER_SMOKE_ARTIFACTS and DINKSTER_IMPORT_TEST_BACKEND to isolated test resources',
  )
await mkdir(artifacts, { recursive: true })
const policy = await fetch(new URL('/api/assets/upload-limits', backend))
assert.equal(policy.status, 200)
const policyBody = await policy.json()
assert.equal(policyBody, null, 'Use an explicitly uncapped test engine')
const source = join(artifacts, 'native-file.bin')
const size = 500_000_000
const handle = await open(source, 'wx')
try {
  await handle.truncate(size)
  await handle.write(Buffer.from([19, 0, 255, 42]), 0, 4, 0)
  await handle.write(Buffer.from([101, 7, 0, 233]), 0, 4, size - 4)
} finally {
  await handle.close()
}
const expected = createHash('sha256')
for await (const chunk of createReadStream(source)) expected.update(chunk)
const expectedDigest = expected.digest('hex')
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
  args: [join(import.meta.dirname, 'native-import-fixture.mjs')],
  env,
})
try {
  const page = await app.firstWindow()
  await page.waitForFunction(
    () => typeof window.dinksterDesktop?.importFile === 'function',
  )
  await page.locator('input[type=file]').setInputFiles(source)
  const result = await page.evaluate(async (backend) => {
    const file = document.querySelector('input[type=file]').files[0]
    Blob.prototype.arrayBuffer = async () => {
      throw new Error('Whole-file page read is forbidden')
    }
    FileReader.prototype.readAsArrayBuffer = () => {
      throw new Error('Whole-file page read is forbidden')
    }
    return window.dinksterDesktop.importFile(backend, file, {
      name: file.name,
      mediaType: 'application/octet-stream',
    })
  }, backend)
  assert.equal(result.status, 'imported')
  assert.equal(result.asset.size, size)
  assert.equal(result.asset.name, 'native-file.bin')
  assert.match(result.asset.virtualPath, /^mounts\//)
  const proof = await app.evaluate(() => globalThis.nativeImportProof)
  assert.equal(proof.requests, 1)
  assert.ok(
    proof.bytes < size / 1000,
    'Only path metadata crosses the client boundary',
  )
  const url = new URL(
    `/api/assets/${encodeURIComponent(result.asset.digest)}`,
    backend,
  )
  url.search = new URLSearchParams({ scope: 'local', project }).toString()
  const response = await fetch(url)
  assert.equal(response.status, 200)
  const actual = createHash('sha256')
  let copied = 0
  for await (const chunk of response.body) {
    actual.update(chunk)
    copied += chunk.length
  }
  assert.equal(copied, size)
  assert.equal(actual.digest('hex'), expectedDigest)
  assert.deepEqual(
    await page.evaluate(
      async (backend) =>
        window.dinksterDesktop.importFile(
          backend,
          new File(['synthetic'], 'synthetic.bin'),
          { name: 'synthetic.bin', mediaType: 'application/octet-stream' },
        ),
      backend,
    ),
    { status: 'refused', reason: 'not-native-file' },
  )
  assert.equal(
    await page.evaluate(async (backend) => {
      try {
        await window.dinksterDesktop.importFile(
          backend,
          '/private/source.bin',
          { name: 'source.bin', mediaType: 'application/octet-stream' },
        )
        return false
      } catch {
        return true
      }
    }, backend),
    true,
  )
  const evidence = {
    status: 'PASS',
    size,
    copied,
    sha256: expectedDigest,
    importRequests: proof.requests,
    requestBytes: proof.bytes,
    boundary:
      'Real Electron preload and IPC, production native import helper, real engine; fixture supplies trusted window/project binding instead of production managedFiles',
  }
  await writeFile(
    join(artifacts, 'native-import-result.json'),
    JSON.stringify(evidence, null, 2),
  )
  console.log(JSON.stringify(evidence))
} finally {
  await app.close()
}
