export interface WebLauncherRuntime {
  start(): Promise<void>
  stop(): Promise<void>
}

export interface WebLauncherHost {
  readonly url: string
  close(): Promise<void>
}

export interface WebLauncher {
  start(): Promise<void>
  stop(): Promise<void>
}

export function createWebLauncher(
  runtime: WebLauncherRuntime,
  host: WebLauncherHost,
  onReady: (url: string) => void,
): WebLauncher {
  let stopPromise: Promise<void> | undefined
  const stop = (): Promise<void> => {
    stopPromise ??= Promise.allSettled([runtime.stop(), host.close()]).then(() => undefined)
    return stopPromise
  }
  return {
    start: async () => {
      try {
        await runtime.start()
        if (!stopPromise) onReady(host.url)
      } catch (error) {
        await stop()
        throw error
      }
    },
    stop,
  }
}
