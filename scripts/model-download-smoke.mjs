import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import assert from 'node:assert/strict'

const data = await mkdtemp(join(tmpdir(), 'studio-model-download-ui-'))
const output = resolve('artifacts', 'model-download-smoke')
await mkdir(output, { recursive: true })
let backgroundInstalled = false
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json')
  if (request.url === '/system_stats') response.end(JSON.stringify({ devices: [{ name: 'Test GPU', type: 'cuda', vram_total: 24 * 2 ** 30, vram_free: 20 * 2 ** 30 }] }))
  else if (request.url === '/object_info') response.end(JSON.stringify({
    LoadBackgroundRemovalModel: { input: { required: { bg_removal_name: [backgroundInstalled ? ['birefnet.safetensors'] : []] } } }
  }))
  else { response.statusCode = 404; response.end('{}') }
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const app = await electron.launch({ args: ['.'], env: { ...process.env, STUDIO_SKIP_SETUP_CHECKLIST: '1', STUDIO_DATA_DIR: data }, timeout: 60000 })
try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.getByRole('heading', { name: 'Character lab' }).waitFor()
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('studio:check')
    ipcMain.handle('studio:check', () => [])
  })
  await writeFile(join(data, 'main.py'), '# TEST ONLY')
  await page.evaluate(async ({ root, port }) => {
    const state = await window.studio.snapshot()
    await window.studio.settings({ ...state.settings, comfyRoot: root, comfyUrl: `http://127.0.0.1:${port}` })
  }, { root: data, port: server.address().port })
  const png = await app.evaluate(({ nativeImage }) => nativeImage.createFromBitmap(Buffer.alloc(16 * 16 * 4, 255), { width: 16, height: 16 }).toPNG().toString('base64'))
  const image = join(data, 'test-only-pose.png')
  await writeFile(image, Buffer.from(png, 'base64'))
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    globalThis.downloadConfirmations = []
    dialog.showMessageBox = async (_window, options) => { globalThis.downloadConfirmations.push(options); return { response: 0, checkboxChecked: false } }
  }, image)
  await page.getByRole('tab', { name: 'Designer', exact: true }).click()
  await page.locator('.design-stages').getByRole('button', { name: 'T-pose reference', exact: false }).click()
  await page.getByRole('button', { name: 'Import T-pose', exact: true }).click()
  await page.getByRole('button', { name: 'Remove T-pose background', exact: true }).click()
  const warning = page.locator('.design-recovery')
  const download = warning.getByRole('button', { name: 'Download required models', exact: true })
  await expect(warning).toContainText('BiRefNet background-removal weights are missing', { timeout: 15000 })
  await expect(download).toBeEnabled()
  await warning.screenshot({ path: join(output, 'model-download-action.png'), scale: 'css' })
  await warning.getByRole('button', { name: 'Review model settings' }).click()
  await expect(page.getByLabel(/^Background removal/)).toBeFocused()
  await download.click()
  await expect.poll(() => app.evaluate(() => globalThis.downloadConfirmations.length), { timeout: 15000 }).toBe(1)
  await expect(download).toBeEnabled()
  const confirmation = await app.evaluate(() => globalThis.downloadConfirmations[0])
  assert.match(confirmation.detail, /0\.41 GiB/)
  assert.match(confirmation.detail, /birefnet\.safetensors/)
  assert.match(confirmation.detail, /No character assets or credentials are uploaded/)
  assert.equal(confirmation.defaultId, 0)
  assert.equal((await page.evaluate(() => window.studio.snapshot())).designer.config.backgroundModel, undefined)

  // UI-only transfer states; no real models, assets or credentials leave this fixture.
  const snapshot = await page.evaluate(() => window.studio.snapshot())
  await app.evaluate(({ ipcMain, BrowserWindow }, state) => {
    globalThis.downloadUi = { state, mode: 'cancel', calls: 0 }
    ipcMain.removeHandler('designer:install-models')
    ipcMain.handle('designer:install-models', async (_event, id) => {
      const test = globalThis.downloadUi
      if (id !== 'background') throw new Error('Wrong recovery package')
      test.calls++
      const update = (status, message) => {
        test.state.designer.modelDownload = { package: id, status, message, receivedBytes: 100, totalBytes: 1000 }
        BrowserWindow.getAllWindows()[0].webContents.send('studio:update', test.state)
      }
      update('running', 'Downloading / verifying birefnet.safetensors')
      if (test.mode === 'cancel') await new Promise((resolve, reject) => { test.cancel = () => { update('cancelled', 'Model download cancelled.'); reject(new Error('Model download cancelled.')) } })
      if (test.mode === 'failure') { update('failed', 'Model download failed: HTTP 403.'); throw new Error('Model download failed: HTTP 403.') }
      test.state.designer.config.backgroundModel = 'birefnet.safetensors'
      update('complete', 'Required models verified and selected. Retry the stage when ready.')
      return test.state.designer.config
    })
    ipcMain.removeHandler('designer:cancel-download')
    ipcMain.handle('designer:cancel-download', () => globalThis.downloadUi.cancel())
  }, snapshot)
  await download.click()
  await expect(page.getByLabel('Model download progress')).toBeVisible()
  await expect(download).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Remove T-pose background', exact: true })).toBeDisabled()
  await page.getByRole('tab', { name: 'Animator', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Import FBX LOCAL FILE', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Motion library & batches', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save graph', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Close motion library', exact: true }).click()
  await page.getByRole('tab', { name: 'Designer', exact: true }).click()
  await page.getByRole('button', { name: 'Cancel download', exact: true }).click()
  await expect(warning).toContainText('cancelled')
  await expect(download).toBeEnabled()
  await app.evaluate(() => { globalThis.downloadUi.mode = 'failure' })
  await download.click()
  await expect(warning).toContainText('HTTP 403')
  await expect(download).toBeEnabled()
  backgroundInstalled = true
  await app.evaluate(() => { globalThis.downloadUi.mode = 'success' })
  await download.click()
  await expect(page.getByLabel(/^Background removal/)).toHaveValue('birefnet.safetensors')
  await expect(page.getByRole('button', { name: 'Remove T-pose background', exact: true })).toBeEnabled({ timeout: 15000 })
  await expect(warning).toHaveCount(0)
  assert.equal(await app.evaluate(() => globalThis.downloadUi.calls), 3)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 760))
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Download controls must fit the minimum window width.')
  assert.deepEqual(errors, [])
  console.log('Model download desktop flow passed: real missing-model recovery and approval decline; fixture progress, cancellation, failure, selection and retry.')
} finally {
  await app.close()
  await new Promise(resolve => server.close(resolve))
  await rm(data, { recursive: true, force: true })
}
