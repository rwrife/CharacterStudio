import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const data = await mkdtemp(join(tmpdir(), 'kimodo-model-setup-'))
const output = resolve('artifacts', 'desktop-smoke')
await mkdir(output, { recursive: true })
const packaged = process.argv.includes('--packaged')
const app = await electron.launch({
  ...(packaged ? { executablePath: resolve('release', 'CharacterStudio-win32-arm64', 'CharacterStudio.exe'), args: [] } : { args: ['.'] }),
  env: { ...process.env, STUDIO_SKIP_SETUP_CHECKLIST: '1', STUDIO_DATA_DIR: data }, timeout: 60000
})
try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await page.getByRole('heading', { name: 'Character lab' }).waitFor()
  // Test-only readiness states and browser interception: never submit access requests or create credentials.
  await app.evaluate(({ ipcMain, shell }) => {
    globalThis.setupTest = { status: 'blocked', calls: 0, links: [], failLinks: false,
      gpu: { name: 'Test GPU', totalGB: 16, freeGB: 12 } }
    ipcMain.removeHandler('studio:check')
    ipcMain.handle('studio:check', () => {
      globalThis.setupTest.calls++
      return [{ name: 'PyTorch / GPU', status: 'ready', detail: 'Controlled GPU fixture.', gpu: globalThis.setupTest.gpu },
        { name: 'Local Llama text encoder', status: globalThis.setupTest.status, detail: 'Controlled model-access UI fixture.' }]
    })
    shell.openExternal = async url => {
      if (globalThis.setupTest.failLinks) throw new Error('Test browser launch failed')
      globalThis.setupTest.links.push(url)
    }
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Backend connections', exact: true }).click()
  const guide = page.locator('.model-setup-guide')
  await expect(page.getByLabel('Detected GPU memory')).toContainText('12.0 GiB free / 16.0 GiB total')
  await expect(page.locator('#text-encoder option[value="lfm"]')).toContainText('Recommended for available memory')
  await expect(page.getByLabel('Kimodo text encoder', { exact: true })).toHaveValue('llm2vec')
  await expect(guide).toHaveAttribute('open', '')
  await expect(guide.getByText('Expand to review and access', { exact: true })).toBeVisible()
  await expect(guide.getByText('Wait for approval', { exact: true })).toBeVisible()
  await expect(guide.getByLabel('Hugging Face login command')).toContainText('\\venv\\Scripts\\hf.exe')
  await expect(guide.getByLabel('Hugging Face login command')).toContainText('auth login')
  await expect(guide.getByLabel('Hugging Face account check command')).toContainText('auth whoami')
  await guide.getByRole('button', { name: 'Open Meta Llama model page' }).click()
  await guide.getByRole('button', { name: 'Open Hugging Face token settings' }).click()
  assert.deepEqual(await app.evaluate(() => globalThis.setupTest.links), [
    'https://huggingface.co/meta-llama/Meta-Llama-3-8B-Instruct', 'https://huggingface.co/settings/tokens'
  ])
  await guide.getByText('Can I avoid the access request?', { exact: true }).click()
  await expect(guide.getByText(/Studio also offers an experimental/)).toBeVisible()
  const calls = await app.evaluate(() => globalThis.setupTest.calls)
  await guide.getByRole('button', { name: 'Refresh model access checks' }).click()
  await expect.poll(() => app.evaluate(() => globalThis.setupTest.calls)).toBeGreaterThan(calls)
  await app.evaluate(() => { globalThis.setupTest.failLinks = true })
  await guide.getByRole('button', { name: 'Open Meta Llama model page' }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Test browser launch failed')
  await app.evaluate(() => { globalThis.setupTest.failLinks = false })
  await guide.getByRole('button', { name: 'Open Meta Llama model page' }).click()
  await page.getByRole('dialog').evaluate(el => { el.scrollTop = 0 })
  await page.screenshot({ path: join(output, packaged ? 'packaged-model-setup.png' : 'model-setup-guide.png') })
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1100, 760) })
  assert.ok(await guide.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Guide must wrap within the minimum window width.')

  await page.evaluate(async () => {
    const state = await window.studio.snapshot()
    await window.studio.settings({ ...state.settings, comfyRoot: "C:\\Model tools\\O'Brien\\ComfyUI" })
  })
  await app.evaluate(() => { globalThis.setupTest.status = 'ready' })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Backend connections', exact: true }).click()
  await expect(guide).not.toHaveAttribute('open')
  await guide.locator(':scope > summary').click()
  await expect(guide.getByLabel('Hugging Face login command')).toHaveText("& 'C:\\Model tools\\O''Brien\\ComfyUI\\venv\\Scripts\\hf.exe' auth login")
  await expect(guide.getByText('Expand to review and access', { exact: true })).toBeVisible()
  assert.equal(await guide.locator('input').count(), 0, 'Setup must never collect a token in the app.')
  await page.getByLabel('Kimodo text encoder', { exact: true }).selectOption('lfm')
  if (await guide.getAttribute('open') === null) await guide.locator(':scope > summary').click()
  await expect(guide.getByLabel('LFM setup command')).toContainText(".\\scripts\\setup-lfm.ps1 -ComfyRoot 'C:\\Model tools\\O''Brien\\ComfyUI'")
  assert.equal(await guide.getByRole('button', { name: 'Open Meta Llama model page' }).count(), 0)
  await expect(guide.getByText(/no Llama approval or Hugging Face login is required/i)).toBeVisible()
  await page.getByRole('button', { name: 'Save settings', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await window.studio.snapshot()).settings.textEncoder)).toBe('lfm')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Backend connections', exact: true }).click()
  await expect(page.getByLabel('Kimodo text encoder', { exact: true })).toHaveValue('lfm')
  await app.evaluate(() => { globalThis.setupTest.gpu = { name: 'Large Test GPU', totalGB: 48, freeGB: 32 } })
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.getByLabel('Detected GPU memory')).toContainText('32.0 GiB free / 48.0 GiB total')
  await expect(page.locator('#text-encoder option[value="llm2vec"]')).toContainText('Recommended for available memory')
  await expect(page.getByLabel('Kimodo text encoder', { exact: true })).toHaveValue('lfm')
  await app.evaluate(() => { globalThis.setupTest.gpu = undefined })
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.locator('#encoder-memory-guidance')).toContainText('Choose manually')
  await expect(page.getByLabel('Kimodo text encoder', { exact: true })).toHaveValue('lfm')
  assert.deepEqual(errors, [])
  console.log(`${packaged ? 'Packaged' : 'Built'} model setup: original access guide, safe links, local CLI commands, LFM guide and persisted encoder selection passed.`)
} finally {
  await app.close()
  await rm(data, { recursive: true, force: true })
}
