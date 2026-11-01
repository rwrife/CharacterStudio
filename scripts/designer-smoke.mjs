import { _electron as electron, expect } from '@playwright/test'
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { once } from 'node:events'
import assert from 'node:assert/strict'

const data = await mkdtemp(join(tmpdir(), 'kimodo-designer-ui-'))
const output = resolve('artifacts', 'designer-smoke')
await mkdir(output, { recursive: true })
const native = process.argv.includes('--generate')
const packaged = process.argv.includes('--packaged')
const app = await electron.launch({
  ...(packaged ? { executablePath: resolve('release', 'CharacterStudio-win32-arm64', 'CharacterStudio.exe'), args: [] } : { args: ['.'] }),
  env: { ...process.env, STUDIO_DATA_DIR: data }, timeout: 60000
})
try {
  const page = await app.firstWindow()
  await expect(page).toHaveTitle('Character Studio')
  assert.equal(await app.evaluate(({ app }) => app.getName()), 'Character Studio')
  await expect(page.locator('.brand')).toContainText('powered by ComfyUI')
  await expect(page.locator('.brand')).not.toContainText('LOCAL / 01')
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.getByRole('heading', { name: 'Character lab' }).waitFor()
  // Keep unrelated motion-model/network readiness out of this designer check.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('studio:check')
    ipcMain.handle('studio:check', () => [])
  })
  if (native) {
    const reservation = createServer()
    reservation.listen(0, '127.0.0.1')
    await once(reservation, 'listening')
    const port = reservation.address().port
    await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
    // Use an app-owned backend with valid log streams, without restarting the user's service.
    await page.evaluate(async port => {
      const state = await window.studio.snapshot()
      await window.studio.settings({ ...state.settings, comfyUrl: `http://127.0.0.1:${port}` })
      await window.studio.startComfy()
    }, port)
  }
  await page.getByRole('tab', { name: 'Designer', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Character designer' })).toBeVisible()
  await page.getByRole('tab', { name: 'Designer', exact: true }).press('ArrowRight')
  await expect(page.getByRole('tab', { name: 'Animator', exact: true })).toBeFocused()
  await expect(page.getByRole('heading', { name: 'Character lab' })).toBeVisible()
  await page.getByRole('tab', { name: 'Animator', exact: true }).press('Home')
  await expect(page.getByRole('tab', { name: 'Designer', exact: true })).toBeFocused()
  await page.getByLabel('Character & scenario').fill('A Brazilian MMA fighter raised in the jungles of Brazil, wearing green shorts, standing in a jungle clearing.')
  await page.getByLabel('Art style', { exact: true }).fill('90s video game character concept art, bright vibrant colors, exaggerated muscles and upper body features.')
  await page.getByLabel('Character title', { exact: false }).fill('Jungle Champion')
  await page.getByRole('tab', { name: 'Animator', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Character lab' })).toBeVisible()
  await page.getByLabel('Motion instructions').fill('A person stands and waves.')
  await page.getByRole('tab', { name: 'Designer', exact: true }).click()
  await expect(page.getByLabel('Character & scenario')).toHaveValue(/Brazilian MMA/)
  await page.getByRole('tab', { name: 'Animator', exact: true }).click()
  await expect(page.getByLabel('Motion instructions')).toHaveValue('A person stands and waves.')
  await page.getByRole('tab', { name: 'Designer', exact: true }).click()
  await expect(page.getByLabel('Installed image checkpoint').locator('option', { hasText: 'DreamShaper' })).toHaveCount(1, { timeout: 15000 })
  const imageName = await page.getByLabel('Installed image checkpoint').locator('option', { hasText: 'DreamShaper' }).getAttribute('value')
  // Options without explicit values use their text content.
  await page.getByLabel('Installed image checkpoint').selectOption(imageName || { label: 'DreamShaper_8_pruned.safetensors' })
  if (native) {
    await page.getByLabel('Background removal', { exact: false }).selectOption({ label: 'birefnet.safetensors' })
    await page.getByLabel('T-pose edit model', { exact: true }).selectOption({ label: 'flux-2-klein-4b-fp8.safetensors' })
    await page.getByLabel('Edit text encoder', { exact: true }).selectOption({ label: 'qwen_3_4b.safetensors' })
    await page.getByLabel('Edit autoencoder', { exact: true }).selectOption({ label: 'flux2-vae.safetensors' })
    await page.getByLabel('3D model profile').selectOption('standard')
    await page.getByLabel('Installed 3D checkpoint').selectOption({ label: 'hunyuan3d-dit-v2_fp16.safetensors' })
  }
  await page.getByRole('button', { name: 'Save model choices' }).click()
  await expect(page.getByRole('button', { name: 'Create character concept' })).toBeEnabled()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 760))
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Designer must fit the minimum window width.')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960))
  await expect.poll(() => page.evaluate(() => innerWidth)).toBeGreaterThan(1200)
  const placement = await page.evaluate(() => {
    const tabs = document.querySelector('.workspace-tabs').getBoundingClientRect()
    const notice = document.querySelector('.topbar>.connection').getBoundingClientRect()
    return { center: tabs.x + tabs.width / 2, viewportCenter: innerWidth / 2, tabsRight: tabs.right, noticeLeft: notice.left }
  })
  assert.ok(Math.abs(placement.center - placement.viewportCenter) < 2, 'Workspace tabs must be centered in the title bar.')
  assert.ok(placement.noticeLeft > placement.tabsRight + 20, 'Backend notices must remain visually separated on the right.')
  await page.locator('.design-models').evaluate(el => { el.scrollTop = 0 })
  await page.locator('.design-brief').evaluate(el => { el.scrollTop = 0 })
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(output, 'designer-ready.png'), scale: 'css', fullPage: true })
  if (native) {
    await page.getByRole('button', { name: 'Create character concept' }).click()
    const completedStage = async () => {
      await expect.poll(async () => (await page.evaluate(() => window.studio.snapshot())).designer.designs[0]?.status ?? 'running', { timeout: 1200000, intervals: [1000, 3000, 5000] }).not.toBe('running')
      const state = await page.evaluate(() => window.studio.snapshot())
      assert.equal(state.designer.designs[0].status, 'idle', state.designer.designs[0].message)
    }
    await completedStage()
    await expect(page.getByRole('button', { name: 'Use scene & generate T-pose' })).toBeEnabled()
    await expect(page.getByRole('img', { name: 'Character and scene reference for review' })).toBeVisible()
    await page.screenshot({ path: join(output, 'generated-scene.png'), scale: 'css', fullPage: true })
    await page.getByRole('button', { name: 'Use scene & generate T-pose' }).click()
    await completedStage()
    await expect(page.getByRole('button', { name: 'Use T-pose & generate 3D' })).toBeEnabled()
    await expect(page.getByRole('img', { name: 'T-pose reference for review' })).toBeVisible()
    await page.screenshot({ path: join(output, 'generated-tpose.png'), scale: 'css', fullPage: true })
    const images = (await page.evaluate(() => window.studio.snapshot())).designer.designs[0]
    await copyFile(join(data, 'designs', images.id, 'scene.png'), join(output, 'scene-reference.png'))
    await copyFile(join(data, 'designs', images.id, 'tpose-cutout.png'), join(output, 'tpose-cutout.png'))
    await page.getByRole('button', { name: 'Use T-pose & generate 3D' }).click()
    await completedStage()
    const state = await page.evaluate(() => window.studio.snapshot())
    assert.ok(state.designer.designs[0].sceneUrl)
    assert.ok(state.designer.designs[0].tposeUrl)
    assert.ok(state.designer.designs[0].modelUrl)
    assert.equal(state.designer.designs[0].tposeIsolated, true)
    const design = state.designer.designs[0]
    await copyFile(join(data, 'designs', design.id, 'model.glb'), join(output, 'character.glb'))
    await copyFile(join(data, 'designs', design.id, 'model-input.png'), join(output, 'model-input.png'))
    const manifest = JSON.parse(await readFile(join(data, 'designs', design.id, 'model-workflow.json'), 'utf8'))
    assert.equal(manifest.input.file, 'tpose-cutout.png')
    await expect(page.getByRole('button', { name: 'Send to Animator' })).toBeEnabled()
    await expect(page.locator('.design-canvas canvas')).toBeVisible({ timeout: 30000 })
    await expect(page.locator('.design-canvas .viewport-notice')).toHaveCount(0, { timeout: 30000 })
    await expect(page.locator('.design-canvas .viewport-error')).toHaveCount(0)
    await page.waitForTimeout(750)
    await page.screenshot({ path: join(output, 'generated-model.png'), scale: 'css', fullPage: true })
    await page.getByRole('button', { name: 'Send to Animator' }).click()
    await expect(page.getByRole('heading', { name: 'Character lab' })).toBeVisible({ timeout: 120000 })
    const animated = await page.evaluate(() => window.studio.snapshot())
    assert.ok(animated.characters[0].vertices > 100)
    assert.equal(animated.designer.designs[0].characterId, animated.characters[0].id)
    await page.screenshot({ path: join(output, 'model-in-animator.png'), scale: 'css', fullPage: true })
    await page.getByRole('tab', { name: 'Designer', exact: true }).click()
    await page.getByRole('button', { name: 'Open in Animator' }).click()
    assert.equal((await page.evaluate(() => window.studio.snapshot())).characters.length, 1)
    await page.getByRole('tab', { name: 'Designer', exact: true }).click()
    console.log(`Actual local scene -> isolated T-pose -> Hunyuan3D GLB -> Blender/Animator completed (${animated.characters[0].vertices} vertices).`)
  }
  const chooseFile = file => app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  const importedImage = join(data, 'TEST-ONLY-external-cutout.png')
  const fixturePng = await app.evaluate(({ nativeImage }) => {
    const bitmap = Buffer.alloc(240 * 120 * 4)
    for (let y = 15; y < 105; y++) for (let x = 90; x < 150; x++) {
      const offset = (y * 240 + x) * 4
      bitmap[offset + 1] = 180; bitmap[offset + 3] = 255
    }
    return nativeImage.createFromBitmap(bitmap, { width: 240, height: 120 }).toPNG().toString('base64')
  })
  await writeFile(importedImage, Buffer.from(fixturePng, 'base64'))
  await page.getByLabel('Character & scenario').fill('')
  await page.getByLabel('Art style', { exact: true }).fill('')
  await page.getByLabel('Character title', { exact: false }).fill('')
  await page.getByLabel('Continue from an existing file').selectOption('scene')
  await chooseFile(importedImage)
  await page.getByRole('button', { name: 'Import scene', exact: true }).click()
  await expect(page.locator('.design-source')).toContainText('Imported:')
  await expect(page.getByRole('button', { name: 'Use scene & generate T-pose' })).toBeEnabled()
  await page.getByLabel('Continue from an existing file').selectOption('tpose')
  await page.getByLabel('Already isolated transparent PNG').check()
  await page.getByRole('button', { name: 'Import T-pose', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Use T-pose & generate 3D' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Generate scene', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Remove T-pose background' })).toHaveCount(0)
  const imported = (await page.evaluate(() => window.studio.snapshot())).designer.designs[0]
  assert.equal(imported.sceneUrl, undefined)
  assert.equal(imported.tposeIsolated, true)
  assert.equal(imported.sources.tpose.kind, 'imported')
  if (native) {
    await page.getByLabel('Continue from an existing file').selectOption('model')
    await chooseFile(join(output, 'character.glb'))
    await page.getByRole('button', { name: 'Import GLB mesh', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Send to Animator' })).toBeEnabled()
    const modelImport = (await page.evaluate(() => window.studio.snapshot())).designer.designs[0]
    assert.ok(modelImport.modelUrl)
    assert.equal(modelImport.sceneUrl, undefined)
    assert.equal(modelImport.tposeUrl, undefined)
    assert.equal(modelImport.sources.model.kind, 'imported')
  }
  assert.deepEqual(errors, [])
  console.log('Designer UI: native bridge, stage imports, local model choices, state-preserving tabs and minimum-width layout passed.')
} finally {
  await app.close()
  await rm(data, { recursive: true, force: true })
}
