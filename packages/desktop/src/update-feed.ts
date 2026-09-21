export interface UpdateFeedTarget {
  setFeedURL(options: { readonly provider: 'generic'; readonly url: string }): void
}

export function configuredUpdateFeed(raw: string | undefined): string | undefined {
  const candidate = raw?.trim()
  if (!candidate) return undefined
  const url = new URL(candidate)
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('the desktop update feed must use HTTPS or loopback HTTP')
  }
  if (url.username || url.password) throw new Error('the desktop update feed URL cannot contain credentials')
  return url.toString().replace(/\/$/, '')
}

export function configureUpdateFeed(target: UpdateFeedTarget, raw: string | undefined): string | undefined {
  const url = configuredUpdateFeed(raw)
  if (url) target.setFeedURL({ provider: 'generic', url })
  return url
}
