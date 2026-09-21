import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CredentialStore, credentialOrigin, hasAuthorizationHeader, type CredentialCipher } from '../src/credential-store.js'

const temporaryDirectories: string[] = []
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

async function storePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dinkster-credentials-'))
  temporaryDirectories.push(directory)
  return join(directory, 'credentials.json')
}

/** Reversible fake standing in for safeStorage; `tag` simulates keychain identity. */
function fakeCipher(tag = 'k1', available = true): CredentialCipher {
  return {
    available: () => available,
    encrypt: (plain) => Buffer.from(`${tag}:${plain}`, 'utf8'),
    decrypt: (blob) => {
      const text = blob.toString('utf8')
      if (!text.startsWith(`${tag}:`)) throw new Error('wrong key')
      return text.slice(tag.length + 1)
    },
  }
}

describe('credentialOrigin', () => {
  it('reduces http(s) URLs to their exact origin', () => {
    expect(credentialOrigin('https://host:8443/api/x?y=1')).toBe('https://host:8443')
    expect(credentialOrigin('http://host')).toBe('http://host')
  })

  it('rejects non-http schemes, embedded credentials, and non-strings', () => {
    expect(credentialOrigin('ftp://host')).toBeUndefined()
    expect(credentialOrigin('https://user:pass@host')).toBeUndefined()
    expect(credentialOrigin('not a url')).toBeUndefined()
    expect(credentialOrigin(42)).toBeUndefined()
  })
})

describe('CredentialStore retirement', () => {
  it('clears the credential and rejects every later set for a retired profile', async () => {
    const path = await storePath()
    const store = await CredentialStore.open(path, fakeCipher())
    await store.set('cp-one', 'https://host:8443', 'token-1')
    await store.retire('cp-one')
    expect(store.list()).toEqual([])
    expect(store.secretFor('https://host:8443')).toBeUndefined()
    await expect(store.set('cp-one', 'https://host:8443', 'token-2')).rejects.toThrow('can no longer be stored')
    expect(store.list()).toEqual([])
  })

  it('keeps rejecting sets for a retired profile after reopening from disk', async () => {
    const path = await storePath()
    const first = await CredentialStore.open(path, fakeCipher())
    await first.set('cp-one', 'https://host:8443', 'token-1')
    await first.retire('cp-one')
    const second = await CredentialStore.open(path, fakeCipher())
    await expect(second.set('cp-one', 'https://host:8443', 'late')).rejects.toThrow('can no longer be stored')
    expect(second.list()).toEqual([])
    expect(second.secretFor('https://host:8443')).toBeUndefined()
  })

  it('clears a set that was queued before the retirement', async () => {
    const path = await storePath()
    const store = await CredentialStore.open(path, fakeCipher())
    const set = store.set('cp-one', 'https://host:8443', 'token-1')
    const retire = store.retire('cp-one')
    await Promise.all([set, retire])
    expect(store.list()).toEqual([])
    expect(store.secretFor('https://host:8443')).toBeUndefined()
    const reopened = await CredentialStore.open(path, fakeCipher())
    expect(reopened.list()).toEqual([])
  })

  it('drops a stored entry whose id is retired in the file', async () => {
    const path = await storePath()
    const store = await CredentialStore.open(path, fakeCipher())
    await store.set('cp-one', 'https://host:8443', 'token-1')
    const tampered = JSON.parse(await readFile(path, 'utf8')) as { retired: string[] }
    tampered.retired = ['cp-one']
    await writeFile(path, JSON.stringify(tampered))
    const reopened = await CredentialStore.open(path, fakeCipher())
    expect(reopened.list()).toEqual([])
    expect(reopened.secretFor('https://host:8443')).toBeUndefined()
  })

  it('does not retire on ordinary credential removal', async () => {
    const path = await storePath()
    const store = await CredentialStore.open(path, fakeCipher())
    await store.set('cp-one', 'https://host:8443', 'token-1')
    await store.remove('cp-one')
    await store.set('cp-one', 'https://host:8443', 'token-2')
    expect(store.secretFor('https://host:8443')).toBe('token-2')
  })
})

describe('CredentialStore', () => {
  it('round-trips a secret bound to its exact origin', async () => {
    const path = await storePath()
    const store = await CredentialStore.open(path, fakeCipher())
    await store.set('cp-one', 'https://host:8443', 'token-1')
    expect(store.list()).toEqual([{ profileId: 'cp-one', origin: 'https://host:8443' }])
    expect(store.origins()).toEqual(['https://host:8443'])
    expect(store.secretFor('https://host:8443')).toBe('token-1')
    expect(store.secretFor('https://host:9999')).toBeUndefined()
    expect(store.secretFor('http://host:8443')).toBeUndefined()
  })

  it('persists across reopen and never stores plaintext', async () => {
    const path = await storePath()
    const first = await CredentialStore.open(path, fakeCipher())
    await first.set('cp-one', 'https://host', 'secret-token')
    expect(await readFile(path, 'utf8')).not.toContain('secret-token')
    const second = await CredentialStore.open(path, fakeCipher())
    expect(second.secretFor('https://host')).toBe('secret-token')
  })

  it('rejects non-origin urls and unavailable encryption', async () => {
    const store = await CredentialStore.open(await storePath(), fakeCipher())
    await expect(store.set('cp-one', 'https://host/path', 'x')).rejects.toThrow(/origin/)
    await expect(store.set('cp-one', 'ws://host', 'x')).rejects.toThrow(/origin/)
    const locked = await CredentialStore.open(await storePath(), fakeCipher('k1', false))
    await expect(locked.set('cp-one', 'https://host', 'x')).rejects.toThrow(/unavailable/)
    expect(locked.secretFor('https://host')).toBeUndefined()
  })

  it('treats a corrupt or foreign file as empty instead of failing', async () => {
    const path = await storePath()
    await writeFile(path, '{broken')
    expect((await CredentialStore.open(path, fakeCipher())).list()).toEqual([])
    await writeFile(path, JSON.stringify({ v: 99, entries: { 'cp-x': { origin: 'https://h', blob: 'AA==' } } }))
    expect((await CredentialStore.open(path, fakeCipher())).list()).toEqual([])
    await writeFile(path, JSON.stringify({ v: 1, entries: { 'cp-x': { origin: 'https://h/path', blob: 'AA==' } } }))
    expect((await CredentialStore.open(path, fakeCipher())).list()).toEqual([])
  })

  it('reads an undecryptable blob as absent', async () => {
    const path = await storePath()
    const written = await CredentialStore.open(path, fakeCipher('old-key'))
    await written.set('cp-one', 'https://host', 'token-1')
    const reopened = await CredentialStore.open(path, fakeCipher('new-key'))
    expect(reopened.list()).toHaveLength(1)
    expect(reopened.secretFor('https://host')).toBeUndefined()
  })

  it('removes an entry and persists the removal', async () => {
    const path = await storePath()
    const store = await CredentialStore.open(path, fakeCipher())
    await store.set('cp-one', 'https://host', 'token-1')
    await store.remove('cp-one')
    expect(store.list()).toEqual([])
    await store.remove('cp-one') // absent id is a no-op
    expect((await CredentialStore.open(path, fakeCipher())).list()).toEqual([])
  })

  it('rejects a second profile credential for an occupied origin', async () => {
    const store = await CredentialStore.open(await storePath(), fakeCipher())
    await store.set('cp-one', 'https://host', 'token-1')
    await expect(store.set('cp-two', 'https://host', 'token-2')).rejects.toThrow(/already holds/)
    expect(store.secretFor('https://host')).toBe('token-1')
    await store.set('cp-one', 'https://host', 'token-3') // the holder may rotate its own token
    expect(store.secretFor('https://host')).toBe('token-3')
    await store.remove('cp-one')
    await store.set('cp-two', 'https://host', 'token-2') // freed origin is claimable again
    expect(store.secretFor('https://host')).toBe('token-2')
  })

  it('fails closed when a persisted file holds duplicate-origin credentials', async () => {
    const path = await storePath()
    const cipher = fakeCipher()
    const blob = cipher.encrypt('token').toString('base64')
    await writeFile(path, JSON.stringify({ v: 1, entries: {
      'cp-one': { origin: 'https://dup', blob },
      'cp-two': { origin: 'https://dup', blob },
      'cp-three': { origin: 'https://other', blob },
    } }))
    const store = await CredentialStore.open(path, cipher)
    expect(store.secretFor('https://dup')).toBeUndefined()
    expect(store.list()).toEqual([{ profileId: 'cp-three', origin: 'https://other' }])
  })

  it('serializes concurrent mutations so none are lost', async () => {
    const path = await storePath()
    const store = await CredentialStore.open(path, fakeCipher())
    await Promise.all([
      store.set('cp-one', 'https://a', 'token-a'),
      store.set('cp-two', 'https://b', 'token-b'),
      store.set('cp-three', 'https://c', 'token-c'),
      store.remove('cp-missing'),
    ])
    expect(store.list()).toHaveLength(3)
    const reopened = await CredentialStore.open(path, fakeCipher())
    expect(reopened.secretFor('https://a')).toBe('token-a')
    expect(reopened.secretFor('https://b')).toBe('token-b')
    expect(reopened.secretFor('https://c')).toBe('token-c')
  })

  it('continues accepting mutations after a failed one', async () => {
    const store = await CredentialStore.open(await storePath(), fakeCipher())
    await expect(store.set('cp-bad', 'https://host/path', 'x')).rejects.toThrow(/origin/)
    await store.set('cp-good', 'https://host', 'token')
    expect(store.secretFor('https://host')).toBe('token')
  })
})

describe('hasAuthorizationHeader', () => {
  it('matches the Authorization header in any casing', () => {
    expect(hasAuthorizationHeader({ Authorization: 'Bearer x' })).toBe(true)
    expect(hasAuthorizationHeader({ authorization: 'Bearer x' })).toBe(true)
    expect(hasAuthorizationHeader({ AUTHORIZATION: 'Bearer x' })).toBe(true)
    expect(hasAuthorizationHeader({ 'Content-Type': 'application/json' })).toBe(false)
    expect(hasAuthorizationHeader({})).toBe(false)
  })
})
