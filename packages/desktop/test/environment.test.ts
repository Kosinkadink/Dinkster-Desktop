import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EnvironmentClient, parseDevelopmentSources, type EnvironmentOperation, type EnvironmentRequest } from '../src/environment.js'
import { channelTools } from '../src/environment-channel.js'
import { acquireEnvironmentTools } from '../src/environment-tools.js'

const trustedChannelKeys = vi.hoisted(() => ({} as Record<string, string>))
vi.mock('../src/channel-signatures.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/channel-signatures.js')>()
  return { ...actual, verifyChannel: (text: string, channel: string) => actual.verifyChannel(text, channel, trustedChannelKeys) }
})
const signingKey = generateKeyPairSync('ed25519')
const publicBytes = signingKey.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
const keyId = `sha256:${createHash('sha256').update(publicBytes).digest('hex')}`
trustedChannelKeys[keyId] = publicBytes.toString('base64')

function channelFixture(document: Record<string, unknown>, channel = 'nightly', privateKey = signingKey.privateKey): string {
  // Fixtures use ASCII fields; the cross-language fixture covers Unicode ordering.
  function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
    return JSON.stringify(value)
  }
  const signed = { ...document, channel }
  return canonical({ signed, signatures: [{ keyId, signature: sign(null, Buffer.from(canonical(signed)), privateKey).toString('base64') }] })
}

const roots: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

function nativeToolsName(): string {
  const os = { win32: 'windows', linux: 'linux', darwin: 'macos' }[process.platform as 'win32' | 'linux' | 'darwin']
  return `dinkster-tools-${os}-${process.arch === 'x64' ? 'x86_64' : 'arm64'}.zip`
}

function toolsArtifacts(row: { name: string; size: number; sha256: string }): typeof row[] {
  return ['linux-x86_64', 'windows-x86_64', 'macos-arm64'].map((platform) => ({ ...row, name: `dinkster-tools-${platform}.zip` }))
}

function independentManifest(artifacts: { name: string; size: number; sha256: string }[], overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: 'dinkster.tools/1',
    repository: 'Kosinkadink/Dinkster',
    commit: 'a'.repeat(40),
    version: '1.2.3',
    builtAt: '2026-11-05T18:36:00Z',
    label: '2026-11-05-1.2.3',
    artifacts,
    ...overrides,
  })
}

async function commandFixture(): Promise<{ root: string; client: EnvironmentClient }> {
  const root = await mkdtemp(join(tmpdir(), 'desktop-env-'))
  roots.push(root)
  const script = join(root, 'command.cjs')
  await writeFile(script, `
    const fs = require('node:fs'); const path = require('node:path');
    const args = process.argv.slice(2);
    const root = args[args.indexOf('--root') + 1]; const operation = args[args.indexOf('--root') + 2];
    fs.writeFileSync(path.join(root, 'arguments.json'), JSON.stringify(args));
    fs.writeFileSync(path.join(root, 'services.txt'), process.env.DINKSTER_SERVICES);
    const error = args.includes('--repair') ? 'generation drift needs offline repair' : undefined;
    console.log(JSON.stringify({format:'dinkster.environment-result/1',operation,
      status:error ? 'error' : args.includes('--plan') ? 'planned' : operation === 'doctor' ? 'clean' : 'applied',
      root, current: 2, plan: ['reuse the shared wheel store'],
      url: operation === 'update' ? 'http://127.0.0.1:44002' : 'http://127.0.0.1:44001',
      engines: [{name:'main',generation:2,state:operation === 'stop' ? 'stopped' : 'ready',
        url:operation === 'update' ? 'http://127.0.0.1:44002' : 'http://127.0.0.1:44001'}], ...(error ? {error} : {})}));
    if (error) process.exitCode = 1;
  `)
  return { root, client: new EnvironmentClient(process.execPath, [script]) }
}

describe('Desktop dinkster-env command client', () => {
  it('reads library pages without activation flags and rejects malformed pages', async () => {
    const { root, client } = await commandFixture()
    const script = join(root, 'command.cjs')
    const original = await readFile(script, 'utf8')
    const response = original.replace("status:error ? 'error' :", "status:operation === 'library-list' ? 'clean' : error ? 'error' :")
      .replace('root, current: 2,', 'root, current: 2, library: {kind:"workflows",records:[{id:"first"}],cursor:"-opaque"},')
    await writeFile(script, response)
    expect((await client.run({ root, operation: 'library-list', libraryKind: 'workflows', libraryProject: 'second', libraryCursor: '-opaque', libraryLimit: 2 })).library).toEqual({ kind: 'workflows', records: [{ id: 'first' }], cursor: '-opaque' })
    expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual(['--root', root, 'library-list', 'workflows', '--project', 'second', '--limit', '2', '--cursor=-opaque', '--json'])
    await expect(client.run({ root, operation: 'library-list', libraryKind: 'assets', repair: true })).rejects.toThrow('read-only')
    await expect(client.run({ root, operation: 'library-list', libraryKind: 'projects' }, true)).rejects.toThrow('read-only')
    await expect(client.run({ root, operation: 'library-list', libraryKind: 'assets', libraryLimit: 201 })).rejects.toThrow('page size')
    await expect(client.run({ root, operation: 'start', libraryKind: 'projects' })).rejects.toThrow('require library-list')
    for (const page of [{ kind: 'workflows', records: [], cursor: 4 }, { kind: 'workflows', cursor: null }, { kind: 'wrong', records: [], cursor: null }]) {
      await writeFile(script, response.replace('{kind:"workflows",records:[{id:"first"}],cursor:"-opaque"}', JSON.stringify(page)))
      await expect(client.run({ root, operation: 'library-list', libraryKind: 'workflows' })).rejects.toThrow('library list response')
    }
    await client.dispose()
  })

  it('reads authoritative project candidates and requires reviewed selection before mutation', async () => {
    const { root, client } = await commandFixture()
    const script = join(root, 'command.cjs')
    const original = await readFile(script, 'utf8')
    const project = { id: 'film', uid: 'film-global', name: 'Film', revision: 7, deleted: false,
      environment: { id: 'a'.repeat(32), lastSnapshot: null, lastRunAt: null } }
    const response = original.replace("status:error ? 'error' :", "status:['project-get','project-check'].includes(operation) ? 'clean' : error ? 'error' :")
      .replace('root, current: 2,', `root, current: 2, project: ${JSON.stringify(project)}, environment:{id:'${'a'.repeat(32)}',snapshot:'2'},`)
    await writeFile(script, response)
    for (const operation of ['project-get', 'project-check'] as const) {
      expect((await client.run({ root, operation, libraryProject: 'film' })).project).toEqual(project)
      expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual(['--root', root, operation, 'film', '--json'])
      await expect(client.run({ root, operation, libraryProject: 'film' }, true)).rejects.toThrow('project queries')
    }
    const request = { root, operation: 'project-select' as const, libraryProject: 'film', projectRevision: 7 }
    expect((await client.run(request)).status).toBe('planned')
    expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual(['--root', root, 'project-select', 'film', '--revision', '7', '--plan', '--json'])
    expect((await client.run(request, true)).project).toEqual(project)
    expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual(['--root', root, 'project-select', 'film', '--revision', '7', '--yes', '--json'])
    await expect(client.run({ root, operation: 'project-select', libraryProject: 'film' }, true)).rejects.toThrow('observed revision')
    await expect(client.run({ root, operation: 'project-get', libraryProject: '../film' })).rejects.toThrow('invalid library project')
    await expect(client.run({ ...request, port: 9999 }, true)).rejects.toThrow('project queries')
    await expect(client.run({ root, operation: 'start', projectRevision: 7 }, true)).rejects.toThrow('requires project-select')
    for (const invalid of [
      { ...project, id: 'other' }, { ...project, uid: '' }, { ...project, deleted: true },
      { ...project, revision: 0 }, { ...project, environment: { ...project.environment, lastSnapshot: '1' } },
    ]) {
      await writeFile(script, response.replace(JSON.stringify(project), JSON.stringify(invalid)))
      await expect(client.run({ root, operation: 'project-get', libraryProject: 'film' })).rejects.toThrow('project selection response')
    }
    const recorded = { ...project, environment: { ...project.environment, lastSnapshot: '1', lastRunAt: '2026-11-19T20:00:00Z' } }
    await writeFile(script, response.replace(JSON.stringify(project), JSON.stringify(recorded)))
    expect((await client.run({ root, operation: 'project-get', libraryProject: 'film' })).project).toEqual(recorded)
    await writeFile(script, response.replace(JSON.stringify(project), JSON.stringify({ ...project, revision: 9 })))
    await expect(client.run(request, true)).rejects.toThrow('project selection response')
    await writeFile(script, response.replace(`environment:{id:'${'a'.repeat(32)}'`, `environment:{id:'${'b'.repeat(32)}'`))
    await expect(client.run({ root, operation: 'project-check', libraryProject: 'film' })).rejects.toThrow('project selection response')
    await writeFile(script, response.replace("snapshot:'2'", "snapshot:'3'"))
    await expect(client.run({ root, operation: 'project-check', libraryProject: 'film' })).rejects.toThrow('project selection response')
    await writeFile(script, response.replace(`environment:{id:'${'a'.repeat(32)}',snapshot:'2'}`, 'environment:null'))
    expect((await client.run({ root, operation: 'project-get', libraryProject: 'film' })).environment).toBeNull()
    await expect(client.run({ root, operation: 'project-check', libraryProject: 'film' })).rejects.toThrow('project selection response')
    await writeFile(script, response.replace('root, current: 2,', "root:root+'/other', current: 2,"))
    await expect(client.run({ root, operation: 'project-get', libraryProject: 'film' })).rejects.toThrow('different project root')
    await client.dispose()
  })

  it.each(['production', 'qa'] as const)('keeps the validated %s selection for tools descendants', async (services) => {
    vi.stubEnv('DINKSTER_SERVICES', services)
    const { root, client } = await commandFixture()
    vi.stubEnv('DINKSTER_SERVICES', services === 'qa' ? 'production' : 'qa')
    await client.run({ root, operation: 'start', engine: 'main' }, true)
    expect(await readFile(join(root, 'services.txt'), 'utf8')).toBe(services)
    expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).not.toContain('--services')
    await client.dispose()
  })

  it('uses engine sandbox readiness and forwards only an explicit start request', async () => {
    const { root, client } = await commandFixture()
    const script = join(root, 'command.cjs')
    const original = await readFile(script, 'utf8')
    const sandbox = { format: 'dinkster.sandbox-readiness/1', available: false, detail: 'bwrap not found; install bubblewrap' }
    await writeFile(script, original.replace('root, current: 2,', `root, current: 2, sandbox: ${JSON.stringify(sandbox)},`))
    expect((await client.run({ root, operation: 'doctor', sandbox: true })).sandbox).toEqual(sandbox)
    expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual(['--root', root, 'doctor', '--sandbox', '--json'])
    for (const sandboxPacks of [true, false]) {
      await client.run({ root, operation: 'start', sandboxPacks }, true)
      expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual(['--root', root, 'start', ...(sandboxPacks ? ['--sandbox-packs'] : []), '--json', '--yes'])
    }
    await expect(client.run({ root, operation: 'update', sandboxPacks: true })).rejects.toThrow('requires start')
    await expect(client.run({ root, operation: 'doctor', sandbox: true, repair: true })).rejects.toThrow('read-only')
    await writeFile(script, original.replace('root, current: 2,', 'root, current: 2, sandbox: {format:"dinkster.sandbox-readiness/1",available:"true",detail:"bad"},'))
    await expect(client.run({ root, operation: 'doctor', sandbox: true })).rejects.toThrow('invalid pack sandbox')
    await writeFile(script, original.replace("name:'main',generation:2,", "name:'main',generation:2,sandboxPacks:'true',"))
    await expect(client.run({ root, operation: 'status' })).rejects.toThrow('unsupported dinkster-env response')
    await client.dispose()
  })

  it('preserves the trusted native sandbox executor for doctor and start', async () => {
    const { root, client } = await commandFixture()
    const executor = join(root, 'resources', 'sandbox', 'wxc-exec.exe')
    vi.stubEnv('DINKSTER_MXC_EXECUTABLE', executor)
    const script = join(root, 'command.cjs')
    await writeFile(script, (await readFile(script, 'utf8')) + `
      fs.writeFileSync(path.join(root, 'sandbox-executable.txt'), process.env.DINKSTER_MXC_EXECUTABLE);
    `)
    try {
      for (const operation of ['doctor', 'start'] as const) {
        await client.run({ root, operation })
        expect(await readFile(join(root, 'sandbox-executable.txt'), 'utf8')).toBe(executor)
      }
    } finally {
      await client.dispose()
    }
  })

  it('reviews explicit local development folders and confirms the exact source digest', async () => {
    const { root, client } = await commandFixture()
    const development = { engine: join(root, 'engine checkout'), inference: join(root, 'inference'),
      helper: join(root, 'helper'), packs: [join(root, 'pack one'), join(root, 'pack two')], frontendRoot: join(root, 'frontend dist') }
    const sourceApproval = `sha256:${'c'.repeat(64)}`
    const script = join(root, 'command.cjs')
    const original = await readFile(script, 'utf8')
    await writeFile(script, original.replace("root, current: 2,", `root, current: 2, sourceApproval: '${sourceApproval}',`))
    const request = { root, operation: 'develop' as const, development, variant: 'cpu' }
    expect((await client.run(request)).sourceApproval).toBe(sourceApproval)
    const args = ['--root', root, 'develop', '--source', development.engine, '--contributor', '--live-engine',
      '--pack-source', development.packs[0], '--live-pack', development.packs[0],
      '--pack-source', development.packs[1], '--live-pack', development.packs[1],
      '--library-source', development.inference, '--live-library', development.inference,
      '--library-source', development.helper, '--live-library', development.helper,
      '--frontend-root', development.frontendRoot]
    expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual([...args, '--variant', 'cpu', '--json', '--plan'])
    await expect(client.run(request, true)).rejects.toThrow('reviewed source approval')
    expect((await client.run({ ...request, sourceApproval }, true)).status).toBe('applied')
    expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual([...args, '--approve', sourceApproval, '--variant', 'cpu', '--json', '--yes'])
    await expect(client.run({ ...request, operation: 'setup' })).rejects.toThrow('require develop')
    await expect(client.run({ ...request, development: { ...development, engine: 'relative' } })).rejects.toThrow('absolute local folders')
    await writeFile(script, original)
    await expect(client.run(request)).rejects.toThrow('source approval response')
    await client.dispose()
  })

  it('captures explicitly selected Git refs without treating fetched folders as live sources', async () => {
    const { root, client } = await commandFixture()
    const sourceApproval = `sha256:${'e'.repeat(64)}`
    const script = join(root, 'command.cjs')
    await writeFile(script, (await readFile(script, 'utf8')).replace('root, current: 2,', `root, current: 2, sourceApproval: '${sourceApproval}',`))
    const gitEngine = 'https://github.com/Kosinkadink/Dinkster.git#ref=refs/pull/1225/head'
    const gitPack = 'https://github.com/Kosinkadink/dinkster-nodes.git#ref=main&subdirectory=packages/dinkster-nodes-utilities'
    const gitInference = 'https://github.com/Kosinkadink/dinkster-inference.git#ref=v0.1.2'
    const localEngine = join(root, 'engine')
    const localPack = join(root, 'local pack')
    const helper = join(root, 'helper')
    for (const engine of [gitEngine, localEngine]) {
      const frontendSource = 'https://github.com/Kosinkadink/Dinkster-Frontend.git#ref=selected-frontend'
      const development = { engine, packs: [gitPack, localPack], inference: gitInference, helper, frontendSource }
      const request = { root, operation: 'develop' as const, development }
      expect((await client.run(request)).sourceApproval).toBe(sourceApproval)
      const expected = ['--root', root, 'develop', '--source', engine,
        ...(engine === localEngine ? ['--contributor', '--live-engine'] : []),
        '--pack-source', gitPack, '--pack-source', localPack, '--live-pack', localPack,
        '--library-source', gitInference, '--library-source', helper, '--live-library', helper,
        '--frontend-source', frontendSource]
      expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual([...expected, '--json', '--plan'])
      await client.run({ ...request, sourceApproval }, true)
      expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual([...expected, '--approve', sourceApproval, '--json', '--yes'])
    }
    for (const engine of ['http://host/repo.git', 'https://user:secret@host/repo.git', 'https://host/repo.git?token=secret', 'https://host/\nrepo.git', 'file:///tmp/repo', 'relative']) {
      await expect(client.run({ root, operation: 'develop', development: { engine, packs: [] } })).rejects.toThrow()
    }
    await client.dispose()
  })

  it('keeps frontend dev origins explicit and remote access off by default', () => {
    const source = { engine: join(process.cwd(), 'engine'), packs: [] }
    for (const url of ['http://localhost:5173', 'http://127.0.0.2:5173', 'http://[::1]:5173']) {
      expect(parseDevelopmentSources({ ...source, frontendDev: url })).toEqual({ ...source, frontendDev: url, allowFrontendDevRemote: false })
    }
    for (const url of ['http://localhost.example:5173', 'http://127.example:5173', 'http://192.0.2.1:5173']) {
      expect(() => parseDevelopmentSources({ ...source, frontendDev: url })).toThrow('explicit permission')
      expect(parseDevelopmentSources({ ...source, frontendDev: url, allowFrontendDevRemote: true }).frontendDev).toBe(url)
    }
    for (const url of ['http://user:password@localhost:5173', 'file:///tmp/frontend', 'http://localhost:5173/path', 'http://localhost:5173?token=value', 'http://localhost:5173#fragment', 'http://localhost:0', 'http://localhost:70000']) {
      expect(() => parseDevelopmentSources({ ...source, frontendDev: url, allowFrontendDevRemote: true })).toThrow()
    }
    expect(() => parseDevelopmentSources({ ...source, allowFrontendDevRemote: true })).toThrow('requires a dev server')
    expect(() => parseDevelopmentSources({ ...source, frontendRoot: join(process.cwd(), 'bundle'), frontendDev: 'http://localhost:5173' })).toThrow('choose one')
    const frontendSource = 'https://github.com/Kosinkadink/Dinkster-Frontend.git#ref=main'
    for (const alternative of [{ frontendRoot: join(process.cwd(), 'bundle') }, { frontendDev: 'http://localhost:5173' }]) {
      expect(() => parseDevelopmentSources({ ...source, frontendSource, ...alternative })).toThrow('choose one')
    }
    for (const frontendSource of [join(process.cwd(), 'checkout'), 'http://host/repo.git', 'https://user:secret@host/repo.git', 'https://host/repo.git?token=secret']) {
      expect(() => parseDevelopmentSources({ ...source, frontendSource })).toThrow()
    }
  })

  it('selects managed source components with CLI-owned approval and keeps refs read-only', async () => {
    const { root, client } = await commandFixture()
    const approval = `sha256:${'c'.repeat(64)}`
    const base = { root, operation: 'source' as const, sourceAction: 'add' as const,
      sourceUrl: 'https://github.com/Kosinkadink/source#subdirectory=packages/helper', sourceRef: 'refs/pull/23/head',
      gitMirror: 'https://mirror.example.org', packageIndex: 'https://packages.example.org/simple' }
    for (const [target, flags] of [
      ['engine', []], ['pack', ['--pack', 'selected-pack']],
      ['inference', ['--library', 'dinkster-inference']], ['helper', ['--library', 'dinkster-pack-helpers']], ['frontend', ['--frontend']],
    ] as const) {
      const request = { ...base, sourceTarget: target, ...(target === 'pack' ? { sourceName: 'selected-pack' } : {}) }
      await client.run(request)
      expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual([
        '--root', root, 'source', 'add', base.sourceUrl, ...flags, '--ref', base.sourceRef,
        '--git-mirror', base.gitMirror, '--package-index', base.packageIndex, '--json', '--plan',
      ])
      await expect(client.run(request, true)).rejects.toThrow('reviewed supervisor approval')
      await client.run({ ...request, sourceApproval: approval }, true)
      const args = JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8')) as string[]
      expect(args.slice(args.indexOf('--source-approval'), args.indexOf('--source-approval') + 2)).toEqual(['--source-approval', approval])
      expect(args.at(-1)).toBe('--yes')
      await expect(client.run({ ...request, sourceApproval: approval })).rejects.toThrow('reviewed supervisor approval')
    }
    await client.run({ root, operation: 'source', sourceAction: 'refs', sourceUrl: base.sourceUrl, gitMirror: base.gitMirror })
    expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual(['--root', root, 'source', 'refs', base.sourceUrl, '--git-mirror', base.gitMirror, '--json'])
    await client.run({ root, operation: 'source', sourceAction: 'release' })
    expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual(['--root', root, 'source', 'release', '--json', '--plan'])
    await client.run({ root, operation: 'restore', historyEntry: 7 }, true)
    expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual(['--root', root, 'restore', '7', '--json', '--yes'])
    for (const changes of [
      { sourceUrl: 'https://user:password@example.org/repo' }, { sourceUrl: 'file:///source' },
      { sourceRef: '--yes' }, { sourceTarget: 'pack' as const, sourceName: '--yes' }, { channel: 'stable' as const },
    ]) await expect(client.run({ ...base, sourceTarget: 'engine', ...changes })).rejects.toThrow()
    await client.dispose()
  })

  it('requires the planned published frontend identity before confirming a version', async () => {
    const { root, client } = await commandFixture()
    const request = { root, operation: 'update' as const, frontendVersion: '0.3.2rc1' }
    await client.run(request)
    await expect(client.run(request, true)).rejects.toThrow('reviewed supervisor approval')
    const approval = `sha256:${'d'.repeat(64)}`
    await client.run({ ...request, frontendApproval: approval }, true)
    const args = JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8')) as string[]
    expect(args).toContain('0.3.2rc1')
    expect(args.slice(args.indexOf('--frontend-approval'), args.indexOf('--frontend-approval') + 2)).toEqual(['--frontend-approval', approval])
    await expect(client.run({ ...request, frontendApproval: approval })).rejects.toThrow('reviewed supervisor approval')
    await expect(client.run({ ...request, frontendVersion: '--yes' })).rejects.toThrow('published frontend version')
    await expect(client.run({ root, operation: 'status', frontendVersion: '0.3.2' })).rejects.toThrow('setup or update')
    await client.dispose()
  })

  it('passes exact host-owned pack reviews and requires explicit apply approval', async () => {
    const { root, client } = await commandFixture()
    const inputs = join(root, 'review inputs')
    const approval = `sha256:${'b'.repeat(64)}`
    const response = { format: 'dinkster.environment-result/1', operation: 'packs-plan', status: 'planned', root, current: 2,
      plan: ['add dinkster-text@1.2.3rc1'], packPlan: { format: 'dinkster.project-pack-plan/1', root, current: 2, ownEnvironmentBytes: 12345 }, approval, expiresInSeconds: 900 }
    const script = join(root, 'command.cjs')
    await writeFile(script, `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(join(root, 'arguments.json'))}, JSON.stringify(process.argv.slice(2))); console.log(${JSON.stringify(JSON.stringify(response))});`)
    const progress = join(root, 'progress.json')
    const request = { root, operation: 'packs-plan' as const, inputs, progress, packs: [{ pack: 'dinkster-text', version: '1.2.3rc1' }, { pack: 'dinkster-image', version: '2.0.4' }] }
    expect(await client.run(request)).toEqual(response)
    expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual([
      '--root', root, 'packs-plan', 'dinkster-text@1.2.3rc1', 'dinkster-image@2.0.4', '--output', inputs, '--progress', progress, '--json',
    ])
    await expect(client.run(request, true)).rejects.toThrow('unconfirmed')
    expect(await client.run({ ...request, libraryProject: 'film', projectRevision: 7 })).toEqual(response)
    expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual([
      '--root', root, 'packs-plan', 'dinkster-text@1.2.3rc1', 'dinkster-image@2.0.4', '--output', inputs,
      '--project', 'film', '--revision', '7', '--progress', progress, '--json',
    ])
    for (const binding of [{ libraryProject: 'film' }, { projectRevision: 7 }, { libraryProject: '../film', projectRevision: 7 }, { libraryProject: 'film', projectRevision: 0 }]) {
      await expect(client.run({ ...request, ...binding })).rejects.toThrow('authoritative project and observed revision')
    }
    const applied = { ...response, operation: 'packs-apply', status: 'applied', current: 3, plan: [], engines: [{ name: 'main', generation: 3, state: 'ready', url: 'http://127.0.0.1:44003' }] }
    await writeFile(script, `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(join(root, 'arguments.json'))}, JSON.stringify(process.argv.slice(2))); console.log(${JSON.stringify(JSON.stringify(applied))});`)
    const apply = { root, operation: 'packs-apply' as const, inputs, approval }
    await expect(client.run(apply)).rejects.toThrow('confirmed')
    expect(await client.run(apply, true)).toEqual(applied)
    expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual([
      '--root', root, 'packs-apply', '--input', inputs, '--approval', approval, '--json',
    ])
    expect(await client.run({ ...apply, packScope: 'every-project' }, true)).toEqual(applied)
    expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual([
      '--root', root, 'packs-apply', '--input', inputs, '--approval', approval, '--scope', 'every-project', '--json',
    ])
    await expect(client.run({ ...request, packScope: 'every-project' })).rejects.toThrow('pack scope requires packs-apply')
    await expect(client.run({ ...apply, packScope: 'only-project' }, true)).rejects.toThrow('retained destination')
    await rm(join(root, 'arguments.json'))
    for (const packs of [[{ pack: '--help', version: '1.0.0' }], [{ pack: 'dinkster-text', version: '1.0.0 --yes' }], [request.packs[0]!, request.packs[0]!]]) {
      await expect(client.run({ ...request, packs })).rejects.toThrow('invalid or repeated')
    }
    await expect(client.run({ ...request, inputs: 'relative' })).rejects.toThrow('absolute host-owned')
    await expect(client.run({ ...request, progress: 'relative' })).rejects.toThrow('absolute host-owned')
    await expect(client.run({ ...apply, progress }, true)).rejects.toThrow('approval digest')
    await expect(client.run({ ...request, channel: 'nightly' })).rejects.toThrow('retains the current')
    await expect(client.run({ ...apply, approval: 'b'.repeat(64) }, true)).rejects.toThrow('approval digest')
    await expect(stat(join(root, 'arguments.json'))).rejects.toThrow()
    await client.dispose()
  })

  it('binds separate-project planning and application to the retained native destination', async () => {
    const { root, client } = await commandFixture()
    const destination = join(root, 'separate environment')
    const inputs = join(root, 'inputs')
    const approval = `sha256:${'c'.repeat(64)}`
    const response = { format: 'dinkster.environment-result/1', operation: 'packs-plan', status: 'planned', root, current: 2,
      plan: [], packPlan: { format: 'dinkster.project-pack-plan/1', root, current: 2, fork: { destination } }, approval, expiresInSeconds: 900 }
    const respond = async (value: unknown) => writeFile(join(root, 'command.cjs'),
      `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(join(root, 'arguments.json'))}, JSON.stringify(process.argv.slice(2))); console.log(${JSON.stringify(JSON.stringify(value))});`)
    await respond(response)
    const request: EnvironmentRequest = { root, operation: 'packs-plan', inputs, destination,
      libraryProject: 'film', projectRevision: 7, packs: [{ pack: 'dinkster-text', version: '1.0.0' }] }
    expect(await client.run(request)).toEqual(response)
    expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual([
      '--root', root, 'packs-plan', 'dinkster-text@1.0.0', '--output', inputs, '--project', 'film', '--revision', '7', '--destination', destination, '--json',
    ])
    for (const wrong of [undefined, { destination: 'relative' }, { destination: join(root, 'other') }]) {
      await respond({ ...response, packPlan: { ...response.packPlan, fork: wrong } })
      await expect(client.run(request)).rejects.toThrow('different pack destination')
    }
    await respond(response)
    await expect(client.run({ ...request, destination: undefined })).rejects.toThrow('different pack destination')
    await expect(client.run({ ...request, destination: 'relative' })).rejects.toThrow('absolute reviewed project destination')
    await expect(client.run({ ...request, libraryProject: undefined, projectRevision: undefined })).rejects.toThrow('absolute reviewed project destination')
    const apply: EnvironmentRequest = { root, operation: 'packs-apply', inputs, approval, destination, packScope: 'only-project' }
    const applied = { format: 'dinkster.environment-result/1', operation: 'packs-apply', status: 'applied', root, current: 1, plan: [], destination, engines: [] }
    await respond(applied)
    expect(await client.run(apply, true)).toEqual(applied)
    // The destination is retained locally; the supervisor takes it only from the approved plan.
    expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual([
      '--root', root, 'packs-apply', '--input', inputs, '--approval', approval, '--scope', 'only-project', '--json',
    ])
    for (const wrong of [undefined, 'relative', join(root, 'other')]) {
      await respond({ ...applied, destination: wrong })
      await expect(client.run(apply, true)).rejects.toThrow('different pack destination')
    }
    await mkdir(destination)
    await respond({ ...applied, root: destination })
    await expect(client.run(apply, true)).rejects.toThrow('different project root')
    await respond(applied)
    await expect(client.run({ ...apply, destination: undefined }, true)).rejects.toThrow('retained destination')
    await expect(client.run({ ...apply, packScope: 'every-project' }, true)).rejects.toThrow('absolute reviewed project destination')
    await expect(client.run({ ...apply, destination: undefined, packScope: 'every-project' }, true)).rejects.toThrow('different pack destination')
    await client.dispose()
  })

  it.each(['environment.json', 'project.json'])('reads %s and refuses a channel above Desktop without gating offline operations', async (settingsFile) => {
    const { root } = await commandFixture()
    const script = join(root, 'command.cjs')
    const client = new EnvironmentClient(process.execPath, [script], undefined, undefined, '0.2.0')
    await mkdir(join(root, 'channels'))
    const channel = join(root, 'channels', 'nightly.json')
    if (settingsFile === 'environment.json') await writeFile(join(root, 'project.json'), JSON.stringify({ migrated: true }))
    await writeFile(join(root, settingsFile), JSON.stringify({ channel: 'nightly', mirrors: [root] }))
    await writeFile(channel, channelFixture({ format: 'dinkster.channel/1', minimumDesktopVersion: '0.2.1' }))
    for (const operation of ['setup', 'update', 'catalog', 'start'] as const) {
      await expect(client.run({ root, operation })).rejects.toThrow('DesktopVersionTooOld: channel requires Desktop 0.2.1')
      await expect(stat(join(root, 'arguments.json'))).rejects.toThrow()
    }
    await rm(channel)
    for (const operation of ['status', 'doctor', 'stop'] as const) {
      expect((await client.run({ root, operation }, true)).operation).toBe(operation)
    }
    for (const minimumDesktopVersion of ['0.2.0', '0.1.99']) {
      await writeFile(channel, channelFixture({ format: 'dinkster.channel/1', minimumDesktopVersion }))
      expect((await client.run({ root, operation: 'update' })).status).toBe('planned')
    }
    await client.dispose()
  })

  it('authenticates third-party mirror channels before selecting tools, without hostname bypasses', async () => {
    const { root } = await commandFixture()
    const tools = { manifest: 'https://mirror.example/tools-manifest.json', sha256: 'a'.repeat(64), release: 'https://mirror.example/tools' }
    const document = { format: 'dinkster.channel/1', minimumDesktopVersion: '0.2.0', tools }
    const signed = channelFixture(document)
    let response = signed
    vi.stubGlobal('fetch', async () => new Response(response))
    const request = { root, operation: 'setup' as const, channel: 'nightly' as const, mirrors: ['https://mirror.example'] }
    expect(await channelTools(request, '0.2.0')).toEqual(tools)
    for (const refused of [
      JSON.stringify({ ...document, signature: null }),
      signed.replace('a'.repeat(64), 'b'.repeat(64)),
      channelFixture(document, 'stable'),
      channelFixture(document, 'nightly', generateKeyPairSync('ed25519').privateKey),
    ]) {
      response = refused
      await expect(channelTools(request, '0.2.0')).rejects.toThrow('no mirror supplied a valid trusted channel')
      await expect(channelTools({ ...request, mirrors: ['https://releases.dinkster.org'] }, '0.2.0')).rejects.toThrow('no mirror supplied a valid trusted channel')
    }
    response = signed
    expect(await channelTools(request, '0.2.0')).toEqual(tools)
    await expect(stat(join(root, 'arguments.json'))).rejects.toThrow()
  })

  it.each(['setup', 'update', 'catalog', 'start'] as const)('selects channel tools before the bundle for %s and falls back only without a tools pin', async (operation) => {
    const { root } = await commandFixture()
    await mkdir(join(root, 'channels'))
    const manifest = join(root, 'newer-tools.json')
    await writeFile(manifest, '{}')
    await writeFile(join(root, 'channels', 'nightly.json'), channelFixture({
      format: 'dinkster.channel/1', minimumDesktopVersion: '0.2.0',
      tools: { manifest, sha256: 'a'.repeat(64), release: root },
    }))
    const client = new EnvironmentClient(undefined, undefined, undefined,
      { manifest: join(root, 'bundle-must-not-open'), sha256: 'b'.repeat(64), release: root }, '0.2.0')
    // A checksum error from the channel's real file, not ENOENT from the bundle,
    // proves selection and that the channel pin still goes through verification.
    await writeFile(join(root, 'project.json'), JSON.stringify({ channel: 'nightly', mirrors: [root] }))
    await expect(client.run({ root, operation })).rejects.toThrow('checksum mismatch')
    await expect(stat(join(root, 'arguments.json'))).rejects.toThrow()
    await writeFile(join(root, 'channels', 'nightly.json'), channelFixture({
      format: 'dinkster.channel/1', minimumDesktopVersion: '0.2.0',
    }))
    await expect(client.run({ root, operation })).rejects.toThrow('bundle-must-not-open')
    await rm(join(root, 'channels', 'nightly.json'))
    await expect(client.run({ root, operation })).rejects.toThrow('no mirror supplied a valid trusted channel')
    await client.dispose()
  })

  it('extracts only the size/hash-pinned native tools row and retains executable permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-tools-'))
    roots.push(root)
    // Ordinary stored ZIP with python/bin/python3 and python/python.exe, both mode 0755.
    const archive = Buffer.from('UEsDBBQAAAAAAAAAIQDuQOUFBwAAAAcAAAASAAAAcHl0aG9uL2Jpbi9weXRob24zZml4dHVyZVBLAwQUAAAAAAAAACEA7kDlBQcAAAAHAAAAEQAAAHB5dGhvbi9weXRob24uZXhlZml4dHVyZVBLAQIUAxQAAAAAAAAAIQDuQOUFBwAAAAcAAAASAAAAAAAAAAAAAADtgQAAAABweXRob24vYmluL3B5dGhvbjNQSwECFAMUAAAAAAAAACEA7kDlBQcAAAAHAAAAEQAAAAAAAAAAAAAA7YE3AAAAcHl0aG9uL3B5dGhvbi5leGVQSwUGAAAAAAIAAgB/AAAAbQAAAAAA', 'base64')
    const os = { win32: 'windows', linux: 'linux', darwin: 'macos' }[process.platform as 'win32' | 'linux' | 'darwin']
    const name = `dinkster-tools-${os}-${process.arch === 'x64' ? 'x86_64' : 'arm64'}.zip`
    const row = { name, size: archive.length, sha256: createHash('sha256').update(archive).digest('hex') }
    await writeFile(join(root, name), archive)
    const manifest = join(root, 'tools-manifest.json')
    async function input(artifacts = [row], overrides = {}) {
      const bytes = independentManifest([...toolsArtifacts(row).filter((entry) => entry.name !== row.name), ...artifacts], overrides)
      await writeFile(manifest, bytes)
      return { manifest, sha256: createHash('sha256').update(bytes).digest('hex'), release: root }
    }
    const pin = await input()
    const tools = await acquireEnvironmentTools(pin)
    roots.push(tools.directory)
    expect(await readFile(tools.python, 'utf8')).toBe('fixture')
    if (process.platform !== 'win32') expect((await stat(tools.python)).mode & 0o777).toBe(0o755)
    const cacheRoot = join(root, 'desktop-cache')
    const cached = await acquireEnvironmentTools({ ...pin, cacheRoot })
    const label = `2026-11-05-1.2.3-${os}-${process.arch === 'x64' ? 'x86_64' : 'arm64'}`
    expect(cached.directory).toBe(join(cacheRoot, label))
    expect(await readFile(join(cached.directory, 'complete'), 'utf8')).toBe(row.sha256)
    expect(cached.persistent).toBe(true)
    const originalTime = (await stat(cached.python)).mtimeMs
    await rm(join(root, name))
    const reused = await acquireEnvironmentTools({ ...pin, cacheRoot })
    expect(reused).toEqual(cached)
    expect((await stat(reused.python)).mtimeMs).toBe(originalTime)
    const relabeled = await input([row], { builtAt: '2026-11-06T18:36:00Z', label: '2026-11-06-1.2.3' })
    expect(await acquireEnvironmentTools({ ...relabeled, cacheRoot })).toEqual(cached)
    // An existing digest-only extraction is reused in place, without its ZIP.
    const legacyRoot = join(root, 'legacy-cache')
    await mkdir(legacyRoot)
    const legacy = join(legacyRoot, row.sha256)
    await rename(cached.directory, legacy)
    expect((await acquireEnvironmentTools({ ...relabeled, cacheRoot: legacyRoot })).directory).toBe(legacy)
    await rename(legacy, cached.directory)
    // ZIP timestamp changes its digest without changing file bytes or CRCs.
    const replacement = Buffer.from(archive)
    replacement[10] = 1
    await writeFile(join(root, name), replacement)
    const replacementRow = { ...row, sha256: createHash('sha256').update(replacement).digest('hex') }
    const replacementPin = await input([replacementRow])
    await writeFile(join(root, name), archive)
    await expect(acquireEnvironmentTools({ ...replacementPin, cacheRoot })).rejects.toThrow('checksum mismatch')
    expect(await readFile(cached.python, 'utf8')).toBe('fixture')
    await expect(stat(join(cacheRoot, `${label}--2`))).rejects.toThrow()
    await writeFile(join(root, name), replacement)
    const [replaced, simultaneous] = await Promise.all([
      acquireEnvironmentTools({ ...replacementPin, cacheRoot }),
      acquireEnvironmentTools({ ...replacementPin, cacheRoot }),
    ])
    expect(simultaneous).toEqual(replaced)
    expect(replaced.directory).toBe(join(cacheRoot, `${label}--2`))
    expect(await readFile(replaced.python, 'utf8')).toBe('fixture')
    await expect(stat(cached.python)).rejects.toThrow()
    expect(await readFile(join(cached.directory, 'complete'), 'utf8')).toBe(row.sha256)
    // Restoring evicted content uses its first allocation, not the latest label.
    await writeFile(join(root, name), archive)
    expect((await acquireEnvironmentTools({ ...await input([row], { builtAt: '2026-11-07T18:36:00Z', label: '2026-11-07-1.2.3' }), cacheRoot })).directory).toBe(cached.directory)
    expect(await readFile(cached.python, 'utf8')).toBe('fixture')
    // Reservations at and beyond --10 must still resolve by full identity.
    await rename(cached.directory, join(cacheRoot, `${label.toUpperCase()}--10`))
    expect((await acquireEnvironmentTools({ ...await input(), cacheRoot })).directory).toBe(join(cacheRoot, `${label.toUpperCase()}--10`))
    await rename(join(cacheRoot, `${label.toUpperCase()}--10`), cached.directory)
    const blocked = join(cacheRoot, '2026-11-08-1.2.3-LINUX-x86_64')
    await symlink(root, blocked, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(acquireEnvironmentTools({ ...await input(), cacheRoot })).rejects.toThrow('real directory')
    await rm(blocked)
    await writeFile(join(cached.directory, 'complete'), 'invalid')
    await expect(acquireEnvironmentTools({ ...await input(), cacheRoot })).rejects.toThrow('identity metadata')
    await writeFile(join(cached.directory, 'complete'), row.sha256)
    await input()
    await expect(acquireEnvironmentTools({ ...pin, sha256: 'a'.repeat(64) })).rejects.toThrow('checksum mismatch')
    await expect(acquireEnvironmentTools(await input([{ ...row, size: row.size + 1 }]))).rejects.toThrow('size mismatch')
    await expect(acquireEnvironmentTools(await input([{ ...row, sha256: 'b'.repeat(64) }]))).rejects.toThrow('checksum mismatch')
    await expect(acquireEnvironmentTools(await input([row, row]))).rejects.toThrow('manifest artifacts')
    expect(await readFile(tools.python, 'utf8')).toBe('fixture')
  })

  it('uses an independent channel tools manifest without an engine ZIP and refuses changed publication inputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-independent-tools-'))
    roots.push(root)
    const archive = Buffer.from('UEsDBBQAAAAAAAAAIQDuQOUFBwAAAAcAAAASAAAAcHl0aG9uL2Jpbi9weXRob24zZml4dHVyZVBLAwQUAAAAAAAAACEA7kDlBQcAAAAHAAAAEQAAAHB5dGhvbi9weXRob24uZXhlZml4dHVyZVBLAQIUAxQAAAAAAAAAIQDuQOUFBwAAAAcAAAASAAAAAAAAAAAAAADtgQAAAABweXRob24vYmluL3B5dGhvbjNQSwECFAMUAAAAAAAAACEA7kDlBQcAAAAHAAAAEQAAAAAAAAAAAAAA7YE3AAAAcHl0aG9uL3B5dGhvbi5leGVQSwUGAAAAAAIAAgB/AAAAbQAAAAAA', 'base64')
    const row = { name: nativeToolsName(), size: archive.length, sha256: createHash('sha256').update(archive).digest('hex') }
    const artifacts = [row, ...toolsArtifacts(row).filter((entry) => entry.name !== row.name)]
    const manifest = independentManifest(artifacts)
    const sha256 = createHash('sha256').update(manifest).digest('hex')
    const label = `2026-11-05-1.2.3-${sha256.slice(0, 8)}`
    const release = join(root, 'tools', label)
    await mkdir(join(root, 'channels'), { recursive: true })
    await mkdir(release, { recursive: true })
    await writeFile(join(release, 'tools-manifest.json'), manifest)
    await writeFile(join(release, row.name), archive)
    await writeFile(join(root, 'channels', 'nightly.json'), channelFixture({
      format: 'dinkster.channel/1', minimumDesktopVersion: '0.2.0',
      tools: { label, manifest: join(release, 'tools-manifest.json'), sha256, release },
    }))

    const input = await channelTools({ root, operation: 'setup', channel: 'nightly', mirrors: [root] }, '0.2.0')
    expect(input).toEqual({ label, manifest: join(release, 'tools-manifest.json'), sha256, release, mirrorReleases: [release] })
    const tools = await acquireEnvironmentTools(input!)
    roots.push(tools.directory)
    expect(await readFile(tools.python, 'utf8')).toBe('fixture')

    // A complete mirror serves unchanged signed bytes with the origin denied.
    const origin = `https://releases.dinkster.org/tools/${label}`
    const envelope = channelFixture({
      format: 'dinkster.channel/1', minimumDesktopVersion: '0.2.0',
      tools: { label, manifest: `${origin}/tools-manifest.json`, sha256, release: origin },
    })
    await writeFile(join(root, 'channels', 'nightly.json'), envelope)
    vi.stubGlobal('fetch', async () => { throw new Error('official tools origin denied') })
    const mirrored = await channelTools({ root, operation: 'setup', channel: 'nightly', mirrors: [root] }, '0.2.0')
    const mirroredTools = await acquireEnvironmentTools(mirrored!)
    roots.push(mirroredTools.directory)
    expect(await readFile(mirroredTools.python, 'utf8')).toBe('fixture')
    expect(await readFile(join(root, 'channels', 'nightly.json'), 'utf8')).toBe(envelope)

    const mirror = 'http://127.0.0.1:43001/snapshot'
    const requests: string[] = []
    let corruption = 'manifest'
    let originOnline = false
    vi.stubGlobal('fetch', async (location: URL) => {
      const url = String(location)
      requests.push(url)
      if (url.startsWith(origin) && !originOnline) throw new Error('official tools origin denied')
      if (url.endsWith('/channels/nightly.json')) return new Response(envelope)
      if (url.endsWith('/tools-manifest.json')) return new Response(url.startsWith(mirror) && corruption === 'manifest' ? '{}' : manifest)
      if (url.endsWith(`/${row.name}`)) {
        const bytes = Buffer.from(archive)
        if (url.startsWith(mirror) && corruption === 'archive') bytes[10] = 1
        return new Response(bytes)
      }
      throw new Error(`unexpected tools request: ${url}`)
    })
    for (corruption of ['manifest', 'archive']) {
      requests.length = 0
      const ordered = await channelTools({ root, operation: 'setup', channel: 'nightly', mirrors: ['http://not-loopback.example', mirror, root] }, '0.2.0')
      const verified = await acquireEnvironmentTools(ordered!)
      roots.push(verified.directory)
      expect(await readFile(verified.python, 'utf8')).toBe('fixture')
      expect(requests).toContain(`${mirror}/tools/${label}/tools-manifest.json`)
      if (corruption === 'archive') expect(requests).toContain(`${mirror}/tools/${label}/${row.name}`)
      expect(requests.some((url) => url.startsWith(origin))).toBe(false)
      const corruptOnly = await channelTools({ root, operation: 'setup', channel: 'nightly', mirrors: [mirror] }, '0.2.0')
      await expect(acquireEnvironmentTools(corruptOnly!)).rejects.toThrow(/checksum mismatch.*official tools origin denied/)
    }
    originOnline = true
    const fallback = await channelTools({ root, operation: 'setup', channel: 'nightly', mirrors: [mirror] }, '0.2.0')
    const originTools = await acquireEnvironmentTools(fallback!)
    roots.push(originTools.directory)
    expect(await readFile(originTools.python, 'utf8')).toBe('fixture')
    expect(requests).toContain(`${origin}/${row.name}`)

    await expect(acquireEnvironmentTools({ ...input!, sha256: 'b'.repeat(64) })).rejects.toThrow('checksum mismatch')
    const wrongSize = independentManifest([{ ...artifacts[0]!, size: row.size + 1 }, ...artifacts.slice(1)])
    const wrongSizeSha256 = createHash('sha256').update(wrongSize).digest('hex')
    await writeFile(join(release, 'tools-manifest.json'), wrongSize)
    await expect(acquireEnvironmentTools({ ...input!, label: `2026-11-05-1.2.3-${wrongSizeSha256.slice(0, 8)}`, sha256: wrongSizeSha256 })).rejects.toThrow('size mismatch')
    await writeFile(join(release, 'tools-manifest.json'), manifest)
    await expect(acquireEnvironmentTools({ ...input!, label: `2026-11-05-1.2.3-${'a'.repeat(8)}` })).rejects.toThrow('identity')
    for (const overrides of [
      { builtAt: '2026-11-04T18:36:00Z' },
      { version: 'not-a-version' },
      { format: 'dinkster.engine/1' },
    ]) {
      const invalid = independentManifest(artifacts, overrides)
      await writeFile(join(release, 'tools-manifest.json'), invalid)
      await expect(acquireEnvironmentTools({ ...input!, sha256: createHash('sha256').update(invalid).digest('hex') })).rejects.toThrow('identity')
      if (overrides.format === 'dinkster.engine/1') {
        await expect(acquireEnvironmentTools({ ...input!, label: undefined, sha256: createHash('sha256').update(invalid).digest('hex') })).rejects.toThrow('identity')
      }
    }
    const localVersion = independentManifest(artifacts, { version: '1.2.3+build5', builtAt: '2026-11-05T18:36:00+00:00' })
    const localSha256 = createHash('sha256').update(localVersion).digest('hex')
    await writeFile(join(release, 'tools-manifest.json'), localVersion)
    const localTools = await acquireEnvironmentTools({ ...input!, label: `2026-11-05-1.2.3-${localSha256.slice(0, 8)}`, sha256: localSha256 })
    roots.push(localTools.directory)
    expect(await readFile(localTools.python, 'utf8')).toBe('fixture')
    await writeFile(join(release, 'tools-manifest.json'), manifest)
    const wrongArchive = Buffer.from(archive)
    wrongArchive[10] = 1
    await writeFile(join(release, row.name), wrongArchive)
    await expect(acquireEnvironmentTools(input!)).rejects.toThrow('checksum mismatch')
  })

  it('refuses traversal and links in an otherwise correctly pinned tools ZIP', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-tools-'))
    roots.push(root)
    const os = { win32: 'windows', linux: 'linux', darwin: 'macos' }[process.platform as 'win32' | 'linux' | 'darwin']
    const name = `dinkster-tools-${os}-${process.arch === 'x64' ? 'x86_64' : 'arm64'}.zip`
    for (const encoded of [
      'UEsDBBQAAAAAAAAAIQDuQOUFBwAAAAcAAAATAAAAcHl0aG9uLy4uLy4uL2VzY2FwZWZpeHR1cmVQSwECFAMUAAAAAAAAACEA7kDlBQcAAAAHAAAAEwAAAAAAAAAAAAAApIEAAAAAcHl0aG9uLy4uLy4uL2VzY2FwZVBLBQYAAAAAAQABAEEAAAA4AAAAAAA=',
      'UEsDBBQAAAAAAAAAIQDuQOUFBwAAAAcAAAALAAAAcHl0aG9uL2xpbmtmaXh0dXJlUEsBAhQDFAAAAAAAAAAhAO5A5QUHAAAABwAAAAsAAAAAAAAAAAAAAP+hAAAAAHB5dGhvbi9saW5rUEsFBgAAAAABAAEAOQAAADAAAAAAAA==',
    ]) {
      const archive = Buffer.from(encoded, 'base64')
      await writeFile(join(root, name), archive)
      const bytes = independentManifest(toolsArtifacts({ name, size: archive.length, sha256: createHash('sha256').update(archive).digest('hex') }))
      const manifest = join(root, 'tools-manifest.json')
      await writeFile(manifest, bytes)
      await expect(acquireEnvironmentTools({ manifest, sha256: createHash('sha256').update(bytes).digest('hex'), release: root })).rejects.toThrow(/invalid relative path|unsafe tools ZIP/)
    }
    await expect(stat(join(root, 'escape'))).rejects.toThrow()
  })

  it.each([
    { host: 'linux', platform: 'linux' },
    { host: 'win32', platform: 'win32' },
    { host: 'darwin', platform: 'darwin' },
    { host: 'win32', platform: 'linux' },
  ] as const)('checks $platform tools ZIP identity on $host', async ({ host, platform }) => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-tools-'))
    roots.push(root)
    await writeFile(join(root, 'CaseSensitiveCheck'), '')
    const caseSensitive = await stat(join(root, 'casesensitivecheck')).then(() => false, (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return true
    })
    // Stored ZIP: both interpreter paths and the published 2621A/2621a terminfo pair.
    const pair = Buffer.from('UEsDBBQAAAAAAAAAIQC3JjKwCwAAAAsAAAASAAAAcHl0aG9uL2Jpbi9weXRob24zaW50ZXJwcmV0ZXJQSwMEFAAAAAAAAAAhALcmMrALAAAACwAAABEAAABweXRob24vcHl0aG9uLmV4ZWludGVycHJldGVyUEsDBBQAAAAAAAAAIQCc319uBQAAAAUAAAAdAAAAcHl0aG9uL3NoYXJlL3Rlcm1pbmZvLzIvMjYyMUF1cHBlclBLAwQUAAAAAAAAACEAI3uaDgUAAAAFAAAAHQAAAHB5dGhvbi9zaGFyZS90ZXJtaW5mby8yLzI2MjFhbG93ZXJQSwECFAMUAAAAAAAAACEAtyYysAsAAAALAAAAEgAAAAAAAAAAAAAA7YEAAAAAcHl0aG9uL2Jpbi9weXRob24zUEsBAhQDFAAAAAAAAAAhALcmMrALAAAACwAAABEAAAAAAAAAAAAAAO2BOwAAAHB5dGhvbi9weXRob24uZXhlUEsBAhQDFAAAAAAAAAAhAJzfX24FAAAABQAAAB0AAAAAAAAAAAAAAO2BdQAAAHB5dGhvbi9zaGFyZS90ZXJtaW5mby8yLzI2MjFBUEsBAhQDFAAAAAAAAAAhACN7mg4FAAAABQAAAB0AAAAAAAAAAAAAAO2BtQAAAHB5dGhvbi9zaGFyZS90ZXJtaW5mby8yLzI2MjFhUEsFBgAAAAAEAAQAFQEAAPUAAAAAAA==', 'base64')
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    const archDescriptor = Object.getOwnPropertyDescriptor(process, 'arch')!
    Object.defineProperty(process, 'platform', { value: host })
    Object.defineProperty(process, 'arch', { value: platform === 'darwin' ? 'arm64' : 'x64' })
    try {
      const os = { linux: 'linux', win32: 'windows', darwin: 'macos' }[platform]
      const name = `dinkster-tools-${os}-${process.arch === 'x64' ? 'x86_64' : 'arm64'}.zip`
      for (const exactDuplicate of [false, true]) {
        // Change both ZIP name records, leaving file contents and their CRCs intact.
        const archive = exactDuplicate ? Buffer.from(pair.toString('latin1').replaceAll('2621a', '2621A'), 'latin1') : pair
        await writeFile(join(root, name), archive)
        const bytes = independentManifest(toolsArtifacts({ name, size: archive.length, sha256: createHash('sha256').update(archive).digest('hex') }))
        const manifest = join(root, 'tools-manifest.json')
        await writeFile(manifest, bytes)
        const pending = acquireEnvironmentTools({ manifest, sha256: createHash('sha256').update(bytes).digest('hex'), release: root,
          ...(host !== platform ? { platform: 'linux' as const } : {}) })
        if (platform === 'linux' && !caseSensitive) {
          await expect(pending).rejects.toThrow('case-sensitive filesystem')
        } else if (platform === 'linux' && !exactDuplicate) {
          const tools = await pending
          roots.push(tools.directory)
          expect(await readFile(tools.python, 'utf8')).toBe('interpreter')
          if (descriptor.value === 'linux') {
            expect(await readFile(join(tools.directory, 'payload/python/share/terminfo/2/2621A'), 'utf8')).toBe('upper')
            expect(await readFile(join(tools.directory, 'payload/python/share/terminfo/2/2621a'), 'utf8')).toBe('lower')
          }
        } else await expect(pending).rejects.toThrow('unsafe tools ZIP entry')
      }
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
      Object.defineProperty(process, 'arch', archDescriptor)
    }
  })

  it('plans by default and passes explicit confirmation without changing artifact formats', async () => {
    const { root, client } = await commandFixture()
    const request = { root, operation: 'setup' as const, channel: 'nightly' as const, variant: 'win-nvidia-cu126', mirrors: [join(root, 'offline mirror'), 'https://releases.dinkster.org'], data: join(root, 'wheel store'), port: 44000, engine: 'compute', gpus: ['1'] }
    const plan = await client.run(request)
    expect(plan.status).toBe('planned')
    expect(plan.plan).toEqual(['reuse the shared wheel store'])
    expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual([
      '--root', root, 'setup', '--channel', 'nightly', '--variant', 'win-nvidia-cu126',
      '--mirror', join(root, 'offline mirror'), '--mirror', 'https://releases.dinkster.org',
      '--data', join(root, 'wheel store'), '--port', '44000', '--engine', 'compute', '--gpu', '1', '--json', '--plan',
    ])
    const applied = await client.run(request, true)
    expect(applied.status).toBe('applied')
    expect(applied.url).toBe('http://127.0.0.1:44001')
    const args = JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8')) as string[]
    expect(args).toContain('--yes')
    expect(args).not.toContain('--plan')
  })

  it('delegates update, rollback and move, while doctor stays read-only', async () => {
    const { root, client } = await commandFixture()
    for (const operation of ['update', 'rollback', 'move', 'doctor'] as const) {
      const result = await client.run({ root, operation, ...(operation === 'move' ? { destination: join(root, 'moved project') } : {}) }, true)
      expect(result.operation).toBe(operation)
      expect(result.status).toBe(operation === 'doctor' ? 'clean' : 'applied')
      const args = JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8')) as string[]
      expect(args.includes('--yes')).toBe(operation !== 'doctor')
      if (operation === 'move') expect(args[3]).toBe(join(root, 'moved project'))
    }
    await expect(client.run({ root, operation: 'doctor', repair: true }, true)).rejects.toThrow('generation drift needs offline repair')
  })

  it('delegates cleanup preference and retry, preserving deferred status and warnings', async () => {
    const { root } = await commandFixture()
    const cleanup = {
      policy: { automatic: false, previousSuccessfulActivations: 1, minimumAgeSeconds: 0 },
      generations: [{ generation: 7, status: 'deferred', reasons: ['unreadable history'] }],
      quarantine: [{ journal: '600.json', stage: 'complete', generations: [2] }],
      warnings: ['generation 2 awaits deletion'],
      lastAttempt: { status: 'deferred', warnings: ['sharing violation'] },
    }
    const response = join(root, 'response.json')
    const script = join(root, 'cleanup.cjs')
    await writeFile(response, JSON.stringify(cleanup))
    await writeFile(script, `
      const fs=require('node:fs');const args=process.argv.slice(2);
      fs.writeFileSync(${JSON.stringify(join(root, 'arguments.json'))},JSON.stringify(args));
      const operation=args[2];const cleanup=JSON.parse(fs.readFileSync(${JSON.stringify(response)}));
      console.log(JSON.stringify({format:'dinkster.environment-result/1',operation,root:${JSON.stringify(root)},current:3,plan:[],cleanup,
        status:operation==='status'?'clean':args.includes('--plan')?'planned':'deferred',
        ...(args.includes('--yes')?{cleanupAttempt:cleanup.lastAttempt}:{})}));
    `)
    const client = new EnvironmentClient(process.execPath, [script])
    for (const automaticCleanup of [undefined, false, true]) {
      const request = { root, operation: 'cleanup' as const, ...(automaticCleanup === undefined ? {} : { automaticCleanup }) }
      expect((await client.run(request)).cleanup).toEqual(cleanup)
      expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual([
        '--root', root, 'cleanup', ...(automaticCleanup === undefined ? [] : ['--automatic', automaticCleanup ? 'on' : 'off']), '--json', '--plan',
      ])
    }
    for (const keepPreviousGenerations of [1, 2, 100]) {
      expect((await client.run({ root, operation: 'cleanup', keepPreviousGenerations })).cleanup).toEqual(cleanup)
      expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual([
        '--root', root, 'cleanup', '--keep-previous', String(keepPreviousGenerations), '--json', '--plan',
      ])
    }
    for (const keepPreviousGenerations of [0, -1, 101, 1.5, NaN, true, '2']) {
      await expect(client.run({ root, operation: 'cleanup', keepPreviousGenerations } as unknown as EnvironmentRequest)).rejects.toThrow('retained snapshot count')
    }
    await expect(client.run({ root, operation: 'status', keepPreviousGenerations: 2 })).rejects.toThrow('retained snapshot count')
    const retried = await client.run({ root, operation: 'cleanup' }, true)
    expect(retried.status).toBe('deferred')
    expect(retried.cleanupAttempt).toEqual(cleanup.lastAttempt)
    expect((await client.run({ root, operation: 'status' })).cleanup).toEqual(cleanup)
    expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual(['--root', root, 'status', '--json'])
    await writeFile(response, JSON.stringify({ generations: [], quarantine: [], warnings: ['corrupt policy; cleanup deferred'] }))
    expect((await client.run({ root, operation: 'status' })).cleanup?.warnings).toEqual(['corrupt policy; cleanup deferred'])
    for (const malformed of [{ ...cleanup, policy: { ...cleanup.policy, automatic: 'false' } },
      ...[0, 101].map((previousSuccessfulActivations) => ({ ...cleanup, policy: { ...cleanup.policy, previousSuccessfulActivations } })),
      { ...cleanup, lastAttempt: { status: 'deferred', warnings: [false] } }]) {
      await writeFile(response, JSON.stringify(malformed))
      await expect(client.run({ root, operation: 'status' })).rejects.toThrow('cleanup response')
    }
    await expect(client.run({ root, operation: 'status', automaticCleanup: false })).rejects.toThrow('preference requires cleanup')
  })

  it('starts and stops named engines with scoped devices and consumes new supervisor URLs', async () => {
    const { root, client } = await commandFixture()
    const started = await client.run({ root, operation: 'start', engine: 'main', port: 44000, gpus: ['1', 'GPU-1234-abcd'] }, true)
    expect(started.engines).toEqual([{ name: 'main', generation: 2, state: 'ready', url: 'http://127.0.0.1:44001' }])
    expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual([
      '--root', root, 'start', '--port', '44000', '--engine', 'main', '--gpu', '1', '--gpu', 'GPU-1234-abcd', '--json', '--yes',
    ])
    const updated = await client.run({ root, operation: 'update' }, true)
    expect(updated.url).toBe('http://127.0.0.1:44002')
    expect(updated.engines?.[0]?.url).toBe('http://127.0.0.1:44002')
    await client.run({ root, operation: 'status' })
    expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual(['--root', root, 'status', '--json'])
    const stopped = await client.run({ root, operation: 'stop', engine: 'main' }, true)
    expect(stopped.engines?.[0]?.state).toBe('stopped')
    await expect(client.run({ root, operation: 'start', engine: '--other' }, true)).rejects.toThrow('invalid engine name')
    await expect(client.run({ root, operation: 'start', gpus: ['display adapter'] }, true)).rejects.toThrow('invalid GPU device')
    const script = join(root, 'command.cjs')
    const original = await readFile(script, 'utf8')
    for (const [gpus, valid] of [[[], true], [['GPU-ab12', '3'], true], [null, false], ['0', false], [[false], false], [['display adapter'], false]] as const) {
      await writeFile(script, original.replace("engines: [{name:'main',", `engines: [{gpus:${JSON.stringify(gpus)},name:'main',`))
      if (valid) {
        expect((await client.run({ root, operation: 'status' })).engines?.[0]?.gpus).toEqual(gpus)
      } else {
        await expect(client.run({ root, operation: 'status' })).rejects.toThrow('unsupported dinkster-env response')
      }
    }
  })

  it('waits for a transient project writer only when confirming an idempotent start', async () => {
    const { root, client } = await commandFixture()
    const script = join(root, 'command.cjs')
    const original = await readFile(script, 'utf8')
    for (const [operation, confirmed, error, succeeds] of [
      ['start', true, `another environment writer holds ${root}`, true],
      ['start', true, `another environment writer holds ${root} (operation=unknown, pid=unknown, acquiredAt=unknown)`, true],
      ['start', true, `another environment writer holds ${root} (operation=update, pid=1234, acquiredAt=1794831050350215400)`, true],
      ['start', false, `another environment writer holds ${root} (operation=update, pid=1234, acquiredAt=1794831050350215400)`, false],
      ['update', true, `another environment writer holds ${root} (operation=update, pid=1234, acquiredAt=1794831050350215400)`, false],
      ['start', true, `another environment writer holds ${join(root, 'runtime')} (operation=update, pid=1234, acquiredAt=1794831050350215400)`, false],
      ['start', false, `another environment writer holds ${root}`, false],
      ['update', true, `another environment writer holds ${root}`, false],
      ['start', true, `another environment writer holds ${join(root, 'runtime')}`, false],
      ['start', true, 'engine assignment changed; stop it first', false],
    ] as const) {
      const marker = join(root, 'writer-released')
      await rm(marker, { force: true })
      await writeFile(script, `const f = require('node:fs');
        if (!f.existsSync(${JSON.stringify(marker)})) {
          f.writeFileSync(${JSON.stringify(marker)}, 'released');
          console.log(JSON.stringify({format:'dinkster.environment-result/1',operation:${JSON.stringify(operation)},
            root:${JSON.stringify(root)},current:2,plan:[],status:'error',error:${JSON.stringify(error)}}));
          process.exit(1);
        }\n` + original)
      const pending = client.run({ root, operation, engine: 'main' }, confirmed)
      if (succeeds) expect((await pending).engines?.[0]?.state).toBe('ready')
      else await expect(pending).rejects.toThrow(error)
    }
  })

  it('retries a read-only sandbox query only for its runtime lock', async () => {
    const { root, client } = await commandFixture()
    const script = join(root, 'command.cjs')
    const original = await readFile(script, 'utf8')
    const runtime = join(root, 'runtime')
    for (const [sandbox, lock, succeeds] of [
      [true, runtime, true],
      [false, runtime, false],
      [true, root, false],
      [true, join(root, 'other-runtime'), false],
    ] as const) {
      const marker = join(root, 'sandbox-lock-released')
      await rm(marker, { force: true })
      const error = `another environment writer holds ${lock} (operation=environment, pid=4350, acquiredAt=2026-11-19T02:15:08Z)`
      await writeFile(script, `const f = require('node:fs');
        if (!f.existsSync(${JSON.stringify(marker)})) {
          f.writeFileSync(${JSON.stringify(marker)}, 'released');
          console.log(JSON.stringify({format:'dinkster.environment-result/1',operation:'doctor',
            root:${JSON.stringify(root)},current:2,plan:[],status:'error',error:${JSON.stringify(error)}}));
          process.exit(1);
        }\n` + original)
      const pending = client.run({ root, operation: 'doctor', sandbox })
      if (succeeds) expect((await pending).status).toBe('clean')
      else await expect(pending).rejects.toThrow(error)
    }
  })

  it('rejects nonzero responses even when their status claims success, and surfaces drift details', async () => {
    const { root } = await commandFixture()
    for (const status of ['applied', 'drift']) {
      const client = new EnvironmentClient(process.execPath, ['-e', `console.log(JSON.stringify({
        format:'dinkster.environment-result/1',operation:'doctor',status:'${status}',
        root:${JSON.stringify(root)},current:2,plan:[],changes:['constraints.txt has drifted']
      }));process.exitCode=1;`, '--'])
      await expect(client.run({ root, operation: 'doctor' })).rejects.toThrow('constraints.txt has drifted')
    }
  })

  it('rejects unsafe requests and malformed responses instead of treating them as applied', async () => {
    const { root, client } = await commandFixture()
    await expect(client.run({ root: 'relative', operation: 'setup' })).rejects.toThrow('must be absolute')
    await expect(client.run({ root, operation: 'move' })).rejects.toThrow('absolute destination')
    await expect(client.run({ root, operation: 'setup', variant: '--cpu' })).rejects.toThrow('invalid environment variant')
    await expect(client.run({ root, operation: 'setup', port: 0 })).rejects.toThrow('invalid supervisor port')
    await expect(client.run({ root, operation: 'other' as EnvironmentOperation })).rejects.toThrow('unsupported')
    const malformed = new EnvironmentClient(process.execPath, ['-e', 'console.log(JSON.stringify({format:"other"}));', '--'])
    await expect(malformed.run({ root, operation: 'doctor' })).rejects.toThrow('unsupported dinkster-env response')
    await expect(new EnvironmentClient(join(root, 'absent-command')).run({ root, operation: 'doctor' })).rejects.toThrow('not installed')
  })
})
