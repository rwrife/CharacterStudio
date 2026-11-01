import { _electron as electron } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const output = resolve('artifacts', 'desktop-smoke')
await mkdir(output, { recursive: true })
const app = await electron.launch({ args: ['.'], env: { ...process.env, STUDIO_SKIP_SETUP_CHECKLIST: '1', STUDIO_DATA_DIR: resolve('artifacts', 'validation-state') }, timeout: 60000 })
try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await page.getByRole('heading', { name: 'Character lab' }).waitFor()
  const state = await page.evaluate(() => window.studio.snapshot())
  const character = state.characters[0]
  // Test-only protocol substitution, never recorded as a successful generated job.
  await app.evaluate(({ protocol, net }, assets) => {
    protocol.unhandle('studio')
    protocol.handle('studio', request => {
      const file = assets[request.url]
      return file ? net.fetch(file) : new Response('Missing test asset', { status: 404 })
    })
  }, {
    [character.rigPreviewUrl]: pathToFileURL(resolve('artifacts', 'bruiser-analytic-test', 'animated.glb')).toString(),
    [character.previewUrl]: pathToFileURL(resolve('artifacts', 'validation-state', 'characters', character.id, 'preview.glb')).toString()
  })
  await app.evaluate(async ({ session }) => { await session.defaultSession.clearCache() })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Character lab' }).waitFor()
  await page.waitForTimeout(2500)
  await page.getByRole('button', { name: 'Pause animation', exact: true }).click({ timeout: 10000 })
  await page.getByRole('button', { name: 'Front view', exact: true }).click()
  await page.evaluate(() => {
    document.querySelector('.viewport-meta').textContent = 'ANALYTIC RETARGET TEST / NOT COMFYUI-GENERATED'
  })
  const timeline = page.getByLabel('Animation timeline')
  assert.ok(Math.abs(Number(await timeline.getAttribute('max')) - 59 / 30) < 0.001)
  await timeline.evaluate(el => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '0.3')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await page.waitForTimeout(300)
  await page.screenshot({ path: resolve(output, 'bruiser-analytic-pose-a.png') })
  await timeline.evaluate(el => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '1.3')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await page.waitForTimeout(300)
  await page.screenshot({ path: resolve(output, 'bruiser-analytic-pose-b.png') })
  assert.deepEqual(errors, [])
  assert.ok(Math.abs(Number(await timeline.inputValue()) - 1.3) < 0.01)
  console.log('Actual exported Bruiser GLB loaded, played, paused, and scrubbed in desktop Three.js. Fixture is explicitly labeled analytic, not text-generated.')
} finally { await app.close() }
