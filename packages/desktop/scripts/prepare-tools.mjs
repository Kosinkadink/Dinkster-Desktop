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
const independentTools = typeof pin.label === 'string'
if (independentTools && (!/^\d{4}-\d{2}-\d{2}-[A-Za-z0-9.+_-]+-[a-f0-9]{8}$/.test(pin.label) || !pin.releaseTag.startsWith('tools-') || pin.manifest.name !== 'tools-manifest.json')) {
  throw new Error('Independent tools pins require their label, tools tag, and tools manifest')
}

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
const independentIdentity = manifest.format === 'dinkster.tools/1'
  && manifest.repository === 'Kosinkadink/Dinkster'
  && /^[a-f0-9]{40}$/.test(manifest.commit)
  && typeof manifest.version === 'string' && manifest.version
  && typeof manifest.builtAt === 'string' && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(manifest.builtAt) && !Number.isNaN(Date.parse(manifest.builtAt))
  && typeof manifest.label === 'string' && manifest.label
  && manifest.label.slice(11) === manifest.version
  && pin.label === `${manifest.label}-${pin.manifest.sha256.slice(0, 8)}`
  && manifest.artifacts?.length === 3
if ((!independentTools && manifest.format !== 'dinkster.engine/1')
  || (independentTools && !independentIdentity)
  || rows?.length !== 1 || rows[0].size !== artifact.size || rows[0].sha256 !== artifact.sha256) {
  throw new Error('Pinned tools disagree with their manifest')
}
console.log(`Prepared ${artifact.name}: ${artifact.sha256}`)
