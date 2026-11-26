import { readdir, stat, statfs, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { EnvironmentClient } from './environment.js'

export function defaultDataDirectory(): string {
  if (process.platform === 'win32') {
    return join(process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'), 'Dinkster Desktop')
  }
  return join(process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share'), 'dinkster-desktop')
}

export interface SystemCheck {
  readonly platform: string
  readonly architecture: string
  readonly freeBytes: number
  readonly totalBytes: number
  readonly gpu: { readonly available: boolean; readonly name?: string; readonly driver?: string; readonly memoryMiB?: number }
}

async function directoryBytes(path: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) total += await directoryBytes(child)
    else if (entry.isFile()) total += (await stat(child)).size
  }
  return total
}

export async function desktopStorageBytes(dataDirectory: string): Promise<number> {
  try {
    return await directoryBytes(dataDirectory)
  } catch {
    return 0
  }
}

export async function systemCheck(
  dataDirectory: string,
  environment: Pick<EnvironmentClient, 'run'>,
): Promise<SystemCheck> {
  await mkdir(dataDirectory, { recursive: true })
  const disk = await statfs(dataDirectory, { bigint: true })
  const { hardware } = await environment.run({ root: join(dataDirectory, 'hardware-check'), operation: 'catalog', hardware: true })
  if (!hardware) throw new Error('dinkster-env did not return hardware selection')
  const card = hardware.detectedCards?.find((card) => hardware.gpus.includes(card.id)
    && (hardware.graphicsVendor === undefined || hardware.graphicsVendor === null || card.vendor === hardware.graphicsVendor))
  return {
    platform: process.platform,
    architecture: process.arch,
    freeBytes: Number(disk.bavail * disk.bsize),
    totalBytes: Number(disk.blocks * disk.bsize),
    gpu: card ? { available: true, name: card.name,
      ...(card.driver === null ? {} : { driver: card.driver }),
      ...(card.memoryMiB === null ? {} : { memoryMiB: card.memoryMiB }) } : { available: false },
  }
}

export function redactDiagnosticText(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(\bbearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
    .replace(/((?:token|password|passwd|secret|api[_-]?key|access[_-]?token)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/((?:--)?(?:token|password|passwd|secret|api[_-]?key)\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/("(?:token|password|secret|apiKey|accessToken)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
    .replace(/(cookie\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]')
}
