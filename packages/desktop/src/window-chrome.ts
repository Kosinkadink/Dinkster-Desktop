import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'
import { desktopTitle, type DesktopServices } from './services.js'

export interface WindowChrome {
  readonly css: string
  readonly script: string
  readonly native: {
    readonly overlay: Record<'dark' | 'light', { color: string; symbolColor: string; height: number }>
    readonly trafficLightPosition: { x: number; y: number }
  }
}

export function readWindowChrome(directory: string): WindowChrome {
  const metadata = JSON.parse(readFileSync(join(directory, 'desktop-chrome.json'), 'utf8')) as Omit<WindowChrome, 'script'>
  return { ...metadata, script: readFileSync(join(directory, 'desktop-chrome.js'), 'utf8') }
}

export function windowChromeOptions(chrome: WindowChrome, platform: NodeJS.Platform = process.platform): BrowserWindowConstructorOptions {
  return {
    titleBarStyle: 'hidden',
    ...(platform === 'darwin'
      ? { trafficLightPosition: chrome.native.trafficLightPosition }
      : { titleBarOverlay: chrome.native.overlay.dark }),
  }
}

// Dinkster pages are dark unless the page itself says it is light.
const pageTheme = "(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')"

/** The shared DOM installer has no access to Electron or the preload bridge. */
export function installWindowChrome(window: BrowserWindow, chrome: WindowChrome, development: () => boolean = () => false, services: DesktopServices = 'production'): void {
  // A script still waiting in a page that has gone never settles, so each
  // page's loop also ends when the next page loads or the window closes.
  let leave = (): void => {}
  let screenChanged = (): void => {}
  window.on('enter-full-screen', () => screenChanged())
  window.on('leave-full-screen', () => screenChanged())
  const inPage = (code: string): Promise<unknown> => window.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code }])
  const follow = async (left: Promise<void>): Promise<void> => {
    let active = true
    void left.then(() => { active = false })
    while (active && !window.isDestroyed()) {
      const unpublished = development()
      const fullScreenChanged = new Promise<void>((resolve) => { screenChanged = resolve })
      window.setTitle(desktopTitle(services, unpublished))
      const theme = await inPage(`if (!globalThis.DinksterDesktopChrome) { ${chrome.script} }
        DinksterDesktopChrome.install({ ...${JSON.stringify({
          title: desktopTitle(services), platform: process.platform,
          qa: services === 'qa', development: unpublished, fullScreen: window.isFullScreen(),
        })}, theme: ${pageTheme} });
        ${pageTheme}`) === 'light' ? 'light' : 'dark'
      if (!active || window.isDestroyed()) return
      if (process.platform !== 'darwin') window.setTitleBarOverlay(chrome.native.overlay[theme])
      // The app switches its theme without reloading, and macOS hides the
      // traffic lights in full screen; wait for either, then match it.
      await Promise.race([left, fullScreenChanged, inPage(`new Promise((resolve) => {
        const changed = () => ${pageTheme} !== ${JSON.stringify(theme)}
        if (changed()) return resolve()
        const observer = new MutationObserver(() => { if (changed()) { observer.disconnect(); resolve() } })
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
      })`)])
    }
  }
  window.webContents.on('did-finish-load', () => {
    leave()
    const left = new Promise<void>((resolve) => { leave = resolve })
    void window.webContents.insertCSS(chrome.css).then(() => follow(left)).catch(() => {
      if (!window.isDestroyed()) console.warn('Desktop window chrome could not be applied.')
    })
  })
  window.on('closed', () => leave())
}
