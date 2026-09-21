import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
const execute = promisify(execFile)
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

describe('desktop package inputs', () => {
  let scratch: string
  let release: string
  let output: string
  let script: string
  let aimdoWheel: string
  const files = {
    'constraints.txt': Buffer.from('dinkster==0.0.1 --hash=sha256:fixture\n'),
    'dinkster-0.0.1-py3-none-any.whl': Buffer.from('meta wheel'),
    'dinkster_frontend-0.0.1-py3-none-any.whl': Buffer.from('frontend wheel'),
  }
  const aimdoBytes = Buffer.from('aimdo wheel')

  async function writeFixture(overrides: Record<string, unknown> = {}): Promise<void> {
    const manifest = {
      repository: 'Kosinkadink/Dinkster', tag: 'v0.0.1', version: '0.0.1',
      artifacts: Object.entries(files).map(([name, bytes]) => ({ name, sha256: hash(bytes), size: bytes.length })),
      ...overrides,
    }
    const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`
    await writeFile(resolve(release, 'release-manifest.json'), manifestBytes)
    for (const [name, bytes] of Object.entries(files)) await writeFile(resolve(release, name), bytes)
    await writeFile(aimdoWheel, aimdoBytes)
    const current = JSON.parse(await readFile(resolve(root, 'packages/desktop/src/backend-release.json'), 'utf8'))
    await writeFile(resolve(scratch, 'src/backend-release.json'), JSON.stringify({
      ...current,
      commit: 'a'.repeat(40),
      releaseManifest: { archive: 'release-manifest.json', sha256: hash(manifestBytes) },
      desktopWindowsRuntime: {
        ...current.desktopWindowsRuntime,
        aimdo: { ...current.desktopWindowsRuntime.aimdo, commit: 'b'.repeat(40), sha256: hash(aimdoBytes), size: aimdoBytes.length },
      },
    }))
  }

  beforeEach(async () => {
    scratch = await mkdtemp(resolve(tmpdir(), 'dinkster-wheel-package-'))
    release = resolve(scratch, 'release')
    output = resolve(scratch, 'resources/engine')
    aimdoWheel = resolve(scratch, 'aimdo.whl')
    await mkdir(release)
    await mkdir(resolve(scratch, 'scripts'))
    await mkdir(resolve(scratch, 'src'))
    script = resolve(scratch, 'scripts/prepare-engine-release.mjs')
    await writeFile(script, await readFile(resolve(root, 'packages/desktop/scripts/prepare-engine-release.mjs')))
    await writeFixture()
  })

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true })
  })

  function prepare(bundle = release, aimdo = aimdoWheel): Promise<unknown> {
    return execute(process.execPath, [script], {
      env: { ...process.env, DINKSTER_ENGINE_RELEASE: bundle, DINKSTER_AIMDO_WHEEL: aimdo },
    })
  }

  it('copies the verified manifest, wheel set, constraints, and Aimdo wheel', async () => {
    await mkdir(output, { recursive: true })
    await writeFile(resolve(output, 'stale.zip'), 'stale')
    await prepare()
    expect((await readdir(output)).sort()).toEqual([
      ...Object.keys(files), 'release-manifest.json', 'dinkster_aimdo-0.5.5.post1-cp39-abi3-win_amd64.whl',
    ].sort())
  })

  it('rejects a changed manifest before replacing package outputs', async () => {
    await mkdir(output, { recursive: true })
    await writeFile(resolve(output, 'preserved.txt'), 'preserved')
    await writeFile(resolve(release, 'release-manifest.json'), '{}')
    await expect(prepare()).rejects.toThrow('manifest checksum mismatch')
    expect(await readFile(resolve(output, 'preserved.txt'), 'utf8')).toBe('preserved')
  })

  it('rejects a missing or corrupted wheel before replacing package outputs', async () => {
    await mkdir(output, { recursive: true })
    await writeFile(resolve(output, 'preserved.txt'), 'preserved')
    await writeFile(resolve(release, 'dinkster-0.0.1-py3-none-any.whl'), 'corrupted')
    await expect(prepare()).rejects.toThrow('checksum mismatch')
    expect(await readFile(resolve(output, 'preserved.txt'), 'utf8')).toBe('preserved')
  })

  it('requires explicit release and Aimdo inputs', async () => {
    await expect(prepare('')).rejects.toThrow('Set DINKSTER_ENGINE_RELEASE')
    await expect(prepare(release, '')).rejects.toThrow('Set DINKSTER_AIMDO_WHEEL')
  })

  it('packages only wheel release inputs', async () => {
    const manifest = JSON.parse(await readFile(resolve(root, 'packages/desktop/package.json'), 'utf8')) as {
      scripts: Record<string, string>
      build: { extraResources: { from: string; to: string; filter?: string[] }[] }
    }
    expect(manifest.scripts['prepare:engine']).toBe('node scripts/prepare-engine-release.mjs')
    expect(manifest.build.extraResources[1]).toEqual({
      from: 'resources/engine', to: 'engine', filter: ['*.json', '*.txt', '*.whl'],
    })
  })

  it('downloads the pinned release wheel contract with only the dedicated token', async () => {
    const yaml = createRequire(import.meta.url)('js-yaml') as { load(source: string): unknown }
    const source = await readFile(resolve(root, '.github/workflows/release-desktop.yml'), 'utf8')
    const workflow = yaml.load(source) as {
      jobs: { release: { steps: { name?: string; run?: string; env?: Record<string, string> }[] } }
    }
    const steps = workflow.jobs.release.steps
    const acquire = steps.find((step) => step.name === 'Download pinned private backend wheels and Aimdo')!
    expect(steps.find((step) => step.run !== undefined)).toBe(acquire)
    expect(acquire.env).toEqual({ GH_TOKEN: '${{ secrets.DINKSTER_RELEASE_READ_TOKEN }}' })
    expect(acquire.run).toContain('--pattern $pin.releaseManifest.archive --pattern constraints.txt --pattern \'*.whl\'')
    expect(acquire.run).toContain('DINKSTER_ENGINE_RELEASE=')
    expect(acquire.run).toContain('commits/$($pin.releaseTag)')
    expect(acquire.run).toContain("$releaseCommit -cne $pin.commit")
    expect(acquire.run).not.toMatch(/GITHUB_TOKEN|github\.token|githubtoken|\$env:GH_TOKEN\s*=/i)
    expect(source.match(/secrets\.DINKSTER_RELEASE_READ_TOKEN/g)).toHaveLength(1)
  })

  it('removes stale files from requested output directories', async () => {
    const directory = resolve(scratch, 'generated')
    await mkdir(directory)
    await writeFile(resolve(directory, 'stale.js'), 'stale')
    await execute(process.execPath, [resolve(root, 'packages/desktop/scripts/clean-output.mjs'), directory])
    await expect(access(directory)).rejects.toThrow()
  })
})
