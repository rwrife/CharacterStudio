import { _electron as electron } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

const artifact = resolve('artifacts', 'desktop-smoke')
await mkdir(artifact, { recursive: true })
const errors = []
const app = await electron.launch({
  args: ['.'], env: { ...process.env, STUDIO_DATA_DIR: resolve('artifacts', 'desktop-state') },
  timeout: 60000
})
try {
  const page = await app.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await page.getByRole('heading', { name: 'Character lab' }).waitFor()
  const source = resolve('artifacts', 'Bruiser_base.fbx')
  await app.evaluate(({ dialog }, source) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] })
  }, source)
  await page.getByRole('button', { name: /^Import FBX\s+LOCAL FILE$/ }).click()
  await page.getByRole('heading', { name: 'Bruiser_base', exact: false }).waitFor({ timeout: 120000 })
  assert.equal(await page.getByLabel('Rotate Y').inputValue({ timeout: 120000 }), '-90', 'The sample should be automatically oriented facing the camera.')
  await page.getByRole('button', { name: 'Front view', exact: true }).click()
  await page.waitForTimeout(2000)
  await page.screenshot({ path: resolve(artifact, 'bruiser-front.png') })
  await page.getByRole('button', { name: 'Side view', exact: true }).click()
  await page.screenshot({ path: resolve(artifact, 'bruiser-side.png') })
  await page.getByRole('button', { name: 'Backend settings', exact: false }).count()
  const state = await page.evaluate(() => window.studio.snapshot())
  assert.ok(state.characters[0].vertices > 100000)
  assert.equal(state.characters[0].rigged, false)
  assert.deepEqual(errors, [])
  console.log('Desktop smoke: native bridge, FBX import, WebGL preview, and rig controls passed.')
  console.log('Screenshots:', artifact)
} finally {
  await app.close()
}
