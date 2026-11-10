import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'

// Exercise the shipped dialog and compiled renderer with protocol fixtures.
// Subprocess argument and response validation is covered by environment.test.ts.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const artifacts = process.env.DINKSTER_SMOKE_ARTIFACTS
if (artifacts) await mkdir(artifacts, { recursive: true })
const server = createServer(async (request, response) => {
  const paths = {
    '/': 'packages/desktop/resources/projects.html',
    '/dist/project-dialog.js': 'packages/desktop/dist/project-dialog.js',
  }
  const path = paths[request.url]
  if (!path) {
    response.writeHead(404).end()
    return
  }
  response.setHeader(
    'Content-Type',
    request.url === '/' ? 'text/html' : 'text/javascript',
  )
  response.end(await readFile(resolve(root, path)))
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
let browser
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.DINKSTER_CHROMIUM_PATH,
  })
  const page = await browser.newPage({ viewport: { width: 1080, height: 900 } })
  await page.addInitScript(() => {
    const project = {
      id: 'studio',
      name: 'Local studio',
      channel: 'stable',
      root: '/disposable/studio',
      engines: [
        { id: 'main', name: 'main', kind: 'local', gpus: [], port: 3639 },
      ],
    }
    window.calls = []
    window.fixture = 'default'
    let previousCount = 1
    let pendingCount
    let pendingAutomatic
    const result = (operation, status) => ({
      format: 'dinkster.environment-result/1',
      operation,
      status,
      root: project.root,
      current: 3,
      plan: [],
      ...(window.fixture === 'old'
        ? {}
        : {
            cleanup: {
              policy: {
                automatic: window.fixture !== 'disabled',
                previousSuccessfulActivations: previousCount,
                minimumAgeSeconds: 0,
              },
              generations: [
                {
                  generation: 1,
                  status: 'deferred',
                  reasons: ['live runtime requires exit proof'],
                },
                {
                  generation: 2,
                  status: 'retained',
                  reasons: ['previous successful activation'],
                },
                {
                  generation: 3,
                  status: 'retained',
                  reasons: ['current generation'],
                },
              ],
              quarantine: [
                {
                  journal: 'gc-example',
                  stage: 'quarantined',
                  generations: [4],
                },
              ],
              warnings: ['Cleanup will retry when the runtime is idle.'],
              lastAttempt: {
                status: 'deferred',
                warnings: ['Runtime is busy.'],
              },
            },
          }),
    })
    window.dinksterProjects = {
      list: async () => ({ projects: [project] }),
      save: async () => {},
      remove: async () => {},
      open: async () => {},
      plan: async (_project, request) => {
        window.calls.push(request)
        pendingCount = request.keepPreviousGenerations
        pendingAutomatic = request.automaticCleanup
        return {
          ...(request.operation === 'status' ? {} : { token: 'reviewed' }),
          result: result(
            request.operation,
            request.operation === 'status' ? 'clean' : 'planned',
          ),
        }
      },
      apply: async () => {
        if (pendingCount !== undefined) previousCount = pendingCount
        return result(
          'cleanup',
          pendingCount !== undefined || pendingAutomatic !== undefined
            ? 'applied'
            : window.fixture === 'disabled'
              ? 'disabled'
              : 'deferred',
        )
      },
    }
  })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByRole('button', { name: 'Manage main' }).click()
  await page.locator('#local-operation').selectOption('status')
  await page.getByRole('button', { name: 'Review environment plan' }).click()
  await expect(page.locator('#plan')).toContainText(
    'Generation 1: deferred - live runtime requires exit proof',
  )
  await expect(page.locator('#plan')).toContainText('Quarantine gc-example')
  await expect(page.locator('#apply')).toBeHidden()
  if (artifacts)
    await page
      .locator('#plan-panel')
      .screenshot({ path: resolve(artifacts, 'cleanup-status.png') })
  await page.locator('#local-operation').selectOption('cleanup')
  await expect(page.locator('#local-keep-previous')).toHaveValue('')
  if (artifacts)
    await page
      .locator('#local')
      .screenshot({ path: resolve(artifacts, 'cleanup-count-default.png') })
  await page.locator('#local-keep-previous').fill('0')
  assert.equal(
    await page
      .locator('#local-keep-previous')
      .evaluate((input) => input.checkValidity()),
    false,
  )
  await page.locator('#local-keep-previous').fill('2')
  await page.getByRole('button', { name: 'Review environment plan' }).click()
  assert.equal(
    await page.evaluate(() => window.calls.at(-1).keepPreviousGenerations),
    2,
  )
  await page.locator('#apply').click()
  await expect(page.locator('#plan')).toContainText(
    'Keep current and 2 previous successful activation(s)',
  )
  if (artifacts)
    await page
      .locator('#plan-panel')
      .screenshot({ path: resolve(artifacts, 'cleanup-count-two.png') })
  await expect(page.locator('#local-keep-previous')).toHaveValue('')
  await page.getByRole('button', { name: 'Review environment plan' }).click()
  assert.equal(
    await page.evaluate(() => window.calls.at(-1).keepPreviousGenerations),
    undefined,
  )
  await page.locator('#apply').click()
  await expect(page.locator('#message')).toContainText('returned deferred')
  await expect(page.locator('#plan')).toContainText('Runtime is busy.')
  if (artifacts)
    await page
      .locator('#plan-panel')
      .screenshot({ path: resolve(artifacts, 'cleanup-deferred.png') })
  await page.evaluate(() => {
    window.fixture = 'disabled'
  })
  await page.locator('#local-cleanup').selectOption('off')
  await page.getByRole('button', { name: 'Review environment plan' }).click()
  await page.locator('#apply').click()
  await expect(page.locator('#plan')).toContainText(
    'Automatic generation cleanup: off',
  )
  await expect(page.locator('#message')).toContainText('returned applied')
  assert.equal(
    await page.evaluate(() => window.calls.at(-1).automaticCleanup),
    false,
  )
  if (artifacts)
    await page
      .locator('#plan-panel')
      .screenshot({ path: resolve(artifacts, 'cleanup-disabled.png') })
  await expect(page.locator('#local-cleanup')).toHaveValue('keep')
  await page.getByRole('button', { name: 'Review environment plan' }).click()
  assert.equal(
    await page.evaluate(() => window.calls.at(-1).automaticCleanup),
    undefined,
  )
  await page.evaluate(() => {
    window.fixture = 'old'
  })
  await page.locator('#local-operation').selectOption('status')
  await page.getByRole('button', { name: 'Review environment plan' }).click()
  await expect(page.locator('#plan')).toContainText(
    'Cleanup details unavailable',
  )
  await expect(page.locator('#apply')).toBeHidden()
  assert.equal(
    await page.evaluate(() => window.calls.at(-1).automaticCleanup),
    undefined,
  )
  if (artifacts)
    await page
      .locator('#plan-panel')
      .screenshot({ path: resolve(artifacts, 'cleanup-unavailable.png') })
  console.log(
    'Cleanup dialog status, retry, preference and unavailable controls passed.',
  )
} finally {
  await browser?.close()
  await new Promise((done) => server.close(done))
}
