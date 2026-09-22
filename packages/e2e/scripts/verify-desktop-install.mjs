import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { _electron as electron } from '@playwright/test'

const executablePath = process.env.DINKSTER_DESKTOP_EXECUTABLE
const directory = process.env.DINKSTER_DESKTOP_VERIFY_ROOT
if (!executablePath || !directory) {
  throw new Error('Set DINKSTER_DESKTOP_EXECUTABLE and a new DINKSTER_DESKTOP_VERIFY_ROOT')
}

const root = resolve(directory)
await mkdir(root, { recursive: false })
const dataDirectory = join(root, 'data')
const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
  value !== undefined
  && !/TOKEN|SECRET|PASSWORD|CREDENTIAL|ELECTRON_RUN_AS_NODE|^DINKSTER_|^UV_|^PYTHON|^VIRTUAL_ENV$|^GIT_|^PATH$/i.test(name),
))
env.DINKSTER_DESKTOP_DATA = dataDirectory
env.GIT_CONFIG_GLOBAL = join(root, 'no-git-config')
env.GIT_CONFIG_NOSYSTEM = '1'
env.GIT_TERMINAL_PROMPT = '0'
env.PATH = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')

async function verifyLaunch(name) {
  const app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${join(root, 'electron')}`],
    env,
    timeout: 60_000,
  })
  let page
  try {
    page = await app.firstWindow({ timeout: 60_000 })
    await page.waitForLoadState('domcontentloaded')
    await page.getByTestId('desktop-management-button').waitFor({ state: 'visible', timeout: 60_000 })
    const project = await page.evaluate(() => window.dinksterDesktop.projectEngine())
    assert.deepEqual(project.generations, [])
    assert.equal(project.projectId, 'default')
    assert.equal(project.configured, false)
    assert.equal(project.mirrorConfigured, false)
    assert.equal(project.port, undefined)

    await page.getByTestId('desktop-management-button').click()
    const section = page.locator('.desktop-management-section').filter({ has: page.locator('.desktop-project') })
    await section.getByRole('button', { name: 'Remove project' }).waitFor({ state: 'visible' })
    assert.match(await section.textContent(), /Project engine/)
    await page.screenshot({ path: join(root, `${name}.png`), fullPage: true })
    await writeFile(join(root, `${name}.json`), `${JSON.stringify({ project }, null, 2)}\n`)
    return project
  } catch (error) {
    await page?.screenshot({ path: join(root, `${name}-failed.png`), fullPage: true }).catch(() => undefined)
    throw error
  } finally {
    await app.close()
  }
}

const first = await verifyLaunch('first-run')
const restart = await verifyLaunch('restart')
assert.equal(restart.dataRoot, first.dataRoot)

const runtimeRoot = join(dataDirectory, 'control-runtime')
const digests = (await readdir(runtimeRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && /^[0-9a-f]{64}$/.test(entry.name))
assert.equal(digests.length, 1, 'Desktop must materialize one content-addressed control runtime')
const extracted = join(runtimeRoot, digests[0].name)
const descriptor = JSON.parse(await readFile(join(extracted, 'descriptor.json'), 'utf8'))
assert.equal(descriptor.format, 'dinkster.control-runtime/1')
assert.equal(descriptor.artifact.sha256, digests[0].name)
const interpreter = join(extracted, ...descriptor.python.split('/'))
assert.equal((await stat(interpreter)).isFile(), true)

const emptyRoot = join(root, 'empty-generations')
await mkdir(emptyRoot)
const execute = promisify(execFile)
const probe = await execute(interpreter, [
  '-I', '-m', 'dinkster.cli', 'generations', '--root', emptyRoot, '--json',
], { env, windowsHide: true, timeout: 60_000 })
assert.equal(probe.stdout.trim(), '[]')
assert.equal(probe.stderr.trim(), '')
await writeFile(join(root, 'control-runtime.json'), `${JSON.stringify({
  descriptor,
  interpreter,
  generations: JSON.parse(probe.stdout),
}, null, 2)}\n`)

console.log(`Verified installed Desktop fresh-project management and control runtime ${digests[0].name}`)
