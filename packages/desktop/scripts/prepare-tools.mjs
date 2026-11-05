import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pin from '../src/environment-tools-release.json' with { type: 'json' }
import { download, verifyFile } from '../src/io.ts'
import { validateToolsManifest } from '../src/environment-tools.ts'

const directory = fileURLToPath(new URL('../resources/tools/', import.meta.url))
const os = { win32: 'windows', linux: 'linux', darwin: 'macos' }[process.platform]
const arch = { x64: 'x86_64', arm64: 'arm64' }[process.arch]
const artifact = pin.artifacts.find((row) => row.name === `dinkster-tools-${os}-${arch}.zip`)
if (!artifact) throw new Error(`No pinned environment tools for ${process.platform}/${process.arch}`)
const independentTools = typeof pin.label === 'string'
if (independentTools && (!/^\d{4}-\d{2}-\d{2}-[A-Za-z0-9.+_-]+-[a-f0-9]{8}$/.test(pin.label) || pin.releaseTag !== `tools-${pin.label}` || pin.manifest.name !== 'tools-manifest.json')) {
  throw new Error('Independent tools pins require their label, tools tag, and tools manifest')
}
const release = independentTools
  ? `https://releases.dinkster.org/tools/${pin.label}`
  : `https://github.com/${pin.repository}/releases/download/${pin.releaseTag}`

// Only the native archive belongs in an installer; remove inputs from another target.
await rm(directory, { recursive: true, force: true })
await mkdir(directory, { recursive: true })
for (const row of [pin.manifest, artifact]) {
  const target = resolve(directory, row.name)
  await download(`${release}/${row.name}`, target, undefined, row.size)
  if ((await stat(target)).size !== row.size) throw new Error(`Pinned tools size mismatch: ${row.name}`)
  await verifyFile(target, row.sha256)
}
const manifest = JSON.parse(await readFile(resolve(directory, pin.manifest.name), 'utf8'))
const rows = validateToolsManifest(manifest, pin.manifest.sha256, pin.label).filter((row) => row.name === artifact.name)
if ((independentTools && (manifest.repository !== pin.repository || manifest.commit !== pin.commit))
  || rows?.length !== 1 || rows[0].size !== artifact.size || rows[0].sha256 !== artifact.sha256) {
  throw new Error('Pinned tools disagree with their manifest')
}
console.log(`Prepared ${artifact.name}: ${artifact.sha256}`)
