import { engineServices, type DesktopServices } from './services.js'

export async function packActivation(next: string, generation: number | null, services: DesktopServices, added: readonly string[]): Promise<Record<string, unknown>> {
  if (await engineServices(next) !== services) throw new Error('activation-failed')
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const composition = await fetch(`${next}/api/composition`, { signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - Date.now()))) })
    const catalog = await composition.json() as { epoch?: number; composing?: boolean; packs?: Record<string, { state?: string }> }
    if (!composition.ok || !catalog.packs) throw new Error('activation-failed')
    // Supervisor readiness exposes the diagnostic host before all packs announce.
    if (catalog.composing !== true) {
      const health = await fetch(`${next}/api/health`, { signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - Date.now()))) })
      const body = await health.json() as { ok?: boolean; compositionState?: { epoch?: number; failed?: number } }
      const epoch = body.compositionState?.epoch
      if (!health.ok || body.ok !== true || body.compositionState?.failed !== 0 || !Number.isSafeInteger(epoch) || epoch! < 1
        || epoch !== catalog.epoch || !added.every((pack) => catalog.packs![pack]?.state === 'announced')) throw new Error('activation-failed')
      return { generation, epoch, added, removed: [], reloaded: [], unchanged: Object.keys(catalog.packs).filter((pack) => !added.includes(pack)).sort(), failed: {}, diagnostics: [], rolledBack: false }
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))))
  }
  throw new Error('activation-failed')
}
