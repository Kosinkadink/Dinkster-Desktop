import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { DesktopBridge } from '../src/types.js'

const electron = vi.hoisted(() => ({
  dialog: { showSaveDialog: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn() },
  webUtils: {},
}))
vi.mock('electron', () => electron)
import { saveFile } from '../src/save-file.js'

let root: string | undefined
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.resetAllMocks()
  vi.resetModules()
})

describe.each([false, true])('public save bridge (local files only: %s)', (localOnly) => {
  async function bridge() {
    root = await mkdtemp(join(tmpdir(), 'dinkster-save-'))
    const argv = process.argv
    process.argv = localOnly ? [...argv, '--dinkster-local-files'] : argv
    try { await import('../src/preload.js') }
    finally { process.argv = argv }
    const exposed = electron.contextBridge.exposeInMainWorld.mock.calls.find(([name]) => name === 'dinksterDesktop')?.[1] as DesktopBridge
    electron.ipcRenderer.invoke.mockImplementation(async (channel, bytes, name) => {
      expect(channel).toBe('desktop:save-file')
      return saveFile(bytes, name, {} as BrowserWindow, () => {})
    })
    return exposed
  }

  it('returns the chosen basename only after writing the exact byte view', async () => {
    const api = await bridge()
    const path = join(root!, 'chosen.bin')
    electron.dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: path })
    const bytes = new Uint8Array([91, 0, 255, 13, 10, 128, 92]).subarray(1, 6)
    expect(await api.saveFile(bytes, 'suggested.bin')).toEqual({ status: 'saved', name: 'chosen.bin' })
    expect(await readFile(path)).toEqual(Buffer.from([0, 255, 13, 10, 128]))
  })

  it('reports closed and writes nothing even if a canceled dialog supplies a path', async () => {
    const api = await bridge()
    electron.dialog.showSaveDialog.mockResolvedValue({ canceled: true, filePath: join(root!, 'not-saved.bin') })
    expect(await api.saveFile(new Uint8Array([1]), 'suggested.bin')).toEqual({ status: 'closed' })
    expect(await readdir(root!)).toEqual([])
  })

  it('rejects paths and non-byte payloads before opening a dialog', async () => {
    const api = await bridge()
    for (const name of ['/tmp/output.bin', '../output.bin', 'C:\\output.bin', 'folder/output.bin', '..', '', 'bad\0name']) {
      await expect(api.saveFile(new Uint8Array([1]), name)).rejects.toThrow('suggested file name')
    }
    await expect(api.saveFile('bytes' as unknown as Uint8Array, 'output.bin')).rejects.toThrow('requires bytes')
    expect(electron.dialog.showSaveDialog).not.toHaveBeenCalled()
  })

  it('rejects write failures rather than returning saved or closed', async () => {
    const api = await bridge()
    electron.dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: join(root!, 'missing', 'output.bin') })
    await expect(api.saveFile(new Uint8Array([1]), 'output.bin')).rejects.toThrow()
    expect(await readdir(root!)).toEqual([])
  })
})
