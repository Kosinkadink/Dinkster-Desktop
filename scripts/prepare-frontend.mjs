import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const source = resolve(
  process.env.DINKSTER_FRONTEND_DIST ?? '.frontend/packages/app/dist',
)
const destination = resolve('packages/app/dist')
const branding = resolve('.frontend/branding')
const brandDestination = resolve('packages/desktop/resources/branding')

const entries = await readdir(source)
if (!entries.includes('index.html')) {
  throw new Error(`${source} is not a built dinkster-frontend bundle`)
}

await rm(destination, { recursive: true, force: true })
await mkdir(destination, { recursive: true })
await cp(source, destination, { recursive: true })
console.log(`Prepared frontend bundle from ${source}`)

// Keep native icons and palette byte-identical to the pinned frontend source.
await rm(brandDestination, { recursive: true, force: true })
await mkdir(brandDestination, { recursive: true })
for (const directory of [
  'platform',
  'raster/color',
  'raster/mono',
  'svg',
  'tokens',
]) {
  await cp(resolve(branding, directory), resolve(brandDestination, directory), {
    recursive: true,
  })
}
console.log(`Prepared native branding from ${branding}`)
