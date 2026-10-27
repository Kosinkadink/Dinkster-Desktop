import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(
  new URL('../packages/desktop/package.json', import.meta.url),
)
const tar = require('tar')
const commit = process.env.DINKSTER_REF
assert.match(
  commit ?? '',
  /^[a-f0-9]{40}$/,
  'DINKSTER_REF must be an immutable backend commit',
)
const head = execFileSync('git', ['-C', '.dinkster', 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim()
assert.equal(head, commit, 'Backend checkout must match Full validation pin')
const destination = resolve('.smoke-backend')
await rm(destination, { recursive: true, force: true })
await mkdir(destination)
const archive = resolve('.smoke-backend.tar')
try {
  execFileSync('git', [
    '-C',
    '.dinkster',
    'archive',
    '--format=tar',
    `--output=${archive}`,
    commit,
  ])
  await tar.x({ file: archive, cwd: destination })
  await writeFile(
    resolve(destination, 'desktop-smoke-commit.txt'),
    `${commit}\n`,
  )
} finally {
  await rm(archive, { force: true })
}
