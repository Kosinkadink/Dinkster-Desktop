export interface NvidiaGpu {
  readonly id: string
  readonly name: string
  readonly driver?: string
  readonly computeCapability?: string
  readonly memoryMiB?: number
}

export interface HardwareDetection {
  readonly gpus: readonly NvidiaGpu[]
  readonly diagnostic?: string
}

/** Hardware fields from the base producer's dinkster.base/1 manifest. */
export interface VariantHardware {
  readonly variant: string
  readonly platform: { readonly os: 'windows' | 'linux'; readonly arch: 'x86_64' }
    | { readonly os: 'macos'; readonly arch: 'arm64' }
  readonly nvidia: {
    readonly minimumDriver: string
    readonly minimumComputeCapability: string
    readonly maximumExclusiveComputeCapability: string | null
  } | null
}

export interface VariantPlan {
  readonly selected?: string
  readonly gpus: readonly string[]
  readonly reason: string
  readonly choices: readonly { readonly variant: string; readonly supported: boolean; readonly reason: string; readonly gpus?: readonly string[] }[]
}

export interface HardwareSelection {
  readonly detectedCards: readonly {
    readonly id: string
    readonly name: string
    readonly driver: string | null
    readonly computeCapability: string | null
    readonly memoryMiB: number | null
  }[] | null
  readonly choices: readonly { readonly variant: string; readonly label: string; readonly reason: string; readonly gpus?: readonly string[] }[] | null
  readonly variant: string | null
  readonly buildLabel: string | null
  readonly buildReason: string | null
  readonly gpus: readonly string[]
  readonly refusal: { readonly code: string; readonly message: string } | null
}

export function parseHardwareSelection(value: unknown): HardwareSelection {
  const invalid = (): never => { throw new Error('unsupported dinkster-env hardware response') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const row = value as Record<string, unknown>
  const nullableText = (text: unknown): boolean => text === null || typeof text === 'string'
  if (!['variant', 'buildLabel', 'buildReason'].every((key) => nullableText(row[key]))
    || !Array.isArray(row['gpus']) || !row['gpus'].every((gpu: unknown) => typeof gpu === 'string')) return invalid()
  if (row['detectedCards'] !== null && (!Array.isArray(row['detectedCards']) || !row['detectedCards'].every((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const card = value as Record<string, unknown>
    return typeof card['id'] === 'string' && typeof card['name'] === 'string'
      && nullableText(card['driver']) && nullableText(card['computeCapability'])
      && (card['memoryMiB'] === null || (Number.isSafeInteger(card['memoryMiB']) && Number(card['memoryMiB']) > 0))
  }))) return invalid()
  if (row['choices'] !== null && (!Array.isArray(row['choices']) || !row['choices'].every((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const choice = value as Record<string, unknown>
    return ['variant', 'label', 'reason'].every((key) => typeof choice[key] === 'string')
      && (choice['gpus'] === undefined || (Array.isArray(choice['gpus']) && choice['gpus'].every((gpu: unknown) => typeof gpu === 'string')))
  }))) return invalid()
  const refusal = row['refusal'] as Record<string, unknown> | null | undefined
  if (refusal !== null && (!refusal || typeof refusal !== 'object'
    || typeof refusal['code'] !== 'string' || typeof refusal['message'] !== 'string')) return invalid()
  return value as HardwareSelection
}

export function projectHardware(selection: HardwareSelection): { hardware: HardwareDetection; plan: VariantPlan } {
  return {
    hardware: {
      gpus: (selection.detectedCards ?? []).map((card) => ({
        id: card.id, name: card.name,
        ...(card.driver === null ? {} : { driver: card.driver }),
        ...(card.computeCapability === null ? {} : { computeCapability: card.computeCapability }),
        ...(card.memoryMiB === null ? {} : { memoryMiB: card.memoryMiB }),
      })),
      ...(selection.refusal === null ? {} : { diagnostic: selection.refusal.message }),
    },
    plan: {
      ...(selection.variant === null ? {} : { selected: selection.variant }),
      gpus: selection.gpus,
      reason: selection.refusal?.message ?? selection.buildReason ?? 'No build selected.',
      choices: (selection.choices ?? []).map((choice) => ({ variant: choice.variant, supported: true, reason: choice.reason,
        ...(choice.gpus === undefined ? {} : { gpus: choice.gpus }) })),
    },
  }
}
