import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron as electron, expect } from '@playwright/test'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
assert(
  process.env.DINKSTER_DESKTOP_VERIFY_ROOT,
  'Supply a new owned evidence root',
)
const root = resolve(process.env.DINKSTER_DESKTOP_VERIFY_ROOT)
await mkdir(root)
const require = createRequire(join(repository, 'packages/desktop/package.json'))
const source = pathToFileURL(
  join(repository, 'packages/desktop/dist/window-chrome.js'),
).href
const site = join(repository, 'packages/app/dist/site')
const entry = join(root, 'main.mjs')
await writeFile(
  entry,
  `
import { app, BrowserWindow, nativeTheme } from 'electron'
import { readWindowChrome, windowChromeOptions, installWindowChrome } from ${JSON.stringify(source)}
const chrome = readWindowChrome(${JSON.stringify(site)})
app.on('window-all-closed', () => {})
globalThis.openChrome = async (url, qa, development, width) => {
  const window = new BrowserWindow({ ...windowChromeOptions(chrome, nativeTheme.shouldUseDarkColors),
    width, height: 600, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  installWindowChrome(window, chrome, nativeTheme, () => development, qa ? 'qa' : 'production')
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  await window.loadURL(url)
  window.showInactive()
}
`,
)
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name, value]) =>
      value !== undefined &&
      !/TOKEN|SECRET|PASSWORD|CREDENTIAL|ELECTRON_RUN_AS_NODE|^DINKSTER_|^UV_|^PYTHON|^VIRTUAL_ENV$|^GIT_/i.test(
        name,
      ),
  ),
)
Object.assign(env, {
  CUDA_VISIBLE_DEVICES: '',
  DINKSTER_ACCELERATOR: 'cpu',
  XDG_DATA_HOME: join(root, 'xdg-data'),
  XDG_CACHE_HOME: join(root, 'xdg-cache'),
})
const app = await electron.launch({
  executablePath: require('electron'),
  args: ['--no-sandbox', `--user-data-dir=${join(root, 'electron')}`, entry],
  env,
})
const results = []
try {
  for (const theme of ['dark', 'light']) {
    await app.evaluate(({ nativeTheme }, theme) => {
      nativeTheme.themeSource = theme
    }, theme)
    for (const existing of [true, false]) {
      const html = `<!doctype html><meta charset="utf-8"><title>Untrusted page title</title>
        <style>body{margin:0}main{padding:24px}#toast{position:fixed;right:24px;bottom:24px}</style>
        ${existing ? '<header class="topbar"><button id="control">Original control</button></header>' : ''}
        <main><h1>Engine content</h1><p>Original content remains available.</p></main>
        <button id="toast">Saved successfully - dismiss</button>
        <script>document.querySelector('#toast').onclick=e=>e.target.remove();
        document.querySelector('#control')?.addEventListener('click',e=>e.target.textContent='Control works')</script>`
      const opened = app.waitForEvent('window')
      await app.evaluate(
        async (_, { url, width }) =>
          globalThis.openChrome(url, true, true, width),
        {
          url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
          width: 390,
        },
      )
      const page = await opened
      await expect(page.locator('.dinkster-window-identity')).toBeVisible()
      await expect(page.locator('.dinkster-window-identity')).toContainText(
        'QA',
      )
      await expect(page.locator('.dinkster-window-identity')).toContainText(
        'Development',
      )
      await expect(page.locator('[data-desktop-chrome]')).toHaveAttribute(
        'data-theme',
        theme,
      )
      assert.deepEqual(
        await page.evaluate(() => [
          typeof window.require,
          typeof window.process,
          typeof window.dinksterDesktop,
          typeof window.DinksterDesktopChrome,
        ]),
        ['undefined', 'undefined', 'undefined', 'undefined'],
      )
      const geometry = await page.evaluate(() => {
        const bar = document.querySelector('[data-desktop-chrome]')
        const bounds = bar.getBoundingClientRect()
        const identity = document
          .querySelector('.dinkster-window-identity')
          .getBoundingClientRect()
        const toast = document.querySelector('#toast').getBoundingClientRect()
        return {
          height: bounds.height,
          contained:
            identity.top >= bounds.top && identity.bottom <= bounds.bottom,
          clear: identity.bottom < toast.top,
          overflow: document.documentElement.scrollWidth > innerWidth,
          region: getComputedStyle(bar).webkitAppRegion,
          pseudo: getComputedStyle(document.body, '::after').content,
        }
      })
      assert.equal(geometry.height, 56)
      assert.equal(geometry.contained, true)
      assert.equal(geometry.clear, true)
      assert.equal(geometry.overflow, false)
      assert.equal(geometry.region, 'drag')
      assert.equal(geometry.pseudo, 'none')
      if (existing) {
        await page.locator('#control').click()
        await expect(page.locator('#control')).toHaveText('Control works')
      }
      await page.screenshot({
        path: join(
          root,
          `${theme}-${existing ? 'existing' : 'fallback'}-390.png`,
        ),
      })
      await page.locator('#toast').click()
      await expect(page.locator('#toast')).toHaveCount(0)
      const opposite = theme === 'dark' ? 'light' : 'dark'
      await app.evaluate(({ nativeTheme }, theme) => {
        nativeTheme.themeSource = theme
      }, opposite)
      await expect(page.locator('[data-desktop-chrome]')).toHaveAttribute(
        'data-theme',
        opposite,
      )
      await expect(page.locator('.dinkster-window-identity')).toHaveCount(1)
      await app.evaluate(({ nativeTheme }, theme) => {
        nativeTheme.themeSource = theme
      }, theme)
      const window = await app.browserWindow(page)
      await window.evaluate((window) => window.setSize(1100, 700))
      await page.screenshot({
        path: join(
          root,
          `${theme}-${existing ? 'existing' : 'fallback'}-1100.png`,
        ),
      })
      results.push({
        theme,
        existing,
        geometry,
        isolated: true,
        themeChanged: true,
        toastDismissed: true,
      })
      await window.evaluate((window) => window.destroy())
    }
  }
  await writeFile(
    join(root, 'results.json'),
    JSON.stringify({ platform: process.platform, results }, null, 2),
  )
  console.log(
    `Shared chrome passed ${results.length} Electron cases with live theme changes, controls and isolated worlds`,
  )
} finally {
  await app.close()
}
