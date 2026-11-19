import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { EnvironmentClient } from '../src/environment.js'
import { DesktopLibrary } from '../src/library.js'
import { writeProjects } from '../src/projects.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

it('browses only saved local installations and keeps project pages separate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-library-'))
  roots.push(root)
  await writeProjects(root, { version: 1, projects: [
    { id: 'local', name: 'Local studio', root: join(root, 'install'), channel: 'stable', engines: [{ id: 'main', name: 'Main', kind: 'local', gpus: [] }] },
    { id: 'remote', name: 'Remote studio', channel: 'nightly', engines: [{ id: 'server', name: 'Server', kind: 'remote', url: 'https://example.test' }] },
  ] })
  const script = join(root, 'command.cjs')
  const asset = { digest: `sha256:${'a'.repeat(64)}`, name: 'Image', size: 19, mediaType: 'image/png' }
  await writeFile(script, `
    const args=process.argv.slice(2), kind=args[3], project=args[args.indexOf('--project')+1];
    if(args.includes('--yes') || args.includes('--plan') || args[2]!=='library-list') process.exit(2);
    const library={kind,cursor:args.includes('--cursor=next') ? null : 'next',
      ...(kind==='projects' ? {items:[{id:'beta',name:'Beta'}]} :
      kind==='workflows' ? {records:[{id:'workflow-b',name:'Workflow B',scope:'local',project,mediaType:'application/x-dinkster-workflow+json'}]} :
      {assets:[{asset:${JSON.stringify(asset)},observations:[{project}],aliases:['Image']}]})};
    console.log(JSON.stringify({format:'dinkster.environment-result/1',operation:'library-list',status:'clean',root:args[1],current:null,plan:[],library}));
  `)
  const client = new EnvironmentClient(process.execPath, [script])
  const library = new DesktopLibrary(root, client)
  expect(await library.installations()).toEqual([{ id: 'local', name: 'Local studio' }])
  expect(await library.projects('local', null)).toEqual({ items: [{ id: 'beta', name: 'Beta' }], cursor: 'next' })
  expect(await library.workflows('local', 'beta', 'next')).toEqual({ items: [{ id: 'workflow-b', name: 'Workflow B' }], cursor: null })
  expect(await library.assets('local', 'beta', null)).toEqual({ items: [{ id: asset.digest, name: 'Image' }], cursor: 'next' })
  const notice = 'By the way, these projects and files cannot be shown with the installed tools.'
  await expect(library.projects(join(root, 'install'), null)).rejects.toThrow(notice)
  await expect(library.projects('remote', null)).rejects.toThrow(notice)
  await expect(library.assets('local', '../beta', null)).rejects.toThrow(notice)
  const original = await readFile(script, 'utf8')
  await writeFile(script, original.replace('scope:\'local\',project,', 'scope:\'local\',project:\'other\','))
  await expect(library.workflows('local', 'beta', null)).rejects.toThrow(notice)
  await writeFile(script, original.replace('observations:[{project}]', "observations:[{project:'other'}]"))
  await expect(library.assets('local', 'beta', null)).rejects.toThrow(notice)
  await client.dispose()
})
