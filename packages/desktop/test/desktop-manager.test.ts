import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearEngineOperation,
  createInstallSnapshot,
  desktopStorageBytes,
  listEngineReleases,
  parseInstallSnapshot,
  readEngineOperation,
  readEngineSelection,
  readStoredEngineSelection,
  redactDiagnosticText,
  writeEngineOperation,
  writeEngineSelection,
} from '../src/desktop-manager.js'
import { ENGINE_RELEASE } from '../src/release.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dinkster-manager-test-'))
  roots.push(path)
  return path
}

describe('desktop engine management', () => {
  it('uses the packaged release until a valid selection is saved', async () => {
    const data = await root()
    await expect(readEngineSelection(data, 'cpu')).resolves.toEqual({ commit: ENGINE_RELEASE.commit, variant: 'cpu' })
    await mkdir(join(data, 'engine'), { recursive: true })
    await writeFile(join(data, 'engine', 'selection.json'), JSON.stringify({ commit: 'older', variant: 'nvidia', followPackaged: true }))
    await expect(readEngineSelection(data, 'cpu')).resolves.toEqual({ commit: 'older', variant: 'cuda', followPackaged: true })
    await writeEngineSelection(data, { commit: 'newer', variant: 'xpu' })
    await expect(readEngineSelection(data, 'mps')).resolves.toEqual({ commit: 'newer', variant: 'xpu' })

    await writeFile(join(data, 'engine', 'selection.json'), JSON.stringify({ commit: 'unknown', variant: 'other' }))
    const diagnostic = vi.fn()
    await expect(readStoredEngineSelection(data, diagnostic)).resolves.toEqual({ commit: 'unknown', variant: 'cpu' })
    expect(diagnostic).toHaveBeenCalledWith("Unknown persisted desktop engine accelerator 'other'; using cpu")
  })

  it('lists only complete releases and reports their disk usage', async () => {
    const data = await root()
    const releases = join(data, 'engine', 'releases')
    const current = join(releases, 'current')
    const incomplete = join(releases, 'incomplete')
    await mkdir(current, { recursive: true })
    await mkdir(incomplete, { recursive: true })
    await writeFile(join(current, '.dinkster-desktop-release.json'), JSON.stringify({ commit: 'abc', variant: 'cpu' }))
    await writeFile(join(current, 'payload'), '12345')
    await writeFile(join(incomplete, 'payload'), 'ignored')
    const installed = await listEngineReleases(data, { commit: 'abc', variant: 'cpu' })
    expect(installed).toHaveLength(1)
    expect(installed[0]).toMatchObject({ commit: 'abc', variant: 'cpu', active: true })
    expect(installed[0]!.bytes).toBeGreaterThanOrEqual(5)
    await expect(desktopStorageBytes(data)).resolves.toBeGreaterThan(installed[0]!.bytes)
  })

  it('persists an operation journal until exact recovery clears it', async () => {
    const data = await root()
    const operation = {
      id: 'op-1', kind: 'packaged-update' as const, startedAt: '2026-08-18T00:00:00.000Z',
      previous: { commit: 'old', variant: 'cpu' as const },
      target: { commit: 'new', variant: 'rocm' as const },
    }
    await writeEngineOperation(data, operation)
    await expect(readEngineOperation(data)).resolves.toEqual(operation)
    await clearEngineOperation(data)
    await expect(readEngineOperation(data)).resolves.toBeUndefined()
  })

  it('captures and validates dependency versions in portable snapshots', async () => {
    const data = await root()
    const release = join(data, 'engine', 'releases', 'current')
    const sitePackages = process.platform === 'win32'
      ? join(release, '.venv', 'Lib', 'site-packages', 'torch-2.1.dist-info')
      : join(release, '.venv', 'lib', 'python3.12', 'site-packages', 'torch-2.1.dist-info')
    await mkdir(sitePackages, { recursive: true })
    await writeFile(join(release, '.dinkster-desktop-release.json'), JSON.stringify({ commit: 'abc', variant: 'cpu' }))
    await writeFile(join(sitePackages, 'METADATA'), 'Name: torch\nVersion: 2.1.0\n')
    const snapshot = await createInstallSnapshot(data, { commit: 'abc', variant: 'cpu' }, 'manual')
    expect(snapshot.dependencies).toEqual([{ name: 'torch', version: '2.1.0' }])
    expect(parseInstallSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot)
    expect(parseInstallSnapshot({
      ...snapshot,
      selection: { commit: 'legacy', variant: 'nvidia' },
    }).selection).toEqual({ commit: 'legacy', variant: 'cuda' })
    expect(() => parseInstallSnapshot({ format: 1 })).toThrow('malformed')
  })

  it('scrubs credentials from support diagnostics', () => {
    const source = 'Authorization: Bearer abc123 token=secret\nCookie: sid=private\n{"password":"hunter2","error":"Bearer raw-token"}\nhttps://user:pass@example.test --api-key hidden'
    const scrubbed = redactDiagnosticText(source)
    expect(scrubbed).not.toContain('abc123')
    expect(scrubbed).not.toContain('secret')
    expect(scrubbed).not.toContain('private')
    expect(scrubbed).not.toContain('hunter2')
    expect(scrubbed).not.toContain('raw-token')
    expect(scrubbed).not.toContain('user:pass')
    expect(scrubbed).not.toContain('hidden')
    expect(scrubbed.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(6)
  })
})
