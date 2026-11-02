import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Checks the first-launch checklist against this machine's real tools, without starting downloads or installs.
const data = await mkdtemp(join(tmpdir(), 'kimodo-first-launch-'))
const output = resolve('artifacts', 'desktop-smoke')
await mkdir(output, { recursive: true })
const launch = () => electron.launch({ args: ['.'], env: { ...process.env, STUDIO_SKIP_SETUP_CHECKLIST: '', STUDIO_DATA_DIR: data }, timeout: 60000 })

let app = await launch()
try {
  let page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  let dialog = page.getByRole('dialog', { name: 'Setup checklist' })
  await expect(dialog).toBeVisible({ timeout: 20000 })
  await expect(dialog.getByText('WELCOME · FIRST LAUNCH')).toBeVisible()
  for (const group of ['Core requirements', 'Animator', 'Designer models', 'Optional'])
    await expect(dialog.getByRole('region', { name: group })).toBeVisible()
  await expect(dialog.locator('.setup-item')).toHaveCount(14, { timeout: 30000 })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.screenshot({ path: join(output, 'setup-checklist.png') })

  // Intercept the browser: links come from the main-process allowlist, never from the renderer.
  await app.evaluate(({ shell }) => { globalThis.openedLinks = []; shell.openExternal = async url => { globalThis.openedLinks.push(url) } })
  await dialog.getByRole('button', { name: 'License' }).first().click()
  await expect.poll(() => app.evaluate(() => globalThis.openedLinks.length)).toBe(1)
  assert.match((await app.evaluate(() => globalThis.openedLinks))[0], /^https:\/\/huggingface\.co\//)

  await dialog.getByRole('button', { name: 'Re-check' }).click()
  await expect(dialog.getByRole('button', { name: 'Re-check' })).toBeEnabled({ timeout: 30000 })
  const toggle = dialog.getByLabel('Show this checklist at launch')
  await expect(toggle).toBeChecked()
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await dialog.getByRole('button', { name: /Continue to Studio|Start creating/ }).click()
  await expect(dialog).toBeHidden()
  await page.getByRole('button', { name: 'Setup checklist' }).click()
  await expect(dialog.getByText('SETUP CHECKLIST', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Close setup checklist' }).click()
  assert.deepEqual(errors, [])
  await app.close()

  // The user's choice persists: a relaunch validates dependencies instead of reopening the checklist, and can be cancelled.
  app = await launch()
  page = await app.firstWindow()
  await page.getByRole('heading', { name: 'Character lab' }).waitFor()
  const card = page.getByRole('status', { name: 'Dependency check' })
  const prompt = page.getByRole('dialog', { name: 'Dependency check' })
  await expect(card.or(prompt)).toBeVisible({ timeout: 20000 })
  await expect(page.getByRole('dialog', { name: 'Setup checklist' })).toHaveCount(0)
  const cancel = card.getByRole('button', { name: 'Cancel' })
  if (await cancel.isVisible()) {
    await cancel.click()
    await expect(card).toBeHidden()
    await expect(prompt).toHaveCount(0)
  }
  await app.close()

  // An uncancelled check finishes: problems open a prompt with one-click fixes; a healthy machine shows a brief notice.
  app = await launch()
  page = await app.firstWindow()
  await page.setViewportSize({ width: 1440, height: 1000 })
  const launchPrompt = page.getByRole('dialog', { name: 'Dependency check' })
  const ready = page.getByRole('status', { name: 'Dependency check' }).getByText('All required dependencies are working.')
  await expect(launchPrompt.or(ready)).toBeVisible({ timeout: 60000 })
  if (await launchPrompt.isVisible()) {
    await expect(launchPrompt.locator('.setup-item').first()).toBeVisible()
    await page.screenshot({ path: join(output, 'launch-check.png') })
    await launchPrompt.getByRole('button', { name: 'Re-check' }).click()
    const cancelCheck = launchPrompt.getByRole('button', { name: 'Cancel check' })
    if (await cancelCheck.isVisible()) { await cancelCheck.click(); await expect(launchPrompt.getByText('Check cancelled')).toBeVisible() }
    await expect(launchPrompt.getByRole('button', { name: 'Re-check' })).toBeVisible({ timeout: 60000 })
    await launchPrompt.getByRole('button', { name: 'Open setup checklist' }).click()
    await expect(launchPrompt).toBeHidden()
    const checklist = page.getByRole('dialog', { name: 'Setup checklist' })
    await expect(checklist).toBeVisible()
    await checklist.getByRole('button', { name: 'Close setup checklist' }).click()
    console.log(`Launch check prompt shown. Screenshot: ${join(output, 'launch-check.png')}`)
  } else console.log('All required dependencies were ready; no launch prompt was needed.')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  console.log(`Setup checklist smoke passed. Screenshot: ${join(output, 'setup-checklist.png')}`)
} finally {
  await app.close().catch(() => {})
  await rm(data, { recursive: true, force: true })
}
