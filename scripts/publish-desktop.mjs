import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const repository = 'Kosinkadink/Dinkster-Desktop'
const tag = process.env.RELEASE_TAG
assert.match(
  tag ?? '',
  /^desktop-v\d+\.\d+\.\d+(?:-rc\.\d+)?$/,
  'Expected desktop-vX.Y.Z or desktop-vX.Y.Z-rc.N',
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
assert.equal(
  process.env.GITHUB_REF,
  `refs/tags/${tag}`,
  'Publication requires a tag ref',
)
const source = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim()
const pkg = JSON.parse(readFileSync('packages/desktop/package.json', 'utf8'))
assert.equal(
  tag,
  `desktop-v${pkg.version}`,
  'Tag does not match package version',
)
const tagged = JSON.parse(
  execFileSync('gh', ['api', `repos/${repository}/commits/refs/tags/${tag}`], {
    encoding: 'utf8',
  }),
)
assert.equal(tagged.sha, source, 'Tag no longer matches the checked-out commit')
const existing = JSON.parse(
  execFileSync(
    'gh',
    [
      'api',
      'graphql',
      '-f',
      'query=query($tag:String!){repository(owner:"Kosinkadink",name:"Dinkster-Desktop"){release(tagName:$tag){id}}}',
      '-f',
      `tag=${tag}`,
    ],
    { encoding: 'utf8' },
  ),
)
assert.equal(existing.errors, undefined, 'Release lookup failed')
assert.equal(
  existing.data.repository.release,
  null,
  'Release already exists; refusing to overwrite',
)
const mode = process.argv[2]
if (mode === 'validate') {
  appendFileSync(process.env.GITHUB_OUTPUT, `source=${source}\n`)
} else {
  assert.equal(mode, 'publish', 'Expected validate or publish')
  assert.equal(
    source,
    process.env.DESKTOP_SOURCE_COMMIT,
    'Publication source changed during build',
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
    assert.equal(metadata.commit, source)
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
  const summary = (message) => {
    console.log(message)
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`)
  }
  const test = /-rc\.\d+$/.test(pkg.version)
  gh(
    'release',
    'create',
    tag,
    ...files,
    '--verify-tag',
    '--title',
    `Dinkster Desktop ${pkg.version}`,
    ...(test ? ['--prerelease', '--latest=false'] : ['--latest']),
  )
  const published = view()
  assert.equal(published.isDraft, false, 'Publication did not complete')
  assert.equal(published.tagName, tag)
  assert.deepEqual(
    published.assets.map((asset) => asset.name).sort(),
    files.map((file) => basename(file)).sort(),
  )
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
