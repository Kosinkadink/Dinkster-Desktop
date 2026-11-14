import { rcompare } from 'semver'

const releases = 'https://github.com/Kosinkadink/Dinkster-Desktop/releases'
export const DEFAULT_UPDATE_FEED = `${releases}/latest/download`

export interface UpdateFeedTarget {
  channel: string | null
  allowPrerelease: boolean
  allowDowngrade: boolean
  setFeedURL(options: { readonly provider: 'generic'; readonly url: string; readonly channel: string }): void
}

export function configuredUpdateFeed(raw: string | undefined): string {
  const candidate = raw?.trim() || DEFAULT_UPDATE_FEED
  const url = new URL(candidate)
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('the desktop update feed must use HTTPS or loopback HTTP')
  }
  if (url.username || url.password) throw new Error('the desktop update feed URL cannot contain credentials')
  return url.toString().replace(/\/$/, '')
}

async function releaseCandidateFeed(): Promise<string> {
  const signal = AbortSignal.timeout(15_000)
  // The built-in GitHub provider cannot select RCs with desktop-v tags.
  // Resolve the published tag, then let the generic provider verify its bytes.
  const candidates: { tag_name: string }[] = []
  for (let page = 1; ; page += 1) {
    const response = await fetch(`https://api.github.com/repos/Kosinkadink/Dinkster-Desktop/releases?per_page=100&page=${page}`, {
      signal,
      headers: { Accept: 'application/vnd.github+json' },
    })
    if (!response.ok) throw new Error('Unable to resolve the Desktop RC feed')
    const entries: unknown = await response.json()
    if (!Array.isArray(entries)) throw new Error('Invalid Desktop release listing')
    candidates.push(...entries.filter((entry): entry is { tag_name: string } => {
      if (!entry || typeof entry !== 'object') return false
      const release = entry as Record<string, unknown>
      return release['draft'] === false && release['prerelease'] === true
        && typeof release['tag_name'] === 'string'
        && /^desktop-v\d+\.\d+\.\d+-rc\.\d+$/.test(release['tag_name'])
    }))
    if (!response.headers.get('link')?.includes('rel="next"')) break
  }
  candidates.sort((left, right) => rcompare(left.tag_name.slice('desktop-v'.length), right.tag_name.slice('desktop-v'.length)))
  const latest = candidates[0]
  if (!latest) throw new Error('No Desktop RC release is published')
  return `${releases}/download/${latest.tag_name}`
}

export async function configureUpdateFeed(target: UpdateFeedTarget, raw: string | undefined, version: string): Promise<string> {
  const rc = /^\d+\.\d+\.\d+-rc\.\d+$/.test(version)
  const channel = rc ? 'rc' : 'latest'
  const url = raw?.trim() || !rc ? configuredUpdateFeed(raw) : await releaseCandidateFeed()
  target.channel = channel
  target.allowPrerelease = rc
  // Setting channel enables downgrades in electron-updater; turn it back off.
  target.allowDowngrade = false
  target.setFeedURL({ provider: 'generic', url, channel })
  return url
}
