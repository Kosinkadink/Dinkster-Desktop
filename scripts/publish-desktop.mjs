import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const repository = 'Kosinkadink/Dinkster-Desktop'
const tag = process.env.RELEASE_TAG
assert.match(
  tag ?? '',
  /^desktop-v\d+\.\d+\.\d+(?:-[A-Za-z0-9][A-Za-z0-9.-]*)?$/,
  'Expected desktop-vX.Y.Z or desktop-vX.Y.Z-suffix',
)
const gh = (...args) =>
  execFileSync('gh', [...args, '--repo', repository], { encoding: 'utf8' })
const view = () =>
  JSON.parse(
    gh(
      'release',
      'view',
      tag,
      '--json',
      'tagName,isDraft,isPrerelease,targetCommitish,assets',
    ),
  )
const draft = view()
assert.equal(draft.isDraft, true, 'Release must be a draft')
assert.equal(draft.tagName, tag, 'Release tag changed')
assert.match(
  draft.targetCommitish,
  /^[0-9a-f]{40}$/,
  'Draft target must be an exact commit',
)
const pkg = JSON.parse(
  Buffer.from(
    execFileSync(
      'gh',
      [
        'api',
        `repos/${repository}/contents/packages/desktop/package.json?ref=${draft.targetCommitish}`,
        '--jq',
        '.content',
      ],
      { encoding: 'utf8' },
    ),
    'base64',
  ).toString('utf8'),
)
const stableTag = `desktop-v${pkg.version}`
assert.ok(
  tag === stableTag || tag.startsWith(`${stableTag}-`),
  'Draft tag does not match the target package version',
)
const mode = process.argv[2]
if (mode === 'resolve') {
  assert.equal(draft.assets.length, 0, 'Draft must have no existing assets')
  appendFileSync(process.env.GITHUB_OUTPUT, `source=${draft.targetCommitish}\n`)
} else {
  assert.equal(mode, 'publish', 'Expected resolve or publish')
  assert.equal(
    draft.targetCommitish,
    process.env.DESKTOP_SOURCE_COMMIT,
    'Draft target changed during build',
  )
  assert.equal(
    draft.assets.length,
    0,
    'Draft already has assets; refusing to overwrite',
  )
  const root = 'release-assets'
  const windows = JSON.parse(
    readFileSync(join(root, 'release/desktop-release.json'), 'utf8'),
  )
  const mac = JSON.parse(
    readFileSync(
      join(root, 'macos-release/desktop-macos-release.json'),
      'utf8',
    ),
  )
  assert.equal(windows.archive, `Dinkster-Desktop-${pkg.version}-Setup.exe`)
  assert.equal(mac.archive, `Dinkster-Desktop-${pkg.version}-macos-arm64.zip`)
  assert.deepEqual(mac.platform, { os: 'macos', arch: 'arm64' })
  assert.equal(mac.signed, false)
  assert.equal(mac.notarized, false)
  const checksum = (path) =>
    createHash('sha256').update(readFileSync(path)).digest('hex')
  for (const [folder, metadata] of [
    ['release', windows],
    ['macos-release', mac],
  ]) {
    assert.equal(metadata.repository, repository)
    assert.equal(metadata.commit, draft.targetCommitish)
    assert.equal(metadata.version, pkg.version)
    const path = join(root, folder, metadata.archive)
    assert.equal(readFileSync(path).length, metadata.size)
    assert.equal(checksum(path), metadata.sha256)
  }
  const sums = readFileSync(join(root, 'release/SHA256SUMS'), 'utf8')
    .trim()
    .split(/\r?\n/)
    .sort()
  assert.deepEqual(
    sums,
    [
      `${windows.sha256}  ${windows.archive}`,
      `${mac.sha256}  ${mac.archive}`,
    ].sort(),
  )
  const files = [
    join(root, 'release', windows.archive),
    join(root, 'release/desktop-release.json'),
    join(root, 'release/SHA256SUMS'),
    join(root, 'macos-release', mac.archive),
    join(root, 'macos-release/desktop-macos-release.json'),
  ]
  gh('release', 'upload', tag, ...files)
  const uploaded = view()
  assert.equal(uploaded.isDraft, true)
  assert.equal(uploaded.targetCommitish, draft.targetCommitish)
  assert.deepEqual(
    uploaded.assets.map((asset) => asset.name).sort(),
    files.map((file) => basename(file)).sort(),
  )
  const scratch = mkdtempSync(join(tmpdir(), 'dinkster-release-verify-'))
  try {
    for (const file of files) {
      const output = join(scratch, basename(file))
      gh(
        'release',
        'download',
        tag,
        '--pattern',
        basename(file),
        '--output',
        output,
      )
      assert.equal(
        checksum(output),
        checksum(file),
        `Uploaded bytes differ: ${basename(file)}`,
      )
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  const summary = (message) => {
    console.log(message)
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`)
  }
  const test = tag !== stableTag
  try {
    gh(
      'release',
      'edit',
      tag,
      '--draft=false',
      ...(test ? ['--prerelease', '--latest=false'] : []),
    )
  } catch (error) {
    summary(
      `Publication refused for ${tag}; all five uploaded assets were verified. Draft retained for desk publication after run inspection.`,
    )
    throw error
  }
  const published = view()
  assert.equal(published.isDraft, false, 'Publication did not complete')
  if (test)
    assert.equal(
      published.isPrerelease,
      true,
      'Test release must be a prerelease',
    )
  summary(
    `Publication permitted for ${tag}; all five verified assets published using GITHUB_TOKEN.${test ? ' Prerelease does not move latest; desk deletes the test release and its tag after recording evidence.' : ''}`,
  )
}
