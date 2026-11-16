import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

const resources = process.argv[2]
if (!resources) throw new Error('Pass the installed resources directory')

const directory = resolve(resources, 'sandbox')
const provenance = JSON.parse(await readFile(resolve(directory, 'MXC-PROVENANCE.json'), 'utf8'))
const build = JSON.parse(await readFile(resolve(directory, 'mxc-build.json'), 'utf8'))
assert.equal(provenance.name, 'wxc-exec.exe')
assert.equal(provenance.commit, 'c66201839d63cae2239db5e92f1f1d6076cf5181')
assert.equal(provenance.license, 'MIT')
assert.match(provenance.build.join('\n'), /MXC_TELEMETRY_COMPONENT_PATH=/)
assert.match(await readFile(resolve(directory, 'MXC-LICENSE.txt'), 'utf8'), /^MIT License\r?\n/m)
const executable = resolve(directory, provenance.name)
const bytes = await readFile(executable)
assert.equal((await stat(executable)).isFile(), true)
assert.deepEqual(build, {
  format: 'dinkster.mxc/1',
  commit: 'c66201839d63cae2239db5e92f1f1d6076cf5181',
  telemetryComponent: '',
  sha256: createHash('sha256').update(bytes).digest('hex'),
})
console.log(JSON.stringify({ commit: process.env.GITHUB_SHA, executor: executable, source: provenance.source, sourceCommit: build.commit, sha256: build.sha256 }, null, 2))
