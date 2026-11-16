import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { inspect } from 'node:util'

export async function forwardMirror(url, response) {
  let upstream
  let bytesReceived = 0
  try {
    upstream = await fetch(url)
    response.writeHead(upstream.status)
    if (!upstream.body) {
      response.end()
      return
    }
    await pipeline(
      Readable.fromWeb(upstream.body),
      new Transform({
        transform(chunk, encoding, done) {
          bytesReceived += chunk.length
          done(null, chunk)
        },
      }),
      response,
    )
  } catch (cause) {
    const diagnostic = {
      url,
      status: upstream?.status ?? null,
      contentLength: upstream?.headers.get('content-length') ?? null,
      bytesReceived,
      exception: inspect(cause, { depth: 5 }),
    }
    const error = Object.assign(
      new Error(`Upstream mirror failed: ${JSON.stringify(diagnostic)}`, {
        cause,
      }),
      { diagnostic },
    )
    // A partially sent body cannot carry a new HTTP error response.
    response.destroy(error)
    throw error
  }
}
