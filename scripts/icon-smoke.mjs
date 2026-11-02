import { _electron as electron, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const directory = await mkdtemp(join(tmpdir(), 'studio-icon-'))
let app
try {
  app = await electron.launch({
    args: ['.'],
    env: { ...process.env, STUDIO_SKIP_SETUP_CHECKLIST: '1', STUDIO_NO_AUTO_INSTALL: '1', STUDIO_DATA_DIR: directory },
    timeout: 60000
  })
  const page = await app.firstWindow()
  await page.getByRole('heading', { name: 'Character lab' }).waitFor()
  const icon = page.locator('.brand-mark')
  await expect(icon).toBeVisible()
  assert.equal(await icon.evaluate(image => image.complete && image.naturalWidth === 1024 && image.naturalHeight === 1024), true)
  for (const width of [1100, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    for (const workspace of ['Designer', 'Animator']) {
      await page.getByRole('tab', { name: workspace, exact: true }).click()
      const bounds = await page.evaluate(() => {
        const icon = document.querySelector('.brand-mark').getBoundingClientRect()
        const header = document.querySelector('.topbar').getBoundingClientRect()
        const brand = document.querySelector('.brand').getBoundingClientRect()
        const tabs = document.querySelector('.workspace-tabs').getBoundingClientRect()
        const actions = document.querySelector('.topbar-actions').getBoundingClientRect()
        return {
          width: icon.width, height: icon.height,
          fits: icon.top >= header.top && icon.bottom <= header.bottom,
          separated: brand.right < tabs.left && tabs.right < actions.left,
          noOverflow: document.documentElement.scrollWidth <= innerWidth
        }
      })
      assert.equal(bounds.width, 48)
      assert.equal(bounds.height, 48)
      assert.ok(bounds.fits && bounds.separated && bounds.noOverflow, `${workspace} header must fit at ${width}px.`)
    }
  }
  await mkdir(resolve('docs', 'screenshots'), { recursive: true })
  await page.locator('.topbar').screenshot({ path: resolve('docs', 'screenshots', 'app-titlebar.png'), scale: 'css' })
  console.log('Icon smoke passed: artwork loaded, 48px titlebar icon, both workspaces fit at 1100px and 1440px.')
} finally {
  await app?.close()
  await rm(directory, { recursive: true, force: true })
}
