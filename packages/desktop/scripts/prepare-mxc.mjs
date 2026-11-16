import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

import { mxcCommit as commit, writeMxcBuild } from './mxc-build.mjs'

const execute = promisify(execFile)
const sourceUrl = `https://github.com/microsoft/mxc/archive/${commit}.zip`
const sourceRoot = `mxc-${commit}`
const directory = resolve(import.meta.dirname, '../resources/sandbox')
const output = resolve(directory, 'wxc-exec.exe')

if (process.platform !== 'win32') throw new Error('The MXC executor is prepared only for Windows packaging')

const temporary = await mkdtemp(resolve(tmpdir(), 'dinkster-mxc-'))
try {
  const archive = resolve(temporary, 'mxc.zip')
  const source = resolve(temporary, sourceRoot)
  const response = await fetch(sourceUrl)
  if (!response.ok) throw new Error(`Could not download MXC source ${commit}: ${response.status} ${response.statusText}`)
  await writeFile(archive, Buffer.from(await response.arrayBuffer()))
  await execute('tar', ['-xf', archive, '-C', temporary])

  assert.equal((await stat(source)).isDirectory(), true, 'Downloaded MXC source root')
  assert.match(await readFile(resolve(source, 'LICENSE.md'), 'utf8'), /^MIT License\r?\n/m, 'MXC source license')
  assert.match(await readFile(resolve(source, 'src/rust-toolchain.toml'), 'utf8'), /channel\s*=\s*"1\.93"/, 'MXC Rust toolchain')

  await execute('cargo', ['build', '--locked', '--release', '-p', 'wxc', '--target', 'x86_64-pc-windows-msvc'], {
    cwd: resolve(source, 'src'),
    env: { ...process.env, MXC_TELEMETRY_COMPONENT_PATH: '' },
  })

  await mkdir(directory, { recursive: true })
  await copyFile(resolve(source, 'src/target/x86_64-pc-windows-msvc/release/wxc-exec.exe'), output)
  await writeMxcBuild(output, resolve(directory, 'mxc-build.json'))
  console.log(`Prepared ${output} from MXC ${commit} with MXC_TELEMETRY_COMPONENT_PATH explicitly empty`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
