import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { installationManager } from './installation-manager.mjs'
import { createServer } from 'node:http'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect } from '@playwright/test'

// This exercises Electron's client boundary, not generation assembly. The real
// shared-mirror fixture remains the environment command owner's responsibility.
if (process.env.DINKSTER_ISOLATED_SCENARIO === undefined) {
  for (const scenario of [
    'success',
    'start-failure',
    'stop-uncertain',
    'lost-response',
    'compatibility-changed',
    'health-failure',
    'composition-failure',
    'revision-changed',
    'document-changed',
    'selection-changed',
  ]) {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url)],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          DINKSTER_ISOLATED_SCENARIO: scenario,
          ...(process.env.DINKSTER_SMOKE_ARTIFACTS
            ? {
                DINKSTER_SMOKE_ARTIFACTS: join(
                  process.env.DINKSTER_SMOKE_ARTIFACTS,
                  scenario,
                ),
              }
            : {}),
        },
      },
    )
    assert.ifError(result.error)
    assert.equal(result.status, 0, `Electron project activation: ${scenario}`)
  }
  process.exit(0)
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const scratch = await mkdtemp(join(tmpdir(), 'dinkster-desktop-client-'))
const artifacts = process.env.DINKSTER_SMOKE_ARTIFACTS
if (artifacts) await mkdir(artifacts, { recursive: true })
const servers = []
const locationRequests = []
let activationFailure
let compositionPending = false
let revisionChangeAtHealth = false
let applyReady
let releaseApply
const applyHeld = new Promise((resolve) => {
  applyReady = resolve
})
let app
try {
  for (const heading of ['Original supervisor', 'Updated supervisor']) {
    const server = createServer(async (request, response) => {
      if (request.url === '/test/apply-held') {
        releaseApply = () => {
          releaseApply = undefined
          response.end('continue')
        }
        applyReady()
        return
      }
      if (request.url === '/api/nodes?wire=1') {
        response.setHeader('Content-Type', 'application/json')
        response.end(
          JSON.stringify({ dinkster: { services: { name: 'production' } } }),
        )
        return
      }
      if (request.url === '/api/health' || request.url === '/api/composition') {
        if (request.url === '/api/health' && revisionChangeAtHealth) {
          revisionChangeAtHealth = false
          const file = join(scratch, 'project-opening.json')
          const current = JSON.parse(await readFile(file, 'utf8'))
          await writeFile(
            file,
            JSON.stringify({ ...current, revision: current.revision + 1 }),
          )
        }
        const composing =
          request.url === '/api/composition' && compositionPending
        if (composing) compositionPending = false
        response.setHeader('Content-Type', 'application/json')
        response.end(
          JSON.stringify(
            request.url === '/api/health'
              ? {
                  ok: true,
                  compositionState: {
                    epoch: 2,
                    failed: activationFailure === 'health' ? 1 : 0,
                  },
                }
              : {
                  epoch: 2,
                  ...(composing ? { composing: true } : {}),
                  packs: {
                    'dinkster-text': {
                      state:
                        activationFailure === 'composition'
                          ? 'failed'
                          : composing
                            ? 'pending'
                            : 'announced',
                    },
                  },
                },
          ),
        )
        return
      }
      if (request.url.startsWith('/api/mounts/locations')) {
        locationRequests.push(new URL(request.url, 'http://localhost'))
        response.setHeader('Content-Type', 'application/json')
        response.end(
          JSON.stringify({
            vault: scratch,
            locations: [],
            activeMounts: [],
            mounts: [],
            pendingRemovals: [],
            restartRequired: false,
            resolvePath: false,
          }),
        )
        return
      }
      response.setHeader('Content-Type', 'text/html')
      response.end(
        `<!doctype html><title>${heading}</title><style>body{margin:0;background:#171717;color:#ededed;font:14px system-ui}.topbar{display:flex;align-items:center;justify-content:space-between;background:#202020}button{font:inherit;padding:8px 12px;color:inherit;background:#303030;border:1px solid #555;border-radius:6px}main{padding:24px}</style>
        ${heading === 'Updated supervisor' ? '<header class="topbar"><button id="menu" onclick="this.textContent=\'Menu opened\'">Menu</button><span>Dinkster project</span><button id="settings">Settings</button></header>' : ''}
        <main><h1>${heading}</h1></main>`,
      )
    })
    await new Promise((done) => server.listen(0, '127.0.0.1', done))
    servers.push(server)
  }
  const urls = servers.map(
    (server) => `http://127.0.0.1:${server.address().port}`,
  )
  const command = join(scratch, 'environment-command.cjs')
  const calls = join(scratch, 'calls.jsonl')
  const installed = join(scratch, 'installed.json')
  await writeFile(
    installed,
    JSON.stringify({
      base: {
        variant: 'studio-cuda',
        origin: 'user-defined',
        torchVersion: '2.14.1+cu130',
        torchIndex: 'https://download.pytorch.org/whl/cu130',
      },
    }),
  )
  await writeFile(
    command,
    String.raw`#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\n');
const root = args[args.indexOf('--root') + 1];
const operation = args[args.indexOf('--root') + 2];
const planned = args.includes('--plan');
const observed = ${JSON.stringify(join(scratch, 'observed.json'))};
const isolatedFile = ${JSON.stringify(join(scratch, 'isolated.json'))};
const isolated = fs.existsSync(isolatedFile) ? JSON.parse(fs.readFileSync(isolatedFile, 'utf8')) : undefined;
if (isolated && root === isolated.destination && !['project-get','project-check','packs-plan','packs-apply'].includes(operation)) {
  const row={format:'dinkster.environment-result/1',operation,status:['status','doctor'].includes(operation)?'clean':'applied',root,current:3,plan:[],
    engines:[{name:'main',generation:3,state:operation==='start'?'ready':operation==='stop'?'stopped':isolated.state,url:${JSON.stringify(urls[0])},gpus:[]}]};
  if(operation==='doctor') row.sandbox={format:'dinkster.sandbox-readiness/1',available:true,detail:'available'};
  if(operation==='start') {
    if(fs.readFileSync(${JSON.stringify(join(scratch, 'second-state.json'))},'utf8')!=='stopped') throw new Error('source still running');
    if(['start-failure','stop-uncertain'].includes(isolated.scenario)) {
      fs.writeFileSync(isolatedFile,JSON.stringify({...isolated,state:'ready'}));
      console.log(JSON.stringify({...row,status:'error',error:'isolated startup failed'}));process.exit(0);
    }
  }
  if(operation==='stop' && isolated.scenario==='stop-uncertain') {
    console.log(JSON.stringify({...row,status:'error',error:'isolated stop uncertain'}));process.exit(0);
  }
  if(operation==='start'||operation==='stop') fs.writeFileSync(isolatedFile,JSON.stringify({...isolated,state:row.engines[0].state}));
  console.log(JSON.stringify(row));process.exit(0);
}
if (operation === 'project-get' || operation === 'project-check') {
  const selection=JSON.parse(fs.readFileSync(${JSON.stringify(join(scratch, 'project-opening.json'))},'utf8'));
  const project={id:args[3],uid:'565e7ba1-c262-401d-83b1-7026465b6c39',name:'Opening project',revision:selection.revision ?? 1,deleted:false,
    environment:{id:isolated && isolated.scenario!=='selection-changed'?'c'.repeat(32):'b'.repeat(32),lastSnapshot:null,lastRunAt:null}};
  if(isolated && operation==='project-check') fs.writeFileSync(isolatedFile,JSON.stringify({...isolated,checks:(isolated.checks ?? 0)+1}));
  const error=(selection.refuse || (isolated?.scenario==='compatibility-changed' && isolated.checks>=1)) && operation==='project-check' ? 'library compatibility refused' : undefined;
  console.log(JSON.stringify({format:'dinkster.environment-result/1',operation,status:error?'error':'clean',root,current:root===isolated?.destination?3:1,plan:[],
    ...(error?{error}:{project,environment:{id:root===isolated?.destination?'c'.repeat(32):root===selection.target?'b'.repeat(32):'a'.repeat(32),snapshot:root===isolated?.destination?'3':'1'}})}));
  process.exit(0);
}
if (root === ${JSON.stringify(join(scratch, 'second-installation'))} && !['packs-plan','packs-apply'].includes(operation)) {
  const state=${JSON.stringify(join(scratch, 'second-state.json'))};
  const running=fs.existsSync(state) && fs.readFileSync(state,'utf8')==='ready';
  const row={format:'dinkster.environment-result/1',operation,status:operation==='status'||operation==='doctor'?'clean':'applied',root,current:1,plan:[],
    engines:[{name:'main',generation:1,state:operation==='stop'?'stopped':operation==='start'||running?'ready':'stopped',url:${JSON.stringify(urls[1])},gpus:[]}]};
  if(operation==='doctor') row.sandbox={format:'dinkster.sandbox-readiness/1',available:true,detail:'available'};
  if(operation==='start') {
    if(JSON.parse(fs.readFileSync(observed,'utf8')).engines.some(row=>row.state==='ready')) {
      console.log(JSON.stringify({...row,status:'error',error:'previous environment still running'}));process.exit(0);
    }
    const selection=JSON.parse(fs.readFileSync(${JSON.stringify(join(scratch, 'project-opening.json'))},'utf8'));
    fs.writeFileSync(state,'ready');
    if(selection.failStart) { console.log(JSON.stringify({...row,status:'error',error:'replacement failed'}));process.exit(0); }
  }
  if(operation==='stop') {
    const selection=JSON.parse(fs.readFileSync(${JSON.stringify(join(scratch, 'project-opening.json'))},'utf8'));
    if(selection.failStop) {console.log(JSON.stringify({...row,status:'error',error:'replacement stop uncertain'}));process.exit(0);}
    fs.writeFileSync(state,'stopped');
  }
  console.log(JSON.stringify(row));process.exit(0);
}
const cleanup = {
  policy:{automatic:false,previousSuccessfulActivations:2,minimumAgeSeconds:0},
  generations:[{generation:7,status:'retained',reasons:['current snapshot']}],
  quarantine:[{journal:'600.json',stage:'complete',generations:[2]}],
  warnings:['snapshot 2 awaits deletion']
};
if (operation === 'space') {
  console.log(JSON.stringify({format:'dinkster.environment-result/1',operation,status:'clean',root,current:7,plan:[],
    space:{format:'dinkster.space/1',observedAt:1,project:root,store:null,scope:'Managed software only',sharing:'Shared sizes overlap',
      complete:true,allocatedBytes:4096,observedAllocatedBytes:4096,sharedAllocatedBytes:0,
      eligibleGenerationReclaimableBytes:1024,automaticReclaimableBytes:0,additionalExplicitReclaimableBytes:0,
      policy:cleanup.policy,settingsCommand:'dinkster-env cleanup',settingsHelp:'Review snapshot cleanup before confirming.',
      generations:cleanup.generations.map(row=>({...row,allocationGroup:'builds/7'})),stores:[],
      groups:{'builds/7':{exclusiveAllocatedBytes:4096,sharedAllocatedBytes:0}},
      warnings:[],cleanupWarnings:[],eligibilityWarnings:[],reclaimabilityWarnings:[]}}));
  process.exit(0);
}
if (operation === 'cleanup') {
  console.log(JSON.stringify({format:'dinkster.environment-result/1',operation,status:planned?'planned':'complete',root,current:7,plan:[],cleanup}));
  process.exit(0);
}
if (operation === 'status') {
  const row = fs.existsSync(observed)
    ? JSON.parse(fs.readFileSync(observed, 'utf8'))
    : {format:'dinkster.environment-result/1',root,current:null,plan:[],engines:[]};
  console.log(JSON.stringify({...row, operation, status:'clean', cleanup}));
  process.exit(0);
}
if (operation === 'catalog') {
  const base = 'sha256:' + 'a'.repeat(64);
  console.log(JSON.stringify({format:'dinkster.environment-result/1',operation,status:'clean',root,current:null,plan:[],channel:'stable',
    variants:[{variant:'linux-cpu',base,downloadBytes:123456789,manifest:{format:'dinkster.base/1',id:base,variant:'linux-cpu',
      platform:{os:'linux',arch:'x86_64'},nvidia:null,parts:[]}}]}));
  process.exit(0);
}
if (operation === 'packs-plan') {
  const output = args[args.indexOf('--output') + 1];
  fs.mkdirSync(output);
  let projectReview;
  if(args.includes('--project')) {
    const selection=JSON.parse(fs.readFileSync(${JSON.stringify(join(scratch, 'project-opening.json'))},'utf8'));
    const project={id:args[args.indexOf('--project')+1],uid:'565e7ba1-c262-401d-83b1-7026465b6c39',name:'Opening project',revision:selection.revision ?? 1,deleted:false,
      environment:{id:isolated && isolated.scenario!=='selection-changed'?'c'.repeat(32):'b'.repeat(32),lastSnapshot:null,lastRunAt:null}};
    if(args[args.indexOf('--revision')+1]!==String(project.revision)) throw new Error('project revision mismatch');
    projectReview={library:root+'/private-library',environment:project.environment.id,project,projects:[{project,needs:{packs:['dinkster-text']}}]};
  }
  const destination=args.includes('--destination')?args[args.indexOf('--destination')+1]:undefined;
  if(destination) fs.writeFileSync(require('node:path').join(output,'fork.json'),JSON.stringify({destination}));
  console.log(JSON.stringify({format:'dinkster.environment-result/1',operation,status:'planned',root,current:1,
    plan:['Add dinkster-text 1.0.0'],packPlan:{format:'dinkster.project-pack-plan/1',root,current:1,...(projectReview?{projectReview}:{}),...(destination?{fork:{destination}}:{})},
    approval:'sha256:'+'c'.repeat(64),expiresInSeconds:900}));
  process.exit(0);
}
if(operation==='packs-apply' && args[args.indexOf('--scope')+1]==='only-project') {
  const fork=JSON.parse(fs.readFileSync(require('node:path').join(args[args.indexOf('--input')+1],'fork.json'),'utf8'));
  const metadata=JSON.parse(fs.readFileSync(${JSON.stringify(join(scratch, 'desktop', 'projects.json'))},'utf8'));
  if(!metadata.projects.some(row=>row.root===fork.destination)) throw new Error('destination has no saved native binding');
  fs.mkdirSync(fork.destination);
  fs.copyFileSync(require('node:path').join(root,'environment.json'),require('node:path').join(fork.destination,'environment.json'));
  const scenario=JSON.parse(fs.readFileSync(${JSON.stringify(join(scratch, 'project-opening.json'))},'utf8')).isolatedScenario;
  fs.writeFileSync(isolatedFile,JSON.stringify({...fork,state:'stopped',scenario}));
  if(scenario==='lost-response') {console.log('lost construction response');process.exit(0);}
  const complete=()=>{console.log(JSON.stringify({format:'dinkster.environment-result/1',operation,status:'applied',root,current:3,plan:[],engines:[],destination:fork.destination}));process.exit(0);};
  if(scenario==='document-changed') {fetch(${JSON.stringify(`${urls[0]}/test/apply-held`)}).then(complete);return;}
  complete();
}
const replacementState=${JSON.stringify(join(scratch, 'second-state.json'))};
if(operation==='start' && fs.existsSync(replacementState) && fs.readFileSync(replacementState,'utf8')==='ready') {
  console.log(JSON.stringify({format:'dinkster.environment-result/1',operation,status:'error',root,current:1,plan:[],error:'replacement still running'}));process.exit(0);
}
const updated = operation === 'update' || operation === 'packs-apply';
const url = ${JSON.stringify(urls)}[updated ? 1 : 0];
const row = {format:'dinkster.environment-result/1',operation,
status:operation === 'doctor' ? 'clean' : planned ? 'planned' : 'applied',root,current:updated ? 2 : 1,
...(operation === 'doctor' ? JSON.parse(fs.readFileSync(${JSON.stringify(installed)}, 'utf8')) : {}),
...(operation === 'source' ? (args.includes('release') ? {restoredFrom:7} : {sourceApproval:'sha256:'+'e'.repeat(64),source:'git',published:false,reproducible:true,sources:{engine:{commit:'a'.repeat(40)}}}) : {}),
...(args.includes('--frontend-version') ? {frontendApproval:'sha256:'+'b'.repeat(64),frontend:{version:args[args.indexOf('--frontend-version')+1]}} : {}),
...(operation === 'develop' ? {sourceApproval:'sha256:'+'d'.repeat(64), sourceDescription:'Unpublished development sources',
  development:{sources:args.filter((value) => value.startsWith('https://')).map((value) => {
    const url = new URL(value); const fields = new URLSearchParams(url.hash.slice(1)); url.hash = '';
    return {kind:'selected source',git:{url:url.href,requestedRef:fields.get('ref'),commit:'f'.repeat(40),subdirectory:fields.get('subdirectory') ?? '.'}};
  })}} : {}),
plan:['Reuse the shared wheel store', 'Start a healthy supervisor before switching current',
  ...(args.includes('--frontend-dev') ? ['proxy frontend dev server '+args[args.indexOf('--frontend-dev')+1]] : []),
  ...(args.includes('--allow-frontend-dev-remote') ? ['explicitly allow a non-loopback frontend dev server'] : [])],url,
engines:[{name:'main',generation:updated ? 2 : 1,state:operation === 'stop' ? 'stopped' : 'ready',url,
  gpus:args.flatMap((value,index)=>value==='--gpu'?[args[index+1]]:[])}]};
if (!planned && root !== ${JSON.stringify(join(scratch, 'second-installation'))}) fs.writeFileSync(observed, JSON.stringify(row));
console.log(JSON.stringify(row));
`,
    { mode: 0o755 },
  )
  const env = Object.fromEntries(
    [
      'PATH',
      'HOME',
      'DISPLAY',
      'XAUTHORITY',
      'XDG_RUNTIME_DIR',
      'SystemRoot',
      'TEMP',
      'TMP',
    ].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  )
  env.DINKSTER_DESKTOP_DATA = join(scratch, 'desktop')
  env.DINKSTER_ENV = command
  // The command stub does not write project settings. Replay the exact public
  // Stable envelope, authenticated by the app's production root without a test key.
  const mirror = join(scratch, 'mirror')
  await mkdir(join(mirror, 'channels'), { recursive: true })
  await writeFile(
    join(mirror, 'channels/stable.json'),
    await readFile(new URL('./stable-channel.txt', import.meta.url)),
  )
  await mkdir(join(scratch, 'installation'))
  await writeFile(
    join(scratch, 'installation/environment.json'),
    JSON.stringify({
      format: 'dinkster.project/1',
      channel: 'stable',
      mirrors: [mirror],
      variant: 'linux-cpu',
      port: 3639,
    }),
  )
  app = await electron.launch({
    executablePath:
      process.env.DINKSTER_ELECTRON_EXECUTABLE ??
      createRequire(join(root, 'packages/desktop/package.json'))('electron'),
    args: [
      '--no-sandbox',
      `--user-data-dir=${join(scratch, 'chromium')}`,
      join(root, 'packages/desktop'),
    ],
    env,
  })
  const manager = await installationManager(app)
  await manager.getByText('No projects yet.', { exact: false }).waitFor()
  await expect
    .poll(() =>
      manager
        .locator('header')
        .evaluate((bar) =>
          getComputedStyle(bar).getPropertyValue('-webkit-app-region'),
        ),
    )
    .toBe('drag')
  if (artifacts)
    await manager.screenshot({
      path: join(artifacts, 'projects-default.png'),
      fullPage: true,
    })
  await manager
    .getByText('Manage a local installation', { exact: true })
    .click()
  await manager.locator('#local-name').fill('Local studio')
  await manager.locator('#local-root').fill(join(scratch, 'installation'))
  await manager.locator('#local-mirrors').fill(mirror)
  await manager
    .getByRole('button', { name: 'Inspect hardware and variants' })
    .click()
  await expect(
    manager.locator('#local-variant option[value="linux-cpu"]'),
  ).toHaveCount(1)
  await expect(manager.locator('#local-variant')).toHaveValue('')
  await manager.locator('#local-variant').selectOption('linux-cpu')
  await expect(manager.locator('#hardware-reason')).toContainText(
    'Explicit override: CPU',
  )
  await expect(manager.locator('#hardware-reason')).toContainText(
    '123,456,789 bytes',
  )
  if (artifacts)
    await manager.screenshot({
      path: join(artifacts, 'hardware-cpu-choice.png'),
      fullPage: true,
    })
  await manager.getByRole('button', { name: 'Review environment plan' }).click()
  await manager.getByRole('button', { name: 'Confirm and apply' }).waitFor()
  let history = (await readFile(calls, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse)
  const catalog = history.find((args) => args[2] === 'catalog')
  const setup = history.filter((args) => args[2] === 'setup')
  assert(catalog && !catalog.includes('--plan') && !catalog.includes('--yes'))
  assert.equal(setup.length, 1)
  assert(setup[0].includes('--plan'))
  assert(!setup[0].includes('--yes'))
  assert.equal(setup[0][setup[0].indexOf('--engine') + 1], 'main')
  assert(history.every((args) => !args.includes('--yes')))
  if (artifacts)
    await manager.screenshot({
      path: join(artifacts, 'local-plan.png'),
      fullPage: true,
    })
  await manager.getByRole('button', { name: 'Confirm and apply' }).click()
  await manager
    .getByRole('button', { name: 'Open main', exact: true })
    .waitFor()
  const opened = app.waitForEvent('window')
  await manager.getByRole('button', { name: 'Open main', exact: true }).click()
  const engine = await opened
  await engine.getByRole('heading', { name: 'Original supervisor' }).waitFor()
  const engineOrigin = new URL(engine.url()).origin
  await expect
    .poll(() =>
      engine
        .locator('body')
        .evaluate((body) => getComputedStyle(body, '::before').content),
    )
    .toBe('"Dinkster Desktop"')
  if (artifacts)
    await engine.screenshot({
      path: join(artifacts, 'chrome-remote-fallback.png'),
    })
  assert.equal(
    await engine.evaluate(() => typeof window.dinksterProjects),
    'undefined',
  )
  assert.deepEqual(
    await engine.evaluate(() => Object.keys(window.dinksterDesktop).sort()),
    [
      'chooseDirectory',
      'fileCapabilities',
      'resolveDroppedFile',
      'revealFile',
      'revealModelLocation',
      'saveFile',
    ],
  )
  assert.deepEqual(
    await engine.evaluate(
      (url) => window.dinksterDesktop.fileCapabilities(url),
      engineOrigin,
    ),
    { nativeFolderChoice: true, reveal: true, resolvePath: false },
  )
  assert.deepEqual(
    await engine.evaluate(
      (url) => window.dinksterDesktop.fileCapabilities(url),
      urls[1],
    ),
    { nativeFolderChoice: false, reveal: false, resolvePath: false },
  )
  // Sharing the trusted origin does not grant an unrelated window file access.
  const untrusted = await app.evaluate(
    async ({ BrowserWindow, app, dialog }, url) => {
      const child = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: `${app.getAppPath()}/dist/preload.cjs`,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      })
      const original = dialog.showOpenDialog
      dialog.showOpenDialog = async () => {
        throw new Error('Untrusted request reached the dialog')
      }
      try {
        await child.loadURL(url)
        return await child.webContents.executeJavaScript(`(async () => {
        const bridge = window.dinksterDesktop
        const errors = []
        for (const action of [
          () => bridge.chooseDirectory(location.origin),
          () => bridge.revealFile(location.origin, '/ungranted'),
        ]) {
          try { await action(); errors.push('accepted') }
          catch (error) { errors.push(error.message) }
        }
        return { capabilities: await bridge.fileCapabilities(location.origin), errors }
      })()`)
      } finally {
        dialog.showOpenDialog = original
        child.destroy()
      }
    },
    engineOrigin,
  )
  assert.deepEqual(untrusted.capabilities, {
    nativeFolderChoice: false,
    reveal: false,
    resolvePath: false,
  })
  assert.equal(untrusted.errors.length, 2)
  for (const error of untrusted.errors)
    assert.match(error, /untrusted renderer/)
  // A cached window binding is insufficient after the environment loses readiness.
  const observedFile = join(scratch, 'observed.json')
  const observed = JSON.parse(await readFile(observedFile, 'utf8'))
  await writeFile(
    observedFile,
    JSON.stringify({
      ...observed,
      engines: [{ ...observed.engines[0], state: 'failed' }],
    }),
  )
  assert.deepEqual(
    await engine.evaluate(
      (url) => window.dinksterDesktop.fileCapabilities(url),
      engineOrigin,
    ),
    { nativeFolderChoice: false, reveal: false, resolvePath: false },
  )
  await writeFile(observedFile, JSON.stringify(observed))
  const projectsFile = join(env.DINKSTER_DESKTOP_DATA, 'projects.json')
  const savedProjects = await readFile(projectsFile, 'utf8')
  for (const change of ['none', 'generation', 'binding']) {
    await app.evaluate(({ dialog }) => {
      globalThis.originalFolderDialog = dialog.showOpenDialog
      globalThis.folderDialogEntered = false
      dialog.showOpenDialog = () =>
        new Promise((done) => {
          globalThis.finishFolderDialog = done
          globalThis.folderDialogEntered = true
        })
    })
    const chosen = engine.evaluate(async (url) => {
      try {
        return { path: await window.dinksterDesktop.chooseDirectory(url) }
      } catch (error) {
        return { error: error.message }
      }
    }, engineOrigin)
    await expect
      .poll(() => app.evaluate(() => globalThis.folderDialogEntered))
      .toBe(true)
    // Revoke authority only after the request reaches the asynchronous dialog.
    if (change === 'generation') {
      await writeFile(
        observedFile,
        JSON.stringify({
          ...observed,
          current: 2,
          engines: [{ ...observed.engines[0], generation: 2 }],
        }),
      )
    }
    if (change === 'binding') {
      await writeFile(
        projectsFile,
        JSON.stringify({ version: 1, projects: [] }),
      )
    }
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = globalThis.originalFolderDialog
      globalThis.finishFolderDialog({ canceled: false, filePaths: [path] })
    }, scratch)
    const result = await chosen
    if (change === 'none') assert.deepEqual(result, { path: scratch })
    if (change === 'generation') {
      assert.match(result.error, /no longer the selected ready snapshot/)
      assert.equal(result.path, undefined)
    }
    if (change === 'binding') {
      assert.match(result.error, /local project binding changed/)
      assert.equal(result.path, undefined)
    }
    await writeFile(observedFile, JSON.stringify(observed))
    await writeFile(projectsFile, savedProjects)
  }
  await engine.goto(`${engineOrigin}/?dinksterProject=p-shared`)
  const identity = {
    digest: `blake3:${'a1'.repeat(32)}`,
    scope: 'local',
    project: 'p-shared',
  }
  const deniedReveal = (asset) =>
    engine.evaluate(
      async ({ url, asset }) => {
        try {
          await window.dinksterDesktop.revealFile(url, asset)
          return 'unexpected success'
        } catch (error) {
          return error.message
        }
      },
      { url: engineOrigin, asset },
    )
  assert.match(await deniedReveal(identity), /No verified local copy/)
  assert.equal(locationRequests.at(-1).searchParams.get('project'), 'p-shared')
  const requests = locationRequests.length
  assert.match(
    await deniedReveal({ ...identity, project: 'default' }),
    /requesting project/,
  )
  assert.equal(locationRequests.length, requests)
  await engine.evaluate(() =>
    history.replaceState(null, '', '?dinksterProject=p-other'),
  )
  assert.match(await deniedReveal(identity), /No verified local copy/)
  assert.equal(locationRequests.at(-1).searchParams.get('project'), 'p-shared')
  assert.match(
    await deniedReveal({ ...identity, project: 'p-other' }),
    /requesting project/,
  )
  await engine.goto(`${engineOrigin}/?dinksterProject=invalid_project`)
  assert.deepEqual(
    await engine.evaluate(
      (url) => window.dinksterDesktop.fileCapabilities(url),
      engineOrigin,
    ),
    { nativeFolderChoice: false, reveal: false, resolvePath: false },
  )
  await engine.goto(engineOrigin)
  await manager
    .getByRole('button', { name: 'Manage main', exact: true })
    .click()
  await manager.locator('#local-operation').selectOption('update')
  await manager.getByRole('button', { name: 'Review environment plan' }).click()
  await manager.getByRole('button', { name: 'Confirm and apply' }).click()
  await engine.getByRole('heading', { name: 'Updated supervisor' }).waitFor()
  await expect
    .poll(() =>
      engine
        .locator('.topbar')
        .evaluate((bar) =>
          getComputedStyle(bar).getPropertyValue('-webkit-app-region'),
        ),
    )
    .toBe('drag')
  await expect
    .poll(() =>
      engine
        .locator('#menu')
        .evaluate((button) =>
          getComputedStyle(button).getPropertyValue('-webkit-app-region'),
        ),
    )
    .toBe('no-drag')
  await engine.getByRole('button', { name: 'Menu', exact: true }).click()
  await expect(engine.locator('#menu')).toHaveText('Menu opened')
  if (artifacts)
    await engine.screenshot({
      path: join(artifacts, 'chrome-engine-topbar.png'),
    })
  assert.equal(new URL(engine.url()).origin, engineOrigin)
  await manager
    .getByText('Environment operation completed.', { exact: false })
    .waitFor()
  await manager
    .locator('#local-operation')
    .selectOption({ label: 'Restore previous' })
  await expect(manager.locator('#local-operation')).toHaveValue('rollback')
  if (artifacts)
    await manager.screenshot({
      path: join(artifacts, 'restore-previous.png'),
      fullPage: true,
    })
  await manager.getByRole('button', { name: 'Review environment plan' }).click()
  await manager.getByRole('button', { name: 'Confirm and apply' }).click()
  await engine.getByRole('heading', { name: 'Original supervisor' }).waitFor()
  assert.equal(new URL(engine.url()).origin, engineOrigin)
  await manager
    .getByText('Environment operation completed.', { exact: false })
    .waitFor()
  // Exercise the actual Electron header boundary, not a directly supplied secret.
  const selection = { packs: [{ pack: 'dinkster-text', version: '1.0.0' }] }
  const postInstall = (path, body) =>
    engine.evaluate(
      async ({ path, body }) => {
        const response = await fetch(`/api/packs/install/${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        return { status: response.status, body: await response.json() }
      },
      { path, body },
    )
  const packReview = await postInstall('plan', selection)
  assert.equal(packReview.status, 200, JSON.stringify(packReview))
  assert.equal(packReview.body.plan.root, '<environment>')
  await engine.evaluate(() => {
    const frame = document.createElement('iframe')
    frame.src = '/untrusted-frame'
    document.body.append(frame)
  })
  const iframe = await engine
    .frameLocator('iframe')
    .locator('body')
    .evaluate(async (_body, body) => {
      const response = await fetch('/api/packs/install/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      return response.status
    }, selection)
  await engine.locator('iframe').evaluate((frame) => frame.remove())
  assert.equal(iframe, 403)
  const deniedWindow = await app.evaluate(
    async ({ BrowserWindow }, { url, body }) => {
      const child = new BrowserWindow({
        show: false,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      })
      try {
        await child.loadURL(url)
        return await child.webContents
          .executeJavaScript(`fetch('/api/packs/install/plan', {
        method:'POST',headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}
      }).then(response => response.status)`)
      } finally {
        child.destroy()
      }
    },
    { url: engineOrigin, body: selection },
  )
  assert.equal(deniedWindow, 403)
  await engine.evaluate(() => {
    window.retainedPackInstallDocument = 'unchanged'
  })
  for (const failure of ['health', 'composition']) {
    activationFailure = failure
    const refusedReview = await postInstall('plan', selection)
    assert.equal(refusedReview.status, 200)
    const refused = await postInstall('apply', {
      confirmation: refusedReview.body.confirmation,
    })
    assert.equal(refused.status, 409, JSON.stringify(refused))
    assert.deepEqual(refused.body, {
      error: 'activation-failed',
      generation: 2,
    })
    assert.equal(new URL(engine.url()).origin, engineOrigin)
    assert.equal(
      await engine.evaluate(() => window.retainedPackInstallDocument),
      'unchanged',
    )
    assert.equal(
      await engine.evaluate(() =>
        fetch('/')
          .then((response) => response.text())
          .then((text) => text.includes('Original supervisor')),
      ),
      true,
    )
    assert.equal(
      (
        await postInstall('apply', {
          confirmation: refusedReview.body.confirmation,
        })
      ).status,
      409,
    )
  }
  activationFailure = undefined
  compositionPending = true
  const healthyReview = await postInstall('plan', selection)
  assert.equal(healthyReview.status, 200)
  const packApplied = await postInstall('apply', {
    confirmation: healthyReview.body.confirmation,
  })
  assert.equal(packApplied.status, 200, JSON.stringify(packApplied))
  assert.equal(packApplied.body.generation, 2)
  assert.deepEqual(packApplied.body.activation.added, ['dinkster-text'])
  assert.equal(
    await engine.evaluate(() => window.retainedPackInstallDocument),
    'unchanged',
  )
  assert.equal(new URL(engine.url()).origin, engineOrigin)
  assert.equal(
    (
      await postInstall('apply', {
        confirmation: healthyReview.body.confirmation,
      })
    ).status,
    409,
  )
  assert.equal(
    await engine.evaluate(() =>
      fetch('/')
        .then((response) => response.text())
        .then((text) => text.includes('Updated supervisor')),
    ),
    true,
  )
  for (const operation of ['status', 'cleanup', 'space']) {
    await manager.locator('#local-operation').selectOption(operation)
    await manager
      .getByRole('button', { name: 'Review environment plan' })
      .click()
    await expect(manager.locator('#plan')).toContainText(
      'Automatic snapshot cleanup: off',
    )
    await expect(manager.locator('#plan')).toContainText(
      'Snapshot 7: retained - current snapshot',
    )
    await expect(manager.locator('#plan')).not.toContainText(
      /generation|rollback/i,
    )
    if (operation === 'space') {
      await expect(manager.locator('#plan')).toContainText('Environment:')
      await expect(manager.locator('#plan')).toContainText(
        'Eligible snapshot cleanup: 1,024 bytes',
      )
    } else {
      await expect(manager.locator('#plan')).toContainText(
        'snapshots 2 await retry',
      )
    }
    if (operation === 'cleanup')
      await expect(manager.locator('#apply')).toBeVisible()
    else await expect(manager.locator('#apply')).toBeHidden()
    if (artifacts)
      await manager.locator('#plan-panel').screenshot({
        path: join(artifacts, `snapshot-${operation}.png`),
      })
  }
  await manager.locator('#local-operation').selectOption('doctor')
  await manager.getByRole('button', { name: 'Review environment plan' }).click()
  await expect(manager.locator('#plan')).toContainText(
    'Variant: studio-cuda (user-defined)\nTorch: 2.14.1+cu130\nTorch index: https://download.pytorch.org/whl/cu130',
  )
  await expect(manager.locator('#apply')).toBeHidden()
  if (artifacts)
    await manager.locator('#plan-panel').screenshot({
      path: join(artifacts, 'user-defined-base.png'),
    })
  for (const labelled of [true, false]) {
    const baseLabel = '2026-11-01-py3.14.10-torch2.14.1-cu130-12345678'
    const engineLabel = '2026-11-02-0.4.2'
    await writeFile(
      installed,
      JSON.stringify({
        base: {
          variant: 'linux-nvidia',
          origin: 'published',
          torchVersion: '2.14.1+cu130',
          torchIndex: 'https://download.pytorch.org/whl/cu130',
          label: labelled ? baseLabel : null,
        },
        engine: {
          release: 'sha256:' + 'b'.repeat(64),
          version: '0.4.2',
          label: labelled ? engineLabel : null,
        },
      }),
    )
    await manager
      .getByRole('button', { name: 'Review environment plan' })
      .click()
    await expect(manager.locator('#plan')).toContainText(
      'Variant: linux-nvidia (published)',
    )
    await expect(manager.locator('#plan')).toContainText(
      'Engine: 0.4.2 (sha256:' + 'b'.repeat(64) + ')',
    )
    if (labelled) {
      await expect(manager.locator('#plan')).toContainText(
        `Base label: ${baseLabel}`,
      )
      await expect(manager.locator('#plan')).toContainText(
        `Engine label: ${engineLabel}`,
      )
    } else {
      await expect(manager.locator('#plan')).not.toContainText('Base label:')
      await expect(manager.locator('#plan')).not.toContainText('Engine label:')
    }
    if (artifacts)
      await manager.locator('#plan-panel').screenshot({
        path: join(
          artifacts,
          labelled ? 'installed-labels.png' : 'legacy-labels.png',
        ),
      })
  }
  if (artifacts)
    await manager.screenshot({
      path: join(artifacts, 'local-applied.png'),
      fullPage: true,
    })
  await manager.locator('#local-kind').selectOption('development')
  await manager
    .locator('#development-engine')
    .fill(join(scratch, 'engine checkout'))
  await manager
    .locator('#development-inference')
    .fill(join(scratch, 'inference'))
  await manager.locator('#development-helper').fill(join(scratch, 'helper'))
  await manager.locator('#development-packs').fill(join(scratch, 'pack one'))
  await manager
    .locator('#development-frontend')
    .fill(join(scratch, 'frontend dist'))
  await manager
    .getByRole('button', { name: 'Inspect hardware and variants' })
    .click()
  await manager.locator('#local-variant').selectOption('linux-cpu')
  if (artifacts)
    await manager
      .locator('#local-settings')
      .screenshot({ path: join(artifacts, 'development-setup.png') })
  await manager.getByRole('button', { name: 'Review environment plan' }).click()
  await manager.getByRole('button', { name: 'Confirm and apply' }).waitFor()
  let developmentCalls = (await readFile(calls, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse)
    .filter((args) => args[2] === 'develop')
  assert.equal(developmentCalls.length, 1)
  assert(developmentCalls[0].includes('--plan'))
  assert(!developmentCalls[0].includes('--approve'))
  await manager.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await expect(manager.locator('#apply')).toBeHidden()
  await manager.getByRole('button', { name: 'Review environment plan' }).click()
  await manager.getByRole('button', { name: 'Confirm and apply' }).click()
  await expect(manager.locator('#projects')).toContainText(
    'Development - unpublished sources',
  )
  await engine.getByRole('heading', { name: 'Original supervisor' }).waitFor()
  await expect
    .poll(() =>
      engine
        .locator('body')
        .evaluate((body) => getComputedStyle(body, '::after').content),
    )
    .toBe('"Development project - unpublished sources"')
  assert(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some(
        (window) =>
          window.getTitle() ===
          'Dinkster Desktop - Development - unpublished sources',
      ),
    ),
  )
  assert.equal(
    await engine.evaluate(() => typeof window.dinksterProjects),
    'undefined',
  )
  assert.deepEqual(
    await engine.evaluate(() => Object.keys(window.dinksterDesktop).sort()),
    [
      'chooseDirectory',
      'fileCapabilities',
      'resolveDroppedFile',
      'revealFile',
      'revealModelLocation',
      'saveFile',
    ],
  )
  developmentCalls = (await readFile(calls, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse)
    .filter((args) => args[2] === 'develop')
  assert.equal(developmentCalls.length, 3)
  const appliedDevelopment = developmentCalls[2]
  assert.equal(
    appliedDevelopment[appliedDevelopment.indexOf('--approve') + 1],
    'sha256:' + 'd'.repeat(64),
  )
  assert(appliedDevelopment.includes('--yes'))
  if (artifacts) {
    await manager
      .locator('#projects')
      .screenshot({ path: join(artifacts, 'development-project-list.png') })
    await engine.screenshot({ path: join(artifacts, 'development-engine.png') })
  }
  await manager.locator('#development-frontend').fill('')
  await manager
    .locator('#development-frontend-dev')
    .fill('http://192.0.2.1:5173')
  await manager.getByRole('button', { name: 'Review environment plan' }).click()
  await expect(manager.locator('#message')).toContainText('explicit permission')
  await expect(manager.locator('#apply')).toBeHidden()
  await manager.locator('#development-frontend-remote').check()
  await manager.getByRole('button', { name: 'Review environment plan' }).click()
  await expect(manager.locator('#apply')).toBeVisible()
  const remoteFrontendCall = (await readFile(calls, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse)
    .filter((args) => args[2] === 'develop')
    .at(-1)
  assert(remoteFrontendCall.includes('--allow-frontend-dev-remote'))
  assert.equal(
    remoteFrontendCall[remoteFrontendCall.indexOf('--frontend-dev') + 1],
    'http://192.0.2.1:5173',
  )
  if (artifacts) {
    await manager
      .locator('#development-sources')
      .screenshot({ path: join(artifacts, 'development-dev-server-setup.png') })
    await manager
      .locator('#plan-panel')
      .screenshot({ path: join(artifacts, 'development-dev-server-plan.png') })
  }
  await manager.getByRole('button', { name: 'Dismiss', exact: true }).click()
  const gitPack =
    'https://github.com/Kosinkadink/dinkster-nodes.git#ref=refs/pull/123/head&subdirectory=packages/dinkster-nodes-utilities'
  await manager.locator('#development-packs').fill(gitPack)
  await manager.locator('#development-frontend-dev').fill('')
  await manager.locator('#development-frontend-remote').uncheck()
  const gitFrontend =
    'https://github.com/Kosinkadink/Dinkster-Frontend.git#ref=selected-frontend'
  await manager.locator('#development-frontend-git').fill(gitFrontend)
  await manager.getByRole('button', { name: 'Review environment plan' }).click()
  await expect(manager.locator('#apply')).toBeVisible()
  await expect(manager.locator('#plan')).toContainText(
    'Requested ref: refs/pull/123/head',
  )
  await expect(manager.locator('#plan')).toContainText(
    `Resolved commit: ${'f'.repeat(40)}`,
  )
  await expect(manager.locator('#plan')).toContainText(
    'Package folder: packages/dinkster-nodes-utilities',
  )
  const gitCall = (await readFile(calls, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse)
    .filter((args) => args[2] === 'develop')
    .at(-1)
  assert.equal(gitCall[gitCall.indexOf('--pack-source') + 1], gitPack)
  assert(!gitCall.includes('--live-pack'))
  assert.equal(gitCall[gitCall.indexOf('--frontend-source') + 1], gitFrontend)
  assert(
    !gitCall.includes('--frontend-dev') && !gitCall.includes('--frontend-root'),
  )
  await expect(manager.locator('#plan')).toContainText(
    'Requested ref: selected-frontend',
  )
  if (artifacts) {
    await manager
      .locator('#development-sources')
      .screenshot({ path: join(artifacts, 'development-git-setup.png') })
    await manager
      .locator('#plan-panel')
      .screenshot({ path: join(artifacts, 'development-git-plan.png') })
  }
  await manager.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await manager.locator('#local-operation').selectOption('source')
  await expect(manager.locator('#source-settings')).toBeVisible()
  await manager.locator('#local-kind').selectOption('release')
  await expect(manager.locator('#source-settings')).toBeHidden()
  await expect(manager.locator('#development-sources')).toBeHidden()
  await manager.locator('#local-operation').selectOption('source')
  await manager
    .locator('#source-url')
    .fill('https://github.com/Kosinkadink/Dinkster.git')
  await manager.locator('#source-ref').fill('selected-managed-ref')
  await manager.getByRole('button', { name: 'Review environment plan' }).click()
  await expect(manager.locator('#apply')).toBeVisible()
  await expect(manager.locator('#plan')).toContainText(
    `"commit": "${'a'.repeat(40)}"`,
  )
  await manager.getByRole('button', { name: 'Confirm and apply' }).click()
  await expect(manager.locator('#message')).toContainText(
    'Environment operation completed',
  )
  let managedCall = (await readFile(calls, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse)
    .filter((args) => args[2] === 'source' && args.includes('--yes'))
    .at(-1)
  assert.equal(
    managedCall[managedCall.indexOf('--source-approval') + 1],
    `sha256:${'e'.repeat(64)}`,
  )
  assert(!managedCall.includes('--approve'))
  await manager.locator('#source-action').selectOption('release')
  await manager.getByRole('button', { name: 'Review environment plan' }).click()
  await expect(manager.locator('#plan')).toContainText(
    'Restore recorded release history entry: 7',
  )
  await manager.getByRole('button', { name: 'Confirm and apply' }).click()
  await expect(manager.locator('#message')).toContainText(
    'Environment operation completed',
  )
  managedCall = (await readFile(calls, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse)
    .filter((args) => args[2] === 'restore')
    .at(-1)
  assert.deepEqual(managedCall.slice(2), ['restore', '7', '--json', '--yes'])
  await manager.locator('#local-operation').selectOption('update')
  await manager.locator('#local-frontend-version').fill('0.3.2rc1')
  await manager.getByRole('button', { name: 'Review environment plan' }).click()
  await expect(manager.locator('#plan')).toContainText('0.3.2rc1')
  await manager.getByRole('button', { name: 'Confirm and apply' }).click()
  await expect(manager.locator('#message')).toContainText(
    'Environment operation completed',
  )
  managedCall = (await readFile(calls, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse)
    .filter((args) => args[2] === 'update' && args.includes('--yes'))
    .at(-1)
  assert.equal(
    managedCall[managedCall.indexOf('--frontend-approval') + 1],
    `sha256:${'b'.repeat(64)}`,
  )
  assert(
    !managedCall.includes('--source-approval') &&
      !managedCall.includes('--approve'),
  )
  if (artifacts)
    await manager
      .locator('#plan-panel')
      .screenshot({ path: join(artifacts, 'managed-frontend-plan.png') })
  await manager.locator('#name').fill('Remote studio')
  await manager.locator('#url').fill(urls[1])
  await manager.getByRole('button', { name: 'Save remote project' }).click()
  await manager.getByRole('button', { name: 'Open Remote engine' }).waitFor()
  const count = (await readFile(calls, 'utf8')).trim().split('\n').length
  const remoteOpened = app.waitForEvent('window')
  await manager.getByRole('button', { name: 'Open Remote engine' }).click()
  const remote = await remoteOpened
  await remote.getByRole('heading', { name: 'Updated supervisor' }).waitFor()
  assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, count)
  assert.equal(await remote.evaluate(() => typeof window.require), 'undefined')
  assert.equal(
    await remote.evaluate(() => typeof window.dinksterDesktop),
    'undefined',
  )
  const dataFiles = await readdir(env.DINKSTER_DESKTOP_DATA)
  for (const forbidden of [
    'builds',
    'generations',
    'current',
    'store',
    'journal',
  ])
    assert(!dataFiles.includes(forbidden))
  // Windows detection is mocked here; the UI and variant rule run unchanged.
  for (const driver of ['524.99', '580.10']) {
    await app.evaluate(
      async ({ ipcMain }, input) => {
        const require = process
          .getBuiltinModule('node:module')
          .createRequire(input.module)
        const { planVariant } = require(input.module)
        ipcMain.removeHandler('desktop:projects-inspect')
        ipcMain.handle('desktop:projects-inspect', (_event, request) => {
          const platform = { os: 'windows', arch: 'x86_64' }
          const manifests = [
            {
              variant: 'win-nvidia',
              platform,
              nvidia: {
                minimumDriver: '580',
                minimumComputeCapability: '7.5',
                maximumExclusiveComputeCapability: null,
              },
            },
            {
              variant: 'win-nvidia-cu126',
              platform,
              nvidia: {
                minimumDriver: '525',
                minimumComputeCapability: '5.0',
                maximumExclusiveComputeCapability: '10.0',
              },
            },
            { variant: 'win-cpu', platform, nvidia: null },
          ]
          const hardware = {
            gpus: [
              {
                id: '0',
                name: 'Display GPU',
                driver: input.driver,
                computeCapability: '6.1',
              },
              {
                id: '1',
                name: 'Compute GPU',
                driver: input.driver,
                computeCapability: '8.9',
              },
            ],
          }
          return {
            hardware,
            plan: planVariant(manifests, hardware, request.gpus, 'win32'),
            result: {
              format: 'dinkster.environment-result/1',
              operation: 'catalog',
              status: 'clean',
              root: request.root,
              current: null,
              plan: [],
              variants: manifests.map((manifest) => ({
                variant: manifest.variant,
                downloadBytes: 123456789,
                manifest,
              })),
            },
          }
        })
      },
      {
        driver,
        module: join(root, 'packages/desktop/dist/hardware.js'),
      },
    )
    await manager.locator('#local-gpus').fill('1')
    await manager
      .getByRole('button', { name: 'Inspect hardware and variants' })
      .click()
    if (driver === '524.99') {
      await expect(manager.locator('#local-variant')).toHaveValue('')
      await expect(manager.locator('#hardware-reason')).toContainText(
        'Requires NVIDIA driver 525',
      )
      await expect(
        manager.locator('#local-variant option[value="win-cpu"]'),
      ).toHaveCount(1)
      if (artifacts)
        await manager
          .locator('#local-settings')
          .screenshot({ path: join(artifacts, 'hardware-old-driver.png') })
      await manager.locator('#local-variant').selectOption('win-cpu')
      await expect(manager.locator('#hardware-reason')).toContainText(
        'Explicit override: CPU',
      )
    } else {
      await expect(manager.locator('#local-variant')).toHaveValue('win-nvidia')
      await expect(manager.locator('#hardware-reason')).toContainText(
        'lowest compute capability 8.9',
      )
      if (artifacts)
        await manager
          .locator('#local-settings')
          .screenshot({ path: join(artifacts, 'hardware-assigned-gpu.png') })
      await manager.locator('#local-variant').selectOption('win-nvidia-cu126')
      await expect(manager.locator('#hardware-reason')).toContainText(
        'Explicit override:',
      )
      if (artifacts)
        await manager
          .locator('#local-settings')
          .screenshot({ path: join(artifacts, 'hardware-override.png') })
    }
  }
  await app.evaluate(({ app: instance }) => {
    instance.quit()
  })
  await expect
    .poll(async () => (await readFile(calls, 'utf8')).includes('"stop"'))
    .toBe(true)
  history = (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(
    history.filter((args) => args.includes('--yes')).map((args) => args[2]),
    [
      'setup',
      'start',
      'update',
      'rollback',
      'develop',
      'source',
      'restore',
      'update',
      'stop',
    ],
  )
  await app.close()
  app = undefined
  const opening = join(scratch, 'project-opening.json')
  const firstRoot = join(scratch, 'installation')
  const secondRoot = join(scratch, 'second-installation')
  await mkdir(secondRoot)
  await writeFile(
    join(secondRoot, 'environment.json'),
    await readFile(join(firstRoot, 'environment.json')),
  )
  await writeFile(
    join(env.DINKSTER_DESKTOP_DATA, 'projects.json'),
    JSON.stringify({
      version: 1,
      projects: [firstRoot, secondRoot].map((root, index) => ({
        id: index ? 'second' : 'first',
        name: index ? 'Second environment' : 'First environment',
        root,
        channel: 'stable',
        engines: [{ id: 'main', name: 'Main', kind: 'local', gpus: [] }],
      })),
    }),
  )
  await writeFile(
    join(scratch, 'observed.json'),
    JSON.stringify({
      format: 'dinkster.environment-result/1',
      root: firstRoot,
      current: 1,
      plan: [],
      engines: [
        {
          name: 'main',
          generation: 1,
          state: 'ready',
          url: urls[0],
          gpus: ['GPU-ab12', '3'],
        },
      ],
    }),
  )
  await writeFile(opening, JSON.stringify({ target: secondRoot }))
  app = await electron.launch({
    executablePath:
      process.env.DINKSTER_ELECTRON_EXECUTABLE ??
      createRequire(join(root, 'packages/desktop/package.json'))('electron'),
    args: [
      '--no-sandbox',
      `--user-data-dir=${join(scratch, 'opening-chromium')}`,
      join(root, 'packages/desktop'),
    ],
    env,
  })
  await installationManager(app)
  const library = app
    .windows()
    .find((page) => page.url().endsWith('/desktop-library.html'))
  assert.ok(library, 'the engine-free library window is present')
  await library.waitForFunction(
    () => typeof window.dinksterLibrary?.open === 'function',
  )
  const oldOwner = await readFile(join(scratch, 'observed.json'), 'utf8')
  const legacyOwner = JSON.parse(oldOwner)
  delete legacyOwner.engines[0].gpus
  await writeFile(join(scratch, 'observed.json'), JSON.stringify(legacyOwner))
  await assert.rejects(
    library.evaluate(() => window.dinksterLibrary.open('first', 'beta')),
    /cannot report the running GPU assignment/,
  )
  assert.equal(
    await readFile(join(scratch, 'observed.json'), 'utf8'),
    JSON.stringify(legacyOwner),
  )
  await writeFile(join(scratch, 'observed.json'), oldOwner)
  await writeFile(opening, JSON.stringify({ target: secondRoot, refuse: true }))
  await assert.rejects(
    library.evaluate(() => window.dinksterLibrary.open('first', 'beta')),
    /library compatibility refused/,
  )
  assert.equal(
    await readFile(join(scratch, 'observed.json'), 'utf8'),
    oldOwner,
    'preflight refusal preserves the running owner',
  )
  await writeFile(
    opening,
    JSON.stringify({ target: secondRoot, failStart: true }),
  )
  await assert.rejects(
    library.evaluate(() => window.dinksterLibrary.open('first', 'beta')),
    /replacement failed/,
  )
  assert.equal(
    await readFile(join(scratch, 'second-state.json'), 'utf8'),
    'stopped',
    'a partially started replacement is stopped before recovery',
  )
  assert.equal(
    JSON.parse(await readFile(join(scratch, 'observed.json'), 'utf8'))
      .engines[0].state,
    'ready',
  )
  assert.deepEqual(
    JSON.parse(await readFile(join(scratch, 'observed.json'), 'utf8'))
      .engines[0].gpus,
    ['GPU-ab12', '3'],
    'recovery retains the observed ordered assignment rather than the empty saved selection',
  )
  await writeFile(
    opening,
    JSON.stringify({ target: secondRoot, failStart: true, failStop: true }),
  )
  await assert.rejects(
    library.evaluate(() => window.dinksterLibrary.open('first', 'beta')),
    /saved environments are retained for recovery/,
  )
  assert.equal(
    JSON.parse(await readFile(join(scratch, 'observed.json'), 'utf8'))
      .engines[0].state,
    'stopped',
    'an uncertain replacement stop must not restart the old environment',
  )
  assert.equal(
    await readFile(join(scratch, 'second-state.json'), 'utf8'),
    'ready',
  )
  // Independent successful-switch control after the explicit recovery refusal.
  await writeFile(join(scratch, 'observed.json'), oldOwner)
  await writeFile(join(scratch, 'second-state.json'), 'stopped')
  await writeFile(opening, JSON.stringify({ target: secondRoot }))
  await library.evaluate(() => window.dinksterLibrary.open('first', 'beta'))
  assert.equal(
    JSON.parse(await readFile(join(scratch, 'observed.json'), 'utf8'))
      .engines[0].state,
    'stopped',
  )
  assert.equal(
    await readFile(join(scratch, 'second-state.json'), 'utf8'),
    'ready',
  )
  const projectPage = app
    .windows()
    .find(
      (page) =>
        new URL(page.url()).searchParams.get('dinksterProject') === 'beta',
    )
  assert.ok(
    projectPage,
    'the target window carries the authoritative library project',
  )
  await projectPage.waitForLoadState()
  await expect(
    projectPage.getByRole('heading', { name: 'Updated supervisor' }),
  ).toBeVisible()
  assert.equal(
    await projectPage.evaluate(() => typeof window.dinksterLibrary),
    'undefined',
  )
  const projectOrigin = new URL(projectPage.url()).origin
  assert.equal(
    await projectPage.evaluate(
      (url) =>
        window.dinksterDesktop
          .fileCapabilities(url)
          .then((value) => value.nativeFolderChoice),
      projectOrigin,
    ),
    true,
  )
  assert.equal(locationRequests.at(-1).searchParams.get('project'), 'beta')
  const projectInstall = (action, body) =>
    projectPage.evaluate(
      async ({ action, body }) => {
        const response = await fetch(`/api/packs/install/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        return { status: response.status, body: await response.json() }
      },
      { action, body },
    )
  assert.equal((await projectInstall('plan', selection)).status, 400)
  const sharedSelection = { ...selection, scope: 'every-project' }
  const projectReview = await projectInstall('plan', sharedSelection)
  assert.equal(projectReview.status, 200, JSON.stringify(projectReview))
  assert.equal(projectReview.body.plan.projectReview.project.id, 'beta')
  assert.equal(projectReview.body.plan.projectReview.library, '<library>')
  await writeFile(opening, JSON.stringify({ target: secondRoot, revision: 2 }))
  assert.deepEqual(
    await projectInstall('apply', {
      confirmation: projectReview.body.confirmation,
    }),
    {
      status: 409,
      body: { error: 'plan-stale' },
    },
  )
  const currentReview = await projectInstall('plan', sharedSelection)
  assert.equal(currentReview.status, 200, JSON.stringify(currentReview))
  await projectPage.evaluate(() => {
    window.retainedLibraryDocument = 'unchanged'
  })
  const libraryApplied = await projectInstall('apply', {
    confirmation: currentReview.body.confirmation,
  })
  assert.equal(libraryApplied.status, 200, JSON.stringify(libraryApplied))
  assert.equal(
    await projectPage.evaluate(() => window.retainedLibraryDocument),
    'unchanged',
  )
  assert.equal(new URL(projectPage.url()).origin, projectOrigin)
  const projectCalls = (await readFile(calls, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse)
  const lastPlan = projectCalls.findLast((args) => args[2] === 'packs-plan')
  assert.equal(lastPlan[lastPlan.indexOf('--project') + 1], 'beta')
  assert.equal(lastPlan[lastPlan.indexOf('--revision') + 1], '2')
  const lastApply = projectCalls.findLast((args) => args[2] === 'packs-apply')
  assert.equal(lastApply[lastApply.indexOf('--scope') + 1], 'every-project')
  const isolatedScenario = process.env.DINKSTER_ISOLATED_SCENARIO ?? 'success'
  assert.ok(
    [
      'success',
      'start-failure',
      'stop-uncertain',
      'lost-response',
      'compatibility-changed',
      'health-failure',
      'composition-failure',
      'revision-changed',
      'document-changed',
      'selection-changed',
    ].includes(isolatedScenario),
  )
  await writeFile(
    opening,
    JSON.stringify({ target: secondRoot, revision: 2, isolatedScenario }),
  )
  const isolatedReview = await projectInstall('plan', {
    ...selection,
    scope: 'only-project',
  })
  assert.equal(isolatedReview.status, 200, JSON.stringify(isolatedReview))
  assert.equal(
    isolatedReview.body.plan.fork.destination,
    '<separate environment>',
  )
  compositionPending = true
  revisionChangeAtHealth = isolatedScenario === 'revision-changed'
  if (isolatedScenario === 'health-failure') activationFailure = 'health'
  if (isolatedScenario === 'composition-failure')
    activationFailure = 'composition'
  const beforeIsolatedApply = (await readFile(calls, 'utf8'))
    .trim()
    .split('\n').length
  const applying = projectInstall('apply', {
    confirmation: isolatedReview.body.confirmation,
  }).catch((error) => {
    if (isolatedScenario !== 'document-changed') throw error
    return { navigationError: error }
  })
  if (isolatedScenario === 'document-changed') {
    await applyHeld
    await projectPage.reload()
    await projectPage.waitForLoadState()
    releaseApply()
  }
  const isolatedApplied = await applying
  if (isolatedScenario === 'document-changed') {
    assert.match(
      String(isolatedApplied.navigationError),
      /context was destroyed|navigation|Target.*closed|Failed to fetch/i,
    )
    await expect
      .poll(
        async () => (await projectInstall('plan', sharedSelection)).body.error,
      )
      .toBe('plan-stale')
  } else {
    assert.equal(
      isolatedApplied.status,
      isolatedScenario === 'success'
        ? 200
        : isolatedScenario === 'lost-response'
          ? 422
          : 409,
      JSON.stringify(isolatedApplied),
    )
    if (isolatedScenario !== 'success')
      assert.deepEqual(
        isolatedApplied.body,
        isolatedScenario === 'lost-response'
          ? { error: 'apply-failed' }
          : { error: 'activation-failed', generation: 3 },
      )
  }
  assert.equal(
    await projectPage.evaluate(() => window.retainedLibraryDocument),
    isolatedScenario === 'document-changed' ? undefined : 'unchanged',
  )
  assert.equal(new URL(projectPage.url()).origin, projectOrigin)
  await expect(
    projectPage.getByRole('heading', { name: 'Updated supervisor' }),
  ).toBeVisible()
  assert.equal(
    await readFile(join(scratch, 'second-state.json'), 'utf8'),
    !['success', 'stop-uncertain'].includes(isolatedScenario)
      ? 'ready'
      : 'stopped',
  )
  const forked = JSON.parse(
    await readFile(join(scratch, 'isolated.json'), 'utf8'),
  )
  assert.equal(
    forked.state,
    ['success', 'stop-uncertain'].includes(isolatedScenario)
      ? 'ready'
      : 'stopped',
  )
  const savedFork = JSON.parse(
    await readFile(projectsFile, 'utf8'),
  ).projects.find((entry) => entry.root === forked.destination)
  assert.ok(
    savedFork,
    'the separate environment remains resolvable by its saved native binding',
  )
  const subsequent = await projectInstall('plan', sharedSelection)
  assert.equal(
    subsequent.status,
    ['success', 'selection-changed'].includes(isolatedScenario) ? 200 : 409,
    JSON.stringify(subsequent),
  )
  const isolatedCalls = (await readFile(calls, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse)
  const handoffCalls = isolatedCalls.slice(beforeIsolatedApply)
  if (
    [
      'compatibility-changed',
      'lost-response',
      'document-changed',
      'selection-changed',
    ].includes(isolatedScenario)
  ) {
    assert.ok(
      !handoffCalls.some((args) => ['start', 'stop'].includes(args[2])),
      'a missing construction response or failed compatibility preflight never stops the source',
    )
  }
  if (isolatedScenario === 'stop-uncertain') {
    assert.ok(
      handoffCalls.some(
        (args) => args[1] === forked.destination && args[2] === 'stop',
      ),
    )
    assert.ok(
      !handoffCalls.some(
        (args) => args[1] === secondRoot && args[2] === 'start',
      ),
      'an uncertain replacement stop must not restart the source',
    )
  }
  const nextPlan = isolatedCalls.findLast((args) => args[2] === 'packs-plan')
  assert.equal(
    nextPlan[1],
    isolatedScenario === 'success' ? forked.destination : secondRoot,
    'later commands follow the new native binding or refuse the recovered stale selection',
  )
  assert.equal(nextPlan[nextPlan.indexOf('--project') + 1], 'beta')
  await projectPage.goto(`${projectOrigin}/?dinksterProject=other`)
  assert.deepEqual(
    await projectPage.evaluate(
      (url) => window.dinksterDesktop.fileCapabilities(url),
      projectOrigin,
    ),
    {
      nativeFolderChoice: false,
      reveal: false,
      resolvePath: false,
    },
  )
  assert.deepEqual(await projectInstall('plan', sharedSelection), {
    status: 409,
    body: { error: 'plan-stale' },
  })
  console.log(
    `Electron client boundary passed (${isolatedScenario}): plan/confirm, startup, new-port update, rollback, retained document, replay refusal, remote-only routing, identity-checked stop, authoritative library opening, preflight-before-stop, failed replacement recovery and project-scoped navigation.`,
  )
} catch (error) {
  console.error(error)
  console.error(
    await readFile(join(scratch, 'desktop/logs/desktop.log'), 'utf8').catch(
      () => 'No Desktop log',
    ),
  )
  console.error(await readFile(join(scratch, 'calls.jsonl'), 'utf8'))
  const manager = app
    ?.windows()
    .find(
      (page) =>
        page.url().startsWith('file:') && page.url().includes('projects'),
    )
  if (manager && !manager.isClosed()) {
    console.error(
      'Project manager status:',
      await manager.locator('#message').textContent(),
    )
    if (artifacts)
      await manager.screenshot({
        path: join(artifacts, 'client-failure.png'),
        fullPage: true,
      })
  }
  throw error
} finally {
  releaseApply?.()
  if (app) await app.close().catch(() => {})
  await Promise.all(
    servers.map((server) => new Promise((done) => server.close(done))),
  )
  await rm(scratch, { recursive: true, force: true })
}
