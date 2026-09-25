import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { captures } from '../e2e/help-captures.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const assets = new URL('../src/help/assets/', import.meta.url);
const manifestPath = new URL('../src/help/screenshots.generated.json', import.meta.url);
const selected = process.argv.slice(2);
const specs = selected.length ? captures.filter((s) => selected.includes(s.id)) : captures;
if (!specs.length) throw new Error('No matching capture id.');
await mkdir(assets, { recursive: true });
const manifest = selected.length ? JSON.parse(await readFile(manifestPath, 'utf8')) : {};
const server = await createServer({ root, server: { host: '127.0.0.1', port: 4176, strictPort: true } });
await server.listen();
const browser = await chromium.launch();

async function firstVisible(page, selector) {
  const matches = page.locator(selector);
  for (let i = 0; i < await matches.count(); i++) if (await matches.nth(i).isVisible()) return matches.nth(i);
  throw new Error('No visible capture anchor: ' + selector);
}

try {
  for (const spec of specs) {
    const viewport = spec.mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 };
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1, locale: 'de-DE', timezoneId: 'Europe/Berlin', reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.clock.setFixedTime(new Date('2026-09-10T10:00:00Z'));
    // Teaching map: deterministic fictional tile; all other off-origin traffic
    // is blocked so recapture cannot depend on a live account or external data.
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === '127.0.0.1') return route.continue();
      if (url.hostname.endsWith('tile.openstreetmap.org')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#edf1e9"/><path d="M0 80H256M85 0V256M0 190H256M185 0V256" stroke="#fff" stroke-width="8"/></svg>' });
      return route.abort();
    });
    try {
      await page.goto(`http://127.0.0.1:4176/e2e/help.html${spec.query ? '?' + spec.query : ''}${spec.hash ?? ''}`);
      await page.locator('.vp-app, .vp-modal').first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(1000);
      if (spec.menu) await page.getByRole('button', { name: /Konto-Menü/ }).click();
      // Ein einmaliger Hinweis beim ersten Besuch (etwa die Einführung der
      // Tagesuhr) würde die Aufnahme verdecken: er wird wie vom Kunden beendet.
      if (spec.klick) {
        const knopf = page.getByRole('button', { name: spec.klick });
        if (await knopf.count()) await knopf.first().click();
        await page.waitForTimeout(300);
      }
      // Die Seite lädt ihre Daten nach dem ersten Bild - gewartet wird auf den
      // ersten Anker, nie auf eine feste Zeit, die auf einem langsamen Rechner fehlt.
      await page.locator(spec.points[0].selector).first().waitFor({ timeout: 15000 }).catch(() => {});
      // Ein Weg durch echte Formulare (Katalog → Einrichten): klicken, ausfüllen,
      // auf ein Ergebnis warten, eine Stelle ins Bild holen - wie ein Kunde.
      for (const a of spec.aktionen ?? []) {
        if (a.klick) await page.getByRole('button', { name: a.klick }).first().click();
        if (a.fuellen) {
          const feld = page.getByLabel(a.fuellen[0]).first();
          await feld.fill(a.fuellen[1]);
          await feld.blur();
        }
        if (a.warten) await page.locator(a.warten).first().waitFor({ timeout: 10000 });
        if (a.zeigen) await page.locator(a.zeigen).first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
        await page.waitForTimeout(400);
      }
      if (errors.length) throw new Error(errors.join('\n'));
      const rootNode = spec.viewportOnly ? null : await firstVisible(page, spec.root ?? 'main');
      const origin = rootNode ? await rootNode.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; }) : { x: 0, y: 0, ...viewport };
      origin.height = Math.min(origin.height, spec.maxHeight ?? (spec.root === 'main' ? 1200 : Infinity));
      const callouts = [];
      for (const p of spec.points) {
        const anchor = await firstVisible(page, p.selector);
        const at = await anchor.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x + scrollX + Math.min(20, r.width / 2), y: r.y + scrollY + Math.min(18, r.height / 2) }; });
        const x = Math.round((at.x - origin.x) / origin.width * 10000) / 100;
        const y = Math.round((at.y - origin.y) / origin.height * 10000) / 100;
        if (x < 0 || x > 100 || y < 0 || y > 100) throw new Error(`Anchor outside screenshot: ${p.selector} (${x},${y})`);
        callouts.push({ x, y, text: p.text });
      }
      const file = spec.id + '.png';
      const path = fileURLToPath(new URL(file, assets));
      // Capture the document rectangle without scrolling it behind the sticky
      // portal header. Its origin also remains identical to the callout origin.
      if (rootNode) await page.screenshot({ path, animations: 'disabled', fullPage: true, clip: origin });
      else await page.screenshot({ path, animations: 'disabled' });
      const png = await readFile(path);
      manifest[spec.id] = { title: spec.title, file, width: png.readUInt32BE(16), height: png.readUInt32BE(20),
        alt: spec.title + '. Aufnahme des VoltPilot-Portals mit fiktiven Daten. Die nummerierten Stellen werden unter dem Bild erklärt.', callouts };
      console.log('Captured ' + spec.id);
    } catch (error) {
      console.error('Capture failed: ' + spec.id + ': ' + error.message);
      throw error;
    } finally { await page.close(); }
  }
  // Publish a complete index; readers never see half a handbook during capture.
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
} finally { await browser.close(); await server.close(); }
