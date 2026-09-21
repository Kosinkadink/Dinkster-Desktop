import { resolve } from 'node:path'
import { availableLoopbackPort, EngineRuntime, defaultDataDirectory } from './engine.js'
import { configuredEngineAccelerator } from './accelerator.js'
import { acquireLifecycleLease } from './lifecycle-lease.js'
import { createWebHost } from './web-host.js'
import { createWebLauncher } from './web-launcher.js'

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const source = process.env['DINKSTER_ENGINE_SOURCE'] ?? resolve(repositoryRoot, '..', 'Dinkster')
const dataDirectory = process.env['DINKSTER_DESKTOP_DATA'] ?? defaultDataDirectory()
const configuredAccelerator = configuredEngineAccelerator(
  process.env['DINKSTER_ACCELERATOR'] ?? process.env['DINKSTER_ENGINE_VARIANT'],
)
if (configuredAccelerator.diagnostic) console.warn(configuredAccelerator.diagnostic)
const lease = await acquireLifecycleLease(dataDirectory)
try {
  const port = await availableLoopbackPort()
  const runtime = new EngineRuntime({
    dataDirectory,
    sourceDirectory: source,
    port,
    ...(process.env['DINKSTER_UV'] ? { uvExecutable: process.env['DINKSTER_UV'] } : {}),
    ...(configuredAccelerator.accelerator ? { variant: configuredAccelerator.accelerator } : {}),
  })

  runtime.on('status', (status) => console.log(`[${status.phase}] ${status.detail}`))
  runtime.on('log', (line) => process.stdout.write(String(line)))

  const host = await createWebHost(resolve(repositoryRoot, 'packages', 'app', 'dist'), port)
  const launcher = createWebLauncher(runtime, {
    url: host.url,
    close: async () => {
      await Promise.allSettled([host.close(), lease.release()])
    },
  }, (url) => console.log(`Dinkster is available at ${url}`))
  const stop = () => {
    void launcher.stop().finally(() => process.exit(0))
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  await launcher.start()
} catch (error) {
  await lease.release()
  throw error
}
