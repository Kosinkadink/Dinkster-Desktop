import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { load } from 'js-yaml'

export async function verifyUpdateFeed(releaseDirectory) {
  const manifestPath = resolve(releaseDirectory, 'latest.yml')
  const manifest = await readFile(manifestPath, 'utf8')
  const document = load(manifest)
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('latest.yml must be an object')
  const release = document
  if (!Array.isArray(release.files) || release.files.length !== 1 ||
    !release.files[0] || typeof release.files[0] !== 'object' || Array.isArray(release.files[0])) {
    throw new Error('latest.yml must contain exactly one files entry')
  }
  const entry = release.files[0]
  const artifactName = entry.url
  if (typeof artifactName !== 'string' || basename(artifactName) !== artifactName ||
    release.path !== artifactName || typeof entry.sha512 !== 'string' || release.sha512 !== entry.sha512 ||
    !Number.isSafeInteger(entry.size) || entry.size < 1) {
    throw new Error('latest.yml files entry does not match its top-level artifact metadata')
  }
  const artifactPath = resolve(releaseDirectory, artifactName)
  const artifact = await stat(artifactPath)
  if (entry.size !== artifact.size) throw new Error('latest.yml files entry size does not match the release artifact')
  const hash = createHash('sha512')
  await new Promise((resolveHash, reject) => {
    createReadStream(artifactPath).on('data', (chunk) => hash.update(chunk)).on('end', resolveHash).on('error', reject)
  })
  if (hash.digest('base64') !== entry.sha512) throw new Error('latest.yml files entry sha512 does not match the release artifact')

  const server = createServer(async (request, response) => {
    const name = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname.slice(1))
    if (name !== 'latest.yml' && name !== artifactName) {
      response.writeHead(404).end()
      return
    }
    const path = name === 'latest.yml' ? manifestPath : artifactPath
    const size = (await stat(path)).size
    response.writeHead(200, { 'content-length': size, 'content-type': name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream' })
    if (request.method === 'HEAD') response.end()
    else createReadStream(path).pipe(response)
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test feed did not bind a TCP port')
    const feed = `http://127.0.0.1:${address.port}`
    const servedManifest = await fetch(`${feed}/latest.yml`)
    if (!servedManifest.ok || await servedManifest.text() !== manifest) throw new Error('test feed changed latest.yml')
    const servedArtifact = await fetch(`${feed}/${encodeURIComponent(entry.url)}`, { method: 'HEAD' })
    if (!servedArtifact.ok || Number(servedArtifact.headers.get('content-length')) !== entry.size) {
      throw new Error('test feed did not expose the manifest artifact')
    }
    console.log(`Verified generic update feed manifest for ${artifactName} (${artifact.size} bytes) at ${feed}`)
  } finally {
    await new Promise((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose())
      server.closeAllConnections()
    })
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const releaseDirectory = resolve(process.env['DINKSTER_UPDATE_FEED_RELEASE'] ?? resolve(import.meta.dirname, '..', 'release'))
  await verifyUpdateFeed(releaseDirectory)
}
