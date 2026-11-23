import { dialog, type BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { DesktopSaveResult } from './types.js'

export async function saveFile(bytes: unknown, suggestedName: unknown, parent: BrowserWindow, revalidate: () => void): Promise<DesktopSaveResult> {
  if (!(bytes instanceof Uint8Array)) throw new Error('Save requires bytes')
  if (typeof suggestedName !== 'string' || !suggestedName || suggestedName === '.' || suggestedName === '..'
    || /[/\\\x00-\x1f]/.test(suggestedName) || /[:*?"<>|]/.test(suggestedName)) {
    throw new Error('Save requires a suggested file name, not a path')
  }
  const result = await dialog.showSaveDialog(parent, { defaultPath: suggestedName })
  revalidate()
  if (result.canceled || !result.filePath) return { status: 'closed' }
  await writeFile(result.filePath, bytes)
  return { status: 'saved', name: basename(result.filePath) }
}
