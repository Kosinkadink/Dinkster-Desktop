import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const repository = 'Kosinkadink/Dinkster-Desktop'
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
const pr = event.pull_request
assert.equal(event.repository.full_name, repository)
assert.equal(pr.base.ref, 'main')
assert.equal(pr.head.repo.full_name, repository)
assert.equal(pr.merged, true)
assert.ok(pr.labels.some((label) => label.name === 'Release'))
assert.match(pr.merge_commit_sha, /^[0-9a-f]{40}$/)
const source = pr.merge_commit_sha
const versionAt = (ref) =>
  JSON.parse(
    execFileSync('git', ['show', `${ref}:packages/desktop/package.json`], {
      encoding: 'utf8',
    }),
  ).version
const version = versionAt(source)
assert.match(version, /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/)
if (version === versionAt(`${source}^`)) {
  console.log('Package version unchanged; no tag or release dispatched')
} else {
  const tag = `desktop-v${version}`
  const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' })
  const ref = `refs/tags/${tag}`
  const matches = JSON.parse(
    gh('api', `repos/${repository}/git/matching-refs/tags/${tag}`),
  )
  if (matches.some((row) => row.ref === ref)) {
    const existing = JSON.parse(gh('api', `repos/${repository}/commits/${ref}`))
    assert.equal(
      existing.sha,
      source,
      'Existing release tag points to another commit',
    )
  } else {
    gh(
      'api',
      '--method',
      'POST',
      `repos/${repository}/git/refs`,
      '-f',
      `ref=${ref}`,
      '-f',
      `sha=${source}`,
    )
  }
  gh(
    'workflow',
    'run',
    'publish-desktop.yml',
    '--repo',
    repository,
    '--ref',
    tag,
  )
  console.log(`Release workflow dispatched for ${tag} at ${source}`)
}
