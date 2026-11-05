import { isAbsolute, join, normalize } from 'node:path'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { download } from './io.js'
import type { EnvironmentRequest } from './environment.js'
import type { EnvironmentToolsInput } from './environment-tools.js'

function toolsLocation(location: string): URL | string {
  if (isAbsolute(location)) return location
  const url = new URL(location)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('channel tools locations require an absolute path or credential-free HTTPS')
  return url
}

function validToolsPin(tools: Record<string, unknown>): tools is Record<string, unknown> & EnvironmentToolsInput {
  if (typeof tools['manifest'] !== 'string' || typeof tools['sha256'] !== 'string' || !/^[a-f0-9]{64}$/.test(tools['sha256'])
    || typeof tools['release'] !== 'string' || (tools['label'] !== undefined && (typeof tools['label'] !== 'string' || !/^\d{4}-\d{2}-\d{2}-[A-Za-z0-9.+_-]+-[a-f0-9]{8}$/.test(tools['label'])))) return false
  try {
    const manifest = toolsLocation(tools['manifest'])
    const release = toolsLocation(tools['release'])
    if (tools['label'] === undefined) return true
    if (typeof manifest === 'string' && typeof release === 'string') {
      return normalize(manifest) === join(normalize(release), 'tools-manifest.json')
        && normalize(release).endsWith(join('tools', tools['label']))
    }
    if (manifest instanceof URL && release instanceof URL) {
      const directory = release.href.replace(/\/$/, '')
      return manifest.href === `${directory}/tools-manifest.json`
        && release.pathname.replace(/\/$/, '').endsWith(`/tools/${tools['label']}`)
    }
  } catch {
    return false
  }
  return false
}

/** Installed engine operations never consult mutable channel metadata. */
export async function channelTools(request: EnvironmentRequest, desktopVersion: string): Promise<EnvironmentToolsInput | undefined> {
  if (!['setup', 'update', 'catalog'].includes(request.operation)) return undefined
  let settings: { channel?: string; mirrors?: string[] } = {}
  try { settings = JSON.parse(await readFile(join(request.root, 'project.json'), 'utf8')) as typeof settings }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const channel = request.channel ?? settings.channel ?? 'stable'
  const mirrors = request.mirrors?.length ? request.mirrors : settings.mirrors ?? []
  if (channel !== 'main' && channel !== 'stable') throw new Error('unsupported channel')
  let document: Record<string, unknown> | undefined
  for (const mirror of mirrors) {
    const directory = await mkdtemp(join(tmpdir(), 'dinkster-channel-'))
    try {
      let text: string
      if (isAbsolute(mirror)) text = await readFile(join(mirror, 'channels', `${channel}.json`), 'utf8')
      else {
        const url = new URL(mirror)
        if (!['releases.dinkster.org', 'localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('untrusted channel mirror')
        const path = join(directory, 'channel.json')
        await download(new URL(`channels/${channel}.json`, `${url.href.replace(/\/$/, '')}/`).href, path, undefined, 8 * 1024 * 1024)
        text = await readFile(path, 'utf8')
      }
      if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('channel metadata exceeds size limit')
      const value = JSON.parse(text) as Record<string, unknown>
      if (value['format'] !== 'dinkster.channel/1' || typeof value['minimumDesktopVersion'] !== 'string' || !/^\d+\.\d+\.\d+$/.test(value['minimumDesktopVersion']) || (value['signature'] !== null && value['signature'] !== undefined)) throw new Error('unsupported channel metadata')
      document = value
      break
    } catch {
      // Match the environment client's ordered mirror failover.
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
  if (!document) throw new Error('no mirror supplied a valid trusted channel')
  const minimum = String(document['minimumDesktopVersion']).split('.').map(Number)
  const current = desktopVersion.split(/[.-]/).slice(0, 3).map(Number)
  for (let index = 0; index < 3; index++) {
    if (current[index]! > minimum[index]!) break
    if (current[index]! < minimum[index]!) throw new Error(`DesktopVersionTooOld: channel requires Desktop ${document['minimumDesktopVersion']}; running ${desktopVersion}`)
  }
  const tools = document['tools'] as Record<string, unknown> | undefined
  if (!tools) return undefined
  if (!validToolsPin(tools)) throw new Error('invalid channel tools pin')
  return { ...(tools.label === undefined ? {} : { label: tools.label }), manifest: tools.manifest, sha256: tools.sha256, release: tools.release }
}
