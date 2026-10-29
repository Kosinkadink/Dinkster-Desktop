import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'

export async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export async function verifyFile(path: string, expected: string): Promise<void> {
  const actual = await sha256(path)
  if (actual !== expected.toLowerCase()) {
    throw new Error(`checksum mismatch for ${path}: expected ${expected}, got ${actual}`)
  }
}

export async function download(url: string, destination: string, signal?: AbortSignal): Promise<void> {
  signal ??= AbortSignal.timeout(10 * 60_000)
  let response: Response
  for (let redirects = 0; ; redirects++) {
    const location = new URL(url)
    const loopback = location.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(location.hostname)
    if ((!loopback && location.protocol !== 'https:') || location.username || location.password) throw new Error('downloads require credential-free HTTPS or loopback HTTP')
    response = await fetch(location, { redirect: 'manual', signal })
    if (![301, 302, 303, 307, 308].includes(response.status)) break
    await response.body?.cancel()
    const target = response.headers.get('location')
    if (!target || redirects >= 5) throw new Error('invalid download redirect')
    url = new URL(target, location).href
  }
  if (!response.ok || response.body === null) {
    throw new Error(`download failed (${response.status})`)
  }
  await mkdir(dirname(destination), { recursive: true })
  const temporary = `${destination}.part`
  await rm(temporary, { force: true })
  try {
    await pipeline(response.body, createWriteStream(temporary), { signal })
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
  await rm(destination, { force: true })
  await rename(temporary, destination)
}
