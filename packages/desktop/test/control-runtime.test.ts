import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import * as tar from 'tar'
import { afterEach, describe, expect, it } from 'vitest'
import {
  materializeBundledControlRuntime,
  parseControlRuntimeDescriptor,
  type ControlRuntimeDescriptor,
} from '../src/control-runtime.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

const platform = process.platform === 'win32'
  ? 'windows-amd64'
  : process.platform === 'darwin' ? 'macos-arm64' : 'linux-x86_64'
const python = platform === 'windows-amd64' ? 'python.exe' : 'bin/python3'

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dinkster-control-runtime-'))
  roots.push(root)
  return root
}

function descriptor(sha256 = 'a'.repeat(64), size = 42): ControlRuntimeDescriptor {
  return {
    format: 'dinkster.control-runtime/1',
    commit: 'b'.repeat(40),
    platform,
    artifact: { path: `control/${platform}/${sha256}.tar.gz`, sha256, size },
    python,
    invocation: ['<python>', '-I', '-m', 'dinkster.cli'],
  }
}

async function runtimeFixture(): Promise<{
  resources: string
  data: string
  descriptor: ControlRuntimeDescriptor
}> {
  const root = await temporaryRoot()
  const resources = join(root, 'resources', 'control-runtime')
  const source = join(root, 'source')
  const data = join(root, 'data')
  await mkdir(join(source, ...python.split('/').slice(0, -1)), { recursive: true })
  await mkdir(resources, { recursive: true })
  await writeFile(join(source, ...python.split('/')), 'python fixture')
  await chmod(join(source, ...python.split('/')), 0o755)
  const provisional = join(resources, 'runtime.tar.gz')
  await tar.c({ cwd: source, file: provisional, gzip: true }, [python.split('/')[0]!])
  const bytes = await readFile(provisional)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const value = descriptor(sha256, bytes.length)
  const archive = join(resources, `${sha256}.tar.gz`)
  await writeFile(archive, bytes)
  await rm(provisional)
  await writeFile(join(resources, 'descriptor.json'), JSON.stringify(value))
  return { resources: join(root, 'resources'), data, descriptor: value }
}

function tarField(header: Buffer, offset: number, length: number): string {
  const end = header.indexOf(0, offset)
  return header.subarray(offset, end < 0 || end > offset + length ? offset + length : end).toString()
}

function writeTarField(header: Buffer, offset: number, length: number, value: string): void {
  header.fill(0, offset, offset + length)
  header.write(value, offset, length, 'utf8')
}

function mutatePythonEntry(
  archive: Buffer,
  mutate: (header: Buffer) => void,
): Buffer {
  const body = gunzipSync(archive)
  let offset = 0
  while (offset + 512 <= body.length) {
    const header = body.subarray(offset, offset + 512)
    const name = tarField(header, 0, 100)
    const size = Number.parseInt(tarField(header, 124, 12).trim() || '0', 8)
    if (name === python) {
      mutate(header)
      header.fill(0x20, 148, 156)
      let checksum = 0
      for (const byte of header) checksum += byte
      writeTarField(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `)
      return gzipSync(body)
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  throw new Error(`fixture archive has no ${python} entry`)
}

async function replacePackagedArchive(
  fixture: Awaited<ReturnType<typeof runtimeFixture>>,
  bytes: Buffer,
): Promise<void> {
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const value = descriptor(sha256, bytes.length)
  const resources = join(fixture.resources, 'control-runtime')
  await writeFile(join(resources, `${sha256}.tar.gz`), bytes)
  await writeFile(join(resources, 'descriptor.json'), JSON.stringify(value))
}

describe('bundled control runtime', () => {
  it('strictly parses the canonical descriptor contract', () => {
    const valid = descriptor()
    expect(parseControlRuntimeDescriptor(valid)).toEqual(valid)
    for (const invalid of [
      { ...valid, extra: true },
      { ...valid, commit: 'B'.repeat(40) },
      { ...valid, platform: 'linux-arm64' },
      { ...valid, invocation: ['python', '-m', 'dinkster.cli'] },
      { ...valid, python: '../python' },
      { ...valid, python: valid.platform === 'windows-amd64' ? 'bin/python3' : 'python.exe' },
      { ...valid, artifact: { ...valid.artifact, path: `control/other/${valid.artifact.sha256}.tar.gz` } },
      { ...valid, artifact: { ...valid.artifact, size: 0 } },
    ]) {
      expect(() => parseControlRuntimeDescriptor(invalid)).toThrow()
    }
  })

  it('verifies and extracts the packaged pair into content-addressed state', async () => {
    const fixture = await runtimeFixture()
    const first = await materializeBundledControlRuntime(fixture.resources, fixture.data)
    expect(first.descriptor).toEqual(fixture.descriptor)
    expect(await readFile(first.interpreter, 'utf8')).toBe('python fixture')
    expect(first.interpreter).toContain(fixture.descriptor.artifact.sha256)

    const second = await materializeBundledControlRuntime(fixture.resources, fixture.data)
    expect(second.interpreter).toBe(first.interpreter)
  })

  it('rejects corrupted packaged bytes before changing runtime state', async () => {
    const fixture = await runtimeFixture()
    const archive = join(fixture.resources, 'control-runtime', `${fixture.descriptor.artifact.sha256}.tar.gz`)
    await writeFile(archive, 'corrupted')
    await expect(materializeBundledControlRuntime(fixture.resources, fixture.data)).rejects.toThrow('size mismatch')
    await expect(readFile(join(fixture.data, 'control-runtime', fixture.descriptor.artifact.sha256, 'descriptor.json')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a same-size checksum mismatch before changing runtime state', async () => {
    const fixture = await runtimeFixture()
    const archive = join(fixture.resources, 'control-runtime', `${fixture.descriptor.artifact.sha256}.tar.gz`)
    const bytes = await readFile(archive)
    bytes[bytes.length - 1] ^= 1
    await writeFile(archive, bytes)

    await expect(materializeBundledControlRuntime(fixture.resources, fixture.data))
      .rejects.toThrow('checksum mismatch')
    await expect(readFile(join(fixture.data, 'control-runtime', fixture.descriptor.artifact.sha256, 'descriptor.json')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a descriptor for a different host platform before reading the archive', async () => {
    const fixture = await runtimeFixture()
    const otherPlatform = platform === 'linux-x86_64' ? 'windows-amd64' : 'linux-x86_64'
    const otherPython = otherPlatform === 'windows-amd64' ? 'python.exe' : 'bin/python3'
    const value = {
      ...fixture.descriptor,
      platform: otherPlatform,
      python: otherPython,
      invocation: ['<python>', '-I', '-m', 'dinkster.cli'],
      artifact: {
        ...fixture.descriptor.artifact,
        path: `control/${otherPlatform}/${fixture.descriptor.artifact.sha256}.tar.gz`,
      },
    }
    await writeFile(join(fixture.resources, 'control-runtime', 'descriptor.json'), JSON.stringify(value))

    await expect(materializeBundledControlRuntime(fixture.resources, fixture.data))
      .rejects.toThrow('does not match')
  })

  it('rejects archive entries that escape the extraction root', async () => {
    const fixture = await runtimeFixture()
    const archive = await readFile(join(
      fixture.resources,
      'control-runtime',
      `${fixture.descriptor.artifact.sha256}.tar.gz`,
    ))
    const mutated = mutatePythonEntry(archive, (header) => {
      writeTarField(header, 0, 100, '../payload')
    })
    await replacePackagedArchive(fixture, mutated)

    await expect(materializeBundledControlRuntime(fixture.resources, fixture.data))
      .rejects.toThrow('normalized relative POSIX path')
  })

  it.each([
    { type: '1', label: 'hard-link' },
    { type: '6', label: 'special-entry' },
  ])('rejects a $label archive type', async ({ type }) => {
    const fixture = await runtimeFixture()
    const archive = await readFile(join(
      fixture.resources,
      'control-runtime',
      `${fixture.descriptor.artifact.sha256}.tar.gz`,
    ))
    const mutated = mutatePythonEntry(archive, (header) => {
      header[156] = type.charCodeAt(0)
      if (type === '1') writeTarField(header, 157, 100, python)
    })
    await replacePackagedArchive(fixture, mutated)

    await expect(materializeBundledControlRuntime(fixture.resources, fixture.data))
      .rejects.toThrow('entry type is not allowed')
  })

  it('rejects a symlink whose target escapes the extraction root', async () => {
    const fixture = await runtimeFixture()
    const archive = await readFile(join(
      fixture.resources,
      'control-runtime',
      `${fixture.descriptor.artifact.sha256}.tar.gz`,
    ))
    const mutated = mutatePythonEntry(archive, (header) => {
      header[156] = '2'.charCodeAt(0)
      writeTarField(header, 157, 100, '../../outside')
    })
    await replacePackagedArchive(fixture, mutated)

    await expect(materializeBundledControlRuntime(fixture.resources, fixture.data))
      .rejects.toThrow('link escapes the extraction root')
  })

  it('rejects a Windows-absolute archive path on every host platform', async () => {
    const fixture = await runtimeFixture()
    const archive = await readFile(join(
      fixture.resources,
      'control-runtime',
      `${fixture.descriptor.artifact.sha256}.tar.gz`,
    ))
    const mutated = mutatePythonEntry(archive, (header) => {
      writeTarField(header, 0, 100, 'C:/escape/python.exe')
    })
    await replacePackagedArchive(fixture, mutated)

    await expect(materializeBundledControlRuntime(fixture.resources, fixture.data))
      .rejects.toThrow('normalized relative POSIX path')
  })
})
