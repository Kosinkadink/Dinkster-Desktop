import { existsSync } from 'node:fs'
import { delimiter, join, win32 } from 'node:path'

export const ENGINE_ACCELERATORS = ['cpu', 'cuda', 'mps', 'rocm', 'xpu'] as const
export type EngineAccelerator = typeof ENGINE_ACCELERATORS[number]

export function isEngineAccelerator(value: unknown): value is EngineAccelerator {
  return typeof value === 'string' && ENGINE_ACCELERATORS.includes(value as EngineAccelerator)
}

export function decodeEngineAccelerator(value: unknown): EngineAccelerator | undefined {
  if (value === 'nvidia') return 'cuda'
  return isEngineAccelerator(value) ? value : undefined
}

export interface AcceleratorSelection {
  readonly accelerator?: EngineAccelerator
  readonly diagnostic?: string
}

export function configuredEngineAccelerator(value: string | undefined): AcceleratorSelection {
  const selection = value?.trim()
  if (!selection) return {}
  if (selection === 'nvidia') {
    return {
      accelerator: 'cuda',
      diagnostic: "Desktop engine accelerator 'nvidia' was renamed to 'cuda'; using cuda",
    }
  }
  if (isEngineAccelerator(selection)) return { accelerator: selection }
  return {
    accelerator: 'cpu',
    diagnostic: `Unknown desktop engine accelerator '${selection}'; using cpu`,
  }
}

export function persistedEngineAccelerator(
  value: unknown,
  diagnostic?: (message: string) => void,
): EngineAccelerator {
  const decoded = decodeEngineAccelerator(value)
  if (decoded !== undefined) return decoded
  diagnostic?.(`Unknown persisted desktop engine accelerator '${String(value)}'; using cpu`)
  return 'cpu'
}

function commandOnPath(command: string): boolean {
  const suffixes = process.platform === 'win32'
    ? (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';')
    : ['']
  for (const root of (process.env['PATH'] ?? '').split(delimiter)) {
    if (!root) continue
    for (const suffix of suffixes) if (existsSync(join(root, `${command}${suffix}`))) return true
  }
  return false
}

export interface AcceleratorHostFacts {
  readonly platform?: NodeJS.Platform
  readonly architecture?: string
  readonly commandExists?: (command: string) => boolean
  readonly pathExists?: (path: string) => boolean
  readonly windowsDirectory?: string
}

export function detectEngineAccelerator(facts: AcceleratorHostFacts = {}): EngineAccelerator {
  const platform = facts.platform ?? process.platform
  const architecture = facts.architecture ?? process.arch
  const commandExists = facts.commandExists ?? commandOnPath
  const pathExists = facts.pathExists ?? existsSync
  const windowsDirectory = facts.windowsDirectory ?? process.env['SystemRoot'] ?? 'C:\\Windows'
  if (platform === 'darwin') return architecture === 'arm64' ? 'mps' : 'cpu'
  const nvml = platform === 'win32'
    ? win32.join(windowsDirectory, 'System32', 'nvml.dll')
    : join(windowsDirectory, 'System32', 'nvml.dll')
  if (
    pathExists('/proc/driver/nvidia/version') ||
    commandExists('nvidia-smi') ||
    pathExists(nvml)
  ) return 'cuda'
  if (
    pathExists('/sys/module/amdgpu') ||
    pathExists('/opt/rocm') ||
    commandExists('rocm-smi') ||
    commandExists('rocminfo')
  ) return 'rocm'
  if (commandExists('xpu-smi') || pathExists('/sys/module/intel_vsec')) return 'xpu'
  return 'cpu'
}

export function engineProcessEnvironment(
  accelerator: EngineAccelerator,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...environment, DINKSTER_ACCELERATOR: accelerator }
}
