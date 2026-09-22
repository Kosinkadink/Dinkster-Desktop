import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const DESCRIPTOR_VARIABLE = 'DINKSTER_CONTROL_RUNTIME_DESCRIPTOR'
const ARCHIVE_VARIABLE = 'DINKSTER_CONTROL_RUNTIME_ARCHIVE'
const PLATFORMS = new Set(['linux-x86_64', 'windows-amd64', 'macos-arm64'])
const INTERPRETER = new Map([
  ['linux-x86_64', 'bin/python3'],
  ['windows-amd64', 'python.exe'],
  ['macos-arm64', 'bin/python3'],
])

function isCanonicalRelativePosixPath(value) {
  if (typeof value !== 'string' || value === '') return false
  if (value.includes('\\') || value.startsWith('/')) return false
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

function rejectUnknownFields(value, fields, subject) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Control-runtime ${subject} must be a JSON object`)
  }
  const expected = fields.sort()
  if (!isDeepStrictEqual(Object.keys(value).sort(), expected)) {
    throw new Error(`Control-runtime ${subject} must contain exactly the fields ${fields.join(', ')}`)
  }
}

function validateDescriptor(descriptor) {
  rejectUnknownFields(descriptor, ['artifact', 'commit', 'format', 'invocation', 'platform', 'python'], 'descriptor')
  if (descriptor.format !== 'dinkster.control-runtime/1') {
    throw new Error(`Control-runtime descriptor format must be dinkster.control-runtime/1, got ${JSON.stringify(descriptor.format)}`)
  }
  if (!/^[a-f0-9]{40}$/.test(descriptor.commit)) {
    throw new Error('Control-runtime descriptor commit must be a lowercase 40-character hex commit')
  }
  if (!PLATFORMS.has(descriptor.platform)) {
    throw new Error(`Control-runtime descriptor platform must be one of ${[...PLATFORMS].sort().join(', ')}, got ${JSON.stringify(descriptor.platform)}`)
  }
  const { artifact, python, invocation } = descriptor
  rejectUnknownFields(artifact, ['path', 'sha256', 'size'], 'artifact')
  if (!isCanonicalRelativePosixPath(artifact.path) ||
    artifact.path !== `control/${descriptor.platform}/${artifact.sha256}.tar.gz`) {
    throw new Error(`Control-runtime artifact path must be control/<platform>/<sha256>.tar.gz, got ${JSON.stringify(artifact.path)}`)
  }
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) {
    throw new Error('Control-runtime artifact sha256 must be a lowercase 64-character hex digest')
  }
  if (!Number.isSafeInteger(artifact.size) || artifact.size < 1) {
    throw new Error('Control-runtime artifact size must be a safe integer of at least 1')
  }
  if (python !== INTERPRETER.get(descriptor.platform)) {
    throw new Error(`Control-runtime descriptor python must be bin/python3 for Linux and macOS or python.exe for Windows, got ${JSON.stringify(python)}`)
  }
  if (!isDeepStrictEqual(invocation, ['<python>', '-I', '-m', 'dinkster.cli'])) {
    throw new Error('Control-runtime descriptor invocation must be exactly ["<python>", "-I", "-m", "dinkster.cli"]')
  }
}

async function canonicalPath(path) {
  try {
    return await realpath(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return resolve(path)
  }
}

async function inputOutsideStaging(source, canonicalStaging) {
  // An outward alias is also unsafe if deleting its parent makes the input unreachable.
  for (let ancestor = resolve(source); ; ancestor = dirname(ancestor)) {
    const inputRelative = relative(canonicalStaging, await canonicalPath(ancestor))
    if (!isAbsolute(inputRelative) && inputRelative.split(sep)[0] !== '..') {
      throw new Error('Input files must be outside resources/control-runtime')
    }
    if (dirname(ancestor) === ancestor) break
  }
}

const descriptorPath = process.env[DESCRIPTOR_VARIABLE]
const archivePath = process.env[ARCHIVE_VARIABLE]
if (!descriptorPath) throw new Error(`Set ${DESCRIPTOR_VARIABLE} to the bundled control-runtime descriptor file; see docs/desktop.md`)
if (!archivePath) throw new Error(`Set ${ARCHIVE_VARIABLE} to the control-runtime archive named by the descriptor; see docs/desktop.md`)

const staging = resolve(import.meta.dirname, '../resources/control-runtime')
const canonicalStaging = await canonicalPath(staging)
await inputOutsideStaging(descriptorPath, canonicalStaging)
await inputOutsideStaging(archivePath, canonicalStaging)

// Copy the verified targets even if cleanup removes an intermediate alias in a chain.
const descriptorSource = await canonicalPath(descriptorPath)
const archiveSource = await canonicalPath(archivePath)

let descriptor
try {
  descriptor = JSON.parse(await readFile(descriptorSource, 'utf8'))
} catch (cause) {
  throw new Error('Control-runtime descriptor must be valid JSON', { cause })
}
validateDescriptor(descriptor)

const archiveName = basename(archiveSource)
if (archiveName !== `${descriptor.artifact.sha256}.tar.gz` || basename(descriptor.artifact.path) !== archiveName) {
  throw new Error(`Control-runtime archive must be named ${descriptor.artifact.sha256}.tar.gz after the descriptor artifact path, got ${JSON.stringify(archiveName)}`)
}

const hash = createHash('sha256')
let size = 0
for await (const chunk of createReadStream(archiveSource)) {
  hash.update(chunk)
  size += chunk.length
}
const actual = hash.digest('hex')
if (actual !== descriptor.artifact.sha256) {
  throw new Error(`${archiveName} checksum mismatch: expected ${descriptor.artifact.sha256}, got ${actual}`)
}
if (size !== descriptor.artifact.size) {
  throw new Error(`${archiveName} size mismatch: expected ${descriptor.artifact.size}, got ${size}`)
}

await rm(staging, { recursive: true, force: true })
await mkdir(staging, { recursive: true })
const stagedDescriptor = resolve(staging, 'descriptor.json')
const stagedArchive = resolve(staging, archiveName)
await copyFile(descriptorSource, stagedDescriptor)
await copyFile(archiveSource, stagedArchive)
console.log(`${stagedDescriptor} (${descriptor.commit})`)
console.log(`${stagedArchive} (${descriptor.artifact.sha256})`)
