import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
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
  await expect(page.locator('.brand')).toContainText('powered by HuggingFace')
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
  await page.getByLabel('T-pose OpenPose ControlNet').selectOption({ label: 'control_v11p_sd15_openpose_fp16.safetensors' })
  if (native) {
    await page.getByLabel('Background removal', { exact: false }).selectOption({ label: 'birefnet.safetensors' })
    await page.getByLabel('Reference identity adapter').selectOption({ label: 'ip-adapter-plus_sd15.safetensors' })
    await page.getByLabel('Adapter CLIP Vision').selectOption({ label: 'CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors' })
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
      await expect.poll(async () => (await page.evaluate(() => window.studio.snapshot())).designer.designs[0]?.status ?? 'running', { timeout: 300000 }).not.toBe('running')
      const state = await page.evaluate(() => window.studio.snapshot())
      assert.equal(state.designer.designs[0].status, 'idle', state.designer.designs[0].message)
    }
    await completedStage()
    await expect(page.getByRole('button', { name: 'Use scene & generate T-pose' })).toBeEnabled()
    await expect(page.getByRole('img', { name: 'Generated character and scene in the requested art style' })).toBeVisible()
    await page.screenshot({ path: join(output, 'generated-scene.png') })
    await page.getByRole('button', { name: 'Use scene & generate T-pose' }).click()
    await completedStage()
    await expect(page.getByRole('button', { name: 'Use T-pose & generate 3D' })).toBeEnabled()
    await expect(page.getByRole('img', { name: 'Generated T-pose reference for review' })).toBeVisible()
    await page.screenshot({ path: join(output, 'generated-tpose.png') })
    await page.getByRole('button', { name: 'Use T-pose & generate 3D' }).click()
    await expect(page.getByRole('alert')).toContainText('installed checkpoint', { timeout: 20000 })
    const state = await page.evaluate(() => window.studio.snapshot())
    assert.ok(state.designer.designs[0].sceneUrl)
    assert.ok(state.designer.designs[0].tposeUrl)
    assert.equal(state.designer.designs[0].modelUrl, undefined)
    assert.equal(state.designer.designs[0].tposeIsolated, true)
    console.log('Actual local SD 1.5 scene, IP-Adapter/OpenPose T-pose and BiRefNet transparent cutout completed. 3D correctly blocked on missing installed weights.')
  }
  assert.deepEqual(errors, [])
  console.log('Designer UI: native bridge, local model choices, state-preserving tabs and minimum-width layout passed.')
} finally {
  await app.close()
  await rm(data, { recursive: true, force: true })
}
