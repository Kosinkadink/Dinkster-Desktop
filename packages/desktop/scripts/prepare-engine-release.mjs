import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import backend from '../src/backend-release.json' with { type: 'json' }

const digest = async (path) => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

if (backend.repository !== 'Kosinkadink/Dinkster' || !/^[a-f0-9]{40}$/.test(backend.commit) ||
  backend.releaseTag !== `v${backend.version}` || !/^\d+\.\d+\.\d+$/.test(backend.version) ||
  backend.releaseManifest.archive !== 'release-manifest.json' ||
  !/^[a-f0-9]{64}$/.test(backend.releaseManifest.sha256) ||
  !Number.isSafeInteger(backend.workerProtocol) || backend.workerProtocol < 1) {
  throw new Error('Invalid pinned backend release metadata')
}
const { aimdo } = backend.desktopWindowsRuntime
if (!aimdo || aimdo.repository !== 'Kosinkadink/dinkster-aimdo' || !/^[a-f0-9]{40}$/.test(aimdo.commit) ||
  !/^\d+\.\d+\.\d+(?:\.post\d+)?$/.test(aimdo.version) || aimdo.releaseTag !== `v${aimdo.version}` ||
  aimdo.archive !== `dinkster_aimdo-${aimdo.version}-cp39-abi3-win_amd64.whl` || !/^[a-f0-9]{64}$/.test(aimdo.sha256)) {
  throw new Error('Invalid pinned Aimdo release metadata')
}

async function canonicalPath(path) {
  try {
    return await realpath(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return resolve(path)
  }
}

const output = resolve(import.meta.dirname, '../resources/engine')
const bundle = process.env.DINKSTER_ENGINE_RELEASE
const aimdoWheel = process.env.DINKSTER_AIMDO_WHEEL
if (!bundle) throw new Error('Set DINKSTER_ENGINE_RELEASE to the pinned release artifact directory')
if (!aimdoWheel) throw new Error('Set DINKSTER_AIMDO_WHEEL to the pinned Aimdo wheel')
const canonicalOutput = await canonicalPath(output)
for (const input of [bundle, aimdoWheel]) {
  for (let ancestor = resolve(input); ; ancestor = dirname(ancestor)) {
    const inputRelative = relative(canonicalOutput, await canonicalPath(ancestor))
    if (!isAbsolute(inputRelative) && inputRelative.split(sep)[0] !== '..') {
      throw new Error('Input artifacts must be outside resources/engine')
    }
    if (dirname(ancestor) === ancestor) break
  }
}

const manifestPath = resolve(bundle, backend.releaseManifest.archive)
const manifestHash = await digest(manifestPath)
if (manifestHash !== backend.releaseManifest.sha256) {
  throw new Error(`release manifest checksum mismatch: expected ${backend.releaseManifest.sha256}, got ${manifestHash}`)
}
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
if (manifest.repository !== backend.repository || manifest.tag !== backend.releaseTag ||
  manifest.version !== backend.version || !Array.isArray(manifest.artifacts)) {
  throw new Error('Release manifest does not match the pinned backend release')
}
const artifacts = manifest.artifacts.filter(({ name }) => name === 'constraints.txt' || name?.endsWith('.whl'))
if (!artifacts.some(({ name }) => name?.startsWith(`dinkster-${backend.version}-`)) ||
  !artifacts.some(({ name }) => name?.startsWith(`dinkster_frontend-${backend.version}-`))) {
  throw new Error('Release manifest is missing required Dinkster wheels')
}
const names = new Set()
const payloads = [{ source: manifestPath, name: backend.releaseManifest.archive }]
for (const artifact of artifacts) {
  if (typeof artifact.name !== 'string' || basename(artifact.name) !== artifact.name || names.has(artifact.name) ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
    throw new Error('Release manifest contains an invalid artifact')
  }
  names.add(artifact.name)
  const source = resolve(bundle, artifact.name)
  const actual = await digest(source)
  if (actual !== artifact.sha256) {
    throw new Error(`${artifact.name} checksum mismatch: expected ${artifact.sha256}, got ${actual}`)
  }
  payloads.push({ source, name: artifact.name })
}
const aimdoHash = await digest(aimdoWheel)
if (aimdoHash !== aimdo.sha256) {
  throw new Error(`${aimdo.archive} checksum mismatch: expected ${aimdo.sha256}, got ${aimdoHash}`)
}
payloads.push({ source: await canonicalPath(aimdoWheel), name: aimdo.archive })

await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
for (const payload of payloads) {
  const destination = resolve(output, payload.name)
  await copyFile(payload.source, destination)
  console.log(destination)
}
