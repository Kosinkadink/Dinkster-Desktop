import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

const resources = process.argv[2]
if (!resources) throw new Error('Pass the installed resources directory')

const directory = resolve(resources, 'sandbox')
const provenance = JSON.parse(await readFile(resolve(directory, 'MXC-PROVENANCE.json'), 'utf8'))
assert.equal(provenance.name, 'wxc-exec.exe')
assert.equal(provenance.commit, 'c66201839d63cae2239db5e92f1f1d6076cf5181')
assert.equal(provenance.license, 'MIT')
assert.match(provenance.build.join('\n'), /MXC_TELEMETRY_COMPONENT_PATH=/)
assert.match(await readFile(resolve(directory, 'MXC-LICENSE.txt'), 'utf8'), /^MIT License\r?\n/m)
assert.equal((await stat(resolve(directory, provenance.name))).isFile(), true)
console.log(JSON.stringify({ commit: process.env.GITHUB_SHA, executor: resolve(directory, provenance.name), source: provenance.source, sourceCommit: provenance.commit }, null, 2))
