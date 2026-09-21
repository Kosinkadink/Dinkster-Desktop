import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const source = resolve(
  process.env.DINKSTER_FRONTEND_DIST ?? '.frontend/packages/app/dist',
)
const destination = resolve('packages/app/dist')

const entries = await readdir(source)
if (!entries.includes('index.html')) {
  throw new Error(`${source} is not a built dinkster-frontend bundle`)
}

await rm(destination, { recursive: true, force: true })
await mkdir(destination, { recursive: true })
await cp(source, destination, { recursive: true })
console.log(`Prepared frontend bundle from ${source}`)
