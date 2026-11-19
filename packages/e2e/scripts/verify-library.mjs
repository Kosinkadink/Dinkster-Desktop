import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { _electron as electron, expect as baseExpect } from '@playwright/test'
import { acquireEnvironmentTools } from '../../desktop/dist/environment-tools.js'

const execute = promisify(execFile)

const expect = baseExpect.configure({ timeout: 60_000 })
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const fixture = process.env.DINKSTER_LIBRARY_FIXTURE
const artifacts = process.env.DINKSTER_SMOKE_ARTIFACTS
if (!fixture || !artifacts)
  throw new Error(
    'Set DINKSTER_LIBRARY_FIXTURE and DINKSTER_SMOKE_ARTIFACTS to isolated absolute directories',
  )
const pin = JSON.parse(
  await readFile(
    join(root, 'packages/desktop/src/environment-tools-release.json'),
    'utf8',
  ),
)
await mkdir(artifacts, { recursive: true })
const scratch = await mkdtemp(join(tmpdir(), 'dinkster-library-'))
const desktop = join(scratch, 'desktop')
const tools = {
  label: pin.label,
  sha256: pin.manifest.sha256,
  manifest: `https://releases.dinkster.org/tools/${pin.label}/tools-manifest.json`,
  release: `https://releases.dinkster.org/tools/${pin.label}`,
}
const require = createRequire(join(root, 'packages/desktop/package.json'))
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
let app
try {
  await mkdir(desktop)
  const installation = join(scratch, 'installation')
  await cp(fixture, installation, { recursive: true })
  const missing = join(scratch, 'missing')
  const unreadable = join(scratch, 'unreadable')
  await mkdir(join(unreadable, 'dinkster-library'), { recursive: true })
  await writeFile(
    join(unreadable, 'dinkster-library/records.sqlite'),
    'not a database',
  )
  await writeFile(
    join(desktop, 'projects.json'),
    JSON.stringify({
      version: 1,
      projects: [
        ['local', 'Local studio', installation],
        ['missing', 'Empty studio', missing],
        ['unreadable', 'Unreadable studio', unreadable],
      ].map(([id, name, root]) => ({
        id,
        name,
        root,
        channel: 'nightly',
        engines: [{ id: 'main', name: 'Main', kind: 'local', gpus: [] }],
      })),
    }),
  )
  const database = join(installation, 'dinkster-library/library.sqlite')
  const before = digest(await readFile(database))
  const env = Object.fromEntries(
    [
      'PATH',
      'DISPLAY',
      'XAUTHORITY',
      'LANG',
      'DBUS_SESSION_BUS_ADDRESS',
      'XDG_RUNTIME_DIR',
      'SystemRoot',
      'SYSTEMROOT',
      'WINDIR',
      'COMSPEC',
    ].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  )
  Object.assign(env, {
    HOME: join(scratch, 'home'),
    USERPROFILE: join(scratch, 'home'),
    XDG_DATA_HOME: join(scratch, 'account-data'),
    XDG_CONFIG_HOME: join(scratch, 'account-config'),
    LOCALAPPDATA: join(scratch, 'local-app-data'),
    APPDATA: join(scratch, 'app-data'),
    DINKSTER_HOME: join(scratch, 'home'),
    DINKSTER_DESKTOP_DATA: desktop,
    DINKSTER_TOOLS_MANIFEST: join(
      root,
      'packages/desktop/resources/tools/tools-manifest.json',
    ),
    DINKSTER_TOOLS_MANIFEST_SHA256: pin.manifest.sha256,
    DINKSTER_TOOLS_RELEASE: join(root, 'packages/desktop/resources/tools'),
    CUDA_VISIBLE_DEVICES: '',
    DINKSTER_ACCELERATOR: 'cpu',
  })
  app = await electron.launch({
    executablePath:
      process.env.DINKSTER_ELECTRON_EXECUTABLE ?? require('electron'),
    args: [
      '--no-sandbox',
      `--user-data-dir=${join(scratch, 'chromium')}`,
      join(root, 'packages/desktop'),
    ],
    env,
    timeout: 60_000,
  })
  const page = await app.firstWindow()
  await expect(page.getByRole('button', { name: 'View projects' })).toHaveCount(
    3,
  )
  const bridge = await page.evaluate(() => ({
    library: typeof window.dinksterLibrary,
    desktop: typeof window.dinksterDesktop,
    projects: typeof window.dinksterProjects,
  }))
  assert.deepEqual(bridge, {
    library: 'object',
    desktop: 'undefined',
    projects: 'undefined',
  })
  const capture = async (name) => {
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({
      path: join(artifacts, `${name}.png`),
      fullPage: true,
    })
  }
  await capture('installations')
  await page.getByRole('button', { name: 'View projects' }).nth(0).click()
  await expect(page.getByText('Beta project', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'View assets' })).toHaveCount(3)
  await capture('projects')
  await page.getByRole('button', { name: 'View assets' }).nth(0).click()
  await expect(page.getByText('beta-0.png', { exact: true })).toBeVisible()
  await expect(page.getByText('beta-workflow-2', { exact: true })).toBeVisible()
  assert(!(await page.locator('body').innerText()).includes('private.png'))
  assert(!(await page.locator('body').innerText()).includes('default-0.png'))
  await capture('beta-assets')
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(390, 760)
  })
  await expect
    .poll(() => page.evaluate(() => innerWidth))
    .toBeLessThanOrEqual(390)
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  )
  await capture('beta-assets-narrow')
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1040, 760)
  })
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await page.getByRole('button', { name: 'View assets' }).nth(1).click()
  await expect(page.getByText('default-0.png', { exact: true })).toBeVisible()
  assert(!(await page.locator('body').innerText()).includes('beta-0.png'))
  await capture('default-assets')
  await page.getByRole('button', { name: 'Installations', exact: true }).click()
  await page.getByRole('button', { name: 'View projects' }).nth(1).click()
  await expect(
    page.getByText('No projects yet.', { exact: true }),
  ).toBeVisible()
  await capture('missing')
  await page.getByRole('button', { name: 'Installations', exact: true }).click()
  await page.getByRole('button', { name: 'View projects' }).nth(2).click()
  await expect(
    page.getByText(
      'By the way, these projects and files cannot be shown with the installed tools.',
      { exact: true },
    ),
  ).toBeVisible()
  await expect(page.getByText('No projects yet.', { exact: true })).toHaveCount(
    0,
  )
  await capture('unreadable')
  const font = await page.evaluate(() => ({
    family: getComputedStyle(document.body).fontFamily,
    noto: [...document.fonts].filter(
      (face) => face.family.includes('Noto') && face.status === 'loaded',
    ).length,
  }))
  assert(font.noto > 0)
  assert.equal(digest(await readFile(database)), before)
  assert.deepEqual((await readdir(installation)).sort(), [
    'dinkster-library',
    'project.json',
  ])
  await app.close()
  app = undefined
  const installed = await acquireEnvironmentTools({
    ...tools,
    manifest: env.DINKSTER_TOOLS_MANIFEST,
    release: env.DINKSTER_TOOLS_RELEASE,
    cacheRoot: join(scratch, 'cli-tools'),
  })
  await execute(
    installed.python,
    [
      '-I',
      join(root, 'packages/e2e/scripts/verify-library-cli.py'),
      '--tools-python',
      installed.python,
      '--fixture',
      installation,
      '--complete',
      '--evidence',
      join(artifacts, 'cli'),
    ],
    { env, timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 },
  )
  await writeFile(
    join(artifacts, 'result.json'),
    JSON.stringify(
      {
        platform: process.platform,
        toolsCommit: pin.commit,
        toolsManifest: pin.manifest.sha256,
        bridge,
        font,
        libraryUnchanged: true,
        states: [
          'installations',
          'projects',
          'beta-assets',
          'beta-assets-narrow',
          'default-assets',
          'missing',
          'unreadable',
        ],
      },
      null,
      2,
    ),
  )
  console.log(
    'PASS: published-tools library navigation, isolated preload, project separation, narrow layout, missing/unreadable states and unchanged library bytes',
  )
} finally {
  if (app) await app.close()
  await rm(scratch, { recursive: true, force: true })
}
