import { realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DesktopAssetIdentity, DesktopDroppedFileResult, DesktopFileCapabilities, DesktopFileImport, DesktopFileImportProgress, DesktopFileImportResult } from './types.js'
import { validProjectId } from './window-layout.js'
import { wslLinuxPath, wslWindowsPath } from './wsl.js'

export async function chooseDirectory(
  packaged: boolean,
  openDialog: () => Promise<{ canceled: boolean; filePaths: string[] }>,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ canceled: boolean; filePaths: string[] }> {
  // Script only the Electron boundary; packaged apps never read the test hook.
  const scripted = packaged ? undefined : environment.DINKSTER_TEST_FOLDER_CHOICE
  if (scripted !== undefined) {
    const path: unknown = JSON.parse(scripted)
    if (path === null) return { canceled: true, filePaths: [] }
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new Error('Invalid test folder choice')
    return { canceled: false, filePaths: [path] }
  }
  return openDialog()
}

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
export async function assetLocations(backendUrl: string, input: unknown, project: string, distribution?: string): Promise<readonly { path: string; root: string }[]> {
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
  if (distribution) {
    if (typeof body.vault === 'string') body.vault = wslWindowsPath(distribution, body.vault)
    if (Array.isArray(body.locations)) for (const location of body.locations) {
      if (typeof location?.path === 'string') location.path = wslWindowsPath(distribution, location.path)
    }
    if (Array.isArray(body.activeMounts)) for (const mount of body.activeMounts) {
      if (typeof mount?.path === 'string') mount.path = wslWindowsPath(distribution, mount.path)
    }
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

/** Resolve a registered shared folder by id, never by a renderer-supplied path. */
export async function revealModelLocation(
  backendUrl: string,
  location: unknown,
  project: string,
  shell: { openExternal(url: string): Promise<void> },
  authorize: () => Promise<void>,
  distribution?: string,
): Promise<void> {
  if (typeof location !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(location) || !validProjectId(project)) throw new Error('Invalid model location identity')
  const lookup = async (): Promise<string> => {
    await authorize()
    const url = new URL('/api/models/settings', backendUrl)
    url.searchParams.set('project', project)
    const response = await fetch(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error('Model location verification failed')
    const body = await response.json() as { locations?: { id?: unknown; path?: unknown }[] }
    if (!Array.isArray(body?.locations)) throw new Error('Model location verification failed')
    const matches = body.locations.filter((row) => row?.id === location)
    const path = matches.length === 1 ? matches[0]?.path : undefined
    if (typeof path !== 'string' || path.includes('\0')) throw new Error('Model location is no longer registered')
    const hostPath = distribution ? wslWindowsPath(distribution, path) : path
    if (!isAbsolute(hostPath)) throw new Error('Model location is no longer registered')
    await authorize()
    return hostPath
  }
  try {
    const path = await lookup()
    const target = await realpath(path)
    if (!(await stat(target)).isDirectory()) throw new Error()
    if (await lookup() !== path || await realpath(path) !== target) throw new Error()
    await authorize()
    await shell.openExternal(pathToFileURL(target).href)
  } catch {
    throw new Error('The registered model folder could not be opened; copy the server path instead')
  }
}

/** The operator capability response stays in main; only its booleans are public. */
export async function nativeFileCapabilities(backendUrl: string, signal?: AbortSignal): Promise<{ resolvePath: boolean; importFile: boolean; importProgress: boolean }> {
  try {
    const response = await fetch(new URL('/api/mounts/locations', backendUrl), {
      redirect: 'error', cache: 'no-store', signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]),
    })
    if (response.status !== 200) throw new Error()
    const body = await response.json()
    if (!body || !Array.isArray(body.mounts) || !Array.isArray(body.activeMounts)
      || typeof body.restartRequired !== 'boolean' || !Array.isArray(body.pendingRemovals)
      || (body.vault !== undefined && (typeof body.vault !== 'string' || !isAbsolute(body.vault)))
      || (body.resolvePath !== undefined && typeof body.resolvePath !== 'boolean')
      || (body.importFile !== undefined && typeof body.importFile !== 'boolean')
      || (body.importProgress !== undefined && typeof body.importProgress !== 'boolean')) throw new Error()
    return { resolvePath: body.resolvePath === true, importFile: body.importFile === true, importProgress: body.importFile === true && body.importProgress === true }
  } catch {
    throw new Error('Mounted file capability verification failed')
  }
}

/** Only advertised support permits sending a native path to the resolver. */
export async function resolveDroppedPath(backendUrl: string, path: unknown, project: string, authorize: () => Promise<void>, distribution?: string): Promise<DesktopDroppedFileResult> {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || !validProjectId(project)) {
    throw new Error('Invalid native file resolution request')
  }
  const enginePath = distribution ? wslLinuxPath(distribution, path) : path
  await authorize()
  const url = new URL('/api/mounts/resolve-path', backendUrl)
  try {
    const supported = (await nativeFileCapabilities(backendUrl)).resolvePath
    await authorize()
    if (!supported) return { status: 'refused', reason: 'unsupported-backend' }
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: enginePath, project, scope: 'local' }),
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000),
    })
    await authorize()
    if (response.status !== 200) throw new Error()
    const body = await response.json()
    await authorize()
    if (!body || Object.keys(body).length !== 2) throw new Error()
    if (body.status === 'refused' && body.reason === 'not-resolvable') return { status: 'refused', reason: 'not-resolvable' }
    const asset = body.asset
    if (body.status !== 'resolved' || !asset || Object.keys(asset).length !== 5
      || Object.keys(asset).some((key) => !['digest', 'name', 'size', 'mediaType', 'virtualPath'].includes(key))
      || typeof asset.digest !== 'string' || !/^blake3:[a-f0-9]{64}$/.test(asset.digest)
      || typeof asset.name !== 'string' || !asset.name || /[/\\\0]/.test(asset.name)
      || !Number.isSafeInteger(asset.size) || asset.size < 0
      || typeof asset.mediaType !== 'string' || !asset.mediaType
      || typeof asset.virtualPath !== 'string' || !/^mounts\/[^/]+\/.+/.test(asset.virtualPath)
      || asset.virtualPath.includes('\\') || asset.virtualPath.includes('\0')
      || asset.virtualPath.split('/').some((part: string) => !part || part === '.' || part === '..')) throw new Error()
    return { status: 'resolved', asset: { digest: asset.digest, name: asset.name, size: asset.size, mediaType: asset.mediaType, virtualPath: asset.virtualPath } }
  } catch {
    // Network and backend diagnostics may contain the native path.
    throw new Error('Mounted file resolution failed; no upload fallback was authorized')
  }
}

async function readImportProgress(response: Response, progress: (value: DesktopFileImportProgress) => void): Promise<unknown> {
  if (response.headers.get('content-type')?.split(';')[0] !== 'application/x-ndjson' || !response.body) throw new Error()
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let pending = ''
  let received = 0
  let publishing = false
  let result: { status: number; body: unknown } | undefined
  try {
    while (true) {
      const chunk = await reader.read()
      pending += decoder.decode(chunk.value, { stream: !chunk.done })
      let newline: number
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (line.length > 65_536 || result) throw new Error()
        const event = JSON.parse(line) as Record<string, unknown>
        if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error()
        if (event.type === 'result') {
          if (event.status !== 200 && event.status !== 201) throw new Error()
          result = { status: event.status, body: event.body }
        } else if (event.type === 'progress') {
          if (publishing || (event.phase !== 'copying' && event.phase !== 'publishing')
            || typeof event.received !== 'number' || !Number.isSafeInteger(event.received) || event.received < received
            || (event.total !== null && (typeof event.total !== 'number' || !Number.isSafeInteger(event.total) || event.total < 0))) throw new Error()
          received = event.received
          publishing = event.phase === 'publishing'
          progress({ phase: event.phase, received, total: event.total as number | null })
        } else throw new Error()
      }
      if (pending.length > 65_536) throw new Error()
      if (chunk.done) break
    }
    if (pending || !result) throw new Error()
    return result.body
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Import is an explicit write, never a fallback from mounted-path resolution. */
export async function importNativeFile(backendUrl: string, path: unknown, destination: unknown, project: string, authorize: () => Promise<void>, distribution?: string, transfer?: { signal: AbortSignal; onProgress(progress: DesktopFileImportProgress): void }): Promise<DesktopFileImportResult> {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || !validProjectId(project)
    || !destination || typeof destination !== 'object') throw new Error('Invalid native file import request')
  const target = destination as DesktopFileImport
  if (Object.keys(target).some((key) => !['name', 'mediaType', 'kind', 'mount', 'folder'].includes(key))
    || typeof target.name !== 'string' || !target.name || target.name === '.' || target.name === '..' || /[/\\\0]/.test(target.name)
    || typeof target.mediaType !== 'string' || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(target.mediaType)
    || (target.kind !== undefined && !['media/image', 'media/audio', 'media/video', 'media/model3d', 'data/latent'].includes(target.kind))
    || (target.mount !== undefined && (typeof target.mount !== 'string' || !target.mount || /[/\\\0]/.test(target.mount)))
    || (target.folder !== undefined && (typeof target.folder !== 'string' || /[\\\0]/.test(target.folder)
      || (target.folder !== '' && target.folder.split('/').some((part) => !part || part === '.' || part === '..'))))
    || (target.kind === 'data/latent' && (target.mount !== undefined || target.folder !== undefined))) throw new Error('Invalid native file import destination')
  let enginePath = path
  if (distribution) {
    try { enginePath = wslLinuxPath(distribution, path) }
    catch { return { status: 'refused', reason: 'not-native-file' } }
  }
  try {
    transfer?.signal.throwIfAborted()
    await authorize()
    const supported = await nativeFileCapabilities(backendUrl, transfer?.signal)
    await authorize()
    transfer?.signal.throwIfAborted()
    if (!supported.importFile || (transfer && !supported.importProgress)) return { status: 'refused', reason: 'unsupported-backend' }
    const url = new URL('/api/mounts/import-file', backendUrl)
    url.search = new URLSearchParams({ scope: 'local', project, name: target.name,
      ...(target.kind !== undefined ? { kind: target.kind } : {}),
      ...(target.mount !== undefined ? { mount: target.mount } : {}),
      ...(target.folder !== undefined ? { folder: target.folder } : {}),
    }).toString()
    // A host copy may take longer than capability discovery; do not time it out.
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(transfer ? { accept: 'application/x-ndjson' } : {}) },
      body: JSON.stringify({ path: enginePath, mediaType: target.mediaType }),
      redirect: 'error', cache: 'no-store', signal: transfer?.signal ?? null,
    })
    try {
      await authorize()
      if (response.status !== 200 && response.status !== 201) throw new Error()
      const body = transfer ? await readImportProgress(response, transfer.onProgress) : await response.json()
      await authorize()
      transfer?.signal.throwIfAborted()
      const asset = body?.asset
      if (!body || Object.keys(body).length !== 2
        || (target.kind !== undefined ? body.kind !== target.kind : body.digest !== asset?.digest)
        || !asset || Object.keys(asset).length !== 5
        || Object.keys(asset).some((key) => !['digest', 'name', 'size', 'mediaType', 'virtualPath'].includes(key))
        || typeof asset.digest !== 'string' || !/^blake3:[a-f0-9]{64}$/.test(asset.digest)
        || typeof asset.name !== 'string' || !asset.name || /[/\\\0]/.test(asset.name)
        || !Number.isSafeInteger(asset.size) || asset.size < 0
        || typeof asset.mediaType !== 'string' || !asset.mediaType
        || typeof asset.virtualPath !== 'string'
        || (asset.virtualPath !== '' && (!/^mounts\/[^/]+\/.+/.test(asset.virtualPath)
          || /[\\\0]/.test(asset.virtualPath) || asset.virtualPath.split('/').some((part: string) => !part || part === '.' || part === '..')
          || asset.virtualPath.split('/').at(-1) !== asset.name))) throw new Error()
      return { status: 'imported', asset: { digest: asset.digest, name: asset.name, size: asset.size, mediaType: asset.mediaType, virtualPath: asset.virtualPath } }
    } finally {
      await response.body?.cancel().catch(() => {})
    }
  } catch {
    if (transfer?.signal.aborted) throw new Error('Native file import cancelled')
    throw new Error('Native file import failed; no byte upload fallback was authorized')
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
