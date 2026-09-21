import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from './atomic-file.js'

/**
 * Encrypted connection-credential storage. Secrets are encrypted with the
 * OS-keychain-backed cipher (Electron safeStorage in production) before they
 * touch disk, and plaintext exists only transiently in the main process:
 * the renderer never receives a secret, only which profile ids have one.
 * Each entry binds one connection profile to the exact http(s) origin its
 * credential may be sent to.
 */

export interface CredentialCipher {
  readonly available: () => boolean
  readonly encrypt: (plain: string) => Buffer
  readonly decrypt: (blob: Buffer) => string
}

export interface CredentialEntry {
  readonly profileId: string
  readonly origin: string
}

interface StoredEntry {
  readonly origin: string
  readonly blob: string
}

const STORE_VERSION = 1

/** The exact http(s) origin of a URL, or undefined for anything else. */
export function credentialOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  if (parsed.username !== '' || parsed.password !== '') return undefined
  return parsed.origin
}

/**
 * Whether a request already carries an Authorization header. Header names
 * are not canonicalized, so a renderer-set `authorization` must count in
 * any casing or credential injection would overwrite it.
 */
export function hasAuthorizationHeader(headers: Record<string, unknown>): boolean {
  return Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')
}

interface DecodedStore {
  readonly entries: Map<string, StoredEntry>
  readonly retired: Set<string>
}

function decodeStore(value: unknown): DecodedStore {
  const entries = new Map<string, StoredEntry>()
  const retired = new Set<string>()
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { entries, retired }
  const root = value as Record<string, unknown>
  if (root['v'] !== STORE_VERSION || typeof root['entries'] !== 'object' || root['entries'] === null) return { entries, retired }
  if (Array.isArray(root['retired'])) {
    for (const id of root['retired']) {
      if (typeof id === 'string' && id.length > 0) retired.add(id)
    }
  }
  for (const [profileId, entry] of Object.entries(root['entries'] as Record<string, unknown>)) {
    if (retired.has(profileId)) continue
    if (typeof entry !== 'object' || entry === null) continue
    const { origin, blob } = entry as Record<string, unknown>
    if (typeof blob !== 'string' || blob.length === 0) continue
    if (typeof origin !== 'string' || credentialOrigin(origin) !== origin) continue
    entries.set(profileId, { origin, blob })
  }
  // One credential per origin is an invariant; a file that violates it is
  // ambiguous about which token an origin gets, so all claimants fail closed.
  const originCounts = new Map<string, number>()
  for (const entry of entries.values()) originCounts.set(entry.origin, (originCounts.get(entry.origin) ?? 0) + 1)
  for (const [profileId, entry] of [...entries]) {
    if (originCounts.get(entry.origin)! > 1) entries.delete(profileId)
  }
  return { entries, retired }
}

export class CredentialStore {
  /** Mutations chain through this promise so writes cannot interleave. */
  private mutations: Promise<unknown> = Promise.resolve()

  private constructor(
    private readonly path: string,
    private readonly cipher: CredentialCipher,
    private entries: Map<string, StoredEntry>,
    private retired: Set<string>,
  ) {}

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(task, task)
    this.mutations = result.catch(() => undefined)
    return result
  }

  /** A corrupt or missing file yields an empty store, never a failed launch. */
  static async open(path: string, cipher: CredentialCipher): Promise<CredentialStore> {
    let decoded: DecodedStore = { entries: new Map(), retired: new Set() }
    try {
      decoded = decodeStore(JSON.parse(await readFile(path, 'utf8')))
    } catch {
      // unreadable store: credentials must be re-entered, nothing else breaks
    }
    return new CredentialStore(path, cipher, decoded.entries, decoded.retired)
  }

  list(): readonly CredentialEntry[] {
    return [...this.entries].map(([profileId, entry]) => ({ profileId, origin: entry.origin }))
  }

  /** Unique origins that have at least one stored credential. */
  origins(): readonly string[] {
    return [...new Set([...this.entries.values()].map((entry) => entry.origin))]
  }

  /**
   * Decrypt the secret for an origin on demand. An undecryptable blob (OS
   * keychain changed, profile moved between machines) reads as absent.
   */
  secretFor(origin: string): string | undefined {
    if (!this.cipher.available()) return undefined
    for (const entry of this.entries.values()) {
      if (entry.origin !== origin) continue
      try {
        return this.cipher.decrypt(Buffer.from(entry.blob, 'base64'))
      } catch {
        continue
      }
    }
    return undefined
  }

  set(profileId: string, origin: string, secret: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.retired.has(profileId)) throw new Error('this saved connection was removed; its credential can no longer be stored')
      if (credentialOrigin(origin) !== origin) throw new Error('credential origin must be an exact http(s) origin')
      if (!this.cipher.available()) throw new Error('OS credential encryption is unavailable')
      for (const [otherId, entry] of this.entries) {
        if (otherId !== profileId && entry.origin === origin) {
          throw new Error(`another saved connection already holds a credential for ${origin}`)
        }
      }
      const blob = this.cipher.encrypt(secret).toString('base64')
      const next = new Map(this.entries)
      next.set(profileId, { origin, blob })
      await this.persist(next, this.retired)
      this.entries = next
    })
  }

  remove(profileId: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.entries.has(profileId)) return
      const next = new Map(this.entries)
      next.delete(profileId)
      await this.persist(next, this.retired)
      this.entries = next
    })
  }

  /**
   * Permanently retire a deleted connection profile: clear its credential
   * and refuse every later set for its id. Profile removal spans processes
   * (the profile list lives in renderer storage, the credential here), so a
   * set that was in flight when its profile was deleted - a crashed window's
   * late IPC, a stale window after restart - must not recreate a credential
   * that no profile can ever manage again. Tombstones persist across
   * restarts; ordinary token clearing does not retire.
   */
  retire(profileId: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.retired.has(profileId) && !this.entries.has(profileId)) return
      const nextEntries = new Map(this.entries)
      nextEntries.delete(profileId)
      const nextRetired = new Set(this.retired)
      nextRetired.add(profileId)
      await this.persist(nextEntries, nextRetired)
      this.entries = nextEntries
      this.retired = nextRetired
    })
  }

  private persist(entries: Map<string, StoredEntry>, retired: Set<string>): Promise<void> {
    const payload = {
      v: STORE_VERSION,
      entries: Object.fromEntries(entries),
      retired: [...retired].sort(),
    }
    return writeFileAtomic(this.path, `${JSON.stringify(payload, null, 2)}\n`)
  }
}
