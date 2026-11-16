import { createHash, createPublicKey, verify } from 'node:crypto'

// Trust roots are provisioned independently of mirrors and channel contents.
const CHANNEL_KEYS: Readonly<Record<string, string>> = {
  'sha256:4b5b2c78b32db1ebedc4702a92d6e4e252c17531f0e102ab82dd910be6dec7b9': 'm6rm7XY806I6eifUgiElbaK4nYkWQlDU+WjdsH8Eb9Q='
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function string(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** The same ASCII sorted compact JSON used by signed release security notices. */
function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'string') return string(value)
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (object(value)) {
    const keys = Object.keys(value).sort((left, right) => {
      const a = Array.from(left, (character) => character.codePointAt(0)!)
      const b = Array.from(right, (character) => character.codePointAt(0)!)
      for (let index = 0; index < Math.min(a.length, b.length); index++) {
        if (a[index] !== b[index]) return a[index]! - b[index]!
      }
      return a.length - b.length
    })
    return `{${keys.map((key) => `${string(key)}:${canonical(value[key])}`).join(',')}}`
  }
  throw new Error('channel JSON requires strings, booleans and safe integers')
}

function decode(value: unknown, size: number): Buffer {
  if (typeof value !== 'string') throw new Error('invalid signing bytes')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length !== size || bytes.toString('base64') !== value) throw new Error('signing bytes require canonical base64')
  return bytes
}

export function verifyChannel(text: string, channel: string, keys: Readonly<Record<string, string>> = CHANNEL_KEYS): Record<string, unknown> {
  const envelope: unknown = JSON.parse(text)
  if (!object(envelope) || Object.keys(envelope).sort().join(',') !== 'signatures,signed'
    || !object(envelope['signed']) || !Array.isArray(envelope['signatures']) || envelope['signatures'].length === 0) throw new Error('invalid signed channel envelope')
  // Exact canonical transport rejects duplicate fields instead of accepting
  // whichever duplicate JSON.parse happened to retain.
  if (canonical(envelope) !== text) throw new Error('channel envelope must use canonical ASCII JSON')
  const payload = envelope['signed']
  if (!['stable', 'nightly'].includes(channel) || payload['format'] !== 'dinkster.channel/1'
    || payload['channel'] !== channel || Object.hasOwn(payload, 'signature')) throw new Error('signed channel format or requested channel differs')
  const message = Buffer.from(canonical(payload), 'ascii')
  const seen = new Set<string>()
  let authenticated = false
  for (const row of envelope['signatures']) {
    if (!object(row) || Object.keys(row).sort().join(',') !== 'keyId,signature'
      || typeof row['keyId'] !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(row['keyId'])
      || seen.has(row['keyId'])) throw new Error('invalid or repeated channel signer')
    seen.add(row['keyId'])
    const signature = decode(row['signature'], 64)
    if (!Object.hasOwn(keys, row['keyId'])) continue
    const publicBytes = decode(keys[row['keyId']], 32)
    if (`sha256:${createHash('sha256').update(publicBytes).digest('hex')}` !== row['keyId']) throw new Error('pinned signing key identity differs')
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicBytes]), type: 'spki', format: 'der' })
    if (verify(null, message, key, signature)) authenticated = true
  }
  if (!authenticated) throw new Error('no valid independently trusted channel signature')
  return payload
}
