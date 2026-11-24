import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow, BrowserWindowConstructorOptions, NativeTheme } from 'electron'
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

export function windowChromeOptions(chrome: WindowChrome, dark: boolean, platform: NodeJS.Platform = process.platform): BrowserWindowConstructorOptions {
  return {
    titleBarStyle: 'hidden',
    ...(platform === 'darwin'
      ? { trafficLightPosition: chrome.native.trafficLightPosition }
      : { titleBarOverlay: chrome.native.overlay[dark ? 'dark' : 'light'] }),
  }
}

/** The shared DOM installer has no access to Electron or the preload bridge. */
export function installWindowChrome(window: BrowserWindow, chrome: WindowChrome, appearance: NativeTheme, development: () => boolean = () => false, services: DesktopServices = 'production'): void {
  let loaded = false
  const refresh = async (): Promise<void> => {
    if (!loaded || window.isDestroyed()) return
    const theme = appearance.shouldUseDarkColors ? 'dark' : 'light'
    const unpublished = development()
    window.setTitle(desktopTitle(services, unpublished))
    if (process.platform !== 'darwin') window.setTitleBarOverlay(chrome.native.overlay[theme])
    await window.webContents.executeJavaScriptInIsolatedWorld(1001, [{
      code: `if (!globalThis.DinksterDesktopChrome) { ${chrome.script} }\nDinksterDesktopChrome.install(${JSON.stringify({
        title: desktopTitle(services), platform: process.platform, theme,
        qa: services === 'qa', development: unpublished,
      })})`,
    }])
  }
  const report = (): void => {
    if (!window.isDestroyed()) console.warn('Desktop window chrome could not be applied.')
  }
  window.webContents.on('did-finish-load', () => {
    loaded = true
    void window.webContents.insertCSS(chrome.css).then(refresh).catch(report)
  })
  const changed = (): void => { void refresh().catch(report) }
  appearance.on('updated', changed)
  window.on('closed', () => appearance.removeListener('updated', changed))
}
