import { realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DesktopAssetIdentity, DesktopFileCapabilities } from './types.js'
import { validProjectId } from './window-layout.js'

export function fileCapabilities(backendUrl: unknown, managedUrl: string | undefined, running: boolean, exactLookup = false): DesktopFileCapabilities {
  let local = false
  try {
    if (typeof backendUrl === 'string' && managedUrl && running) {
      const candidate = new URL(backendUrl)
      const managed = new URL(managedUrl)
      local = !candidate.username && !candidate.password && !candidate.search && !candidate.hash
        && candidate.origin === managed.origin && candidate.pathname === '/'
    }
  } catch { /* An invalid connection has no native file authority. */ }
  return { nativeFolderChoice: local, reveal: local && exactLookup }
}

export function requireLocalFiles(backendUrl: unknown, managedUrl: string | undefined, running: boolean): void {
  if (!fileCapabilities(backendUrl, managedUrl, running).nativeFolderChoice) {
    throw new Error('Native file access requires the running shell-managed backend')
  }
}

/** Only the managed backend supplies host paths; renderer input is identity only. */
export async function assetLocations(backendUrl: string, input: unknown, project: string): Promise<readonly { path: string; root: string }[]> {
  if (!input || typeof input !== 'object') throw new Error('Invalid local asset identity')
  const asset = input as DesktopAssetIdentity
  if (Object.keys(asset).some((key) => !['digest', 'scope', 'project'].includes(key))
    || typeof asset.digest !== 'string' || !/^blake3:[a-f0-9]{64}$/.test(asset.digest)
    || asset.scope !== 'local' || !validProjectId(asset.project) || asset.project !== project) {
    throw new Error('Invalid local asset identity or requesting project')
  }
  const url = new URL('/api/mounts/locations', backendUrl)
  url.search = new URLSearchParams({ digest: asset.digest, scope: asset.scope, project: asset.project }).toString()
  const response = await fetch(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`Local asset verification failed (HTTP ${response.status})`)
  const body = await response.json() as {
    vault?: unknown
    locations?: { storage?: unknown; path?: unknown; mount?: unknown }[]
    activeMounts?: { id?: unknown; path?: unknown }[]
  }
  if (typeof body.vault !== 'string' || !isAbsolute(body.vault) || !Array.isArray(body.locations) || !Array.isArray(body.activeMounts)) {
    throw new Error('This backend cannot authorize exact local asset reveal')
  }
  return body.locations.map((location) => {
    const root = location?.storage === 'vault' ? body.vault
      : location?.storage === 'mount' && typeof location.mount === 'string'
        ? body.activeMounts!.find((mount) => mount?.id === location.mount)?.path : undefined
    if (typeof root !== 'string' || !isAbsolute(root) || typeof location?.path !== 'string' || !isAbsolute(location.path)) {
      throw new Error('The backend did not return an active local asset grant')
    }
    return { path: location.path, root }
  })
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
  shell: { showItemInFolder(path: string): void; openExternal(url: string): Promise<void> },
  authorize: () => Promise<void>,
  platform = process.platform,
): Promise<{ mode: 'selected' | 'folder' }> {
  const target = await grantedFile(path, roots)
  await authorize()
  if (await grantedFile(path, roots) !== target) throw new Error('The local file changed during verification')
  if (platform === 'win32' || platform === 'darwin') {
    shell.showItemInFolder(target)
    return { mode: 'selected' }
  }
  // Electron 37's Linux openPath drops its completion callback.
  try { await shell.openExternal(pathToFileURL(dirname(target)).href) }
  catch { throw new Error('The file manager could not open the containing folder') }
  return { mode: 'folder' }
}
