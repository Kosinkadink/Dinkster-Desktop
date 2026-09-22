import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, posix, relative, resolve, sep, win32 } from 'node:path'
import * as tar from 'tar'

const FORMAT = 'dinkster.control-runtime/1'
const COMMIT_PATTERN = /^[0-9a-f]{40}$/
const DIGEST_PATTERN = /^[0-9a-f]{64}$/
const PLATFORMS = ['linux-x86_64', 'windows-amd64', 'macos-arm64'] as const
const INVOCATION = ['<python>', '-I', '-m', 'dinkster.cli'] as const

export type ControlRuntimePlatform = typeof PLATFORMS[number]

export interface ControlRuntimeDescriptor {
  readonly format: typeof FORMAT
  readonly commit: string
  readonly platform: ControlRuntimePlatform
  readonly artifact: {
    readonly path: string
    readonly sha256: string
    readonly size: number
  }
  readonly python: string
  readonly invocation: typeof INVOCATION
}

export interface BundledControlRuntime {
  readonly descriptor: ControlRuntimeDescriptor
  readonly interpreter: string
}

function record(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${description} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactFields(value: Record<string, unknown>, fields: readonly string[], description: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new Error(`${description} fields must be exactly ${expected.join(', ')}`)
  }
}

function canonicalRelativePath(value: unknown, description: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${description} must be a normalized relative POSIX path`)
  }
  if (
    posix.isAbsolute(value)
    || win32.isAbsolute(value)
    || /^[A-Za-z]:/.test(value)
    || value === '.'
    || posix.normalize(value) !== value
    || value.split('/').includes('..')
  ) {
    throw new Error(`${description} must be a normalized relative POSIX path`)
  }
  return value
}

function controlRuntimePlatform(value: unknown): ControlRuntimePlatform {
  if (typeof value !== 'string' || !PLATFORMS.includes(value as ControlRuntimePlatform)) {
    throw new Error(`control runtime platform must be one of ${PLATFORMS.join(', ')}`)
  }
  return value as ControlRuntimePlatform
}

function expectedPython(platform: ControlRuntimePlatform): string {
  return platform === 'windows-amd64' ? 'python.exe' : 'bin/python3'
}

function nativeControlRuntimePlatform(): ControlRuntimePlatform {
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x86_64'
  if (process.platform === 'win32' && process.arch === 'x64') return 'windows-amd64'
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'macos-arm64'
  throw new Error(`control runtime is not supported on ${process.platform}-${process.arch}`)
}

export function parseControlRuntimeDescriptor(value: unknown): ControlRuntimeDescriptor {
  const descriptor = record(value, 'control runtime descriptor')
  exactFields(descriptor, ['format', 'commit', 'platform', 'artifact', 'python', 'invocation'], 'control runtime descriptor')
  if (descriptor['format'] !== FORMAT) throw new Error(`control runtime format must be ${FORMAT}`)
  if (typeof descriptor['commit'] !== 'string' || !COMMIT_PATTERN.test(descriptor['commit'])) {
    throw new Error('control runtime commit must be a lowercase 40-character Git commit')
  }
  const platform = controlRuntimePlatform(descriptor['platform'])
  const artifact = record(descriptor['artifact'], 'control runtime artifact')
  exactFields(artifact, ['path', 'sha256', 'size'], 'control runtime artifact')
  if (typeof artifact['sha256'] !== 'string' || !DIGEST_PATTERN.test(artifact['sha256'])) {
    throw new Error('control runtime artifact sha256 must be lowercase hexadecimal')
  }
  if (typeof artifact['size'] !== 'number' || !Number.isSafeInteger(artifact['size']) || artifact['size'] < 1) {
    throw new Error('control runtime artifact size must be a positive safe integer')
  }
  const artifactPath = canonicalRelativePath(artifact['path'], 'control runtime artifact path')
  const expectedArtifactPath = `control/${platform}/${artifact['sha256']}.tar.gz`
  if (artifactPath !== expectedArtifactPath) {
    throw new Error(`control runtime artifact path must be ${expectedArtifactPath}`)
  }
  const python = canonicalRelativePath(descriptor['python'], 'control runtime python')
  if (python !== expectedPython(platform)) {
    throw new Error(`control runtime python must be ${expectedPython(platform)} for ${platform}`)
  }
  if (!Array.isArray(descriptor['invocation'])
    || descriptor['invocation'].length !== INVOCATION.length
    || descriptor['invocation'].some((item, index) => item !== INVOCATION[index])) {
    throw new Error('control runtime invocation must be <python> -I -m dinkster.cli')
  }
  return {
    format: FORMAT,
    commit: descriptor['commit'],
    platform,
    artifact: {
      path: artifactPath,
      sha256: artifact['sha256'],
      size: artifact['size'],
    },
    python,
    invocation: INVOCATION,
  }
}

async function verifyArchive(path: string, descriptor: ControlRuntimeDescriptor): Promise<Buffer> {
  const bytes = await readFile(path)
  if (bytes.length !== descriptor.artifact.size) {
    throw new Error(`control runtime archive size mismatch: expected ${descriptor.artifact.size}, got ${bytes.length}`)
  }
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== descriptor.artifact.sha256) {
    throw new Error(`control runtime archive checksum mismatch: expected ${descriptor.artifact.sha256}, got ${digest}`)
  }
  return bytes
}

function within(root: string, path: string): boolean {
  const child = relative(root, path)
  return child === '' || (!isAbsolute(child) && child.split(sep)[0] !== '..')
}

function validateArchiveEntry(root: string, entry: tar.ReadEntry): void {
  const path = canonicalRelativePath(entry.path, 'control runtime archive entry')
  if (!within(root, resolve(root, ...path.split('/')))) {
    throw new Error('control runtime archive entry escapes the extraction root')
  }
  if (!['File', 'OldFile', 'Directory', 'SymbolicLink'].includes(entry.type)) {
    throw new Error(`control runtime archive entry type is not allowed: ${entry.type}`)
  }
  if (entry.type === 'SymbolicLink') {
    const target = entry.linkpath
    if (
      !target
      || target.includes('\\')
      || /[\x00-\x1f\x7f]/.test(target)
      || posix.isAbsolute(target)
      || !within(root, resolve(root, ...dirname(path).split('/'), ...target.split('/')))
    ) {
      throw new Error('control runtime archive link escapes the extraction root')
    }
  }
}

async function validateArchive(path: string, root: string): Promise<void> {
  let validationError: unknown
  await tar.t({
    file: path,
    strict: true,
    onentry: (entry) => {
      if (validationError !== undefined) return
      try {
        validateArchiveEntry(root, entry)
      } catch (error) {
        validationError = error
      }
    },
  })
  if (validationError !== undefined) throw validationError
}

async function validateInterpreter(root: string, python: string): Promise<string> {
  const interpreter = resolve(root, ...python.split('/'))
  const resolved = await realpath(interpreter)
  if (!within(root, resolved) || !(await stat(resolved)).isFile()) {
    throw new Error('control runtime interpreter is not a file inside the extracted runtime')
  }
  await access(resolved, constants.X_OK)
  return resolved
}

export async function materializeBundledControlRuntime(
  resourcesPath: string,
  dataDirectory: string,
): Promise<BundledControlRuntime> {
  const resources = resolve(resourcesPath, 'control-runtime')
  const descriptorPath = resolve(resources, 'descriptor.json')
  const descriptor = parseControlRuntimeDescriptor(JSON.parse(await readFile(descriptorPath, 'utf8')))
  const nativePlatform = nativeControlRuntimePlatform()
  if (descriptor.platform !== nativePlatform) {
    throw new Error(`control runtime platform ${descriptor.platform} does not match ${nativePlatform}`)
  }
  const archive = resolve(resources, basename(descriptor.artifact.path))
  const archiveBytes = await verifyArchive(archive, descriptor)

  const parent = resolve(dataDirectory, 'control-runtime')
  const destination = resolve(parent, descriptor.artifact.sha256)
  const marker = resolve(destination, 'descriptor.json')
  try {
    const installed = parseControlRuntimeDescriptor(JSON.parse(await readFile(marker, 'utf8')))
    if (JSON.stringify(installed) === JSON.stringify(descriptor)) {
      return { descriptor, interpreter: await validateInterpreter(destination, descriptor.python) }
    }
  } catch {
    // An incomplete or mismatched content-addressed directory is replaced below.
  }

  await mkdir(parent, { recursive: true })
  const id = randomUUID()
  const temporary = resolve(parent, `${descriptor.artifact.sha256}.${id}.tmp`)
  const temporaryArchive = resolve(parent, `${descriptor.artifact.sha256}.${id}.tar.gz.tmp`)
  await rm(temporary, { recursive: true, force: true })
  await mkdir(temporary)
  try {
    await writeFile(temporaryArchive, archiveBytes, { flag: 'wx' })
    await validateArchive(temporaryArchive, temporary)
    await tar.x({ file: temporaryArchive, cwd: temporary, strict: true })
    await rm(temporaryArchive)
    const interpreter = await validateInterpreter(temporary, descriptor.python)
    await writeFile(resolve(temporary, 'descriptor.json'), `${JSON.stringify(descriptor, null, 2)}\n`, { flag: 'wx' })
    await rm(destination, { recursive: true, force: true })
    await rename(temporary, destination)
    return {
      descriptor,
      interpreter: resolve(destination, relative(temporary, interpreter)),
    }
  } catch (error) {
    await rm(temporaryArchive, { force: true })
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}
