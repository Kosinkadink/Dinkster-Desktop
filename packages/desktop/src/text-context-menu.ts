import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

/** Renderer-owned menus suppress the context-menu event before it reaches Desktop. */
export function installTextContextMenu(window: BrowserWindow): void {
  window.webContents.on('context-menu', (_event, params) => {
    const { isEditable, selectionText, editFlags } = params
    if (!isEditable && !selectionText) return

    const items: MenuItemConstructorOptions[] = []
    if (isEditable) {
      for (const suggestion of params.dictionarySuggestions) {
        items.push({
          label: suggestion,
          click: () => window.webContents.replaceMisspelling(suggestion),
        })
      }
      if (items.length) items.push({ type: 'separator' })
      items.push(
        { role: 'cut', enabled: editFlags.canCut },
        { role: 'copy', enabled: editFlags.canCopy },
        { role: 'paste', enabled: editFlags.canPaste },
        { role: 'selectAll', enabled: editFlags.canSelectAll },
      )
    } else {
      items.push({ role: 'copy', enabled: editFlags.canCopy })
    }
    Menu.buildFromTemplate(items).popup({
      window,
      ...(params.frame ? { frame: params.frame } : {}),
      sourceType: params.menuSourceType,
    })
  })
}
