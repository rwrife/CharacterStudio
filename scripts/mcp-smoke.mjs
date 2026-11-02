import { _electron as electron } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdir, mkdtemp, readFile, writeFile, access } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'

await mkdir(resolve('artifacts', 'mcp-smoke'), { recursive: true })
const directory = await mkdtemp(resolve('artifacts', 'mcp-smoke', 'run-'))
const connection = join(directory, 'mcp-connection.json')
const app = await electron.launch({
  args: ['.', '--mcp'], env: { ...process.env, STUDIO_SKIP_SETUP_CHECKLIST: '1', STUDIO_NO_AUTO_INSTALL: '1', STUDIO_DATA_DIR: directory }, timeout: 60000
})
const errors = []
let client = new Client({ name: 'desktop-smoke', version: '1.0.0' })
let transport
let diagnostics = ''
const connect = async () => {
  transport = new StdioClientTransport({ command: process.execPath, args: [resolve('scripts', 'mcp-client.mjs'), '--connection', connection], stderr: 'pipe' })
  transport.stderr?.on('data', data => { diagnostics += data.toString() })
  await client.connect(transport)
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (probe, description) => {
  const end = Date.now() + 20000
  while (Date.now() < end) { const result = await probe(); if (result) return result; await delay(100) }
  throw new Error(`Timed out: ${description}`)
}
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args })
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`)
  return JSON.parse(result.content[0].text)
}
const ui = () => call('studio_get_ui')
const find = (state, name, role) => {
  const matches = state.elements.filter(el => (name instanceof RegExp ? name.test(el.name) : el.name === name) && (!role || el.role === role))
  assert.equal(matches.length, 1, `Expected one ${role ?? 'element'} named ${name}; found ${matches.map(el => `${el.ref} ${el.name}`).join('; ')}`)
  return matches[0]
}
const locate = (name, role) => until(async () => {
  const state = await ui()
  const matches = state.elements.filter(el => (name instanceof RegExp ? name.test(el.name) : el.name === name) && (!role || el.role === role))
  assert.ok(matches.length < 2, `Ambiguous ${role ?? 'element'}: ${name}`)
  return matches.length === 1 && !matches[0].disabled ? matches[0] : false
}, `enabled ${role ?? 'element'} ${name}`)
const click = async (name, role = 'button') => call('studio_click', { ref: (await locate(name, role)).ref })
const fill = async (name, value) => call('studio_set_value', { ref: (await locate(name, 'textbox')).ref, value })
try {
  const page = await app.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await page.getByRole('heading', { name: 'Character lab' }).waitFor()
  await until(() => access(connection).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false }), 'MCP connection file')
  await connect()
  assert.equal((await client.listTools()).tools.length, 12)
  await call('studio_show_window')
  assert.equal(await page.locator('.brand').innerText(), 'characterstudio')
  assert.equal(await page.locator('.brand .version').count(), 0, 'No header subtitle should be rendered.')
  await click('Designer', 'tab')
  const modelPanel = page.getByLabel('Designer model profiles', { exact: true })
  const modelField = find(await ui(), 'Image model family', 'combobox').ref
  for (const width of [1100, 1440, 1700]) {
    await page.setViewportSize({ width, height: 1000 })
    assert.equal(find(await ui(), 'Hide model settings', 'button').expanded, 'true')
    const expandedWidth = (await page.getByLabel('Designer canvas', { exact: true }).boundingBox()).width
    await click('Hide model settings')
    assert.equal(await modelPanel.isVisible(), false)
    assert.equal(find(await ui(), 'Show model settings', 'button').expanded, 'false')
    assert.ok((await page.getByLabel('Designer canvas', { exact: true }).boundingBox()).width > expandedWidth + 200)
    assert.equal((await ui()).elements.some(el => el.name === 'Image model family'), false)
    const hiddenField = await client.callTool({ name: 'studio_select', arguments: { ref: modelField, values: ['sdxl'] } })
    assert.equal(hiddenField.isError, true, 'Hidden model controls must not remain agent-operable.')
    await click('Show model settings')
    assert.equal(await modelPanel.isVisible(), true)
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await fill('Character title optional', 'Visible MCP concept')
  await fill('Character & scenario', 'An original stylized robot exploring a garden.')
  await fill('Art style', 'Low-poly colorful game art.')
  await call('studio_set_value', { ref: find(await ui(), /^Reference influence/, 'range').ref, value: '0.45' })
  assert.equal(await page.getByLabel('Reference influence').inputValue(), '0.45')
  await page.getByLabel('Art style', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('Art style', { exact: true }).inputValue(), 'Low-poly colorful game art.')
  const disabled = find(await ui(), 'Create character concept', 'button')
  // Missing local models can disable this action; neither MCP nor this test bypasses prerequisites.
  if (disabled.disabled) {
    const result = await client.callTool({ name: 'studio_click', arguments: { ref: disabled.ref } })
    assert.equal(result.isError, true)
  }
  await click(/T-pose reference.*Transparent character cutout/, 'button')
  const isolated = find(await ui(), /^Already isolated transparent PNG/, 'checkbox')
  await call('studio_set_checked', { ref: isolated.ref, checked: true })
  assert.equal(await page.getByLabel(/Already isolated transparent PNG/).isChecked(), true)
  const behindDialog = find(await ui(), 'Art style', 'textbox').ref
  await click('Import T-pose')
  await until(async () => /T-pose/.test((await ui()).modal ?? ''), 'visible T-pose import dialog')
  const blockedByModal = await client.callTool({ name: 'studio_set_value', arguments: { ref: behindDialog, value: 'must not change' } })
  assert.equal(blockedByModal.isError, true)
  assert.match(JSON.stringify(blockedByModal.content), /modal dialog/)
  await click('Cancel file selection')
  assert.equal(await page.getByLabel('Art style', { exact: true }).inputValue(), 'Low-poly colorful game art.')
  await click('Animator', 'tab')
  await click('Motion library & batches')
  await click('Crouch branching template')
  await fill('Graph name UNSAVED', 'MCP desktop control')
  await fill('Motion node name', 'MCP crouch')
  await fill('Motion instructions', 'Hold a low crouch with subtle breathing.')
  const type = find(await ui(), 'Node type', 'combobox')
  await call('studio_select', { ref: type.ref, values: ['state'] })
  await click('Save graph')
  await until(async () => (await call('studio_get_state')).plans.find(plan => plan.name === 'MCP desktop control'), 'graph persistence')
  const saved = (await call('studio_get_state')).plans.find(plan => plan.name === 'MCP desktop control')
  assert.equal(saved.nodes[0].label, 'MCP crouch')
  assert.equal(saved.nodes[0].prompt, 'Hold a low crouch with subtle breathing.')
  let previousBounds
  const node = await until(async () => {
    const node = (await ui()).elements.find(el => el.name === 'state: MCP crouch')
    if (!node) return false
    const currentBounds = JSON.stringify(node.bounds)
    const stable = currentBounds === previousBounds
    previousBounds = currentBounds
    return stable ? node : false
  }, 'stable graph layout')
  const start = { x: Math.round(node.bounds.x + node.bounds.width / 2), y: Math.round(node.bounds.y + 25) }
  await call('studio_pointer', { kind: 'drag', points: [start, { x: start.x + 30, y: start.y + 20 }] })
  await call('studio_wheel', { ...start, deltaY: 100 })
  await click('Save graph')
  await until(async () => {
    const plan = (await call('studio_get_state')).plans.find(plan => plan.id === saved.id)
    return plan.nodes[0].position.x !== saved.nodes[0].position.x
  }, 'real graph drag')
  await click('Export configuration JSON')
  await until(async () => (await ui()).modal === 'Save local file', 'visible export dialog')
  const pickerScreenshot = await client.callTool({ name: 'studio_screenshot', arguments: {} })
  assert.equal(pickerScreenshot.content[0].type, 'image')
  await writeFile(resolve('docs', 'screenshots', 'mcp-file-selection.png'), Buffer.from(pickerScreenshot.content[0].data, 'base64'))
  const output = join(directory, 'export.json')
  await fill('Absolute file path', output)
  await click('Save selected file')
  await until(() => readFile(output, 'utf8').then(JSON.parse, error => { if (error.code !== 'ENOENT') throw error; return false }), 'export file')
  const exported = JSON.parse(await readFile(output, 'utf8'))
  assert.equal(exported.plan.name, 'MCP desktop control')
  assert.equal(exported.plan.nodes.length, 3)
  await click('Export configuration JSON')
  await fill('Absolute file path', output)
  await click('Save selected file')
  await until(async () => (await ui()).text.includes('Replace existing file to overwrite'), 'overwrite warning')
  await call('studio_set_checked', { ref: find(await ui(), 'Replace existing file', 'checkbox').ref, checked: true })
  await click('Save selected file')
  await until(async () => (await ui()).modal === 'Motion library and batches', 'overwrite completion')
  await click('Import configuration JSON')
  await fill('Absolute file path', output)
  await click('Use selected paths')
  await until(async () => (await call('studio_get_state')).plans.length === 2, 'imported copy')
  const stale = find(await ui(), 'Motion node name', 'textbox').ref
  await click('Close motion library')
  assert.equal((await client.callTool({ name: 'studio_set_value', arguments: { ref: stale, value: 'stale' } })).isError, true)
  await click('Backend connections')
  assert.equal(find(await ui(), 'Enable MCP control', 'checkbox').checked, true)
  const encoder = find(await ui(), 'Kimodo text encoder', 'combobox')
  await call('studio_select', { ref: encoder.ref, values: ['lfm'] })
  await click('Save settings')
  await until(async () => (await call('studio_get_state')).settings.textEncoder === 'lfm', 'visible settings save')
  await click('Browse ComfyUI output folder')
  await fill('Absolute folder path', directory)
  await click('Use selected paths')
  await click('Save settings')
  await until(async () => (await call('studio_get_state')).settings.comfyOutput === directory, 'folder selection save')
  await click('Close settings')
  const prompt = await until(async () => (await ui()).elements.find(el => el.name === 'Motion instructions' && el.role === 'textbox' && !el.disabled), 'backend refresh completes')
  await call('studio_set_value', { ref: prompt.ref, value: 'Visible keyboard' })
  await call('studio_press_key', { ref: prompt.ref, key: 'End' })
  await call('studio_press_key', { ref: prompt.ref, key: '!' })
  assert.equal(await page.getByLabel('Motion instructions', { exact: true }).inputValue(), 'Visible keyboard!')
  await fill('Duration seconds', '7')
  assert.equal(await page.getByLabel('Duration seconds').inputValue(), '7')
  const invalidDuration = await client.callTool({ name: 'studio_set_value', arguments: { ref: find(await ui(), 'Duration seconds', 'textbox').ref, value: '9999' } })
  assert.equal(invalidDuration.isError, true)
  const wireframe = find(await ui(), 'Toggle wireframe', 'button')
  await call('studio_pointer', { kind: 'click', points: [{ x: Math.round(wireframe.bounds.x + wireframe.bounds.width / 2), y: Math.round(wireframe.bounds.y + wireframe.bounds.height / 2) }] })
  assert.equal(find(await ui(), 'Toggle wireframe', 'button').pressed, 'true')
  await call('studio_scroll', { ref: find(await ui(), 'Animator motion controls').ref, y: 150 })
  await click('Motion library & batches')
  await until(async () => (await ui()).text.includes('MCP desktop control'), 'saved graph displayed')
  await click('Fit View')
  const screenshot = await client.callTool({ name: 'studio_screenshot', arguments: {} })
  assert.equal(screenshot.content[0].type, 'image')
  const image = Buffer.from(screenshot.content[0].data, 'base64')
  assert.equal(image.readUInt32BE(0), 0x89504e47)
  await mkdir(resolve('docs', 'screenshots'), { recursive: true })
  await writeFile(resolve('docs', 'screenshots', 'mcp-desktop-control.png'), image)
  await writeFile(join(directory, 'desktop.png'), image)
  const beforeReload = find(await ui(), 'Motion node name', 'textbox').ref
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Character lab' }).waitFor()
  await ui()
  const afterReload = await client.callTool({ name: 'studio_set_value', arguments: { ref: beforeReload, value: 'must not change' } })
  assert.equal(afterReload.isError, true)
  assert.equal((await call('studio_get_state')).plans.length, 2)
  await click('Backend connections')
  const originalConnection = JSON.parse(await readFile(connection, 'utf8'))
  await page.getByLabel('Enable MCP control', { exact: true }).click()
  await until(async () => !(await page.evaluate(() => window.studio.desktopControlEnabled())) &&
    await page.getByLabel('Enable MCP control', { exact: true }).isEnabled(), 'MCP disabled in app')
  await assert.rejects(access(connection), { code: 'ENOENT' })
  await assert.rejects(fetch(originalConnection.url, { method: 'POST', headers: { Authorization: `Bearer ${originalConnection.token}` } }))
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'mcp-settings.json'), 'utf8')), { enabled: false })
  await client.close()
  await page.getByLabel('Enable MCP control', { exact: true }).click()
  await until(() => access(connection).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false }), 'MCP re-enabled in app')
  await until(async () => await page.getByLabel('Enable MCP control', { exact: true }).isChecked() &&
    await page.getByLabel('Enable MCP control', { exact: true }).isEnabled(), 'MCP enabled status')
  const renewed = JSON.parse(await readFile(connection, 'utf8'))
  assert.notEqual(renewed.token, originalConnection.token)
  client = new Client({ name: 'desktop-smoke-reconnected', version: '1.0.0' })
  await connect()
  assert.equal(find(await ui(), 'Enable MCP control', 'checkbox').checked, true)
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'mcp-settings.json'), 'utf8')), { enabled: true })
  assert.deepEqual(errors, [])
  assert.equal(diagnostics, '')
  console.log('Desktop MCP smoke passed: real stdio client → authenticated HTTP MCP → visible Electron/React controls; Designer brief, checkbox, file cancel, graph edits/drag, import/export/overwrite, settings/dropdowns/folder picker, stale refs, keyboard, scrolling, screenshot.')
  console.log('Screenshot: docs\\screenshots\\mcp-desktop-control.png (graph authoring only; no learned generation).')
} catch (error) {
  console.error('Desktop smoke failed:', error)
  if (transport) {
    try { await writeFile(join(directory, 'failure-ui.json'), JSON.stringify(await ui(), null, 2)) }
    catch (diagnostic) { console.error('MCP UI diagnostics unavailable:', diagnostic.message) }
    const page = await app.firstWindow()
    await writeFile(join(directory, 'failure-dom.html'), await page.content())
  }
  console.error('Desktop smoke artifacts:', directory)
  throw error
} finally {
  await client.close()
  await app.close()
}
await assert.rejects(access(connection), { code: 'ENOENT' })

const restored = await electron.launch({ args: ['.'], env: { ...process.env, STUDIO_SKIP_SETUP_CHECKLIST: '1', STUDIO_NO_AUTO_INSTALL: '1', STUDIO_DATA_DIR: directory } })
try {
  const page = await restored.firstWindow()
  await page.getByRole('heading', { name: 'Character lab' }).waitFor()
  await until(() => page.evaluate(() => window.studio.desktopControlEnabled()), 'saved MCP preference restored')
  await access(connection)
} finally { await restored.close() }

// Verify ordinary launches remain opt-out and keep native file pickers.
const ordinaryDirectory = await mkdtemp(resolve('artifacts', 'mcp-smoke', 'ordinary-'))
const ordinary = await electron.launch({ args: ['.'], env: { ...process.env, STUDIO_SKIP_SETUP_CHECKLIST: '1', STUDIO_NO_AUTO_INSTALL: '1', STUDIO_DATA_DIR: ordinaryDirectory } })
try {
  const page = await ordinary.firstWindow()
  await page.getByRole('heading', { name: 'Character lab' }).waitFor()
  assert.equal(await page.evaluate(() => window.studio.desktopControlEnabled()), false)
  await assert.rejects(access(join(ordinaryDirectory, 'mcp-connection.json')), { code: 'ENOENT' })
} finally { await ordinary.close() }
