import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import pin from './frontend-release.json' with { type: 'json' }

const require = createRequire(
  new URL('../packages/desktop/package.json', import.meta.url),
)
const extract = require('extract-zip')
const destination = resolve('packages/app/dist')
const brandDestination = resolve('packages/desktop/resources/branding')
const url = new URL(pin.url)
if (
  url.protocol !== 'https:' ||
  url.hostname !== 'files.pythonhosted.org' ||
  url.username ||
  url.password ||
  url.search ||
  url.hash ||
  url.pathname.split('/').at(-1) !==
    `dinkster_frontend-${pin.version}-py3-none-any.whl`
) {
  throw new Error('Frontend pin requires its permanent PyPI wheel URL')
}
const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
if (!response.ok)
  throw new Error(`Frontend download failed: ${response.status}`)
const bytes = Buffer.from(await response.arrayBuffer())
if (
  bytes.length !== pin.size ||
  createHash('sha256').update(bytes).digest('hex') !== pin.sha256
) {
  throw new Error('Frontend wheel size or SHA256 differs from the release pin')
}
const work = await mkdtemp(resolve(tmpdir(), 'dinkster-frontend-'))
try {
  const wheel = resolve(work, 'frontend.whl')
  await writeFile(wheel, bytes)
  await extract(wheel, { dir: resolve(work, 'unpacked') })
  const root = resolve(work, 'unpacked/dinkster_frontend')
  const manifest = JSON.parse(
    await readFile(resolve(root, 'manifest.json'), 'utf8'),
  )
  if (
    manifest.format !== 'dinkster.frontend/1' ||
    manifest.repository !== pin.repository ||
    manifest.version !== pin.version ||
    manifest.engineApi.min !== pin.engineApi.min ||
    manifest.engineApi.max !== pin.engineApi.max
  ) {
    throw new Error('Frontend wheel metadata differs from the release pin')
  }
  const source = resolve(root, 'static')
  await readFile(resolve(source, 'index.html'))
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  await cp(source, destination, { recursive: true })
  await rm(brandDestination, { recursive: true, force: true })
  await mkdir(brandDestination, { recursive: true })
  for (const directory of [
    'platform',
    'raster/color',
    'raster/mono',
    'svg',
    'tokens',
  ]) {
    await cp(
      resolve(source, 'branding', directory),
      resolve(brandDestination, directory),
      {
        recursive: true,
      },
    )
  }
  console.log(`Prepared frontend ${pin.version}: ${pin.sha256}`)
} finally {
  await rm(work, { recursive: true, force: true })
}
