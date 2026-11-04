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
  const reports = []
  for (const width of [1100, 1440]) for (const zoom of [1, 1.25]) {
    await page.setViewportSize({ width, height: 900 })
    await app.evaluate(({ BrowserWindow }, zoom) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom), zoom)
    for (const workspace of ['Designer', 'Animator']) {
      await page.getByRole('tab', { name: workspace, exact: true }).click()
      const bounds = await page.evaluate(() => {
        const get = selector => {
          const element = document.querySelector(selector), style = getComputedStyle(element), rect = element.getBoundingClientRect()
          return { style, rect }
        }
        const icon = get('.brand-mark'), header = get('.topbar'), brand = get('.brand'), tabs = get('.workspace-tabs'), actions = get('.topbar-actions')
        const name = get('.brand-name > strong'), suffix = get('.brand-name > strong > span'), tagline = get('.brand-tagline')
        const action = get('.topbar-actions > .connection'), text = get('.brand-name')
        return {
          viewport: innerWidth, height: parseFloat(header.style.height), padding: parseFloat(header.style.paddingLeft),
          font: header.style.fontFamily, gap: parseFloat(header.style.columnGap),
          icon: [parseFloat(icon.style.width), parseFloat(icon.style.height)], iconShrink: icon.style.flexShrink,
          brandGap: parseFloat(brand.style.columnGap), textGap: parseFloat(text.style.rowGap),
          wordmark: [parseFloat(name.style.fontSize), Number(name.style.fontWeight), parseFloat(name.style.lineHeight), parseFloat(name.style.letterSpacing)],
          suffix: [Number(suffix.style.fontWeight), parseFloat(suffix.style.marginLeft)],
          tagline: [parseFloat(tagline.style.fontSize), Number(tagline.style.fontWeight), parseFloat(tagline.style.lineHeight), parseFloat(tagline.style.letterSpacing)],
          uppercase: tagline.style.textTransform,
          action: [parseFloat(action.style.height), parseFloat(action.style.fontSize), Number(action.style.fontWeight), parseFloat(action.style.lineHeight)],
          actionGap: parseFloat(actions.style.columnGap),
          tabs: parseFloat(get('.workspace-tabs button').style.fontSize),
          fits: icon.rect.top >= header.rect.top && icon.rect.bottom <= header.rect.bottom,
          separated: brand.rect.right < tabs.rect.left && (tabs.rect.right < actions.rect.left || tabs.rect.bottom <= actions.rect.top),
          noOverflow: document.documentElement.scrollWidth <= innerWidth &&
            document.querySelector('.topbar').scrollWidth <= document.querySelector('.topbar').clientWidth
        }
      })
      const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.05, `${message}: ${actual} vs ${expected}`)
      assert.equal(bounds.font, '"Segoe UI Variable", "Segoe UI", sans-serif')
      assert.deepEqual(bounds.icon, [40, 40])
      assert.equal(bounds.iconShrink, '0')
      assert.equal(bounds.brandGap, 12); assert.equal(bounds.textGap, 3); assert.equal(bounds.gap, 20)
      bounds.wordmark.forEach((value, index) => near(value, [24, 700, 26.4, -0.8][index], 'Wordmark metric'))
      assert.deepEqual(bounds.suffix, [300, 4])
      bounds.tagline.forEach((value, index) => near(value, [8, 500, 11.2, 1.5][index], 'Tagline metric'))
      assert.equal(bounds.uppercase, 'uppercase')
      assert.deepEqual(bounds.action, [34, 12, 500, 16])
      assert.equal(bounds.actionGap, bounds.viewport <= 1200 ? 6 : 8)
      assert.equal(bounds.tabs, 19)
      if (bounds.viewport > 900) {
        assert.equal(bounds.height, 78)
        assert.equal(bounds.padding, bounds.viewport <= 1200 ? 18 : 24)
      }
      assert.ok(bounds.fits && bounds.separated && bounds.noOverflow, `${workspace} header must fit at ${width}px / ${zoom} zoom: ${JSON.stringify(bounds)}`)
      if (workspace === 'Designer') reports.push({ width, zoom, ...bounds })
    }
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
  await page.setViewportSize({ width: 1440, height: 900 })
  await mkdir(resolve('docs', 'screenshots'), { recursive: true })
  await page.locator('.topbar').screenshot({ path: resolve('docs', 'screenshots', 'app-titlebar.png'), scale: 'css' })
  console.log('Header computed metrics:', JSON.stringify(reports))
  console.log('Header smoke passed: shared type/spacing metrics, 40px icon, both workspaces fit at 1100px and 1440px with 100%/125% zoom; native titlebar unchanged.')
} finally {
  await app?.close()
  await rm(directory, { recursive: true, force: true })
}
