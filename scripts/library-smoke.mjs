import { _electron as electron } from 'playwright'
import { expect } from '@playwright/test'
import { readFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'

const output = resolve('artifacts', 'desktop-smoke')
await mkdir(output, { recursive: true })
const app = await electron.launch({ args: ['.'], env: { ...process.env, STUDIO_SKIP_SETUP_CHECKLIST: '1', STUDIO_DATA_DIR: resolve('artifacts', 'validation-state') }, timeout: 60000 })
const unavailableBackend = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{}') })
unavailableBackend.listen(0, '127.0.0.1'); await once(unavailableBackend, 'listening')
let originalSettings
try {
  const page = await app.firstWindow()
  originalSettings = (await page.evaluate(() => window.studio.snapshot())).settings
  await page.evaluate(settings => window.studio.saveSettings(settings), { ...originalSettings, comfyUrl: `http://127.0.0.1:${unavailableBackend.address().port}` })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()) })
  await page.getByRole('heading', { name: 'Character lab' }).waitFor()
  await page.getByRole('button', { name: 'Motion library & batches' }).click()
  await page.getByRole('button', { name: 'Crouch branching template' }).click()
  await page.getByLabel('In-place root motion', { exact: true }).check()
  await page.getByRole('button', { name: 'Save graph', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Graph saved' }).waitFor()
  const inPlace = await page.evaluate(() => window.studio.snapshot())
  assert.ok(inPlace.plans[0].nodes.every(node => node.inPlace), 'Root-motion mode must propagate to both branches.')
  await page.getByLabel('In-place root motion', { exact: true }).uncheck()
  await page.getByRole('button', { name: 'Save graph', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Graph saved' }).waitFor()
  const state = await page.evaluate(() => window.studio.snapshot())
  const plan = state.plans[0]
  assert.equal(plan.nodes.length, 3)
  assert.equal(plan.edges.length, 2)
  assert.ok(plan.edges.every(edge => edge.source === plan.nodes[0].id))
  await page.screenshot({ path: resolve(output, 'motion-library.png') })
  const exported = resolve('artifacts', 'library-roundtrip.json')
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, exported)
  await page.getByRole('button', { name: 'Export configuration JSON' }).click()
  await page.getByRole('status').filter({ hasText: 'Configuration saved to' }).waitFor()
  assert.deepEqual(JSON.parse(await readFile(exported, 'utf8')).plan, plan)
  await page.getByRole('button', { name: 'Generate graph · 3 variants' }).click()
  await expect.poll(async () => {
    const batch = (await page.evaluate(() => window.studio.snapshot())).batches[0]
    return batch?.plan.id === plan.id ? `${batch.status}:${batch.items.map(item => item.status).join(',')}` : ''
  }, { timeout: 120000 }).toBe('failed:blocked,blocked,blocked')
  const blocked = await page.evaluate(() => window.studio.snapshot())
  assert.equal(blocked.batches[0].items.length, 3)
  assert.ok(blocked.batches[0].items.every(i => i.status === 'blocked'))
  await page.screenshot({ path: resolve(output, 'batch-backend-blocker.png') })
  assert.deepEqual(errors, [])
  console.log('Desktop library: saved branching configuration, JSON export, collection queue and truthful missing-node blocked status passed.')
} finally {
  if (originalSettings) await (await app.firstWindow()).evaluate(settings => window.studio.saveSettings(settings), originalSettings)
  await app.close(); unavailableBackend.closeAllConnections(); unavailableBackend.close()
}
