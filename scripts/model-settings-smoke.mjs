import { _electron as electron, expect } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Persisted custom selections and disconnected backend; no weights or inference.
const directory = await mkdtemp(join(tmpdir(), 'studio-model-settings-'))
await writeFile(join(directory, 'studio.json'), JSON.stringify({
  settings: { comfyUrl: 'http://127.0.0.1:1', comfyRoot: directory, comfyOutput: directory,
    blenderPath: join(directory, 'unused.exe'), textEncoder: 'lfm' },
  characters: [], jobs: [], plans: [], batches: []
}))
await writeFile(join(directory, 'designer.json'), JSON.stringify({
  config: { imageProfile: 'sdxl', checkpoint: 'saved-custom.safetensors', controlnet: '',
    meshProfile: 'textured', meshCheckpoint: '', titleModel: '' }, references: [], designs: []
}))
const remote = { provider: 'api', location: 'remote', endpoint: 'https://studio.example',
  model: 'saved-mesh', minVramGB: 0 }
await writeFile(join(directory, 'ai-providers.json'), JSON.stringify({
  configuration: { version: 1, stages: { mesh: remote } }, history: []
}))
let app, client
const errors = []
const until = (probe, message) => expect.poll(probe, { timeout: 20000, intervals: [100, 250], message }).toBeTruthy()
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args })
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`)
  return JSON.parse(result.content[0].text)
}
const ui = () => call('studio_get_ui')
const state = () => call('studio_get_state')
const locate = async (name, role) => {
  let element
  await until(async () => {
    const matches = (await ui()).elements.filter(item => item.name === name && item.role === role)
    assert.ok(matches.length < 2, `Ambiguous ${name}`)
    element = matches[0]
    return !!element && !element.disabled
  }, `visible ${role}: ${name}`)
  return element.ref
}
const click = async (name, role = 'button') => call('studio_click', { ref: await locate(name, role) })
const select = async (name, value) => call('studio_select', { ref: await locate(name, 'combobox'), values: [value] })
const configuration = value => ({ ai: value.ai, native: value.designer.config, encoder: value.settings.textEncoder })
try {
  app = await electron.launch({ args: ['.', '--mcp'], env: { ...process.env,
    STUDIO_SKIP_SETUP_CHECKLIST: '1', STUDIO_NO_AUTO_INSTALL: '1', STUDIO_DATA_DIR: directory }, timeout: 60000 })
  const page = await app.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await page.getByRole('heading', { name: 'Character lab' }).waitFor()
  await until(() => readFile(join(directory, 'mcp-connection.json')).then(() => true, () => false), 'MCP connection')
  client = new Client({ name: 'model-settings-ui-smoke', version: '1.0.0' })
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [resolve('scripts', 'mcp-client.mjs'), '--connection', join(directory, 'mcp-connection.json')] }))
  await click('Designer', 'tab')
  const before = configuration(await state())
  await click('Model Settings')
  let view = await ui()
  assert.ok(view.text.includes('Your computer'))
  assert.ok(view.text.includes('SDXL'))
  assert.ok(view.text.includes('saved-custom.safetensors'), 'Saved custom files stay visible without Advanced.')
  assert.ok(!view.elements.some(item => item.name === 'Execution provider'))
  await click('Refresh computer specs')
  await until(async () => (await ui()).text.includes('Local GPU telemetry is unavailable'), 'honest disconnected telemetry')
  await click('Advanced', 'summary')
  const oldProvider = await locate('Execution provider', 'combobox')
  await click('Advanced', 'summary')
  assert.equal((await client.callTool({ name: 'studio_select', arguments: { ref: oldProvider, values: ['tripo'] } })).isError, true)
  assert.deepEqual(configuration(await state()), before, 'Opening, refreshing and collapsing settings never save or change choices.')
  await select('Task', 'mesh')
  view = await ui()
  assert.ok(view.text.includes('Remote - local GPU not required'))
  assert.ok(view.text.includes('saved-mesh'))
  assert.deepEqual(configuration(await state()), before)
  await select('Task', 'scene')
  await click('Use recommended setup')
  assert.ok((await ui()).text.includes('Unsaved changes'))
  assert.deepEqual(configuration(await state()), before, 'Recommendation is only a draft until explicitly saved.')
  await click('Close Model Settings')
  await click('Discard changes')
  assert.deepEqual(configuration(await state()), before)
  await click('Model Settings')
  assert.ok(!(await ui()).elements.some(item => item.name === 'Execution provider'))
  await click('Use recommended setup')
  await click('Save settings')
  await until(async () => (await state()).designer.config.checkpoint === 'DreamShaper_8_pruned.safetensors', 'recommended setup persisted')
  const saved = await state()
  assert.deepEqual(saved.ai.stages.mesh, remote, 'Other providers are untouched.')
  assert.equal(saved.designer.config.meshProfile, 'textured')
  assert.equal(saved.settings.textEncoder, 'lfm', 'No silent encoder substitution.')
  assert.ok((await ui()).elements.some(item => item.name === 'Review required model download'))
  await click('Refresh local models')
  await until(async () => (await ui()).text.includes('Could not refresh local model readiness'), 'visible readiness error outside Advanced')
  // Capture real OS/CPU/RAM and honest disconnected GPU state, with no private paths.
  await page.setViewportSize({ width: 1440, height: 1000 })
  await call('studio_scroll', { ref: await locate('Model Settings content', 'region'), y: -10000 })
  await page.screenshot({ path: resolve('docs', 'screenshots', 'model-settings-simple.png') })
  for (const zoom of [1, 1.25]) {
    await page.setViewportSize({ width: 1100, height: 760 })
    await app.evaluate(({ BrowserWindow }, zoom) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom), zoom)
    assert.ok(await page.getByRole('dialog', { name: 'Model Settings' }).evaluate(el => el.scrollWidth <= el.clientWidth + 1))
    const checkFocusRing = async name => {
      const field = page.getByRole('combobox', { name, exact: true })
      await expect(field).toBeFocused()
      const geometry = await field.evaluate(el => {
        const scroller = el.closest('.model-settings-content')
        const bounds = el.getBoundingClientRect(), clip = scroller.getBoundingClientRect()
        const style = getComputedStyle(el)
        const outlineWidth = parseFloat(style.outlineWidth)
        const ring = outlineWidth + parseFloat(style.outlineOffset)
        return { ring, outlineWidth, left: bounds.left - ring, right: bounds.right + ring,
          clipLeft: clip.left + scroller.clientLeft,
          clipRight: clip.left + scroller.clientLeft + scroller.clientWidth,
          horizontalOverflow: scroller.scrollWidth > scroller.clientWidth }
      })
      assert.ok(geometry.outlineWidth > 0 && geometry.ring >= 3, `${name} retains its visible outward keyboard focus ring at ${zoom} zoom (allowing pixel rounding).`)
      assert.ok(geometry.left >= geometry.clipLeft - 0.5, `${name} left focus ring is inside the scroll clip at ${zoom} zoom.`)
      assert.ok(geometry.right <= geometry.clipRight + 0.5, `${name} right focus ring is inside the scroll clip at ${zoom} zoom.`)
      assert.equal(geometry.horizontalOverflow, false, 'The focus gutter does not create horizontal scrolling.')
    }
    await call('studio_press_key', { ref: await locate('Refresh computer specs', 'button'), key: 'Tab' })
    await checkFocusRing('Task')
    await click('Advanced', 'summary')
    assert.ok((await ui()).elements.some(item => item.name === 'Execution provider'))
    await call('studio_press_key', { ref: await locate('API keys & connections', 'summary'), key: 'Tab' })
    await checkFocusRing('Execution provider')
    await click('Advanced', 'summary')
    await call('studio_scroll', { ref: await locate('Model Settings content', 'region'), y: 10000 })
    assert.ok(await page.getByRole('region', { name: 'Model Settings content' }).evaluate(el => el.scrollTop > 0), 'Settings still scroll vertically.')
    await call('studio_scroll', { ref: await locate('Model Settings content', 'region'), y: -10000 })
    assert.equal(await page.getByRole('region', { name: 'Model Settings content' }).evaluate(el => el.scrollTop), 0)
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
  await call('studio_press_key', { ref: await locate('Close Model Settings', 'button'), key: 'Escape' })
  await expect(page.getByRole('button', { name: 'Model Settings', exact: true })).toBeFocused()
  await client.close(); client = undefined
  await app.close(); app = undefined
  // Relaunch uses the actual saved workspace, not a renderer-only state reset.
  app = await electron.launch({ args: ['.'], env: { ...process.env,
    STUDIO_SKIP_SETUP_CHECKLIST: '1', STUDIO_NO_AUTO_INSTALL: '1', STUDIO_DATA_DIR: directory }, timeout: 60000 })
  const reopened = await app.firstWindow()
  await reopened.getByRole('heading', { name: 'Character lab' }).waitFor()
  await reopened.getByRole('tab', { name: 'Designer', exact: true }).click()
  await reopened.getByRole('button', { name: 'Model Settings', exact: true }).click()
  await expect(reopened.getByLabel('Current task setup')).toContainText('SD 1.5 / DreamShaper')
  await expect(reopened.getByLabel('Execution provider', { exact: true })).not.toBeVisible()
  assert.deepEqual(errors, [])
  console.log('Model settings desktop/MCP: preserved custom choices, task-scoped draft/save/discard, real computer specs, disconnected status, collapsed controls, minimum-size keyboard/focus and relaunch persistence passed. No inference or model downloads.')
} finally {
  await client?.close()
  await app?.close()
  await rm(directory, { recursive: true, force: true })
}
