import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { designConfigSchema } from '../src/main/designer'
import { downloadVerified } from '../src/main/download'
import { comfyCandidates, displayPath, isComfyInstall, loaderChoices, modelItem, modelPath, SetupAssistant, type SetupHost } from '../src/main/setup'
import { comfyPythonPath } from '../src/main/native-runtime'
import { launchIssues, modelUrl, setupLinks, setupModels, summarizeSetup, type SetupItem, type SetupState } from '../src/shared/setup'
import type { DesignerConfig } from '../src/shared/designer'
import type { Settings } from '../src/shared/types'

const temp = () => mkdtempSync(join(tmpdir(), 'studio-setup-'))
const config = (): DesignerConfig => designConfigSchema.parse({ imageProfile: 'sd15', checkpoint: '', controlnet: '', meshProfile: 'mini', meshCheckpoint: '', titleModel: '' })
function fakeComfy(root: string) {
  mkdirSync(join(comfyPythonPath(root), '..'), { recursive: true })
  writeFileSync(join(root, 'main.py'), '')
  writeFileSync(comfyPythonPath(root), '')
  return root
}
function fetcher(body: Buffer, url = 'https://cdn.example/file'): typeof fetch {
  return (async () => {
    const response = new Response(new Uint8Array(body), { headers: { 'content-length': String(body.length) } })
    Object.defineProperty(response, 'url', { value: url })
    return response
  }) as typeof fetch
}
function host(root: string, overrides: Partial<SetupHost> = {}) {
  let settings: Settings = { comfyUrl: 'http://127.0.0.1:1', comfyRoot: join(root, 'missing-comfy'), comfyOutput: join(root, 'missing-output'), blenderPath: join(root, 'missing-blender') }
  let designer = config()
  const opened: string[] = []
  const notified: SetupState[] = []
  const value: SetupHost = {
    root, appRoot: root, firstLaunch: true,
    settings: () => settings, saveSettings: next => (settings = next),
    startComfy: async () => {}, designerConfig: () => designer, saveDesignerConfig: next => { designer = next },
    choose: async () => null, openExternal: async url => { opened.push(url) }, notify: state => { notified.push(state) },
    ...overrides
  }
  return { value, opened, notified, settings: () => settings, designer: () => designer }
}

test('pinned Designer models have immutable revisions, checksums and valid Designer fields', () => {
  assert.equal(new Set(setupModels.map(m => m.id)).size, setupModels.length)
  for (const model of setupModels) {
    // The Designer schema is strict, so this fails for any field it does not define.
    assert.equal(designConfigSchema.parse({ ...config(), [model.configField]: model.file })[model.configField], model.file)
    assert.match(model.revision, /^[a-f0-9]{40}$/)
    assert.match(model.sha256, /^[a-f0-9]{64}$/)
    assert.ok(model.bytes > 100 * 1024 ** 2)
    assert.ok(model.path.endsWith(model.file))
    assert.ok(modelUrl(model).startsWith(`https://huggingface.co/${model.repo}/resolve/${model.revision}/`))
    assert.ok(model.licenseUrl.startsWith('https://'))
  }
  for (const url of Object.values(setupLinks)) assert.ok(url.startsWith('https://'))
})

test('workspace readiness requires every item the workspace depends on', () => {
  const item = (id: SetupItem['id'], status: SetupItem['status'], requiredFor: SetupItem['requiredFor']): SetupItem => ({ id, group: 'core', title: id, detail: '', status, requiredFor, actions: [] })
  assert.deepEqual(summarizeSetup([item('blender', 'done', ['animator']), item('comfy-running', 'todo', ['designer', 'animator']), item('ollama', 'optional', [])]), { designer: false, animator: false })
  assert.deepEqual(summarizeSetup([item('blender', 'todo', ['animator']), item('comfy-running', 'done', ['designer', 'animator']), item('ollama', 'optional', [])]), { designer: true, animator: false })
})

test('paths shown in the checklist hide the account home directory', () => {
  const home = join(tmpdir(), 'artist')
  assert.equal(displayPath(join(home, 'ComfyUI'), home), join('~', 'ComfyUI'))
  assert.equal(displayPath(join(tmpdir(), 'ComfyUI'), home), join(tmpdir(), 'ComfyUI'))
  assert.equal(displayPath(join(tmpdir(), 'artist2', 'ComfyUI'), home), join(tmpdir(), 'artist2', 'ComfyUI'))
})

test('ComfyUI detection requires main.py and its venv Python', () => {
  const root = temp()
  assert.equal(isComfyInstall(root), false)
  writeFileSync(join(root, 'main.py'), '')
  assert.equal(isComfyInstall(root), false)
  fakeComfy(root)
  assert.equal(isComfyInstall(root), true)
  assert.deepEqual(comfyCandidates({ LOCALAPPDATA: 'L:\\Local' }, 'H:\\Home', 'win32'), [join('L:\\Local', 'ComfyUI'), join('H:\\Home', 'Documents', 'ComfyUI'), join('H:\\Home', 'ComfyUI'), 'C:\\ComfyUI'])
})

test('verified downloads publish only matching files and remove partial data', async () => {
  const root = temp(), target = join(root, 'models', 'file.safetensors')
  const body = Buffer.from('pinned model bytes')
  const sha256 = createHash('sha256').update(body).digest('hex')
  const progress: number[] = []
  await downloadVerified('https://huggingface.co/x', target, { sha256, bytes: body.length }, { fetcher: fetcher(body), onProgress: p => progress.push(p.received) })
  assert.deepEqual(readFileSync(target), body)
  assert.equal(progress.at(-1), body.length)

  const other = join(root, 'models', 'bad.safetensors')
  await assert.rejects(downloadVerified('https://huggingface.co/x', other, { sha256: '0'.repeat(64), bytes: body.length }, { fetcher: fetcher(body) }), /checksum/)
  assert.equal(existsSync(other) || existsSync(other + '.part'), false)
  await assert.rejects(downloadVerified('https://huggingface.co/x', other, { sha256, bytes: body.length + 1 }, { fetcher: fetcher(body) }), /size/)
  await assert.rejects(downloadVerified('https://huggingface.co/x', other, { sha256 }, { fetcher: fetcher(body, 'http://insecure/file') }), /insecure/)
  await assert.rejects(downloadVerified('http://huggingface.co/x', other, { sha256 }), /HTTPS/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(downloadVerified('https://huggingface.co/x', other, { sha256 }, { fetcher: fetcher(body), signal: controller.signal }))
  assert.equal(existsSync(other) || existsSync(other + '.part'), false)
  const midway = new AbortController()
  const stalled: typeof fetch = (async () => {
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(body)); setTimeout(() => midway.abort(), 20) } })
    const response = new Response(stream)
    Object.defineProperty(response, 'url', { value: 'https://cdn.example/file' })
    return response
  }) as typeof fetch
  await assert.rejects(downloadVerified('https://huggingface.co/x', other, { sha256 }, { fetcher: stalled, signal: midway.signal }), /cancelled/)
  assert.equal(existsSync(other) || existsSync(other + '.part'), false)
})

test('model status respects exact files, mismatched files and existing Designer choices', async () => {
  const root = temp(), model = setupModels.find(m => m.id === 'flux2-vae')!
  assert.equal((await modelItem(model, root, undefined, config(), true)).status, 'todo')
  assert.equal((await modelItem(model, root, undefined, config(), false)).actions[0].disabled, 'Choose a ComfyUI folder first.')
  mkdirSync(join(root, 'models', model.folder), { recursive: true })
  writeFileSync(modelPath(root, model), 'truncated')
  assert.equal((await modelItem(model, root, undefined, config(), true)).status, 'warning')
  const checkpoint = setupModels.find(m => m.id === 'dreamshaper-8')!
  const chosen = { ...config(), checkpoint: 'sdxl/juggernaut.safetensors' }
  assert.equal((await modelItem(checkpoint, root, ['sdxl/juggernaut.safetensors'], chosen, true)).status, 'done')
  assert.equal((await modelItem(checkpoint, root, ['other/DreamShaper_8_pruned.safetensors'], config(), true)).status, 'done')
})

test('loader choices are read from both ComfyUI combo formats', () => {
  const nodes = {
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [['a.safetensors']] } } },
    ImageOnlyCheckpointLoader: { input: { required: { ckpt_name: ['COMBO', { options: ['b.safetensors'] }] } } }
  }
  assert.deepEqual(loaderChoices(nodes, 'checkpoints').sort(), ['a.safetensors', 'b.safetensors'])
  assert.deepEqual(loaderChoices(nodes, 'vae'), [])
})

test('first launch shows the checklist; existing installs opt in and preferences persist', async () => {
  const root = temp()
  assert.equal(new SetupAssistant(host(root).value).state().showOnLaunch, true)
  assert.equal(new SetupAssistant(host(temp(), { firstLaunch: false }).value).state().showOnLaunch, false)
  const assistant = new SetupAssistant(host(root).value)
  const state = await assistant.preferences({ showOnLaunch: false, completed: true })
  assert.equal(state.showOnLaunch, false)
  assert.ok(state.completedAt)
  const reopened = new SetupAssistant(host(root, { firstLaunch: false }).value).state()
  assert.equal(reopened.showOnLaunch, false)
  await assert.rejects(assistant.preferences({ showOnLaunch: 'yes' } as never))
})

test('setup actions only open allowlisted pages and save validated folders', async () => {
  const root = temp(), comfy = fakeComfy(join(root, 'ComfyUI'))
  const h = host(root, { choose: async kind => kind === 'comfy' ? comfy : null })
  const assistant = new SetupAssistant(h.value)
  await assistant.run({ item: 'kimodo-nodes', action: 'open-kimodo-nodes' })
  await assistant.run({ item: 'model:birefnet', action: 'open-model-license', model: 'birefnet' })
  assert.deepEqual(h.opened, [setupLinks.kimodoNodes, setupModels.find(m => m.id === 'birefnet')!.licenseUrl])
  await assert.rejects(assistant.run({ item: 'blender', action: 'run-anything' as never }))

  let state = await assistant.run({ item: 'comfy-install', action: 'browse-comfy' })
  assert.equal(state.result?.ok, true)
  assert.equal(h.settings().comfyRoot, comfy)
  assert.equal(h.settings().comfyOutput, join(comfy, 'output'))
  state = await assistant.run({ item: 'comfy-output', action: 'use-default-output' })
  assert.equal(state.result?.ok, true)
  assert.ok(existsSync(join(comfy, 'output')))
  assert.ok(h.notified.some(s => s.task?.action === 'use-default-output'))

  const wrong = new SetupAssistant(host(root, { choose: async () => root }).value)
  state = await wrong.run({ item: 'comfy-install', action: 'browse-comfy' })
  assert.equal(state.result?.ok, false)
  assert.match(state.result!.message, /main\.py/)
})

test('the checklist reports missing local tools as actionable steps', async () => {
  const root = temp()
  const report = await new SetupAssistant(host(root).value).report()
  const status = Object.fromEntries(report.items.map(item => [item.id, item.status]))
  assert.equal(status.blender, 'todo')
  assert.equal(status['comfy-install'], 'todo')
  assert.equal(status['comfy-running'], 'todo')
  assert.deepEqual(report.ready, { designer: false, animator: false })
  assert.ok(report.items.find(i => i.id === 'blender')!.actions.some(a => a.id === 'install-blender'))
  assert.equal(report.items.find(i => i.id === 'comfy-running')!.actions[0].disabled, 'Choose a ComfyUI folder first.')
  assert.equal(report.items.filter(i => i.group === 'designer').length, setupModels.length)
})

test('a missing Studio-managed Blender installs automatically once, but a chosen Blender is never replaced', async () => {
  const root = temp()
  const blender = async (overrides: Partial<SetupHost>, assistant = new SetupAssistant(host(root, overrides).value)) =>
    (await assistant.report()).items.find(i => i.id === 'blender')!
  const managed = { blenderPath: join(root, 'tools', 'blender-missing', 'blender.exe') }
  const withPath = (path: Partial<Settings>, extra: Partial<SetupHost> = {}) => {
    const h = host(root, extra)
    h.value.saveSettings({ ...h.value.settings(), ...path })
    return h.value
  }
  const auto = await blender({}, new SetupAssistant(withPath(managed)))
  assert.equal(auto.automatic, 'install-blender')
  assert.match(auto.detail, /installs an isolated, checksum-verified copy/)
  assert.equal((await blender({}, new SetupAssistant(withPath(managed, { autoInstall: false })))).automatic, undefined)
  const chosen = await blender({})
  assert.equal(chosen.automatic, undefined)
  assert.match(chosen.detail, /did not start/)
  assert.ok(chosen.actions.some(a => a.id === 'install-blender'))

  // After an attempt (here cancelled before any download), the install is offered but not restarted automatically.
  const assistant = new SetupAssistant(withPath(managed, { signal: AbortSignal.abort() }))
  const state = await assistant.run({ item: 'blender', action: 'install-blender' })
  assert.equal(state.result?.ok, false)
  const after = await blender({}, assistant)
  assert.equal(after.automatic, undefined)
  assert.ok(after.actions.some(a => a.id === 'install-blender'))
})

test('launch checks report unresolved requirements and honour ignored items until they work again', async () => {
  const root = temp(), output = join(root, 'output')
  mkdirSync(output)
  const h = host(root, { firstLaunch: false })
  const assistant = new SetupAssistant(h.value)
  assert.equal(assistant.state().checkOnLaunch, true)
  assert.deepEqual(assistant.state().ignoredAtLaunch, [])

  let result = await assistant.launchCheck()
  assert.equal(result.cancelled, false)
  if (result.cancelled) return
  const ids = result.issues.map(item => item.id)
  assert.ok(ids.includes('blender') && ids.includes('comfy-running') && ids.includes('comfy-output'))
  assert.ok(result.issues.every(item => item.requiredFor.length && item.status !== 'done'))
  assert.ok(!ids.includes('ollama'), 'optional items never interrupt a launch')

  await assistant.preferences({ ignoredAtLaunch: ['blender', 'comfy-output'], checkOnLaunch: false })
  result = await assistant.launchCheck()
  assert.ok(!result.cancelled && !result.issues.some(item => item.id === 'blender' || item.id === 'comfy-output'))

  // Once an ignored item works it is forgotten, so a later failure is reported again.
  h.value.saveSettings({ ...h.settings(), comfyOutput: output })
  await assistant.launchCheck()
  const reopened = new SetupAssistant(host(root, { firstLaunch: false }).value).state()
  assert.deepEqual(reopened.ignoredAtLaunch, ['blender'])
  assert.equal(reopened.checkOnLaunch, false)
  assert.equal(new SetupAssistant(host(temp(), { firstLaunch: false, quietLaunch: true }).value).state().checkOnLaunch, false)
  await assert.rejects(assistant.preferences({ ignoredAtLaunch: ['../../evil'] } as never))
})

test('launch checks can be cancelled and a new check supersedes the previous one', async () => {
  const assistant = new SetupAssistant(host(temp(), { firstLaunch: false }).value)
  const first = assistant.launchCheck()
  assistant.cancelLaunchCheck()
  assert.deepEqual(await first, { cancelled: true })
  const superseded = assistant.launchCheck()
  const latest = assistant.launchCheck()
  assert.deepEqual(await superseded, { cancelled: true })
  assert.equal((await latest).cancelled, false)
})

test('launch issues exclude finished, optional and ignored items', () => {
  const item = (id: SetupItem['id'], status: SetupItem['status'], requiredFor: SetupItem['requiredFor']): SetupItem => ({ id, group: 'core', title: id, status, detail: '', requiredFor, actions: [] })
  const items = [item('blender', 'todo', ['animator']), item('comfy-running', 'done', ['designer']), item('ollama', 'optional', []), item('comfy-output', 'warning', ['designer'])]
  assert.deepEqual(launchIssues(items, ['comfy-output']).map(i => i.id), ['blender'])
})
