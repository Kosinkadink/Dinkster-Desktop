import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const artifacts = process.env.DINKSTER_SMOKE_ARTIFACTS
if (artifacts) await mkdir(artifacts, { recursive: true })
const server = createServer(async (request, response) => {
  const path = {
    '/': 'packages/desktop/resources/projects.html',
    '/dist/project-dialog.js': 'packages/desktop/dist/project-dialog.js',
  }[request.url]
  if (!path) return void response.writeHead(404).end()
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
  const page = await browser.newPage({
    viewport: { width: 1080, height: 900 },
    locale: 'en-US',
  })
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
    window.fixture = 'complete'
    window.calls = []
    window.dinksterProjects = {
      list: async () => ({ projects: [project] }),
      plan: async (_project, request) => {
        window.calls.push(request)
        const incomplete = window.fixture === 'incomplete'
        const group = (exclusive, shared) => ({
          exclusiveAllocatedBytes: exclusive,
          sharedAllocatedBytes: shared,
        })
        return {
          result: {
            format: 'dinkster.environment-result/1',
            operation: 'space',
            status: 'clean',
            root: project.root,
            current: 3,
            plan: [],
            space: {
              format: 'dinkster.space/1',
              observedAt: 1794351600000000000,
              project: project.root,
              store: '/disposable/store',
              scope:
                'Managed software only. Models, outputs, workflows and mounts are excluded.',
              sharing:
                'Physical allocations shared by hard link or clone are counted once.',
              complete: !incomplete,
              allocatedBytes: incomplete ? null : 28672,
              observedAllocatedBytes: 28672,
              sharedAllocatedBytes: incomplete ? null : 8192,
              automaticReclaimableBytes: incomplete
                ? null
                : window.fixture === 'disabled'
                  ? 0
                  : 4096,
              eligibleGenerationReclaimableBytes: incomplete ? null : 4096,
              additionalExplicitReclaimableBytes: incomplete ? null : 12288,
              policy: {
                automatic: window.fixture !== 'disabled',
                previousSuccessfulActivations: 1,
                minimumAgeSeconds: 86400,
              },
              settingsCommand:
                'dinkster-env --root /disposable/studio cleanup --automatic on --keep-previous 1',
              settingsHelp:
                'Review the cleanup plan before confirming. Shared stores are never automatically cleaned.',
              generations: [
                {
                  generation: 1,
                  status: 'candidate',
                  reasons: ['outside retention policy'],
                  allocationGroup: 'generation/1',
                },
                {
                  generation: 2,
                  status: 'retained',
                  reasons: ['previous successful activation'],
                  allocationGroup: 'generation/2',
                },
                {
                  generation: 3,
                  status: 'retained',
                  reasons: ['current generation'],
                  allocationGroup: 'generation/3',
                },
              ],
              stores: [
                'bases',
                'wheels',
                'pack archives',
                'engine archives',
                'uv cache',
              ].map((label) => ({
                label,
                allocationGroup: `store/${label}`,
                automaticCleanup: false,
                reasons: ['explicit store cleanup only'],
              })),
              groups: {
                'generation/1': group(4096, 0),
                'generation/2': group(0, 8192),
                'generation/3': group(4096, 8192),
                'store/bases': group(4096, 0),
                'store/wheels': group(4096, 0),
                'store/pack archives': group(4096, 0),
                'store/engine archives': group(0, 0),
                'store/uv cache': group(0, 0),
                'project/metadata': group(0, 0),
              },
              warnings: incomplete
                ? [
                    'Clone extent observation unavailable; reclaimability cannot be established.',
                  ]
                : [],
              cleanupWarnings: [],
              eligibilityWarnings: [],
              reclaimabilityWarnings: [],
            },
          },
        }
      },
      apply: async () => {
        throw new Error('A read-only report must not apply')
      },
    }
  })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByRole('button', { name: 'Manage main' }).click()
  await page.locator('#local-operation').selectOption('space')
  for (const state of ['complete', 'disabled', 'incomplete']) {
    await page.evaluate((value) => {
      window.fixture = value
    }, state)
    await page.getByRole('button', { name: 'Review environment plan' }).click()
    await expect(page.locator('#plan-title')).toHaveText(
      'Managed software disk space',
    )
    await expect(page.locator('#apply')).toBeHidden()
    await expect(page.locator('#plan')).toContainText(
      'Models, outputs, workflows and mounts are excluded.',
    )
    await expect(page.locator('#plan')).toContainText(
      'Generation 3: retained - current generation',
    )
    await expect(page.locator('#plan')).toContainText(
      'Shared stores (never automatically cleaned)',
    )
    await expect(page.locator('#plan')).toContainText(
      state === 'incomplete'
        ? 'Total allocated (shared files counted once): unavailable'
        : 'Total allocated (shared files counted once): 28,672 bytes',
    )
    await expect(page.locator('#plan')).toContainText(
      state === 'incomplete'
        ? 'Automatic cleanup would free now: unavailable'
        : `Automatic cleanup would free now: ${state === 'disabled' ? '0' : '4,096'} bytes`,
    )
    await expect(page.locator('#plan')).toContainText(
      `Automatic generation cleanup: ${state === 'disabled' ? 'off' : 'on'}`,
    )
    assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), {
      root: '/disposable/studio',
      operation: 'space',
    })
    if (artifacts)
      await page
        .locator('#plan-panel')
        .screenshot({ path: resolve(artifacts, `space-${state}.png`) })
  }
  await page.setViewportSize({ width: 560, height: 900 })
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  )
  if (artifacts)
    await page
      .locator('#plan-panel')
      .screenshot({ path: resolve(artifacts, 'space-incomplete-narrow.png') })
  console.log(
    'Complete, disabled and incomplete read-only space reports passed; narrow layout does not overflow.',
  )
} finally {
  await browser?.close()
  await new Promise((done) => server.close(done))
}
