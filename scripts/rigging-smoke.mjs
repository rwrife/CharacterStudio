import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const data = await mkdtemp(join(tmpdir(), 'studio-rigging-ui-'))
const output = resolve('artifacts', 'rigging-smoke')
await mkdir(output, { recursive: true })
const app = await electron.launch({ args: ['.'], env: { ...process.env, STUDIO_DATA_DIR: data }, timeout: 60000 })
try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.getByRole('heading', { name: 'Character lab' }).waitFor()
  await page.setViewportSize({ width: 1440, height: 1160 })
  const state = await page.evaluate(() => window.studio.snapshot())
  const { defaultLandmarks } = await import('../src/shared/rig.ts')
  state.characters = [{
    id: '0f58ac73-6a7e-4a04-81cc-b80ed5e8ceec', name: 'UI recovery fixture (no character asset)',
    importedAt: new Date().toISOString(), previewUrl: '', vertices: 33214, meshes: 1, warnings: [],
    rigged: false, setup: { rotation: [0, 0, 0], landmarks: defaultLandmarks() }
  }]
  // UI-only failure/success responses. Native skinning is covered by test_rigging_blender.py.
  await app.evaluate(({ ipcMain, BrowserWindow }, state) => {
    globalThis.rigUi = { state, calls: [], pending: undefined, setupAtRig: undefined }
    const update = () => BrowserWindow.getAllWindows()[0].webContents.send('studio:update', state)
    for (const channel of ['studio:snapshot', 'studio:check', 'studio:setup', 'studio:rig']) ipcMain.removeHandler(channel)
    ipcMain.handle('studio:snapshot', () => state)
    ipcMain.handle('studio:check', () => [])
    ipcMain.handle('studio:setup', (_event, id, setup) => {
      if (id !== state.characters[0].id) throw new Error('Wrong character')
      state.characters[0].setup = setup
      update()
      return state.characters[0]
    })
    ipcMain.handle('studio:rig', async (_event, id, skinning) => {
      const test = globalThis.rigUi
      if (id !== state.characters[0].id) throw new Error('Wrong character')
      test.calls.push(skinning)
      test.setupAtRig = structuredClone(state.characters[0].setup)
      const job = { id: `ui-job-${test.calls.length}`, characterId: id, characterName: state.characters[0].name,
        kind: 'rig', stage: 'rigging', message: 'UI fixture: repairing skin weights', progress: 50, createdAt: new Date().toISOString() }
      state.jobs.unshift(job)
      update()
      if (skinning === 'automatic') {
        job.stage = 'failed'
        job.rigFailure = 'unweighted'
        job.message = 'Automatic skinning left 1,467 of 33,214 vertices unweighted. No successful character result was saved.'
        update()
        throw new Error(job.message)
      }
      await new Promise(resolve => { test.pending = resolve })
      job.stage = 'complete'
      job.warnings = ['UI fixture: Approximate fallback weights assigned to 1,467 vertices. Review deformation before export.']
      state.characters[0].rigged = true
      state.characters[0].rigWarnings = job.warnings
      update()
    })
  }, state)
  await page.reload()
  await page.getByRole('button', { name: /Fit & skin/ }).click()
  const fallback = page.getByRole('button', { name: 'Accept points + fallback skinning', exact: true })
  await expect(fallback).toBeEnabled()
  const build = page.getByRole('button', { name: 'Build skin + rig', exact: true })
  const buildBounds = await build.boundingBox()
  const fallbackBounds = await fallback.boundingBox()
  assert.ok(buildBounds && fallbackBounds)
  assert.equal(Math.round(fallbackBounds.y - buildBounds.y - buildBounds.height), 12, 'Rigging actions must have a 12px gap.')
  await page.getByLabel('Joint X', { exact: true }).fill('0.08')
  await page.getByRole('button', { name: 'Build skin + rig', exact: true }).click()
  await expect(page.getByText('Some vertices could not be attached', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Joint X', { exact: true })).toHaveValue('0.08')
  await expect(page.getByRole('button', { name: 'Generate motion', exact: true })).toHaveCount(0)
  await page.locator('.right-panel').screenshot({ path: join(output, 'rigging-recovery.png'), scale: 'css' })
  await page.getByLabel('Joint X', { exact: true }).fill('0.09')
  await fallback.click()
  await expect(fallback).toBeDisabled()
  await expect(page.getByLabel('Joint X', { exact: true })).toBeDisabled()
  const recorded = await app.evaluate(() => ({ calls: globalThis.rigUi.calls, setup: globalThis.rigUi.setupAtRig }))
  assert.deepEqual(recorded.calls, ['automatic', 'fallback'])
  assert.equal(recorded.setup.landmarks.Hips[0], 0.09)
  await app.evaluate(() => globalThis.rigUi.pending())
  await expect(page.getByText('Rig notes', { exact: true })).toBeVisible()
  await expect(page.getByText(/UI fixture: Approximate fallback weights/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Rigged', exact: true })).toBeEnabled()
  await page.reload()
  await expect(page.getByText(/UI fixture: Approximate fallback weights/)).toBeVisible()
  assert.deepEqual(errors, [])
  console.log('Rigging UI smoke passed: saved points, recovery actions, busy guards and persistent warning display.')
} finally {
  await app.close()
  await rm(data, { recursive: true, force: true })
}
