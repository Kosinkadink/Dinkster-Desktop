import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { _electron as electron, expect } from '@playwright/test'

// Shell installation is independent of generation construction. Local lifecycle
// acceptance also needs the environment owner's real tools and shared mirror.
const executablePath = process.env.DINKSTER_DESKTOP_EXECUTABLE
const directory = process.env.DINKSTER_DESKTOP_VERIFY_ROOT
if (!executablePath || !directory) throw new Error('Set DINKSTER_DESKTOP_EXECUTABLE and a new DINKSTER_DESKTOP_VERIFY_ROOT')
const root = resolve(directory)
await mkdir(root, { recursive: false })
const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
  value !== undefined && !/TOKEN|SECRET|PASSWORD|CREDENTIAL|ELECTRON_RUN_AS_NODE|^DINKSTER_|^UV_|^PYTHON|^VIRTUAL_ENV$|^GIT_|^PATH$/i.test(name),
))
env.DINKSTER_DESKTOP_DATA = join(root, 'data')
env.DINKSTER_ENV = join(root, 'environment-tools-must-not-run')
env.PATH = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32') : '/nonexistent'

let requests = 0
const server = createServer((_request, response) => {
  requests += 1
  response.setHeader('Content-Type', 'text/html')
  response.end('<!doctype html><title>Remote project</title><h1>Installed remote frontend</h1>')
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const url = `http://127.0.0.1:${server.address().port}`
let bindings
try {
  for (const launch of ['first-run', 'restart']) {
    const app = await electron.launch({
      executablePath: resolve(executablePath), args: ['--no-sandbox', `--user-data-dir=${join(root, 'electron')}`], env, timeout: 60_000,
    })
    let page
    try {
      assert.equal(await app.evaluate(({ app }) => app.isPackaged), true)
      page = await app.firstWindow({ timeout: 60_000 })
      await page.getByRole('heading', { name: 'Projects', exact: true }).waitFor()
      if (launch === 'first-run') {
        await page.getByText('No projects yet.', { exact: false }).waitFor()
        await page.locator('#name').fill('Installed remote project')
        await page.locator('#url').fill(url)
        await page.locator('#channel').selectOption('main')
        await page.getByRole('button', { name: 'Save remote project' }).click()
      }
      await page.getByRole('button', { name: 'Open Remote engine' }).waitFor()
      const before = requests
      const opened = app.waitForEvent('window')
      await page.getByRole('button', { name: 'Open Remote engine' }).click()
      const remote = await opened
      await remote.getByRole('heading', { name: 'Installed remote frontend' }).waitFor()
      assert.equal(new URL(remote.url()).origin, url)
      assert(requests > before, 'The remote frontend must be served on each launch')
      assert.deepEqual(await remote.evaluate(() => [
        typeof window.require, typeof window.process, typeof window.dinksterDesktop, typeof window.dinksterProjects,
      ]), ['undefined', 'undefined', 'undefined', 'undefined'])
      const path = join(env.DINKSTER_DESKTOP_DATA, 'projects.json')
      const record = await readFile(path, 'utf8')
      const projects = JSON.parse(record).projects
      assert.equal(projects.length, 1)
      assert.equal(projects[0].channel, 'main')
      assert.equal(projects[0].root, undefined)
      assert.deepEqual(projects[0].engines, [{ id: 'remote', name: 'Remote engine', kind: 'remote', url }])
      if (bindings !== undefined) assert.equal(record, bindings, 'Restart must preserve remote bindings')
      bindings = record
      await page.locator('#name').fill('Rejected credentials')
      await page.locator('#url').fill(url.replace('://', '://blocked@'))
      await page.getByRole('button', { name: 'Save remote project' }).click()
      await expect(page.locator('#message')).toContainText('without credentials')
      assert.equal(await readFile(path, 'utf8'), record, 'Refused URL must not change bindings')
      async function inspect(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          assert(!['generations', 'current', 'store', 'journal', '.venv'].includes(entry.name), `Unexpected environment state: ${entry.name}`)
          if (entry.isDirectory()) await inspect(join(directory, entry.name))
        }
      }
      await inspect(env.DINKSTER_DESKTOP_DATA)
      await remote.screenshot({ path: join(root, `${launch}.png`), fullPage: true })
      await writeFile(join(root, `${launch}.json`), JSON.stringify({
        packaged: true, remote: url, channel: projects[0].channel,
        bindingsPreserved: true, remoteIsolated: true, localEnvironmentCreated: false, credentialUrlRefused: true,
      }, null, 2))
      console.log(`Verified installed Desktop ${launch}: remote frontend, isolated renderer, no local environment or Git`)
    } catch (error) {
      await page?.screenshot({ path: join(root, `${launch}-failed.png`), fullPage: true }).catch(() => undefined)
      throw error
    } finally {
      await app.close()
    }
  }
} finally {
  await new Promise((done) => server.close(done))
}
