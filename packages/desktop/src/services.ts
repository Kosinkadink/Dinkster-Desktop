export type DesktopServices = 'production' | 'qa'

export function parseDesktopServices(argv: readonly string[]): DesktopServices {
  let selected: DesktopServices = 'production'
  let found = false
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!
    if (argument !== '--services' && !argument.startsWith('--services=')) continue
    const value = argument === '--services' ? argv[++index] : argument.slice('--services='.length)
    if (found || (value !== 'production' && value !== 'qa')) {
      throw new Error('Desktop --services accepts production or qa, once per launch.')
    }
    selected = value
    found = true
  }
  return selected
}

export function desktopTitle(services: DesktopServices, development = false): string {
  if (services === 'qa') return 'Dinkster Desktop [QA]'
  return development ? 'Dinkster Desktop - Development - unpublished sources' : 'Dinkster Desktop'
}

export async function engineServices(url: string): Promise<string> {
  const response = await fetch(new URL('/api/nodes?wire=1', url), {
    signal: AbortSignal.timeout(10_000), redirect: 'error',
  })
  if (!response.ok) throw new Error('The local engine did not report its hosted services.')
  const header = await response.json() as { dinkster?: { services?: { name?: unknown } } }
  const name = header.dinkster?.services?.name
  if (name !== 'production' && name !== 'qa' && name !== 'custom') {
    throw new Error('The local engine did not report its hosted services.')
  }
  return name
}
