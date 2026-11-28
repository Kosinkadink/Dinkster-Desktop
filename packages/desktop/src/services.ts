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
