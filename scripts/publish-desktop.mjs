import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
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
  const linux = JSON.parse(
    readFileSync(
      join(root, 'linux-release/desktop-linux-release.json'),
      'utf8',
    ),
  )
  assert.equal(
    linux.archive,
    `Dinkster-Desktop-${pkg.version}-linux-x86_64.AppImage`,
  )
  assert.deepEqual(linux.platform, { os: 'linux', arch: 'x64' })
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
    ['linux-release', linux],
  ]) {
    assert.equal(metadata.repository, repository)
    assert.equal(metadata.commit, source)
    assert.equal(metadata.version, pkg.version)
    const path = join(root, folder, metadata.archive)
    assert.equal(readFileSync(path).length, metadata.size)
    assert.equal(checksum(path), metadata.sha256)
  }
  const { verifyUpdateFeed } = await import(
    '../packages/desktop/scripts/verify-update-feed.mjs'
  )
  await verifyUpdateFeed(join(root, 'release'), pkg.version, 'win32')
  await verifyUpdateFeed(join(root, 'linux-release'), pkg.version, 'linux')
  writeFileSync(
    join(root, 'release/SHA256SUMS'),
    [windows, mac, linux]
      .map((metadata) => `${metadata.sha256}  ${metadata.archive}\n`)
      .join(''),
  )
  const test = /-rc\.\d+$/.test(pkg.version)
  const channel = test ? 'rc' : 'latest'
  const files = [
    join(root, 'release', windows.archive),
    join(root, 'release/desktop-release.json'),
    join(root, 'release/SHA256SUMS'),
    join(root, 'macos-release', mac.archive),
    join(root, 'macos-release/desktop-macos-release.json'),
    join(root, 'linux-release', linux.archive),
    join(root, 'linux-release/desktop-linux-release.json'),
    join(root, 'release', `${channel}.yml`),
    join(root, 'release', `${windows.archive}.blockmap`),
    join(root, 'linux-release', `${channel}-linux.yml`),
  ]
  const summary = (message) => {
    console.log(message)
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`)
  }
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
    `Publication permitted for ${tag}; all ${files.length} verified assets published using GITHUB_TOKEN.${test ? ' Prerelease does not move latest; desk deletes the test release and its tag after recording evidence.' : ''}`,
  )
}
