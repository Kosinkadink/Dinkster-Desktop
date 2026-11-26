import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { redactDiagnosticText, systemCheck } from '../src/desktop-manager.js'
import { EnvironmentClient } from '../src/environment.js'

describe('desktop engine management', () => {
  it('reports the engine-selected graphics card rather than the first detected card', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dinkster-system-'))
    const script = join(root, 'catalog.cjs')
    const client = new EnvironmentClient(process.execPath, [script])
    try {
      const hardware = {
        detectedCards: [
          { id: '0', vendor: 'intel', name: 'Integrated card', driver: '1', computeCapability: null, memoryMiB: null },
          { id: '0', vendor: 'amd', name: 'Selected AMD card', driver: '31.2', computeCapability: null, memoryMiB: 16384 },
        ],
        choices: [], variant: 'fixture-amd', buildLabel: 'AMD graphics', buildReason: 'Compatible.',
        graphicsVendor: 'amd', gpus: ['0'], refusal: null,
      }
      const response = { format: 'dinkster.environment-result/1', operation: 'catalog', status: 'clean',
        root: join(root, 'hardware-check'), current: null, plan: [], variants: [], hardware }
      await writeFile(script, `console.log(${JSON.stringify(JSON.stringify(response))})`)
      expect((await systemCheck(root, client)).gpu).toEqual({ available: true, name: 'Selected AMD card', driver: '31.2', memoryMiB: 16384 })
      await writeFile(script, `console.log(${JSON.stringify(JSON.stringify({ ...response,
        hardware: { ...hardware, variant: null, buildLabel: null, buildReason: null, graphicsVendor: null, gpus: [] } }))})`)
      expect((await systemCheck(root, client)).gpu).toEqual({ available: false })
    } finally {
      await client.dispose()
      await rm(root, { recursive: true, force: true })
    }
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
