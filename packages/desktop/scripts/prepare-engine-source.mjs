import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { unzipSync } from 'fflate'
import backend from '../src/backend-release.json' with { type: 'json' }

if (backend.repository !== 'Kosinkadink/Dinkster' || !/^[a-f0-9]{40}$/.test(backend.commit) ||
  backend.releaseTag !== `backend-${backend.commit}` ||
  backend.archive !== `dinkster-backend-${backend.commit}.zip` || !/^[a-f0-9]{64}$/.test(backend.sha256) ||
  !Number.isSafeInteger(backend.workerProtocol) || backend.workerProtocol < 1) {
  throw new Error('Invalid pinned backend release metadata')
}
const { aimdo, cudaTorch } = backend.desktopWindowsRuntime
if (!aimdo || aimdo.repository !== 'Comfy-Org/comfy-aimdo' ||
  !/^\d+\.\d+\.\d+$/.test(aimdo.version) || aimdo.releaseTag !== `v${aimdo.version}` ||
  aimdo.archive !== `comfy_aimdo-${aimdo.version}-cp39-abi3-win_amd64.whl` || !/^[a-f0-9]{64}$/.test(aimdo.sha256) ||
  !aimdo.url?.startsWith('https://files.pythonhosted.org/packages/')) {
  throw new Error('Invalid pinned Aimdo release metadata')
}
const payloads = [
  { source: process.env.DINKSTER_ENGINE_ARCHIVE, variable: 'DINKSTER_ENGINE_ARCHIVE', pin: backend },
  { source: process.env.DINKSTER_AIMDO_WHEEL, variable: 'DINKSTER_AIMDO_WHEEL', pin: aimdo },
]

async function canonicalPath(path) {
  try {
    return await realpath(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return resolve(path)
  }
}

const directory = resolve(import.meta.dirname, '../resources/engine')
const canonicalDirectory = await canonicalPath(directory)
for (const payload of payloads) {
  const { source, variable, pin } = payload
  if (!source) throw new Error(`Set ${variable} to the pinned release artifact; see docs/desktop.md`)
  // An outward alias is also unsafe if deleting its parent makes the input unreachable.
  for (let ancestor = resolve(source); ; ancestor = dirname(ancestor)) {
    const inputRelative = relative(canonicalDirectory, await canonicalPath(ancestor))
    if (!isAbsolute(inputRelative) && inputRelative.split(sep)[0] !== '..') {
      throw new Error('Input artifacts must be outside resources/engine')
    }
    if (dirname(ancestor) === ancestor) break
  }
  // Copy the verified target even if cleanup removes an intermediate alias in a chain.
  payload.source = await canonicalPath(source)
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(payload.source)) {
    hash.update(chunk)
    size += chunk.length
  }
  const actual = hash.digest('hex')
  if (actual !== pin.sha256) throw new Error(`${pin.archive} checksum mismatch: expected ${pin.sha256}, got ${actual}`)
  if (size !== pin.size) throw new Error(`${pin.archive} size mismatch: expected ${pin.size}, got ${size}`)
}
// Only the native profile is needed; do not extract unrelated source assets.
const profile = `dinkster-backend-${backend.commit}/scripts/desktop_windows_runtime.json`
let declared
try {
  const files = unzipSync(await readFile(payloads[0].source), { filter: (entry) => entry.name === profile })
  declared = JSON.parse(Buffer.from(files[profile] ?? []).toString('utf8'))
} catch (cause) {
  throw new Error('Backend ZIP must contain valid scripts/desktop_windows_runtime.json at its pinned source prefix', { cause })
}
if (!isDeepStrictEqual(declared, { aimdo, cudaTorch })) {
  throw new Error('Backend ZIP Windows native profile does not match the frontend release pin')
}
await rm(directory, { recursive: true, force: true })
await mkdir(directory, { recursive: true })
for (const { source, pin } of payloads) {
  const destination = resolve(directory, pin.archive)
  await copyFile(source, destination)
  console.log(`${destination} (${pin.sha256})`)
}
