/** Browser regression checks against a fresh, isolated local Edge core.
 * Prerequisites: Go; npm ci + npx playwright install chromium webkit in frontend/portal.
 * Run: node edge-app/test/ui-mobile.mjs
 * No cloud enrollment, real hardware, or existing data directories are used.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../frontend/portal/package.json', import.meta.url));
const { chromium, webkit, expect } = require('@playwright/test');
const work = mkdtempSync(join(tmpdir(), 'vp-edge-ui-'));
const core = fileURLToPath(new URL('../core/', import.meta.url));
async function port() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const result = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return result;
}
const httpPort = await port(), mqttPort = await port();
const base = `http://127.0.0.1:${httpPort}`;
execFileSync('go', ['build', '-o', join(work, 'edge'), './cmd/vp-edge-core'], { cwd: core, stdio: 'inherit' });
const child = spawn(join(work, 'edge'), [], { env: {
  ...process.env, VP_CONFIG: '', VP_DATA_DIR: join(work, 'data'),
  VP_HTTP_ADDR: `127.0.0.1:${httpPort}`, VP_LOCAL_MQTT_ADDR: `127.0.0.1:${mqttPort}`,
  VP_PORTAL_BASE_URL: 'http://127.0.0.1:1', VP_MQTT_HOST: '127.0.0.1', VP_OCPP_ENABLED: 'false',
}, stdio: ['ignore', 'ignore', 'pipe'] });
let logs = '';
child.stderr.on('data', data => { logs += data; });
try {
  await expect.poll(async () => {
    try { return (await fetch(base)).status; } catch { return 0; }
  }, { timeout: 20000 }).toBe(200);
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
      // Shared chrome: both pages must keep the same height and the
      // technical-state row must stay BELOW the header after scrolling.
      const heights = new Map();
      for (const route of ['index.html', 'einrichten.html']) {
        await page.goto(base + '/' + route);
        await page.locator('#techToggle').click();
        if (await page.locator('#techToggle').getAttribute('aria-pressed') !== 'true') await page.locator('#techToggle').click();
        for (const width of [320, 375, 390, 430, 768, 834, 1440]) {
          await page.setViewportSize({ width, height: 812 });
          await page.evaluate(() => window.scrollTo(0, 400));
          const header = await page.locator('.topbar').boundingBox();
          const state = await page.locator('.tech-bar').boundingBox();
          assert(header && state);
          assert(Math.abs(header.y) < 1, 'Header stays pinned');
          assert(Math.abs(state.y - header.y - header.height) < 1, 'Technical state must not hide behind header');
          assert((await page.evaluate(() => document.documentElement.scrollWidth)) <= width, 'Compare to requested viewport: mobile innerWidth can silently expand');
          const brand = await page.locator('.brand').boundingBox();
          assert(brand.width >= 44 && brand.height >= 44, 'Home link touch target');
          if (heights.has(width)) assert(Math.abs(heights.get(width) - header.height) < 1, 'Header height stays consistent across pages');
          else heights.set(width, header.height);
        }
      }
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto(base + '/einrichten.html#quellen');
      const trigger = page.locator('#erzAdd');
      await trigger.click();
      const dialog = page.getByRole('dialog', { name: 'Quelle hinzufügen' });
      await expect(dialog).toBeVisible();
      const closeSize = await dialog.locator('#srcClose').boundingBox();
      assert(closeSize.width >= 44 && closeSize.height >= 44, 'Close must have a 44px touch target');
      await dialog.locator('#srcClose').focus();
      await page.keyboard.press('Shift+Tab');
      const last = dialog.locator('button[type=submit]');
      await expect(last).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(dialog.locator('#srcClose')).toBeFocused();
      await dialog.getByRole('combobox', { name: 'Marke', exact: true }).click();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeVisible();
      for (const width of [320, 375, 390, 430, 768, 834, 1440]) {
        await page.setViewportSize({ width, height: 812 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        if (width <= 640) {
          const fonts = await dialog.locator('input:not([type=checkbox])').evaluateAll(els => els.filter(el => el.getClientRects().length).map(el => parseFloat(getComputedStyle(el).fontSize)));
          assert(fonts.length > 0 && fonts.every(size => size >= 16), `Small editable text: ${fonts}`);
        }
        if (width === 375 && process.env.UI_AUDIT_ARTIFACTS) {
          await page.screenshot({ path: join(process.env.UI_AUDIT_ARTIFACTS, `edge-source-${engine.name()}-after.png`) });
        }
      }
      await page.setViewportSize({ width: 812, height: 375 });
      await expect(dialog.locator('#srcClose')).toBeInViewport();
      await expect(last).toBeInViewport();
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      await expect(trigger).toBeFocused();
      await page.setViewportSize({ width: 375, height: 812 });
      await page.locator('#invSetupBtn').click();
      await expect(page.locator('#modelSearch')).toHaveCSS('font-size', '16px');
      await page.locator('#modelSearch').fill('sun 12k');
      await expect(page.locator('.picker-opt:visible').first()).toBeVisible();
      console.log(`${engine.name()}: Edge mobile forms, focus, nested picker, widths and landscape passed`);
    } finally { await browser.close(); }
  }
} catch (error) {
  console.error(logs.slice(-2000));
  throw error;
} finally {
  child.kill('SIGTERM');
  console.log(`Isolated test data retained at ${work}`);
}
