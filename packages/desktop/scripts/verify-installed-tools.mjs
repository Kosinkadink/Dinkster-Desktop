import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import pin from '../src/environment-tools-release.json' with { type: 'json' }

const resources = process.argv[2]
if (!resources) throw new Error('Pass the installed resources directory')
const directory = resolve(resources, 'tools')
const os = { win32: 'windows', linux: 'linux', darwin: 'macos' }[process.platform]
const arch = { x64: 'x86_64', arm64: 'arm64' }[process.arch]
const artifact = pin.artifacts.find((row) => row.name === `dinkster-tools-${os}-${arch}.zip`)
assert(artifact, 'The installer platform must have a pinned tools archive')
assert.deepEqual((await readdir(directory)).sort(), [pin.manifest.name, artifact.name].sort(), 'Install only the native tools and manifest')
const verified = []
for (const row of [pin.manifest, artifact]) {
  const bytes = await readFile(join(directory, row.name))
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  assert.equal(bytes.length, row.size, `${row.name}: installed size`)
  assert.equal(sha256, row.sha256, `${row.name}: installed SHA256`)
  verified.push({ name: row.name, size: bytes.length, sha256 })
}
console.log(JSON.stringify({ commit: process.env.GITHUB_SHA, release: pin.releaseTag, resources: directory, verified }, null, 2))
