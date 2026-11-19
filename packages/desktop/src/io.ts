import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Transform } from 'node:stream'
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

export async function download(url: string, destination: string, signal?: AbortSignal, maximumBytes = Infinity): Promise<void> {
  signal ??= AbortSignal.timeout(10 * 60_000)
  const secure = new URL(url).protocol === 'https:'
  const original = url
  const temporary = `${destination}.part`
  for (let attempt = 0; ; attempt++) {
    let received = 0
    let declared: string | null = null
    try {
      url = original
      let response: Response
      for (let redirects = 0; ; redirects++) {
        const location = new URL(url)
        const loopback = !secure && location.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(location.hostname)
        if ((!loopback && location.protocol !== 'https:') || location.username || location.password) throw new Error('downloads require credential-free HTTPS or loopback HTTP')
        response = await fetch(location, { redirect: 'manual', signal })
        if (![301, 302, 303, 307, 308].includes(response.status)) break
        await response.body?.cancel()
        const target = response.headers.get('location')
        if (!target || redirects >= 5) throw new Error('invalid download redirect')
        url = new URL(target, location).href
      }
      if (!response.ok || response.body === null) {
        await response.body?.cancel()
        throw new Error(`download failed (${response.status})`)
      }
      declared = response.headers.get('content-length')
      await mkdir(dirname(destination), { recursive: true })
      await rm(temporary, { force: true })
      const bounded = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length
          if (received > maximumBytes) callback(new Error('download exceeds the declared size'))
          else callback(null, chunk)
        },
      })
      await pipeline(response.body, bounded, createWriteStream(temporary), { signal })
      await rm(destination, { force: true })
      await rename(temporary, destination)
      return
    } catch (error) {
      await rm(temporary, { force: true })
      const cause = error instanceof Error ? error.cause : undefined
      const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined
      const interrupted = ['UND_ERR_SOCKET', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(String(code))
      if (signal.aborted || !interrupted) throw error
      if (attempt >= 2) throw new Error(`download interrupted after ${received}${declared === null ? '' : ` of ${declared}`} bytes (3 attempts)`, { cause: error })
    }
  }
}
