import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startDesktopMcp, authorizeMcp } from '../src/main/mcp-server'
import { validateDialogPaths } from '../src/main/file-dialog-validation'
import { DesktopMcpControl } from '../src/main/mcp-control'
import type { DesktopAdapter } from '../src/main/mcp-tools'
import type { FileDialogRequest } from '../src/shared/file-dialog'
import type { Snapshot } from '../src/shared/types'

test('in-app MCP toggle is opt-in, serialized, persisted, and restored without changing shutdown preferences', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-mcp-control-test-'))
  let starts = 0, stops = 0
  const states: boolean[] = []
  const start = async () => {
    starts++
    return { close: async () => { stops++ } }
  }
  const control = new DesktopMcpControl(directory, start, enabled => states.push(enabled))
  try {
    assert.equal(await control.initialize(false), false)
    assert.equal(starts, 0)
    assert.deepEqual(await Promise.all([control.setEnabled(true), control.setEnabled(false), control.setEnabled(true)]), [true, false, true])
    assert.equal(control.enabled, true)
    assert.equal(starts, 2)
    assert.equal(stops, 1)
    assert.equal(await control.setEnabled(true), true)
    assert.equal(starts, 2, 'saving an unchanged preference must not restart the listener')
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'mcp-settings.json'), 'utf8')), { enabled: true })
    await control.close()
    assert.equal(control.enabled, false)
    assert.equal(stops, 2)
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'mcp-settings.json'), 'utf8')), { enabled: true })
    const restored = new DesktopMcpControl(directory, start, enabled => states.push(enabled))
    assert.equal(await restored.initialize(false), true)
    assert.equal(await restored.setEnabled(false), false)
    await restored.close()
    const disabled = new DesktopMcpControl(directory, start, () => {})
    assert.equal(await disabled.initialize(false), false)
    assert.equal(await disabled.initialize(true), true, '--mcp remains an explicit per-launch override')
    await disabled.close()
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'mcp-settings.json'), 'utf8')), { enabled: false })
    await assert.rejects(control.setEnabled(true), /shutting down/)
    assert.deepEqual(states.slice(0, 4), [false, true, false, true])
  } finally { await rm(directory, { recursive: true }) }
})

test('failed MCP starts or preference saves cannot leave an invisible enabled listener', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-mcp-control-failure-'))
  let active = false
  let failStart = true
  const control = new DesktopMcpControl(directory, async () => {
    if (failStart) throw new Error('Listener could not start.')
    active = true
    return { close: async () => { active = false } }
  }, () => {})
  try {
    await assert.rejects(control.setEnabled(true), /could not start/)
    assert.equal(control.enabled, false)
    failStart = false
    await mkdir(join(directory, 'mcp-settings.json'))
    await assert.rejects(control.setEnabled(true))
    assert.equal(active, false)
    assert.equal(control.enabled, false)
    await control.close()
  } finally { await rm(directory, { recursive: true }) }
})

test('MCP rejects missing/wrong authentication, foreign hosts/origins, paths and HTTP methods', () => {
  const token = 'a'.repeat(64), host = '127.0.0.1:12345'
  const request = { method: 'POST', url: '/mcp', headers: { host, authorization: `Bearer ${token}` } }
  assert.equal(authorizeMcp(request, token, host), 200)
  assert.equal(authorizeMcp({ ...request, headers: { host } }, token, host), 401)
  assert.equal(authorizeMcp({ ...request, headers: { host, authorization: `Bearer ${'b'.repeat(64)}` } }, token, host), 401)
  assert.equal(authorizeMcp({ ...request, headers: { ...request.headers, origin: 'http://evil.example' } }, token, host), 403)
  assert.equal(authorizeMcp({ ...request, headers: { ...request.headers, host: 'evil.example' } }, token, host), 403)
  assert.equal(authorizeMcp({ ...request, url: '/other' }, token, host), 404)
  assert.equal(authorizeMcp({ ...request, method: 'GET' }, token, host), 405)
  assert.equal(authorizeMcp({ ...request, method: 'DELETE' }, token, host), 405)
})

test('real MCP HTTP protocol enumerates all UI tools, validates arguments, propagates errors and cleans up', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-mcp-test-'))
  const calls: unknown[] = []
  const snapshot: Snapshot = { settings: { comfyUrl: 'http://127.0.0.1:8189', comfyRoot: '', comfyOutput: '', blenderPath: '' }, characters: [], jobs: [], plans: [], batches: [] }
  const adapter: DesktopAdapter = {
    ui: async command => {
      calls.push(command)
      if ('ref' in command && command.ref === 'e99') throw new Error('This control is disabled.')
      return command.action === 'inspect' ? { elements: [{ ref: 'e1', name: 'Designer' }] } : { action: command.action }
    },
    snapshot: () => snapshot, screenshot: async () => 'cG5n',
    key: async (...args) => { calls.push(['key', ...args]) },
    pointer: async (...args) => { calls.push(['pointer', ...args]) },
    wheel: async (...args) => { calls.push(['wheel', ...args]) },
    show: async () => { calls.push(['show']) }
  }
  const running = await startDesktopMcp(adapter, directory)
  const client = new Client({ name: 'test', version: '1' })
  const connection = JSON.parse(await readFile(running.connectionPath, 'utf8')) as { url: string; token: string }
  try {
    assert.match(connection.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    assert.match(connection.token, /^[a-f0-9]{64}$/)
    if (process.platform !== 'win32') assert.equal((await stat(running.connectionPath)).mode & 0o777, 0o600)
    assert.equal((await fetch(connection.url, { method: 'POST' })).status, 401)
    assert.equal((await fetch(connection.url, { method: 'POST', headers: { Authorization: `Bearer ${connection.token}`, Origin: 'http://evil.example' } })).status, 403)
    await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { Authorization: `Bearer ${connection.token}` } } }))
    const list = await client.listTools()
    assert.deepEqual(list.tools.map(t => t.name).sort(), [
      'studio_click', 'studio_get_state', 'studio_get_ui', 'studio_pointer', 'studio_press_key', 'studio_screenshot',
      'studio_scroll', 'studio_select', 'studio_set_checked', 'studio_set_value', 'studio_show_window', 'studio_wheel'
    ])
    assert.match(client.getInstructions()!, /actual visible/)
    for (const [name, args] of [
      ['studio_get_ui', {}], ['studio_get_state', {}], ['studio_click', { ref: 'e1' }],
      ['studio_set_value', { ref: 'e1', value: 'A visible brief' }], ['studio_select', { ref: 'e1', values: ['lfm'] }],
      ['studio_set_checked', { ref: 'e1', checked: true }], ['studio_press_key', { ref: 'e1', key: 'Enter' }],
      ['studio_pointer', { kind: 'drag', points: [{ x: 10, y: 10 }, { x: 20, y: 30 }] }],
      ['studio_scroll', { ref: 'e1', y: 100 }], ['studio_wheel', { x: 1, y: 2, deltaY: 100 }], ['studio_show_window', {}]
    ] as const) {
      const result = await client.callTool({ name, arguments: args })
      assert.equal(result.isError, undefined, name)
    }
    const image = await client.callTool({ name: 'studio_screenshot', arguments: {} })
    assert.deepEqual(image.content, [{ type: 'image', data: 'cG5n', mimeType: 'image/png' }])
    const before = calls.length
    for (const args of [{ ref: 'guessed' }, { ref: 'e1', arbitraryCode: 'alert(1)' }]) {
      const result = await client.callTool({ name: 'studio_click', arguments: args })
      assert.equal(result.isError, true)
    }
    const invalidDrag = await client.callTool({ name: 'studio_pointer', arguments: { kind: 'drag', points: [{ x: 1, y: 1 }] } })
    assert.equal(invalidDrag.isError, true)
    const invalidKey = await client.callTool({ name: 'studio_press_key', arguments: { ref: 'e1', key: 'F4', modifiers: ['alt'] } })
    assert.equal(invalidKey.isError, true)
    assert.equal(calls.length, before, 'invalid inputs must not reach the desktop')
    const disabled = await client.callTool({ name: 'studio_click', arguments: { ref: 'e99' } })
    assert.equal(disabled.isError, true)
    assert.match(JSON.stringify(disabled.content), /disabled/)
  } finally {
    await client.close()
    await running.close()
    await assert.rejects(readFile(running.connectionPath), { code: 'ENOENT' })
    await rm(directory, { recursive: true })
  }
})

test('visible file dialogs enforce types, absolute paths, cardinality, directories and explicit overwrite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-file-dialog-test-'))
  const file = join(directory, 'configuration.json')
  const request: FileDialogRequest = { id: 'test', kind: 'open', title: 'Import', directory: false, multiple: false, filters: [{ name: 'JSON', extensions: ['json'] }], defaultPath: '' }
  try {
    await writeFile(file, '{}')
    await validateDialogPaths(request, [file], false)
    await assert.rejects(validateDialogPaths(request, ['relative.json'], false), /absolute/)
    await assert.rejects(validateDialogPaths(request, [file, file], false), /number/)
    await assert.rejects(validateDialogPaths(request, [join(directory, 'file.fbx')], false), /supported/)
    await assert.rejects(validateDialogPaths(request, [join(directory, 'absent.json')], false), { code: 'ENOENT' })
    await validateDialogPaths({ ...request, directory: true }, [directory], false)
    await assert.rejects(validateDialogPaths({ ...request, directory: true }, [file], false), /folder/)
    await validateDialogPaths({ ...request, kind: 'save' }, [join(directory, 'new.json')], false)
    await assert.rejects(validateDialogPaths({ ...request, kind: 'save' }, [file], false), /Replace existing/)
    await validateDialogPaths({ ...request, kind: 'save' }, [file], true)
    await assert.rejects(validateDialogPaths({ ...request, kind: 'save', filters: [] }, [directory], true), /regular/)
    await assert.rejects(validateDialogPaths({ ...request, kind: 'save' }, [join(directory, 'absent', 'new.json')], false), { code: 'ENOENT' })
  } finally { await rm(directory, { recursive: true }) }
})
