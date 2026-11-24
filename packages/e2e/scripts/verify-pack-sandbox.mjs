import assert from 'node:assert/strict'
import { installationManager } from './installation-manager.mjs'
import { createRequire } from 'node:module'
import { mkdir, readFile, readlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect } from '@playwright/test'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const required = (name) => {
  if (!process.env[name]) throw new Error(`${name} is required`)
  return resolve(process.env[name])
}
const project = required('DINKSTER_SANDBOX_PROJECT')
const python = required('DINKSTER_SANDBOX_TOOLS_PYTHON')
const artifacts = required('DINKSTER_SANDBOX_ARTIFACTS')
const port = Number(process.env.DINKSTER_SANDBOX_PORT ?? 19766)
await mkdir(artifacts, { recursive: true })
const data = join(artifacts, `desktop-data-${process.pid}`)
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      !/TOKEN|SECRET|PASSWORD|CREDENTIAL|ELECTRON_RUN_AS_NODE|^DINKSTER_|^UV_|^PYTHON|^VIRTUAL_ENV$|^GIT_/i.test(
        name,
      ),
  ),
)
Object.assign(env, {
  CUDA_VISIBLE_DEVICES: '',
  DINKSTER_ACCELERATOR: 'cpu',
  DINKSTER_DESKTOP_DATA: data,
  DINKSTER_TOOLS_PYTHON: python,
})
const receipt = { project, port, runs: [] }
let app
async function launch(environment, profile) {
  app = await electron.launch({
    executablePath: createRequire(
      join(repository, 'packages/desktop/package.json'),
    )('electron'),
    args: [
      '--no-sandbox',
      `--user-data-dir=${join(artifacts, profile)}`,
      join(repository, 'packages/desktop'),
    ],
    env: environment,
  })
  const page = await installationManager(app)
  return page
}
async function stop(page) {
  await page.getByLabel('Operation').selectOption('stop')
  await page
    .getByRole('button', { name: 'Review environment plan', exact: true })
    .click()
  await expect(
    page.getByRole('button', { name: 'Confirm and apply' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Confirm and apply' }).click()
  await expect(page.getByRole('status')).toContainText(
    'Environment operation completed',
    { timeout: 60_000 },
  )
}
async function json(url, options) {
  const response = await fetch(url, options)
  const value = await response.json()
  assert(response.ok, JSON.stringify(value))
  return value
}
async function namespaces(pid) {
  return Object.fromEntries(
    await Promise.all(
      ['user', 'pid', 'net'].map(async (name) => [
        name,
        await readlink(`/proc/${pid}/ns/${name}`),
      ]),
    ),
  )
}
async function descendants(pid) {
  const rows = []
  const children = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8'))
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  for (const child of children) {
    try {
      rows.push(
        {
          pid: Number(child),
          name: (await readFile(`/proc/${child}/comm`, 'utf8')).trim(),
          namespaces: await namespaces(child),
        },
        ...(await descendants(child)),
      )
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error
    }
  }
  return rows
}
try {
  assert.equal(
    process.platform,
    'linux',
    'this acceptance checks real Linux worker namespaces',
  )
  const hostNamespaces = await namespaces(process.pid)
  const page = await launch(env, 'chromium-available')
  await page.getByLabel('Environment name').fill('Sandbox acceptance')
  await page.getByLabel('Install location').fill(project)
  await page.getByLabel('Supervisor port').fill(String(port))
  await page.getByRole('button', { name: 'Check sandbox availability' }).click()
  await expect(page.getByLabel('Sandbox local pack workers')).toBeEnabled({
    timeout: 60_000,
  })
  await expect(page.getByLabel('Sandbox local pack workers')).not.toBeChecked()
  for (const sandboxed of [false, true]) {
    await page.getByLabel('Sandbox local pack workers').setChecked(sandboxed)
    await page.getByRole('button', { name: 'Save existing binding' }).click()
    await expect(page.getByRole('status')).toContainText('Binding saved')
    const saved = JSON.parse(
      await readFile(join(data, 'projects.json'), 'utf8'),
    )
    assert.equal(saved.projects[0].sandboxPacks, sandboxed)
    await page.screenshot({
      path: join(artifacts, sandboxed ? 'sandbox-on.png' : 'sandbox-off.png'),
    })
    await page.getByRole('button', { name: 'Open main', exact: true }).click()
    const base = `http://127.0.0.1:${port}`
    await expect
      .poll(
        async () => {
          let nodes
          try {
            nodes = await json(`${base}/api/nodes`)
          } catch {
            return false
          }
          if (nodes.nodes?.['example-tally.shout']) return true
          const composition = await json(`${base}/api/composition`)
          assert.notEqual(
            composition.packs?.['example-tally']?.state,
            'failed',
            JSON.stringify(composition),
          )
          return false
        },
        { timeout: 120_000 },
      )
      .toBe(true)
    const jobId = sandboxed ? 'sandboxed' : 'plain'
    await json(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: 'desktop-sandbox',
        jobId,
        cacheEnabled: false,
        graph: {
          nodes: {
            shout: {
              nodeType: 'example-tally.shout',
              inputs: { text: 'Pack sandbox 966' },
            },
          },
        },
        targets: ['shout'],
      }),
    })
    let job
    await expect
      .poll(
        async () => {
          job = await json(`${base}/api/jobs/desktop-sandbox/${jobId}`)
          return job.state
        },
        { timeout: 60_000 },
      )
      .toBe('completed')
    assert.deepEqual(job.executed, ['shout'])
    assert.deepEqual(job.cached, [])
    const value = await json(
      `${base}/api/values?clientId=desktop-sandbox&jobId=${jobId}&nodeId=shout&outputId=text`,
    )
    assert.equal(value.descriptor.value, 'PACK SANDBOX 966')
    const generation = (await readFile(join(project, 'current'), 'utf8')).trim()
    const runtime = JSON.parse(
      await readFile(join(project, 'runtime', generation, 'main.json'), 'utf8'),
    )
    assert.equal(runtime.sandboxPacks, sandboxed)
    const processes = await json(`${base}/api/workers`)
    const children = await descendants(runtime.pid)
    const isolated = children.filter((child) =>
      ['user', 'pid', 'net'].every(
        (name) => child.namespaces[name] !== hostNamespaces[name],
      ),
    )
    assert.equal(
      isolated.length > 0,
      sandboxed,
      'pack execution must use distinct Linux user, PID and network namespaces only when requested',
    )
    receipt.runs.push({
      sandboxed,
      job,
      value,
      workers: processes,
      hostNamespaces,
      children,
    })
    if (!sandboxed) {
      await page.getByLabel('Sandbox local pack workers').check()
      await page.getByRole('button', { name: 'Save existing binding' }).click()
      await expect(page.getByRole('alert')).toContainText(
        'Stop the local engines',
      )
      const unchanged = JSON.parse(
        await readFile(join(data, 'projects.json'), 'utf8'),
      )
      assert.equal(unchanged.projects[0].sandboxPacks, false)
    }
    await stop(page)
  }
  await app.close()
  app = undefined
  const emptyPath = join(artifacts, 'empty-path')
  await mkdir(emptyPath, { recursive: true })
  const unavailable = await launch(
    { ...env, PATH: emptyPath },
    'chromium-unavailable',
  )
  await unavailable
    .getByLabel('Saved environment')
    .selectOption({ label: 'Sandbox acceptance' })
  await unavailable
    .getByRole('button', { name: 'Check sandbox availability' })
    .click()
  await expect(unavailable.getByText('bwrap not found')).toBeVisible({
    timeout: 60_000,
  })
  await expect(
    unavailable.getByLabel('Sandbox local pack workers'),
  ).toBeChecked()
  await unavailable.screenshot({
    path: join(artifacts, 'sandbox-saved-unavailable.png'),
  })
  await unavailable
    .getByRole('button', { name: 'Open main', exact: true })
    .click()
  await expect(unavailable.getByRole('alert')).toContainText('bwrap not found')
  const retained = JSON.parse(
    await readFile(join(data, 'projects.json'), 'utf8'),
  )
  assert.equal(retained.projects[0].sandboxPacks, true)
  await unavailable.getByLabel('Sandbox local pack workers').uncheck()
  await expect(
    unavailable.getByLabel('Sandbox local pack workers'),
  ).toBeDisabled()
  await expect(
    unavailable.getByLabel('Sandbox local pack workers'),
  ).not.toBeChecked()
  await unavailable
    .getByRole('button', { name: 'Save existing binding' })
    .click()
  await expect(unavailable.getByRole('status')).toContainText('Binding saved')
  const disabled = JSON.parse(
    await readFile(join(data, 'projects.json'), 'utf8'),
  )
  assert.equal(disabled.projects[0].sandboxPacks, false)
  await unavailable.screenshot({
    path: join(artifacts, 'sandbox-unavailable.png'),
  })
  receipt.unavailable = await unavailable
    .getByText('bwrap not found')
    .innerText()
  await writeFile(
    join(artifacts, 'receipt.json'),
    JSON.stringify(receipt, null, 2),
  )
  console.log(
    JSON.stringify({
      passed: true,
      outputs: receipt.runs.map((run) => ({
        sandboxed: run.sandboxed,
        value: run.value.descriptor.value,
      })),
      unavailable: receipt.unavailable,
    }),
  )
} finally {
  if (app) await app.close()
}
