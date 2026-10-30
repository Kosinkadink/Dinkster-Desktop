import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'

export const hangDiagnosticEnabled = process.env['DINKSTER_DESKTOP_HANG_DIAGNOSTIC'] === '1'

type Handler = 'supervisor-restart' | 'proxy' | 'static'
type Boundary = { timestamp: number; handler: Handler; phase: 'entry' | 'exit' }
let worker: Worker | undefined

export function startHangDiagnostic(dataDirectory: string): void {
  if (!hangDiagnosticEnabled || worker) return
  const ticks = new BigInt64Array(new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT))
  Atomics.store(ticks, 0, BigInt(Date.now()))
  worker = new Worker(new URL(import.meta.url), { workerData: { dataDirectory, ticks } })
  worker.unref()
  setInterval(() => Atomics.store(ticks, 0, BigInt(Date.now())), 1000).unref()
}

export function diagnosticBoundary(handler: Handler, phase: Boundary['phase']): void {
  worker?.postMessage({ timestamp: Date.now(), handler, phase } satisfies Boundary)
}

if (!isMainThread && hangDiagnosticEnabled) {
  const { dataDirectory, ticks } = workerData as { dataDirectory: string; ticks: BigInt64Array }
  const directory = join(dataDirectory, 'logs')
  mkdirSync(directory, { recursive: true })
  const file = join(directory, 'hang-diagnostic.jsonl')
  parentPort!.on('message', (record: Boundary) => {
    appendFileSync(file, `${JSON.stringify(record)}\n`)
  })
  setInterval(() => {
    const timestamp = Date.now()
    const lastTick = Number(Atomics.load(ticks, 0))
    if (timestamp - lastTick >= 5000) {
      appendFileSync(file, `${JSON.stringify({ timestamp, handler: 'main-heartbeat', phase: 'missed', lastTick })}\n`)
    }
  }, 1000)
}
