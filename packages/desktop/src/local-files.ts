import { realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, sep } from 'node:path'
import type { DesktopFileCapabilities } from './types.js'

export function fileCapabilities(backendUrl: unknown, managedUrl: string | undefined, running: boolean): DesktopFileCapabilities {
  let local = false
  try {
    if (typeof backendUrl === 'string' && managedUrl && running) {
      const candidate = new URL(backendUrl)
      const managed = new URL(managedUrl)
      local = !candidate.username && !candidate.password && !candidate.search && !candidate.hash
        && candidate.origin === managed.origin && candidate.pathname === '/'
    }
  } catch { /* An invalid connection has no native file authority. */ }
  // The pinned backend has no exact scoped asset-to-file lookup.
  return { nativeFolderChoice: local, reveal: false }
}

export function requireLocalFiles(backendUrl: unknown, managedUrl: string | undefined, running: boolean): void {
  if (!fileCapabilities(backendUrl, managedUrl, running).nativeFolderChoice) {
    throw new Error('Native file access requires the running shell-managed backend')
  }
}

/** Resolve both sides: a granted directory does not authorize links outside it. */
export async function grantedFile(path: unknown, roots: readonly string[]): Promise<string> {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
    throw new Error('Invalid local file path')
  }
  try {
    const target = await realpath(path)
    if (!(await stat(target)).isFile()) throw new Error('not a file')
    for (const root of roots) {
      let canonicalRoot: string
      try { canonicalRoot = await realpath(root) } catch { continue }
      const child = relative(canonicalRoot, target)
      const lexicalChild = relative(root, path)
      if (child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
        && lexicalChild && lexicalChild !== '..' && !lexicalChild.startsWith(`..${sep}`) && !isAbsolute(lexicalChild)) return target
    }
  } catch { /* Do not expose host paths through filesystem errors. */ }
  throw new Error('The file is missing or outside the active local grants')
}

export async function revealGrantedFile(
  path: unknown,
  roots: readonly string[],
  shell: { showItemInFolder(path: string): void; openPath(path: string): Promise<string> },
  platform = process.platform,
): Promise<{ mode: 'selected' | 'folder' }> {
  const target = await grantedFile(path, roots)
  if (platform === 'win32' || platform === 'darwin') {
    shell.showItemInFolder(target)
    return { mode: 'selected' }
  }
  const error = await shell.openPath(dirname(target))
  if (error) throw new Error('The file manager could not open the containing folder')
  return { mode: 'folder' }
}
