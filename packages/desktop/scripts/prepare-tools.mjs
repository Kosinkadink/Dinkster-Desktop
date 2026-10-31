import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pin from '../src/environment-tools-release.json' with { type: 'json' }
import { download, verifyFile } from '../src/io.ts'

const directory = fileURLToPath(new URL('../resources/tools/', import.meta.url))
const os = { win32: 'windows', linux: 'linux', darwin: 'macos' }[process.platform]
const arch = { x64: 'x86_64', arm64: 'arm64' }[process.arch]
const artifact = pin.artifacts.find((row) => row.name === `dinkster-tools-${os}-${arch}.zip`)
if (!artifact) throw new Error(`No pinned environment tools for ${process.platform}/${process.arch}`)

// Only the native archive belongs in an installer; remove inputs from another target.
await rm(directory, { recursive: true, force: true })
await mkdir(directory, { recursive: true })
for (const row of [pin.manifest, artifact]) {
  const target = resolve(directory, row.name)
  await download(`https://github.com/${pin.repository}/releases/download/${pin.releaseTag}/${row.name}`, target, undefined, row.size)
  if ((await stat(target)).size !== row.size) throw new Error(`Pinned tools size mismatch: ${row.name}`)
  await verifyFile(target, row.sha256)
}
const manifest = JSON.parse(await readFile(resolve(directory, pin.manifest.name), 'utf8'))
const rows = manifest.artifacts?.filter((row) => row.name === artifact.name)
if (manifest.format !== 'dinkster.engine/1' || rows?.length !== 1 || rows[0].size !== artifact.size || rows[0].sha256 !== artifact.sha256) {
  throw new Error('Pinned tools disagree with their engine manifest')
}
console.log(`Prepared ${artifact.name}: ${artifact.sha256}`)
