import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'

export function windowChromeOptions(platform: NodeJS.Platform = process.platform): BrowserWindowConstructorOptions {
  return {
    titleBarStyle: 'hidden',
    ...(platform === 'darwin'
      ? { trafficLightPosition: { x: 14, y: 16 } }
      : { titleBarOverlay: { color: '#202020', symbolColor: '#ededed', height: 48 } }),
  }
}

/** Reserve native controls in the existing bar, including server-served frontends. */
export function installWindowChrome(window: BrowserWindow): void {
  const left = process.platform === 'darwin' ? '80px' : 'env(titlebar-area-x, 0px)'
  const css = `
    .topbar, body > header {
      -webkit-app-region: drag;
      min-height: max(54px, env(titlebar-area-height, 54px));
      padding-left: calc(${left} + 12px);
      padding-right: calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) + 12px);
    }
    .topbar > *, body > header > * { -webkit-app-region: no-drag; }
    body:not(:has(.topbar, > header)) { padding-top: 54px; }
    body:not(:has(.topbar, > header))::before {
      content: 'Dinkster Desktop';
      position: fixed; top: 0; left: 0; right: 0; height: 54px; z-index: 2147483647;
      display: flex; align-items: center;
      padding-left: calc(${left} + 12px);
      color: #ededed; background: #202020; font: 14px system-ui, sans-serif;
      -webkit-app-region: drag;
    }
  `
  window.webContents.on('did-finish-load', () => {
    if (!window.isDestroyed()) void window.webContents.insertCSS(css).catch(() => {
      if (!window.isDestroyed()) console.warn('Desktop window chrome could not be applied.')
    })
  })
}
