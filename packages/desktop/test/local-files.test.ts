import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileCapabilities, grantedFile, requireLocalFiles, revealGrantedFile } from '../src/local-files.js'

describe('local file authority', () => {
  it('binds capabilities and requests to the running managed connection only', () => {
    const managed = 'http://127.0.0.1:5011'
    expect(fileCapabilities(`${managed}/`, managed, true)).toEqual({ nativeFolderChoice: true, reveal: true })
    for (const url of [undefined, '', 'http://localhost:5011', 'http://127.0.0.1:5012', 'https://server.invalid', `${managed}/remote`, `${managed}?backend=remote`, 'http://user:password@127.0.0.1:5011']) {
      expect(fileCapabilities(url, managed, true)).toEqual({ nativeFolderChoice: false, reveal: false })
      expect(() => requireLocalFiles(url, managed, true)).toThrow('shell-managed backend')
    }
    expect(fileCapabilities(managed, managed, false).reveal).toBe(false)
    expect(fileCapabilities(managed, undefined, true).nativeFolderChoice).toBe(false)
  })

  it('reveals exact existing granted files and refuses sibling paths and escaping links', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop files '))
    try {
      const granted = join(root, 'mounted network folder')
      const sibling = join(root, 'mounted network folder-other')
      await mkdir(granted)
      await mkdir(sibling)
      const file = join(granted, 'output image.png')
      const outside = join(sibling, 'private.txt')
      await writeFile(file, 'image')
      await writeFile(outside, 'private')
      expect(await grantedFile(file, [granted])).toBe(await realpath(file))
      for (const invalid of [outside, granted, join(granted, 'missing'), '../private', null]) {
        await expect(grantedFile(invalid, [granted])).rejects.toThrow()
      }
      // Junctions exercise Windows directory redirection without symlink privileges.
      await symlink(sibling, join(granted, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
      await expect(grantedFile(join(granted, 'escape', 'private.txt'), [granted])).rejects.toThrow('outside')
      const selected: string[] = []
      const opened: string[] = []
      const shell = {
        showItemInFolder: (path: string) => { selected.push(path) },
        openPath: async (path: string) => { opened.push(path); return '' },
      }
      expect(await revealGrantedFile(file, [granted], shell, 'win32')).toEqual({ mode: 'selected' })
      expect(selected).toEqual([await realpath(file)])
      expect(await revealGrantedFile(file, [granted], shell, 'linux')).toEqual({ mode: 'folder' })
      expect(opened).toEqual([await realpath(granted)])
      await expect(revealGrantedFile(file, [granted], { ...shell, openPath: async () => 'failed' }, 'linux')).rejects.toThrow('file manager')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
