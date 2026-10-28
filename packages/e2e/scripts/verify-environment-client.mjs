import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect } from '@playwright/test'

// This exercises Electron's client boundary, not generation assembly. The real
// shared-mirror fixture remains the environment command owner's responsibility.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const scratch = await mkdtemp(join(tmpdir(), 'dinkster-desktop-client-'))
const artifacts = process.env.DINKSTER_SMOKE_ARTIFACTS
if (artifacts) await mkdir(artifacts, { recursive: true })
const servers = []
let app
try {
  for (const heading of ['Original supervisor', 'Updated supervisor']) {
    const server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html')
      response.end(
        `<!doctype html><title>${heading}</title><h1>${heading}</h1>`,
      )
    })
    await new Promise((done) => server.listen(0, '127.0.0.1', done))
    servers.push(server)
  }
  const urls = servers.map(
    (server) => `http://127.0.0.1:${server.address().port}`,
  )
  const command = join(scratch, 'environment-command.cjs')
  const calls = join(scratch, 'calls.jsonl')
  await writeFile(
    command,
    String.raw`#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\n');
const root = args[args.indexOf('--root') + 1];
const operation = args[args.indexOf('--root') + 2];
const planned = args.includes('--plan');
const url = ${JSON.stringify(urls)}[operation === 'update' ? 1 : 0];
console.log(JSON.stringify({format:'dinkster.environment-result/1',operation,
status:planned ? 'planned' : 'applied',root,current:operation === 'update' ? 2 : 1,
plan:['Reuse the shared wheel store', 'Start a healthy supervisor before switching current'],url,
engines:[{name:'main',generation:operation === 'update' ? 2 : 1,state:operation === 'stop' ? 'stopped' : 'ready',url}]}));
`,
    { mode: 0o755 },
  )
  const env = Object.fromEntries(
    [
      'PATH',
      'HOME',
      'DISPLAY',
      'XDG_RUNTIME_DIR',
      'SystemRoot',
      'TEMP',
      'TMP',
    ].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  )
  env.DINKSTER_DESKTOP_DATA = join(scratch, 'desktop')
  env.DINKSTER_ENV = command
  app = await electron.launch({
    executablePath:
      process.env.DINKSTER_ELECTRON_EXECUTABLE ??
      createRequire(join(root, 'packages/desktop/package.json'))('electron'),
    args: [
      '--no-sandbox',
      `--user-data-dir=${join(scratch, 'chromium')}`,
      join(root, 'packages/desktop'),
    ],
    env,
  })
  const manager = await app.firstWindow()
  await manager.getByText('No projects yet.', { exact: false }).waitFor()
  if (artifacts)
    await manager.screenshot({
      path: join(artifacts, 'projects-default.png'),
      fullPage: true,
    })
  await manager
    .getByText('Manage a local installation', { exact: true })
    .click()
  await manager.locator('#local-name').fill('Local studio')
  await manager.locator('#local-root').fill(join(scratch, 'installation'))
  await manager.locator('#local-variant').fill('linux-cpu')
  await manager.getByRole('button', { name: 'Review environment plan' }).click()
  await manager.getByRole('button', { name: 'Confirm and apply' }).waitFor()
  let history = (await readFile(calls, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse)
  assert.equal(history.length, 1)
  assert(history[0].includes('--plan'))
  assert(!history[0].includes('--yes'))
  if (artifacts)
    await manager.screenshot({
      path: join(artifacts, 'local-plan.png'),
      fullPage: true,
    })
  await manager.getByRole('button', { name: 'Confirm and apply' }).click()
  await manager
    .getByRole('button', { name: 'Open main', exact: true })
    .waitFor()
  const opened = app.waitForEvent('window')
  await manager.getByRole('button', { name: 'Open main', exact: true }).click()
  const engine = await opened
  await engine.getByRole('heading', { name: 'Original supervisor' }).waitFor()
  assert.equal(
    await engine.evaluate(() => typeof window.dinksterProjects),
    'undefined',
  )
  await manager
    .getByRole('button', { name: 'Manage main', exact: true })
    .click()
  await manager.locator('#local-operation').selectOption('update')
  await manager.getByRole('button', { name: 'Review environment plan' }).click()
  await manager.getByRole('button', { name: 'Confirm and apply' }).click()
  await engine.getByRole('heading', { name: 'Updated supervisor' }).waitFor()
  assert.equal(new URL(engine.url()).origin, urls[1])
  await manager
    .getByText('Environment operation completed.', { exact: false })
    .waitFor()
  await manager.locator('#local-operation').selectOption('rollback')
  await manager.getByRole('button', { name: 'Review environment plan' }).click()
  await manager.getByRole('button', { name: 'Confirm and apply' }).click()
  await engine.getByRole('heading', { name: 'Original supervisor' }).waitFor()
  assert.equal(new URL(engine.url()).origin, urls[0])
  await manager
    .getByText('Environment operation completed.', { exact: false })
    .waitFor()
  if (artifacts)
    await manager.screenshot({
      path: join(artifacts, 'local-applied.png'),
      fullPage: true,
    })
  await manager.locator('#name').fill('Remote studio')
  await manager.locator('#url').fill(urls[1])
  await manager.getByRole('button', { name: 'Save remote project' }).click()
  await manager.getByRole('button', { name: 'Open Remote engine' }).waitFor()
  const count = (await readFile(calls, 'utf8')).trim().split('\n').length
  const remoteOpened = app.waitForEvent('window')
  await manager.getByRole('button', { name: 'Open Remote engine' }).click()
  const remote = await remoteOpened
  await remote.getByRole('heading', { name: 'Updated supervisor' }).waitFor()
  assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, count)
  assert.equal(await remote.evaluate(() => typeof window.require), 'undefined')
  const dataFiles = await readdir(env.DINKSTER_DESKTOP_DATA)
  for (const forbidden of ['generations', 'current', 'store', 'journal'])
    assert(!dataFiles.includes(forbidden))
  await app.evaluate(({ app: instance }) => {
    instance.quit()
  })
  await expect
    .poll(async () => (await readFile(calls, 'utf8')).includes('"stop"'))
    .toBe(true)
  history = (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(
    history.filter((args) => args.includes('--yes')).map((args) => args[2]),
    ['setup', 'start', 'update', 'rollback', 'stop'],
  )
  console.log(
    'Electron client boundary passed: plan/confirm, startup, new-port update, rollback, remote-only routing, identity-checked stop delegation.',
  )
} catch (error) {
  const manager = app?.windows()[0]
  if (manager && !manager.isClosed()) {
    console.error(
      'Project manager status:',
      await manager.locator('#message').textContent(),
    )
    if (artifacts)
      await manager.screenshot({
        path: join(artifacts, 'client-failure.png'),
        fullPage: true,
      })
  }
  throw error
} finally {
  if (app) await app.close().catch(() => {})
  await Promise.all(
    servers.map((server) => new Promise((done) => server.close(done))),
  )
  await rm(scratch, { recursive: true, force: true })
}
