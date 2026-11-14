import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { lt, rcompare, valid } from 'semver'
import { verifyUpdateFeed } from './verify-update-feed.mjs'

const repository = 'Kosinkadink/Dinkster-Desktop'
const tag = process.env.RELEASE_TAG
const source = process.env.DESKTOP_SOURCE_COMMIT
const root = resolve(process.env.DINKSTER_VERIFY_WORK ?? '')
assert(process.env.DINKSTER_VERIFY_WORK && /^desktop-v/.test(tag ?? ''))
const version = tag.slice('desktop-v'.length)
assert(valid(version) && /^[a-f0-9]{40}$/.test(source ?? ''))
const channel = version.includes('-rc.') ? 'rc' : 'latest'
const linux = process.platform === 'linux'
const metadataName = linux ? 'desktop-linux-release.json' : 'desktop-release.json'
const manifestName = `${channel}${linux ? '-linux' : ''}.yml`
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' })
const releases = []
for (let page = 1; ; page += 1) {
  const batch = JSON.parse(gh('api', `repos/${repository}/releases?per_page=100&page=${page}`))
  releases.push(...batch)
  if (batch.length < 100) break
}
function eligible(release) {
  const candidate = release.tag_name?.slice('desktop-v'.length)
  return !release.draft && release.tag_name?.startsWith('desktop-v') && valid(candidate)
    && (candidate.includes('-rc.') ? 'rc' : 'latest') === channel
    && [metadataName, manifestName].every((name) => release.assets.some((asset) => asset.name === name))
}
const current = releases.find((release) => release.tag_name === tag)
assert(current && eligible(current), 'The newly published platform update feed must exist')
assert.equal(current.prerelease, channel === 'rc')
const previous = releases.filter((release) => eligible(release) && lt(release.tag_name.slice('desktop-v'.length), version))
  .sort((a, b) => rcompare(a.tag_name.slice('desktop-v'.length), b.tag_name.slice('desktop-v'.length)))[0]
await mkdir(root)
async function download(release, folder) {
  const directory = join(root, folder)
  await mkdir(directory)
  const releaseVersion = release.tag_name.slice('desktop-v'.length)
  const archive = linux ? `Dinkster-Desktop-${releaseVersion}-linux-x86_64.AppImage` : `Dinkster-Desktop-${releaseVersion}-Setup.exe`
  for (const name of [metadataName, archive, ...(!linux ? [`${archive}.blockmap`] : []), manifestName]) {
    assert.equal(basename(name), name)
    const asset = release.assets.find((item) => item.name === name)
    assert(asset, `Missing published asset ${name}`)
    gh('release', 'download', release.tag_name, '--repo', repository, '--pattern', name, '--dir', directory)
    const bytes = await readFile(join(directory, name))
    assert.equal(bytes.length, asset.size)
    if (asset.digest) assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, asset.digest)
  }
  const metadata = JSON.parse(await readFile(join(directory, metadataName), 'utf8'))
  assert.equal(metadata.repository, repository)
  assert.equal(metadata.version, releaseVersion)
  assert.equal(metadata.archive, archive)
  const commit = JSON.parse(gh('api', `repos/${repository}/commits/${release.tag_name}`)).sha
  assert.equal(metadata.commit, commit, 'Published metadata must match its immutable source tag')
  if (folder === 'current') assert.equal(commit, source)
  const bytes = await readFile(join(directory, archive))
  assert.equal(metadata.size, bytes.length)
  assert.equal(metadata.sha256, createHash('sha256').update(bytes).digest('hex'))
  await verifyUpdateFeed(directory, releaseVersion, linux ? 'linux' : 'win32')
  return { directory, archive, version: releaseVersion, commit, tag: release.tag_name }
}
const receipt = { current: await download(current, 'current'), previous: previous ? await download(previous, 'previous') : null }
await writeFile(join(root, 'releases.json'), JSON.stringify(receipt, null, 2))
console.log(previous ? `Acquired signed-update candidates ${receipt.previous.version} -> ${version}` : `Bootstrap ${version}: no older updater-capable ${channel} release; cross-version acceptance remains open`)
