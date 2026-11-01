import { _electron as electron } from 'playwright'
import { mkdir, readFile, access } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const directory = resolve('release', 'KimodoStudio-win32-arm64')
const executablePath = join(directory, 'KimodoStudio.exe')
const appRoot = join(directory, 'resources', 'app')
const data = process.argv[2] ? resolve(process.argv[2]) : resolve('artifacts', 'packaged-state')
const output = resolve('artifacts', 'desktop-smoke')
await mkdir(output, { recursive: true })
for (const excluded of ['artifacts', 'tests', 'scripts', 'src'])
  await assert.rejects(access(join(appRoot, excluded)), { code: 'ENOENT' })
const env = { ...process.env, STUDIO_DATA_DIR: data }
const app = await electron.launch({ executablePath, args: [], env, timeout: 60000 })
try {
  const runtime = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, root: app.getAppPath(), arch: process.arch }))
  assert.equal(runtime.packaged, true)
  assert.equal(runtime.arch, 'arm64')
  assert.equal(runtime.root, appRoot)
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await page.getByRole('heading', { name: 'Character lab' }).waitFor()
  let state = await page.evaluate(() => window.studio.snapshot())
  assert.equal(state.settings.blenderPath, join(appRoot, '.tools', 'blender-4.5.15-windows-arm64', 'blender.exe'), 'Packaged app must use its bundled backend.')
  let character = state.characters.find(c => c.name === 'Bruiser_base.fbx')
  if (!character) {
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, resolve('artifacts', 'Bruiser_base.fbx'))
    await page.getByRole('button', { name: /^Import FBX\s+LOCAL FILE$/ }).click()
    await page.getByRole('heading', { name: 'Bruiser_base', exact: false }).waitFor({ timeout: 120000 })
    state = await page.evaluate(() => window.studio.snapshot())
    character = state.characters[0]
  }
  if (!character.rigged) {
    const setup = JSON.parse(await readFile(resolve('tests', 'fixtures', 'bruiser-setup.json'), 'utf8'))
    await page.evaluate(async ({ id, setup }) => { await window.studio.saveSetup(id, setup); await window.studio.rig(id) }, { id: character.id, setup })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: 'Character lab' }).waitFor()
  }
  state = await page.evaluate(() => window.studio.snapshot())
  assert.ok(state.characters.find(c => c.id === character.id).rigged)
  assert.equal(state.jobs.filter(job => job.kind === 'generate' && job.stage === 'complete').length, 0, 'No analytic fixtures should masquerade as generated jobs.')
  if (!state.plans.length) {
    const { plan } = JSON.parse(await readFile(resolve('artifacts', 'library-roundtrip.json'), 'utf8'))
    await page.evaluate(plan => window.studio.savePlan(plan), { ...plan, id: randomUUID() })
  }
  await page.getByRole('button', { name: 'Adjust rig fit' }).waitFor({ timeout: 120000 })
  await page.getByRole('button', { name: 'Front view', exact: true }).click()
  await page.locator('.connection').filter({ hasNotText: 'Checking backends' }).waitFor({ timeout: 120000 })
  await page.waitForTimeout(2500)
  await page.screenshot({ path: join(output, 'packaged-bruiser-ready.png') })
  await page.getByRole('button', { name: 'Motion library & batches' }).click()
  await page.screenshot({ path: join(output, 'packaged-motion-library.png') })
  await page.getByRole('button', { name: 'Close motion library' }).click()
  await promisify(execFile)(executablePath, [], { env, timeout: 30000 })
  assert.ok(await page.getByRole('heading', { name: 'Character lab' }).isVisible(), 'A second launch should leave the original workspace open.')
  assert.deepEqual(errors, [])
  console.log('Packaged ARM64 app: bundled Blender imported and fully skinned Bruiser; saved branching configuration; single-instance workspace protection. No fake generated clips.')
  console.log('Persistent workspace:', data)
} finally { await app.close() }
