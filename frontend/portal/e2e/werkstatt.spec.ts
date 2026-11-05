import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// WebKit braucht im Container mehr Zeit.
test.describe.configure({ timeout: 90_000 });

const SHA = 'a3f1c09b7e2d4f6a8b0c1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5e6f708';

/**
 * Kein waagerechter Überlauf und nichts, was über den Rand der Seite ragt. Tabellen und die Reiterleiste
 * scrollen in sich; von der Leiste muss der gewählte Reiter ganz zu sehen sein.
 */
async function passt(page: Page) {
  const r = await page.evaluate(() => {
    const breite = document.documentElement.clientWidth;
    const zuBreit = [...document.querySelectorAll<HTMLElement>('.vp-ws *')]
      .filter((e) => e.offsetParent !== null && !e.closest('.vp-table-scroll, .vp-bereich-tabs'))
      .filter((e) => e.getBoundingClientRect().right > breite + 1)
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`);
    const reiter = document.querySelector<HTMLElement>('.vp-bereich-tabs [aria-selected="true"]')!.getBoundingClientRect();
    const leiste = document.querySelector<HTMLElement>('.vp-bereich-tabs')!.getBoundingClientRect();
    return {
      ueberlauf: document.documentElement.scrollWidth - breite,
      zuBreit: zuBreit.slice(0, 5),
      reiterSichtbar: reiter.left >= leiste.left - 1 && reiter.right <= leiste.right + 1,
    };
  });
  expect(r.ueberlauf).toBeLessThanOrEqual(0);
  expect(r.zuBreit).toEqual([]);
  expect(r.reiterSichtbar).toBe(true);
}

function wache(page: Page): string[] {
  const fehler: string[] = [];
  page.on('pageerror', (e) => fehler.push(e.message));
  page.on('console', (m) => m.type() === 'error' && fehler.push(m.text()));
  return fehler;
}

for (const breite of [1440, 375]) {
  test(`Werkstatt bei ${breite} px: Übersicht mit Freigabe, Brücke, Boxen und Belegen, dann an die Werkbank`, async ({ page }) => {
    const fehler = wache(page);
    await page.setViewportSize({ width: breite, height: 900 });
    await page.goto('/e2e/werkstatt.html');

    await expect(page.getByRole('tab', { name: 'Werkstatt' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('ws-versand-oben')).toContainText('Nicht versenden: Stufe 1');
    await expect(page.getByTestId('ws-freigabe')).toContainText('Werkstatt freigegeben · Mango');
    await expect(page.getByTestId('ws-freigabe')).toContainText('Edge Light 2026.11.1 · OpenWrt 25.12.5 · bis 30.11.');
    await expect(page.getByTestId('ws-bruecke')).toContainText('bereit · Kabel am Werkstatt-Anschluss');
    const liste = page.getByTestId('ws-boxen');
    await expect(liste.locator('tr[data-stand="abgenommen"]')).toContainText('edge-5t2dcy6');
    await expect(liste.locator('tr[data-stand="laeuft"]')).toContainText('edge-k7m2xq3');
    await expect(liste.locator('tr[data-stand="problem"]')).toContainText('edge-p3n8rv4');
    await expect(liste).toContainText('Docker-Box');
    await passt(page);
    await page.screenshot({ path: test.info().outputPath(`werkstatt-uebersicht-${breite}.png`), fullPage: true });

    await liste.getByRole('button', { name: 'edge-5t2dcy6' }).click();
    await expect(page).toHaveURL(/#\/werkstatt\?box=edge-5t2dcy6$/);
    const detail = page.getByTestId('ws-detail');
    await expect(page.getByTestId('ws-boxen')).toHaveCount(0);
    await expect(detail.getByTestId('ws-stand')).toHaveText('abgenommen');
    await expect(detail.getByTestId('ws-zeile-hardware')).toContainText('GL-MT300N-V2');
    await expect(detail.getByTestId('ws-zeile-edge-light')).toHaveText('edge-light-2026.11.1');
    await expect(detail.getByTestId('ws-zeile-openwrt')).toHaveText('25.12.5');
    await expect(detail.getByTestId('ws-zeile-tunnel')).toHaveText('10.10.16.9');
    await expect(detail.getByTestId('ws-zeile-ort')).toHaveText('Halle 1 · Beispiel GmbH');
    await expect(detail.getByTestId('ws-belege')).toContainText('Schritt probe: Anmeldung über den Tunnel');
    await expect(detail.getByTestId('ws-abnahme-protokoll')).toContainText('vom Werkstatt-Dienst');
    await expect(detail.getByTestId('ws-qr')).toBeVisible();
    await expect(detail.getByTestId('ws-gehaeuse-hinweis')).toContainText('ohne Referenz und QR-Code dieser Box');
    await passt(page);
    await page.screenshot({ path: test.info().outputPath(`werkstatt-box-${breite}.png`), fullPage: true });

    await detail.getByTestId('ws-zurueck').click();
    await expect(page.getByTestId('ws-boxen')).toBeVisible();
    await liste.getByRole('button', { name: 'edge-p3n8rv4' }).click();
    await expect(page.getByTestId('ws-grund')).toContainText('kein Handshake an wg_wartung');
    await expect(page.getByTestId('ws-bindung')).toContainText('noch kein Tunnel-Schlüssel hinterlegt');
    await page.screenshot({ path: test.info().outputPath(`werkstatt-box-problem-${breite}.png`), fullPage: true });
    await page.getByTestId('ws-zurueck').click();

    await page.getByTestId('ws-zur-werkbank').click();
    await expect(page.getByTestId('wsb')).toHaveAttribute('data-bildschirm', 'start');
    await expect(page.getByTestId('wsb-heute')).toContainText('edge-5t2dcy6');
    await passt(page);
    await page.screenshot({ path: test.info().outputPath(`werkstatt-m1-${breite}.png`), fullPage: true });
    await page.getByTestId('wsb-mango').click();
    await expect(page.getByTestId('wsb')).toHaveAttribute('data-bildschirm', 'laeuft');
    await expect(page.getByTestId('wsb-phasen').getByRole('listitem')).toHaveCount(6);
    await expect(page.getByTestId('wsb-restzeit')).toContainText(/Noch ca\. \d+ Minuten/);
    await expect(page.getByRole('button', { name: /Weiter/ })).toHaveCount(0);
    await passt(page);
    await page.screenshot({ path: test.info().outputPath(`werkstatt-m3-${breite}.png`), fullPage: true });

    await page.getByTestId('wsb-uebersicht').click();
    await expect(page.getByTestId('ws-freigabe')).toBeVisible();
    expect(fehler).toEqual([]);
  });

  const BILDSCHIRME: { lauf: string; art: string; name: string; pruefe: (page: Page) => Promise<void> }[] = [
    { lauf: 'fertig', art: 'fertig', name: 'm5', pruefe: async (page) => {
      await expect(page.getByTestId('wsb-ref')).toHaveText('EDGE-K7M2XQ3');
      await expect(page.getByTestId('wsb-qr')).toBeVisible();
      await expect(page.getByTestId('wsb')).toContainText('Nicht versenden.');
    } },
    { lauf: 'problem', art: 'problem', name: 'm6', pruefe: async (page) => {
      await expect(page.getByTestId('wsb-problem')).toContainText('Hier hat etwas nicht geklappt.');
      await expect(page.getByTestId('wsb-details')).not.toHaveAttribute('open', '');
    } },
    { lauf: 'startlader', art: 'startlader', name: 'm4', pruefe: async (page) => {
      await expect(page.getByRole('heading', { name: 'Reset-Knopf drücken' })).toBeVisible();
    } },
    { lauf: 'wartet', art: 'du', name: 'wartet-auf-eingabe', pruefe: async (page) => {
      await expect(page.getByTestId('wsb-du-hinweis')).toContainText('Tunnel-Adresse');
    } },
    { lauf: 'ohne', art: 'anschliessen', name: 'm2-ohne-freigabe', pruefe: async (page) => {
      await expect(page.getByTestId('wsb-nicht-freigegeben')).toContainText('Noch nicht freigegeben.');
    } },
    { lauf: 'still', art: 'kein-dienst', name: 'kein-dienst', pruefe: async (page) => {
      await expect(page.getByTestId('wsb-kein-dienst')).toContainText('Der Werkstatt-Dienst meldet sich nicht.');
    } },
  ];

  for (const b of BILDSCHIRME) {
    test(`Werkbank bei ${breite} px: ${b.name}`, async ({ page }) => {
      const fehler = wache(page);
      await page.setViewportSize({ width: breite, height: 900 });
      await page.goto(`/e2e/werkstatt.html?lauf=${b.lauf}#/werkstatt?werkbank=1`);
      if (b.art !== 'kein-dienst') await page.getByTestId('wsb-mango').click();
      await expect(page.getByTestId('wsb')).toHaveAttribute('data-bildschirm', b.art);
      await b.pruefe(page);
      await passt(page);
      await page.screenshot({ path: test.info().outputPath(`werkstatt-${b.name}-${breite}.png`), fullPage: true });
      expect(fehler).toEqual([]);
    });
  }
}

test('Einrichtungs-Detailseite: der 3MF-Download liefert die Datei des Gehäuses (nur komplett)', async ({ page }) => {
  const fehler = wache(page);
  await page.goto('/e2e/werkstatt.html#/werkstatt?box=edge-5t2dcy6');
  const summen = new Map(
    readFileSync(resolve(process.cwd(), '../../edge-light/gehaeuse/glinet-gl-mt300n-v2/druck/SHA256SUMS'), 'utf8')
      .trim().split('\n').map((z) => z.split(/\s+/) as [string, string]).map(([sha, name]) => [name, sha]),
  );
  await expect(page.getByTestId('ws-gehaeuse').getByRole('link')).toHaveCount(1);
  for (const name of ['gehaeuse-v04.3mf']) {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId(`ws-gehaeuse-${name}`).getByRole('link').click(),
    ]);
    expect(download.suggestedFilename()).toBe(name);
    const bytes = readFileSync((await download.path())!);
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(summen.get(name));
  }
  expect(fehler).toEqual([]);
});

test('Werkbank: nach „Fertig“ führt „Nächste Box“ zum Anschließen, das Kabel steckt noch', async ({ page }) => {
  const fehler = wache(page);
  await page.goto('/e2e/werkstatt.html?lauf=fertig#/werkstatt?werkbank=1');
  await page.getByTestId('wsb-mango').click();
  await page.getByTestId('wsb-naechste').click();
  await expect(page.getByTestId('wsb')).toHaveAttribute('data-bildschirm', 'anschliessen');
  await expect(page.getByTestId('wsb-warten').locator('li').first()).toHaveAttribute('data-zustand', 'ok');
  expect(fehler).toEqual([]);
});

test('Werkstatt freigeben und Freigabe beenden', async ({ page }) => {
  const fehler = wache(page);
  await page.goto('/e2e/werkstatt.html?lauf=ohne');
  await expect(page.getByTestId('ws-freigabe')).toContainText('Werkstatt nicht freigegeben');
  await page.getByTestId('ws-freigeben').click();
  const dialog = page.getByRole('dialog', { name: 'Werkstatt freigeben' });
  await dialog.getByTestId('ws-freigabe-block').fill(JSON.stringify({ edge_light: {
    fassung: 'edge-light-2026.11.2', quelle: 'https://git.example.test/releases/edge-light-2026.11.2/', programm_sha256: SHA, skripte_sha256: SHA } }));
  await dialog.getByTestId('ws-freigabe-absenden').click();
  await expect(dialog.getByTestId('ws-freigabe-fehler')).toContainText('openwrt.sha256');
  await dialog.getByTestId('ws-freigabe-sha').fill(SHA);
  await dialog.getByTestId('ws-freigabe-absenden').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('ws-freigabe')).toContainText('Werkstatt freigegeben · Mango');
  await expect(page.getByTestId('ws-freigabe')).toContainText('Edge Light 2026.11.2');

  await page.getByTestId('ws-freigabe-beenden').click();
  await page.getByTestId('ws-beenden-bestaetigen').click();
  await expect(page.getByTestId('ws-freigabe')).toContainText('Werkstatt nicht freigegeben');
  await expect(page.getByTestId('ws-freigabe')).toContainText('Zuletzt 2026-11-mango-2');
  expect(fehler).toEqual([]);
});
