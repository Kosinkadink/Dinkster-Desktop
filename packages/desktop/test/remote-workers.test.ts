import { mkdtemp, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeFileAtomic } from '../src/atomic-file.js'
import {
  listRemoteWorkers,
  RemoteWorkerFileGrants,
  RemoteWorkerLifecycle,
  removeRemoteWorker,
  saveRemoteWorker,
} from '../src/remote-workers.js'
import { LifecycleQueue } from '../src/lifecycle-queue.js'

const fsHooks = vi.hoisted((): {
  beforeLink?: (oldPath: string, newPath: string) => Promise<void>
  afterLink?: (oldPath: string, newPath: string) => Promise<void>
  afterReadFile?: (path: string) => Promise<void>
  beforeStat?: (path: string) => void
} => ({}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: async (path: string, encoding?: BufferEncoding) => {
      const contents = encoding === undefined
        ? await actual.readFile(path)
        : await actual.readFile(path, encoding)
      await fsHooks.afterReadFile?.(path)
      return contents
    },
    link: async (oldPath: string, newPath: string): Promise<void> => {
      if (fsHooks.beforeLink) {
        const hook = fsHooks.beforeLink
        fsHooks.beforeLink = undefined
        await hook(oldPath, newPath)
      }
      await actual.link(oldPath, newPath)
      if (fsHooks.afterLink) {
        const hook = fsHooks.afterLink
        fsHooks.afterLink = undefined
        await hook(oldPath, newPath)
      }
    },
    stat: async (path: string) => {
      fsHooks.beforeStat?.(path)
      return actual.stat(path)
    },
  }
})

const roots: string[] = []

afterEach(async () => {
  fsHooks.beforeLink = undefined
  fsHooks.afterLink = undefined
  fsHooks.afterReadFile = undefined
  fsHooks.beforeStat = undefined
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ data: string; token: string; ca: string; config: string }> {
  const data = await mkdtemp(join(tmpdir(), 'dinkster-remotes-test-'))
  roots.push(data)
  const secrets = join(data, 'secrets')
  const config = join(data, 'library', 'remotes.toml')
  const token = join(secrets, 'worker.token')
  const ca = join(secrets, 'worker.pem')
  await mkdir(join(data, 'library'), { recursive: true })
  await mkdir(secrets)
  await writeFile(token, 'TOKEN_CONTENT_NEVER_EXPOSED')
  await writeFile(ca, 'certificate')
  return { data, token, ca, config }
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

async function artifactPaths(path: string, suffix: '.backup' | '.candidate'): Promise<string[]> {
  const prefix = `${basename(path)}.`
  return (await readdir(dirname(path)))
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(suffix))
    .map((entry) => join(dirname(path), entry))
    .sort()
}

const backupPaths = (path: string): Promise<string[]> => artifactPaths(path, '.backup')
const candidatePaths = (path: string): Promise<string[]> => artifactPaths(path, '.candidate')

describe('desktop remote-worker configuration', () => {
  it('creates and lists a complete worker profile without exposing token contents', async () => {
    const { data, token, ca, config } = await fixture()
    await saveRemoteWorker(data, {
      name: 'render-box',
      endpoint: 'render.example.test:5151',
      tokenFile: token,
      tlsCaFile: ca,
      nodes: ['sampler.custom', 'image.decode'],
      memory: [{ device: 'ram', size: '24G' }, { device: 'vram:cuda:0', size: '21474836480' }],
    })
    const source = await readFile(config, 'utf8')
    expect(source).toContain('[worker.render-box]')
    expect(source).toContain('[worker.render-box.memory]')
    expect(source).toContain(`token_file = ${tomlString(token)}`)
    expect(source).toContain(`tls_ca_file = ${tomlString(ca)}`)
    expect(source).not.toContain('TOKEN_CONTENT_NEVER_EXPOSED')
    await expect(listRemoteWorkers(data)).resolves.toEqual([{
      name: 'render-box',
      endpoint: 'render.example.test:5151',
      tokenFile: token,
      tlsCaFile: ca,
      nodes: ['sampler.custom', 'image.decode'],
      memory: [{ device: 'ram', size: '24G' }, { device: 'vram:cuda:0', size: '21474836480' }],
    }])
  })

  it('preserves an explicit empty node allowlist', async () => {
    const { data, token, config } = await fixture()
    await writeFile(config, '[worker.render-box]\n'
      + 'endpoint = "render.example.test:5151"\n'
      + `token_file = ${tomlString(token)}\n`
      + 'nodes = []\n')
    const [worker] = await listRemoteWorkers(data)
    expect(worker?.nodes).toEqual([])

    await saveRemoteWorker(data, { ...worker!, endpoint: 'updated.example.test:5252' })

    await expect(readFile(config, 'utf8')).resolves.toContain('nodes = []')
    await expect(listRemoteWorkers(data)).resolves.toMatchObject([{ nodes: [] }])
  })

  it('preserves comments, formatting, other profiles, and trust_reserved while editing', async () => {
    const { data, token, config } = await fixture()
    const otherToken = join(data, 'secrets', 'other.token')
    await writeFile(otherToken, 'other')
    await writeFile(config, [
      '# Hand-managed worker inventory',
      '[worker.render-box]',
      `endpoint    = "old.example.test:5151" # keep endpoint note`,
      `token_file = ${tomlString(token)}`,
      'trust_reserved = true # advanced operator setting',
      '',
      '[worker.other-box]',
      'endpoint = "other.example.test:5151"',
      `token_file = ${tomlString(otherToken)}`,
      '',
    ].join('\n'))

    await saveRemoteWorker(data, {
      name: 'render-box',
      endpoint: 'new.example.test:5252',
      tokenFile: token,
      memory: [],
    })
    const source = await readFile(config, 'utf8')
    expect(source).toContain('# Hand-managed worker inventory')
    expect(source).toContain('endpoint    = "new.example.test:5252" # keep endpoint note')
    expect(source).toContain('trust_reserved = true # advanced operator setting')
    expect(source).toContain('[worker.other-box]')
  })

  it('removes only the selected profile and its owned comments', async () => {
    const { data, token, config } = await fixture()
    await writeFile(config, [
      '# Inventory heading',
      '',
      '# Remove with render-box',
      '[worker.render-box]',
      'endpoint = "render.example.test:5151"',
      `token_file = ${tomlString(token)}`,
      '',
      '[worker.keep-box]',
      'endpoint = "keep.example.test:5151"',
      `token_file = ${tomlString(token)}`,
      '',
    ].join('\n'))
    await removeRemoteWorker(data, 'render-box')
    const source = await readFile(config, 'utf8')
    expect(source).toContain('# Inventory heading')
    expect(source).not.toContain('render-box')
    expect(source).toContain('[worker.keep-box]')
  })

  it('preserves every byte outside the removed worker tables', async () => {
    const { data, token, config } = await fixture()
    const prefix = '# Inventory heading\r\n[worker.before-box]\r\n'
      + 'endpoint = "before.example.test:5151"\r\n'
      + `token_file = ${tomlString(token)}\r\n\r\n`
    const removed = [
      '# Remove with render-box',
      '[worker.render-box]',
      'endpoint = "render.example.test:5151"',
      `token_file = ${tomlString(token)}`,
      '',
      '[worker.render-box.memory]',
      'ram = "24G"',
    ].join('\r\n') + '\r\n'
    const suffix = '\r\n# Keep comment\r\n[worker.keep-box]\r\n'
      + 'endpoint = "keep.example.test:5151"\r\n'
      + `token_file = ${tomlString(token)}\r\n`
    await writeFile(config, prefix + removed + suffix)

    await removeRemoteWorker(data, 'render-box')

    await expect(readFile(config, 'utf8')).resolves.toBe(prefix + '\r\n' + suffix)
  })

  it('rejects a replacement when a manual edit wins the race to commit', async () => {
    const { config } = await fixture()
    const original = '# Original\n'
    const manual = '# Manual edit\n'
    await writeFile(config, original)
    await writeFile(config, manual)

    await expect(writeFileAtomic(config, '# Desktop edit\n', original)).rejects.toThrow('changed while it was being edited')
    await expect(readFile(config, 'utf8')).resolves.toBe(manual)
    const backups = await backupPaths(config)
    expect(backups).toHaveLength(1)
    await expect(readFile(backups[0]!, 'utf8')).resolves.toBe(manual)
  })

  it('preserves an in-place manual edit that lands during the atomic replacement', async () => {
    const { config } = await fixture()
    const original = '# Original\n'
    const manual = '# Manual in-place edit during replacement\n'
    await writeFile(config, original)
    const manualHandle = await open(config, 'r+')
    fsHooks.beforeLink = async (_temporary, destination) => {
      if (destination !== config) return
      await manualHandle.truncate(0)
      await manualHandle.writeFile(manual)
    }

    try {
      await expect(writeFileAtomic(config, '# Desktop edit\n', original)).rejects.toThrow('changed while it was being edited')
    } finally {
      await manualHandle.close()
    }
    await expect(readFile(config, 'utf8')).resolves.toBe('# Desktop edit\n')
    const backups = await backupPaths(config)
    expect(backups).toHaveLength(1)
    await expect(readFile(backups[0]!, 'utf8')).resolves.toBe(manual)
  })

  it('does not overwrite an editor atomic save during the replacement', async () => {
    const { config } = await fixture()
    const original = '# Original\n'
    const manual = '# Manual atomic save during replacement\n'
    const manualTemp = `${config}.editor`
    await writeFile(config, original)
    await writeFile(manualTemp, manual)
    fsHooks.beforeLink = async (_temporary, destination) => {
      if (destination === config) await rename(manualTemp, config)
    }

    await expect(writeFileAtomic(config, '# Desktop edit\n', original)).rejects.toThrow('changed while it was being edited')
    await expect(readFile(config, 'utf8')).resolves.toBe(manual)
    const backups = await backupPaths(config)
    expect(backups).toHaveLength(1)
    await expect(readFile(backups[0]!, 'utf8')).resolves.toBe(original)
  })

  it('reports a conflict when an editor replaces the linked Desktop candidate', async () => {
    const { config } = await fixture()
    const original = '# Original\n'
    const desktop = '# Desktop edit\n'
    const manual = '# Manual atomic save after link\n'
    const manualTemp = `${config}.editor`
    await writeFile(config, original)
    await writeFile(manualTemp, manual)
    fsHooks.afterLink = async (_temporary, destination) => {
      if (destination === config) await rename(manualTemp, config)
    }

    await expect(writeFileAtomic(config, desktop, original)).rejects.toThrow('conflicting copy was kept')
    await expect(readFile(config, 'utf8')).resolves.toBe(manual)
    const backups = await backupPaths(config)
    expect(backups).toHaveLength(1)
    await expect(readFile(backups[0]!, 'utf8')).resolves.toBe(original)
    const candidates = await candidatePaths(config)
    expect(candidates).toHaveLength(1)
    await expect(readFile(candidates[0]!, 'utf8')).resolves.toBe(desktop)
  })

  it('preserves both late in-place bytes and a later editor atomic save', async () => {
    const { config } = await fixture()
    const original = '# Original\n'
    const inPlace = '# Late in-place edit\n'
    const atomic = '# Later editor atomic save\n'
    const editorTemp = `${config}.editor`
    await writeFile(config, original)
    await writeFile(editorTemp, atomic)
    const manualHandle = await open(config, 'r+')
    fsHooks.afterLink = async (_temporary, destination) => {
      if (destination !== config) return
      await manualHandle.truncate(0)
      await manualHandle.writeFile(inPlace)
      await rename(editorTemp, config)
    }

    try {
      await expect(writeFileAtomic(config, '# Desktop edit\n', original)).rejects.toThrow('conflicting copy was kept')
    } finally {
      await manualHandle.close()
    }
    await expect(readFile(config, 'utf8')).resolves.toBe(atomic)
    const backups = await backupPaths(config)
    expect(backups).toHaveLength(1)
    await expect(readFile(backups[0]!, 'utf8')).resolves.toBe(inPlace)
    const candidates = await candidatePaths(config)
    expect(candidates).toHaveLength(1)
    await expect(readFile(candidates[0]!, 'utf8')).resolves.toBe('# Desktop edit\n')
  })

  it('keeps the claimed inode named for writes through an old descriptor after success', async () => {
    const { config } = await fixture()
    const original = '# Original\n'
    const manual = '# In-place edit after Desktop returns\n'
    await writeFile(config, original)
    const manualHandle = await open(config, 'r+')

    await writeFileAtomic(config, '# Desktop edit\n', original)
    await manualHandle.truncate(0)
    await manualHandle.writeFile(manual)
    await manualHandle.close()

    await expect(readFile(config, 'utf8')).resolves.toBe('# Desktop edit\n')
    const backups = await backupPaths(config)
    expect(backups).toHaveLength(1)
    await expect(readFile(backups[0]!, 'utf8')).resolves.toBe(manual)
  })

  it('keeps the Desktop candidate named through a later editor atomic save', async () => {
    const { config } = await fixture()
    const original = '# Original\n'
    const desktop = '# Desktop edit\n'
    const manual = '# Editor save after Desktop returns\n'
    const manualTemp = `${config}.editor`
    await writeFile(config, original)

    await writeFileAtomic(config, desktop, original)
    await writeFile(manualTemp, manual)
    await rename(manualTemp, config)

    await expect(readFile(config, 'utf8')).resolves.toBe(manual)
    const candidates = await candidatePaths(config)
    expect(candidates).toHaveLength(1)
    await expect(readFile(candidates[0]!, 'utf8')).resolves.toBe(desktop)
  })

  it('keeps a concurrent list behind an active save claim', async () => {
    const { data, token, config } = await fixture()
    const original = '[worker.render-box]\n'
      + 'endpoint = "old.example.test:5151"\n'
      + `token_file = ${tomlString(token)}\n`
    await writeFile(config, original)
    const queue = new LifecycleQueue()
    const restart = vi.fn(async () => {})
    const grants = new RemoteWorkerFileGrants()
    const lifecycle = new RemoteWorkerLifecycle(
      data,
      grants,
      (action) => queue.run(action),
      () => {},
      restart,
    )
    let concurrentList: Promise<readonly { readonly endpoint: string }[]> | undefined
    fsHooks.afterLink = async (_temporary, destination) => {
      if (destination !== config) return
      fsHooks.beforeStat = (path) => {
        if (path === config) throw new Error('list entered recovery during an active save')
      }
      concurrentList = lifecycle.list()
      fsHooks.beforeStat = undefined
    }

    await expect(lifecycle.save('primary', {
      name: 'render-box', endpoint: 'new.example.test:5252', tokenFile: token, memory: [],
      tokenFileGrant: grants.issue('primary', 'token', token).grant,
    })).resolves.toBeUndefined()
    expect(restart).toHaveBeenCalledOnce()
    await expect(concurrentList).resolves.toMatchObject([{ endpoint: 'new.example.test:5252' }])
    await expect(readFile(config, 'utf8')).resolves.toContain('endpoint = "new.example.test:5252"')
    expect(await backupPaths(config)).toHaveLength(1)
  })

  it('binds path authorization and the write to one source snapshot', async () => {
    const { data, token, config } = await fixture()
    const replacementToken = join(data, 'secrets', 'replacement.token')
    await writeFile(replacementToken, 'replacement')
    const original = '[worker.render-box]\n'
      + 'endpoint = "old.example.test:5151"\n'
      + `token_file = ${tomlString(token)}\n`
    const editor = '[worker.render-box]\n'
      + 'endpoint = "editor.example.test:5252"\n'
      + `token_file = ${tomlString(replacementToken)}\n`
    await writeFile(config, original)
    const restart = vi.fn(async () => {})
    const queue = new LifecycleQueue()
    const lifecycle = new RemoteWorkerLifecycle(
      data,
      new RemoteWorkerFileGrants(),
      (action) => queue.run(action),
      () => {},
      restart,
    )
    fsHooks.afterReadFile = async (path) => {
      if (path !== config) return
      fsHooks.afterReadFile = undefined
      await writeFile(config, editor)
    }

    await expect(lifecycle.save('primary', {
      name: 'render-box', endpoint: 'old.example.test:5151', tokenFile: token, memory: [],
    })).rejects.toThrow('changed while it was being edited')
    await expect(readFile(config, 'utf8')).resolves.toBe(editor)
    expect(restart).not.toHaveBeenCalled()
  })

  it('checks engine compatibility after queued save and remove operations start', async () => {
    const { data, token, config } = await fixture()
    const source = '[worker.render-box]\n'
      + 'endpoint = "worker.example.test:5151"\n'
      + `token_file = ${tomlString(token)}\n`
    await writeFile(config, source)
    const queue = new LifecycleQueue()
    let compatible = true
    const restart = vi.fn(async () => {})
    const lifecycle = new RemoteWorkerLifecycle(
      data,
      new RemoteWorkerFileGrants(),
      (action) => queue.run(action),
      () => {
        if (!compatible) throw new Error('restore the packaged engine')
      },
      restart,
    )
    let release!: () => void
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => { started = resolve })
    const blocked = queue.run(async () => {
      started()
      await new Promise<void>((resolve) => { release = resolve })
    })
    await startedPromise
    const saving = lifecycle.save('primary', {
      name: 'render-box', endpoint: 'worker.example.test:5151', tokenFile: token, nodes: [], memory: [],
    })
    const removing = lifecycle.remove('render-box')
    compatible = false
    release()
    await blocked

    await expect(saving).rejects.toThrow('restore the packaged engine')
    await expect(removing).rejects.toThrow('restore the packaged engine')
    await expect(readFile(config, 'utf8')).resolves.toBe(source)
    expect(restart).not.toHaveBeenCalled()
  })

  it('recovers the claimed file after an interrupted conditional replacement', async () => {
    const { data, token, config } = await fixture()
    const previous = `${config}.00000000-0000-4000-8000-000000000000.previous`
    const backup = `${config}.00000000-0000-4000-8000-000000000000.backup`
    const source = '[worker.render-box]\n'
      + 'endpoint = "worker.example.test:5151"\n'
      + `token_file = ${tomlString(token)}\n`
    await writeFile(previous, source)

    await expect(listRemoteWorkers(data)).resolves.toEqual([{
      name: 'render-box', endpoint: 'worker.example.test:5151', tokenFile: token, memory: [],
    }])
    await expect(readFile(config, 'utf8')).resolves.toBe(source)
    await expect(readFile(previous, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(backup, 'utf8')).resolves.toBe(source)
  })

  it('retires an interrupted claim without overwriting an existing path', async () => {
    const { data, config } = await fixture()
    const previous = `${config}.00000000-0000-4000-8000-000000000000.previous`
    const backup = `${config}.00000000-0000-4000-8000-000000000000.backup`
    const current = '# Editor atomic save\n'
    const claimed = '# Claimed original\n'
    await writeFile(config, current)
    await writeFile(previous, claimed)

    await expect(listRemoteWorkers(data)).resolves.toEqual([])
    await expect(readFile(config, 'utf8')).resolves.toBe(current)
    await expect(readFile(previous, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(backup, 'utf8')).resolves.toBe(claimed)
  })

  it('authorizes new credential paths only with sender-bound picker grants', () => {
    const grants = new RemoteWorkerFileGrants()
    const token = grants.issue('primary', 'token', '/secrets/worker.token')
    const worker = {
      name: 'render-box', endpoint: 'worker.test:5151', tokenFile: token.path, memory: [],
    }
    expect(() => grants.authorize('other-window', { ...worker, tokenFileGrant: token.grant }, [])).toThrow('no longer authorized')
    expect(() => grants.authorize('primary', { ...worker, tokenFile: '/secrets/other', tokenFileGrant: token.grant }, [])).toThrow('no longer authorized')
    expect(() => grants.authorize('primary', {
      ...worker, tokenFile: '/secrets/worker.pem', tokenFileGrant: grants.issue('primary', 'tls-ca', '/secrets/worker.pem').grant,
    }, [])).toThrow('no longer authorized')
    const replacement = grants.issue('primary', 'token', token.path)
    const authorized = grants.authorize('primary', { ...worker, tokenFileGrant: replacement.grant }, [])
    expect(authorized.worker).toEqual(worker)
    grants.consume(authorized.grants)
    expect(() => grants.authorize('primary', { ...worker, tokenFileGrant: replacement.grant }, [])).toThrow('no longer authorized')
    expect(grants.authorize('primary', worker, [worker]).grants).toEqual([])

    const stored = { ...worker, endpoint: 'trusted.test:5151', tlsCaFile: '/secrets/worker.pem' }
    expect(() => grants.authorize('primary', {
      ...stored,
      endpoint: 'attacker.test:5151',
      tlsCaFile: undefined,
    }, [stored])).toThrow('Choose the token file again')
    const retargetGrant = grants.issue('primary', 'token', stored.tokenFile)
    expect(grants.authorize('primary', {
      ...stored,
      endpoint: 'replacement.test:5151',
      tlsCaFile: undefined,
      tokenFileGrant: retargetGrant.grant,
    }, [stored]).grants).toEqual([retargetGrant.grant])

    const secureTokenGrant = grants.issue('primary', 'token', stored.tokenFile)
    expect(() => grants.authorize('primary', {
      ...stored,
      endpoint: 'secure-replacement.test:5151',
      tokenFileGrant: secureTokenGrant.grant,
    }, [stored])).toThrow('Choose the TLS certificate or CA file again')
    const secureTlsGrant = grants.issue('primary', 'tls-ca', stored.tlsCaFile)
    expect(grants.authorize('primary', {
      ...stored,
      endpoint: 'secure-replacement.test:5151',
      tokenFileGrant: secureTokenGrant.grant,
      tlsCaFileGrant: secureTlsGrant.grant,
    }, [stored]).grants).toEqual([secureTokenGrant.grant, secureTlsGrant.grant])
  })

  it('refuses malformed files and invalid or unreadable edits without replacing the file', async () => {
    const { data, token, config } = await fixture()
    const malformed = '[worker.box]\nendpoint = "missing-port"\ntoken_file = "/missing"\n'
    await writeFile(config, malformed)
    await expect(saveRemoteWorker(data, {
      name: 'box', endpoint: 'host:5151', tokenFile: token, memory: [],
    })).rejects.toThrow('Cannot manage remotes.toml')
    await expect(readFile(config, 'utf8')).resolves.toBe(malformed)

    await rm(config)
    await expect(saveRemoteWorker(data, {
      name: 'local', endpoint: 'host:5151', tokenFile: token, memory: [],
    })).rejects.toThrow('reserved')
    await expect(saveRemoteWorker(data, {
      name: 'box', endpoint: 'host:70000', tokenFile: token, memory: [],
    })).rejects.toThrow('1 to 65535')
    await expect(saveRemoteWorker(data, {
      name: 'box', endpoint: 'host:5151', tokenFile: join(data, 'missing'), memory: [],
    })).rejects.toThrow('cannot be read')
  })

  it('matches backend Unicode whitespace rules for raw worker and memory names', async () => {
    const { data, token, config } = await fixture()
    for (const whitespace of ['\u00a0', '\u0085', '\u001c']) {
      await expect(saveRemoteWorker(data, {
        name: `${whitespace}box`, endpoint: 'host:5151', tokenFile: token, memory: [],
      })).rejects.toThrow('worker names')
      await expect(saveRemoteWorker(data, {
        name: 'box', endpoint: 'host:5151', tokenFile: token,
        memory: [{ device: `${whitespace}ram`, size: '1G' }],
      })).rejects.toThrow('memory device names')
    }

    await writeFile(config, '[worker."box\\u0085evil"]\n'
      + 'endpoint = "host:5151"\n'
      + `token_file = ${tomlString(token)}\n`)
    await expect(listRemoteWorkers(data)).rejects.toThrow('worker names')
    await writeFile(config, '[worker.box]\n'
      + 'endpoint = "host:5151"\n'
      + `token_file = ${tomlString(token)}\n`
      + '[worker.box.memory]\n'
      + '"ram\\u0085evil" = "1G"\n')
    await expect(listRemoteWorkers(data)).rejects.toThrow('memory device names')

    await rm(config)
    await saveRemoteWorker(data, {
      name: '\uFEFFbox\uFEFF', endpoint: 'host:5151', tokenFile: token,
      memory: [{ device: '\uFEFFram\uFEFF', size: '1G' }, { device: '\uFEFF', size: '2G' }],
    })
    await expect(listRemoteWorkers(data)).resolves.toMatchObject([{
      name: '\uFEFFbox\uFEFF',
      memory: [{ device: '\uFEFFram\uFEFF', size: '1G' }, { device: '\uFEFF', size: '2G' }],
    }])
  })

  it('handles prototype-sensitive profile and memory names without object pollution', async () => {
    const { data, token } = await fixture()
    await saveRemoteWorker(data, {
      name: '__proto__', endpoint: 'host:5151', tokenFile: token,
      memory: [{ device: 'constructor', size: '1G' }],
    })
    await expect(listRemoteWorkers(data)).resolves.toEqual([{
      name: '__proto__', endpoint: 'host:5151', tokenFile: token,
      memory: [{ device: 'constructor', size: '1G' }],
    }])
    expect(Object.prototype).not.toHaveProperty('endpoint')
  })
})
