/** Real Electron UI -> IPC -> Kimodo/LFM -> Blender export, without model/readiness fixtures. */
import { _electron as electron, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { validateCharacterGlb } from '../src/main/export-validation.ts'
import { localUrl } from '../src/main/validation.ts'

const base = localUrl(process.argv[2] ?? 'http://127.0.0.1:8189')
const asset = resolve('artifacts', 'Bruiser_base.fbx')
await access(asset)
const info = await fetch(base + '/object_info').then(response => {
  assert.equal(response.ok, true)
  return response.json()
})
assert.ok(info.Studio_Kimodo_LoadLFM, 'Restart ComfyUI after installing the LFM custom node.')
await mkdir(resolve('artifacts'), { recursive: true })
const root = await mkdtemp(resolve('artifacts', 'lfm-desktop-'))
const app = await electron.launch({ args: ['.'], env: { ...process.env, STUDIO_DATA_DIR: root }, timeout: 60000 })
try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.getByRole('heading', { name: 'Character lab' }).waitFor()
  await page.getByRole('button', { name: 'Backend connections', exact: true }).click()
  await page.locator('#comfy-url').fill(base)
  await page.getByLabel('Kimodo text encoder', { exact: true }).selectOption('lfm')
  await page.getByRole('button', { name: 'Save settings', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await window.studio.snapshot()).settings.textEncoder)).toBe('lfm')
  await expect(page.getByLabel('Detected GPU memory')).toBeVisible({ timeout: 90000 })
  const checks = await page.evaluate(() => window.studio.check())
  assert.deepEqual(checks.filter(check => check.status === 'blocked'), [])
  const gpu = checks.find(check => check.gpu)?.gpu
  assert.ok(gpu && gpu.totalGB > 0 && gpu.freeGB >= 0, 'Readiness must report actual GPU memory.')
  await page.getByRole('dialog').evaluate(el => { el.scrollTop = 0 })
  await page.screenshot({ path: join(root, 'real-gpu-selector.png') })
  await page.getByRole('button', { name: 'Close settings' }).click()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect.poll(() => page.evaluate(async () => (await window.studio.snapshot()).settings.textEncoder)).toBe('lfm')

  // Supply the existing user asset to the file picker; all processing and generation remain real.
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, asset)
  await page.getByRole('button', { name: 'Import FBX LOCAL FILE', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await window.studio.snapshot()).characters.length), { timeout: 180000 }).toBe(1)
  const setup = JSON.parse(await readFile(resolve('tests', 'fixtures', 'bruiser-setup.json'), 'utf8'))
  await page.evaluate(async setup => {
    const state = await window.studio.snapshot()
    await window.studio.saveSetup(state.characters[0].id, setup)
    await window.studio.rig(state.characters[0].id)
  }, setup)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByLabel('Motion instructions', { exact: true }).fill('A person walks forward.')
  await page.getByRole('spinbutton', { name: 'Duration seconds' }).fill('2')
  await page.getByRole('combobox', { name: 'Denoising steps quality' }).selectOption('25')
  await page.getByRole('button', { name: 'Generate animation', exact: true }).click()
  await expect.poll(async () => page.evaluate(async () => {
    const job = (await window.studio.snapshot()).jobs.find(job => job.kind === 'generate')
    return job?.stage === 'failed' ? 'failed: ' + job.message : job?.stage
  }), { timeout: 600000, intervals: [1000, 2000] }).toBe('complete')
  const job = await page.evaluate(async () => (await window.studio.snapshot()).jobs.find(job => job.kind === 'generate'))
  assert.equal(job.textEncoder, 'lfm')
  const directory = join(root, 'jobs', job.id)
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  assert.equal(manifest.textEncoder, 'lfm')
  assert.equal(manifest.clipFrames, 60)
  const history = await fetch(base + '/history/' + job.promptId).then(response => response.json())
  assert.equal(history[job.promptId].prompt[2]['1'].class_type, 'Studio_Kimodo_LoadLFM')
  await validateCharacterGlb(join(directory, 'animated.glb'), true)
  for (const file of ['animated.glb', 'animated.fbx', 'animated.blend'])
    assert.ok((await stat(join(directory, file))).size > 50)
  await page.screenshot({ path: join(root, 'learned-walk.png') })
  assert.deepEqual(errors, [])
  const report = { root, gpu, encoder: manifest.textEncoder, frames: manifest.clipFrames, jobId: job.id,
    outputs: job.outputFiles, realDesktopGeneration: true, limitations: 'No visual-quality equivalence or constrained-graph success claimed.' }
  await writeFile(join(root, 'validation.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  await app.close()
}
