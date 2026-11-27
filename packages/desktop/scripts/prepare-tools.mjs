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
const artifacts = [artifact]
if (process.platform === 'win32' && process.arch === 'x64') {
  const guest = pin.artifacts.find((row) => row.name === 'dinkster-tools-linux-x86_64.zip')
  if (!guest) throw new Error('No pinned Linux environment tools for WSL2')
  artifacts.push(guest)
}
if (typeof pin.label !== 'string' || !/^\d{4}-\d{2}-\d{2}-[A-Za-z0-9.+_-]+-[a-f0-9]{8}$/.test(pin.label) || pin.releaseTag !== `tools-${pin.label}` || pin.manifest.name !== 'tools-manifest.json') {
  throw new Error('Independent tools pins require their label, tools tag, and tools manifest')
}
const release = `https://releases.dinkster.org/tools/${pin.label}`

// Windows also needs the Linux archive for its Desktop-owned WSL2 guest.
await rm(directory, { recursive: true, force: true })
await mkdir(directory, { recursive: true })
for (const row of [pin.manifest, ...artifacts]) {
  const target = resolve(directory, row.name)
  await download(`${release}/${row.name}`, target, undefined, row.size)
  if ((await stat(target)).size !== row.size) throw new Error(`Pinned tools size mismatch: ${row.name}`)
  await verifyFile(target, row.sha256)
}
const manifest = JSON.parse(await readFile(resolve(directory, pin.manifest.name), 'utf8'))
const rows = validateToolsManifest(manifest, pin.manifest.sha256, pin.label)
if (manifest.repository !== pin.repository || manifest.commit !== pin.commit
  || artifacts.some((artifact) => !rows.some((row) => row.name === artifact.name && row.size === artifact.size && row.sha256 === artifact.sha256))) {
  throw new Error('Pinned tools disagree with their manifest')
}
for (const artifact of artifacts) console.log(`Prepared ${artifact.name}: ${artifact.sha256}`)
