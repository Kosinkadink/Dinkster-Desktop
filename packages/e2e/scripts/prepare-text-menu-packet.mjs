import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'

// Unlike the normal build preparation, preserve every downloaded/extracted file.
const repository = process.cwd()
assert(
  process.env.DINKSTER_TEXT_MENU_ROOT,
  'Set DINKSTER_TEXT_MENU_ROOT to the retained lane root',
)
const root = resolve(process.env.DINKSTER_TEXT_MENU_ROOT)
assert.equal(resolve(root, 'desktop'), repository)
const pin = JSON.parse(await readFile('scripts/frontend-release.json', 'utf8'))
const require = createRequire(resolve('packages/desktop/package.json'))
const work = join(root, 'frontend')
await mkdir(work)
const response = await fetch(pin.url)
assert(response.ok, `Frontend download: ${response.status}`)
const bytes = Buffer.from(await response.arrayBuffer())
assert.equal(bytes.length, pin.size)
assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.sha256)
const wheel = join(work, 'frontend.whl')
await writeFile(wheel, bytes)
await require('extract-zip')(wheel, { dir: join(work, 'unpacked') })
const source = join(work, 'unpacked/dinkster_frontend/static')
const site = join(source, 'site')
const manifest = JSON.parse(await readFile(join(site, 'manifest.json'), 'utf8'))
for (const [name, digest] of Object.entries(manifest.files))
  assert.equal(
    createHash('sha256')
      .update(await readFile(join(site, name)))
      .digest('hex'),
    digest,
    name,
  )
await cp(source, resolve('packages/app/dist'), { recursive: true })
for (const directory of [
  'platform',
  'raster/color',
  'raster/mono',
  'svg',
  'tokens',
])
  await cp(
    join(source, 'branding', directory),
    resolve('packages/desktop/resources/branding', directory),
    { recursive: true },
  )
console.log(JSON.stringify({ pin, wheel }))
