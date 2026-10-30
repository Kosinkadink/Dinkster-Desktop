import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

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

const execute = promisify(execFile)
type HardwareCommand = (command: string, args: readonly string[]) => Promise<string>

/** Read host facts only; this never loads CUDA or downloads an environment. */
export async function detectNvidiaGpus(
  platform: NodeJS.Platform = process.platform,
  command: HardwareCommand = async (file, args) =>
    (await execute(file, [...args], { windowsHide: true, timeout: 5000 })).stdout,
): Promise<HardwareDetection> {
  try {
    const csv = await command('nvidia-smi', [
      '--query-gpu=index,name,driver_version,compute_cap,memory.total',
      '--format=csv,noheader',
    ])
    const gpus = csv.trim().split(/\r?\n/).filter(Boolean).map((line): NvidiaGpu => {
      const [id, name, driver, capability, memory] = line.split(',').map((field) => field.trim())
      const memoryMiB = Number(memory?.replace(/\s*MiB$/, ''))
      if (!id || !/^\d+$/.test(id) || !name || !driver || !/^\d+(\.\d+)*$/.test(driver)
        || !capability || !/^\d+\.\d+$/.test(capability) || capability.split('.').every((part) => Number(part) === 0)
        || !memory || !Number.isFinite(memoryMiB) || memoryMiB <= 0) {
        throw new Error('nvidia-smi returned incomplete GPU information')
      }
      return { id, name, driver, computeCapability: capability, memoryMiB }
    })
    if (new Set(gpus.map((gpu) => gpu.id)).size !== gpus.length) throw new Error('nvidia-smi returned duplicate GPU indexes')
    return { gpus }
  } catch (error) {
    if (platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { gpus: [], diagnostic: 'NVIDIA detection failed; choose CPU explicitly or repair the NVIDIA driver and retry.' }
    }
  }
  try {
    const output = await command('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_VideoController | Select-Object PNPDeviceID,Name,AdapterCompatibility | ConvertTo-Json -Compress',
    ])
    const parsed: unknown = JSON.parse(output || '[]')
    const controllers: unknown[] = Array.isArray(parsed) ? parsed : parsed === null ? [] : [parsed]
    const gpus: NvidiaGpu[] = []
    for (const controller of controllers) {
      if (!controller || typeof controller !== 'object') continue
      const row = controller as Record<string, unknown>
      if (typeof row['Name'] !== 'string' || typeof row['PNPDeviceID'] !== 'string') continue
      if (!/nvidia/i.test(`${row['AdapterCompatibility']} ${row['Name']}`)) continue
      gpus.push({ id: row['PNPDeviceID'], name: row['Name'] })
    }
    return {
      gpus,
      diagnostic: gpus.length
        ? 'NVIDIA hardware found without nvidia-smi. Install the required NVIDIA driver, then retry detection.'
        : 'No NVIDIA GPU detected. Choose CPU explicitly or assign an NVIDIA GPU with a supported driver.',
    }
  } catch {
    return { gpus: [], diagnostic: 'Windows GPU detection failed. Choose CPU explicitly or repair the NVIDIA driver and retry.' }
  }
}

/** Hardware fields from the base producer's dinkster.base/1 manifest. */
export interface VariantHardware {
  readonly variant: string
  readonly platform: { readonly os: 'windows' | 'linux'; readonly arch: 'x86_64' }
  readonly nvidia: {
    readonly minimumDriver: string
    readonly minimumComputeCapability: string
    readonly maximumExclusiveComputeCapability: string | null
  } | null
}

export interface VariantPlan {
  readonly selected?: string
  readonly reason: string
  readonly choices: readonly { readonly variant: string; readonly supported: boolean; readonly reason: string }[]
}

function compareVersions(actual: string, minimum: string): number {
  const left = actual.split('.').map(Number)
  const right = minimum.split('.').map(Number)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

export function planVariant(
  manifests: readonly VariantHardware[],
  detection: HardwareDetection,
  assignedGpuIds: readonly string[],
  platform: NodeJS.Platform,
  override?: string,
  architecture: NodeJS.Architecture = process.arch,
): VariantPlan {
  const os = platform === 'win32' ? 'windows' : platform === 'linux' ? 'linux' : undefined
  const arch = architecture === 'x64' ? 'x86_64' : undefined
  const assigned = detection.gpus.filter((gpu) => assignedGpuIds.includes(gpu.id))
  const missing = assignedGpuIds.some((id) => !assigned.some((gpu) => gpu.id === id))
  const variants = manifests.filter((manifest) => os && arch && manifest.platform.os === os && manifest.platform.arch === arch)
  const choices = variants.map((manifest) => {
    const limits = manifest.nvidia
    let reason: string
    let supported = false
    if (limits === null) {
      supported = true
      reason = 'CPU runs locally without an NVIDIA GPU. Select it explicitly; it can be much slower.'
    } else if (missing || assigned.length === 0) {
      reason = `Assign an NVIDIA GPU with driver ${limits.minimumDriver} or newer and compute capability ${limits.minimumComputeCapability} or newer.`
    } else if (assigned.some((gpu) => !gpu.driver || compareVersions(gpu.driver, limits.minimumDriver) < 0)) {
      reason = `${assigned.map((gpu) => `${gpu.name}: driver ${gpu.driver ?? 'not detected'}`).join('; ')}. Requires NVIDIA driver ${limits.minimumDriver} or newer.`
    } else if (assigned.some((gpu) => gpu.computeCapability === undefined)) {
      reason = 'GPU compute capability is unknown. Repair the NVIDIA driver and retry detection.'
    } else {
      const capabilities = assigned.map((gpu) => gpu.computeCapability!).sort(compareVersions)
      const lowest = capabilities[0]!
      const highest = capabilities[capabilities.length - 1]!
      supported = compareVersions(lowest, limits.minimumComputeCapability) >= 0
        && (limits.maximumExclusiveComputeCapability === null || compareVersions(highest, limits.maximumExclusiveComputeCapability) < 0)
      reason = supported
        ? `Assigned GPUs meet driver ${limits.minimumDriver}; lowest compute capability ${lowest} meets ${limits.minimumComputeCapability}.`
        : `Assigned compute capabilities ${lowest}-${highest} require support from ${limits.minimumComputeCapability}${limits.maximumExclusiveComputeCapability === null ? ' upwards' : ` to below ${limits.maximumExclusiveComputeCapability}`}.`
    }
    return { variant: manifest.variant, supported, reason }
  })
  if (override !== undefined) {
    const choice = choices.find((candidate) => candidate.variant === override)
    if (!choice) throw new Error('the selected variant is not available for this platform')
    return { selected: override, reason: `Explicit override: ${choice.reason}`, choices }
  }
  // Prefer the newest compatible base, independent of manifest input ordering.
  const preferred = variants.filter((manifest) => manifest.nvidia !== null)
    .sort((a, b) => compareVersions(b.nvidia!.minimumComputeCapability, a.nvidia!.minimumComputeCapability))
    .find((manifest) => choices.find((choice) => choice.variant === manifest.variant)?.supported)
  if (preferred) {
    const choice = choices.find((candidate) => candidate.variant === preferred.variant)!
    return { selected: choice.variant, reason: choice.reason, choices }
  }
  return {
    reason: [detection.diagnostic, ...choices.filter((choice) => variants.find((manifest) => manifest.variant === choice.variant)?.nvidia !== null).map((choice) => `${choice.variant}: ${choice.reason}`), 'Choose CPU explicitly or change the assigned hardware/driver.'].filter(Boolean).join('\n'),
    choices,
  }
}
