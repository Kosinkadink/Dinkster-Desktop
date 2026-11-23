import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'
import { desktopTitle, type DesktopServices } from './services.js'

export function windowChromeOptions(platform: NodeJS.Platform = process.platform): BrowserWindowConstructorOptions {
  return {
    titleBarStyle: 'hidden',
    ...(platform === 'darwin'
      ? { trafficLightPosition: { x: 14, y: 16 } }
      : { titleBarOverlay: { color: '#202020', symbolColor: '#ededed', height: 48 } }),
  }
}

/** Reserve native controls in the existing bar, including server-served frontends. */
export function installWindowChrome(window: BrowserWindow, development: () => boolean = () => false, services: DesktopServices = 'production'): void {
  const left = process.platform === 'darwin' ? '80px' : 'env(titlebar-area-x, 0px)'
  const css = `
    .topbar, .dinkster-topbar, body > header {
      -webkit-app-region: drag;
      min-height: max(54px, env(titlebar-area-height, 54px));
      padding-left: calc(${left} + 12px);
      padding-right: calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) + 12px);
    }
    .topbar > *, .dinkster-topbar > *, body > header > * { -webkit-app-region: no-drag; }
    body:not(:has(.topbar, .dinkster-topbar, > header)) { padding-top: 54px; }
    body:not(:has(.topbar, .dinkster-topbar, > header))::before {
      content: '${desktopTitle(services)}';
      position: fixed; top: 0; left: 0; right: 0; height: 54px; z-index: 2147483647;
      display: flex; align-items: center;
      padding-left: calc(${left} + 12px);
      color: #ededed; background: #202020; font: 14px system-ui, sans-serif;
      -webkit-app-region: drag;
    }
  `
  window.webContents.on('did-finish-load', () => {
    if (window.isDestroyed()) return
    const unpublished = development()
    window.setTitle(desktopTitle(services, unpublished))
    const marking = unpublished ? `
      body::after {
        content: 'Development project - unpublished sources';
        position: fixed; bottom: 8px; right: 12px; z-index: 2147483647;
        padding: 6px 10px; border: 1px solid #f3cf80; border-radius: 5px;
        color: #f3cf80; background: #202020; font: 12px system-ui, sans-serif;
        pointer-events: none; -webkit-app-region: no-drag;
      }
    ` : ''
    const servicesMark = services === 'qa' ? `
      .topbar > .topbar-group-left::after, .dinkster-topbar .dinkster-brand::after, body > header::after {
        content: '[QA]'; flex-shrink: 0; margin-left: 8px;
        color: #ededed; font: bold 12px system-ui, sans-serif;
        pointer-events: none; -webkit-app-region: no-drag;
      }
    ` : ''
    void window.webContents.insertCSS(css + marking + servicesMark).catch(() => {
      if (!window.isDestroyed()) console.warn('Desktop window chrome could not be applied.')
    })
  })
}
