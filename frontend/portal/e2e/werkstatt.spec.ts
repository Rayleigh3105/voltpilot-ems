import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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

// 390 px ist die Haupt-Breite des Mobil-Durchgangs vp-adminview-mobile-rework
// (die Boxen-Übersicht stapelt seither über `.vp-table.responsive` statt
// seitlich zu scrollen); 375 bleibt als bestehende Probe daneben.
for (const breite of [1440, 390, 375]) {
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
    await expect(page.getByTestId('ws-zur-seite')).toContainText('edge-p3n8rv4');
    await expect(page.getByTestId('ws-zur-seite')).toContainText('kein Handshake an wg_wartung');
    await passt(page);
    await page.screenshot({ path: test.info().outputPath(`werkstatt-uebersicht-${breite}.png`), fullPage: true });

    await liste.getByRole('button', { name: 'edge-5t2dcy6' }).click();
    await expect(page).toHaveURL(/#\/werkstatt\?box=edge-5t2dcy6$/);
    const detail = page.getByTestId('ws-detail');
    await expect(page.getByTestId('ws-boxen')).toHaveCount(0);
    await expect(detail.getByTestId('ws-stand')).toHaveText('abgenommen');
    if (breite <= 720) {
      // Sekundäre Karten beginnen zu, mit der Urteilszeile als Beleg; „Ablauf der
      // Einrichtung" (die Phasenliste) bleibt die offene, primäre Karte.
      const einrichtung = detail.locator('details', { hasText: 'Einrichtung' }).first();
      await expect(einrichtung).not.toHaveAttribute('open', '');
      await expect(einrichtung).toContainText('GL.iNet GL-MT300N-V2');
      const bindung = detail.locator('details', { hasText: 'Bindung und Fernwartung' });
      await expect(bindung).not.toHaveAttribute('open', '');
      await expect(page.getByText('Ablauf der Einrichtung')).toBeVisible();
      await expect(detail.locator('details', { hasText: 'Ablauf der Einrichtung' })).toHaveCount(0);
    }
    await expect(detail.getByTestId('ws-zeile-hardware')).toContainText('GL-MT300N-V2');
    await expect(detail.getByTestId('ws-zeile-edge-light')).toHaveText('edge-light-2026.11.1');
    await expect(detail.getByTestId('ws-zeile-openwrt')).toHaveText('25.12.5');
    await expect(detail.getByTestId('ws-zeile-tunnel')).toHaveText('10.10.16.9');
    await expect(detail.getByTestId('ws-zeile-ort')).toHaveText('Halle 1 · Beispiel GmbH');
    await expect(detail.getByTestId('ws-belege')).toContainText('Schritt probe: Anmeldung über den Tunnel');
    await expect(detail.getByTestId('ws-abnahme-protokoll')).toContainText('vom Werkstatt-Dienst');
    // Am Telefon (vp-adminview-mobile-rework) beginnt „Beschriftung des Gehäuses" - wie andere
    // sekundäre Karten dieser Seite - als Aufklapper zu; am Rechner bleibt sie offen.
    if (breite <= 720) await detail.locator('details > summary').filter({ hasText: 'Beschriftung des Gehäuses' }).click();
    await expect(detail.getByTestId('ws-qr')).toBeVisible();
    await expect(detail.getByTestId('ws-gehaeuse')).toContainText('Box-Druckdatei (3MF) laden');
    await expect(detail.getByTestId('ws-gehaeuse-stand')).toContainText('gehaeuse-edge-5t2dcy6.3mf');
    await expect(detail.getByTestId('ws-zubehoer')).toContainText('Hutschienen-Clip');
    await expect(detail.getByTestId('ws-zubehoer')).toContainText('TH 35');
    await expect(detail.getByTestId('ws-zubehoer')).toContainText('Bohrlehre');
    await expect(detail.getByTestId('ws-zubehoer')).toContainText('Wandschrauben');
    await expect(detail.getByTestId('ws-zubehoer')).toContainText('Noch nie gedruckt');
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
    await expect(page.getByTestId('wsb-schritte').locator('[data-phase]')).toHaveCount(6);
    await expect(page.getByTestId('wsb-restzeit')).toContainText(/Noch ca\. \d+ Minuten/);
    await expect(page.getByTestId('wsb-jetzt')).toContainText('Schritt 10 von 16');
    await expect(page.getByTestId('wsb-schritte').locator('[data-schritt="openwrt"]')).toContainText('Prüfsumme auf der Box = Freigabe');
    if (breite > 760) {
      await expect(page.getByTestId('wsb-software')).toContainText('vorher: GL-Firmware 4.3.17');
      await expect(page.getByTestId('wsb-software-zeile')).toBeHidden();
    } else {
      await expect(page.getByTestId('wsb-software-zeile')).toContainText(/Kommt drauf:\s*OpenWrt 25\.12\.5\s*Edge Light 2026\.11\.1/);
      await expect(page.getByTestId('wsb-software')).toBeHidden();
    }
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
    { lauf: 'problem', art: 'fall', name: 'm6-alter-dienst', pruefe: async (page) => {
      await expect(page.getByTestId('wsb-fall-titel')).toContainText('Hier hat etwas nicht geklappt.');
      await expect(page.getByTestId('wsb-knopf-nochmal')).toHaveCount(0);
      await expect(page.getByTestId('wsb-details')).not.toHaveAttribute('open', '');
    } },
    { lauf: 'startlader', art: 'fall', name: 'm4-alter-dienst', pruefe: async (page) => {
      await expect(page.getByTestId('wsb-bild')).toHaveAttribute('data-bild', 'startlader');
      await expect(page.getByTestId('wsb-knopf-abbild')).toContainText('OpenWrt-Abbild 25.12.5 herunterladen');
    } },
    { lauf: 'gl_passwort', art: 'fall', name: 'fall-gl-passwort', pruefe: async (page) => {
      await expect(page.getByTestId('wsb-fall-banner')).toContainText('Einmal kurz du.');
      await expect(page.getByTestId('wsb-fall-titel')).toHaveText('Diese Mango hat schon jemand eingerichtet.');
      await expect(page.getByTestId('wsb-bild')).toHaveAttribute('data-bild', 'reset');
      await expect(page.getByTestId('wsb-live')).toContainText('Warten auf den Reset');
      await expect(page.getByTestId('wsb-knopf-nochmal')).toHaveCount(0);
    } },
    { lauf: 'passwort_fremd', art: 'fall', name: 'fall-passwort-fremd', pruefe: async (page) => {
      await expect(page.getByTestId('wsb-fall-banner')).toContainText('Zur Seite legen.');
      await expect(page.getByTestId('wsb-selbst')).toHaveAttribute('data-selbst', 'nein');
      await expect(page.getByTestId('wsb-bild')).toHaveCount(0);
    } },
    { lauf: 'startet', art: 'fall', name: 'fall-startet', pruefe: async (page) => {
      await expect(page.getByTestId('wsb-fall-banner')).toContainText('Der Dienst wartet.');
      await expect(page.getByTestId('wsb-knoepfe')).toHaveCount(0);
    } },
    { lauf: 'bruecke_unterspannung', art: 'fall', name: 'fall-bruecke-unterspannung', pruefe: async (page) => {
      await expect(page.getByTestId('wsb-fall-banner')).toContainText('Einmal kurz du.');
      await expect(page.getByTestId('wsb-fall-banner')).toContainText('Danach macht der Dienst weiter.');
      await expect(page.getByTestId('wsb-fall-titel')).toHaveText('Die Brücke hat zu wenig Strom.');
      await expect(page.getByTestId('wsb-bild')).toHaveAttribute('data-bild', 'pi');
      const live = page.getByTestId('wsb-live');
      const zeilen = live.locator('li');
      await expect(zeilen).toHaveCount(2);
      await expect(zeilen.nth(0)).toHaveAttribute('data-zustand', 'ok');
      await expect(zeilen.nth(1)).toHaveAttribute('data-zustand', 'lauf');
      await expect(zeilen.nth(1)).toContainText('Der Dienst fragt alle 10 Sekunden wieder');
      await expect(zeilen.nth(1)).toContainText('Strom');
      await expect(zeilen.nth(1).getByTestId('wsb-live-seit')).toContainText('zuletzt geprüft');
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

test('Einrichtungs-Detailseite: der 3MF-Download holt GENAU die Box-Druckdatei über die admin-Route', async ({ page }) => {
  const fehler = wache(page);
  const inhalt = Buffer.from('PK\x03\x04 gehaeuse-edge-5t2dcy6 (erfunden für den E2E-Test)');
  await page.route('**/api/v1/admin/werkstatt/boxen/edge-5t2dcy6/gehaeuse', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'model/3mf',
      headers: {
        'Content-Disposition': 'attachment; filename=gehaeuse-edge-5t2dcy6.3mf',
        'Access-Control-Expose-Headers': 'Content-Disposition',
      },
      body: inhalt,
    });
  });
  await page.goto('/e2e/werkstatt.html#/werkstatt?box=edge-5t2dcy6');
  const karte = page.getByTestId('ws-gehaeuse');
  await expect(karte.getByTestId('ws-gehaeuse-hinweis')).toHaveCount(0);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    karte.getByRole('button', { name: 'Box-Druckdatei (3MF) laden' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('gehaeuse-edge-5t2dcy6.3mf');
  const bytes = readFileSync((await download.path())!);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(createHash('sha256').update(inhalt).digest('hex'));
  expect(fehler).toEqual([]);
});

/**
 * vp-werkstatt-zubehoer-download: der Download liefert genau die eingecheckten Dateien aus
 * edge-light/gehaeuse/glinet-gl-mt300n-v2/druck/ - geprüft gegen die echten Bytes auf der
 * Festplatte (Prüfsumme), nicht gegen einen erfundenen Platzhalter.
 */
for (const z of [
  { teil: 'hutschienen-clip', dateiname: 'hutschienen-clip.3mf', name: 'Hutschienen-Clip' },
  { teil: 'bohrlehre', dateiname: 'bohrlehre.3mf', name: 'Bohrlehre' },
]) {
  test(`Einrichtungs-Detailseite: ${z.teil} lädt GENAU die eingecheckte Druckdatei`, async ({ page }) => {
    const fehler = wache(page);
    const inhalt = readFileSync(new URL(
      `../../../edge-light/gehaeuse/glinet-gl-mt300n-v2/druck/${z.dateiname}`, import.meta.url));
    await page.route(`**/api/v1/admin/werkstatt/zubehoer/${z.teil}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'model/3mf',
        headers: {
          'Content-Disposition': `attachment; filename=${z.dateiname}`,
          'Access-Control-Expose-Headers': 'Content-Disposition',
        },
        body: inhalt,
      });
    });
    await page.goto('/e2e/werkstatt.html#/werkstatt?box=edge-5t2dcy6');
    const karte = page.getByTestId('ws-zubehoer');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      karte.getByRole('button', { name: `${z.name} (3MF) laden` }).click(),
    ]);
    expect(download.suggestedFilename()).toBe(z.dateiname);
    const bytes = readFileSync((await download.path())!);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(createHash('sha256').update(inhalt).digest('hex'));
    expect(fehler).toEqual([]);
  });
}

test('Werkbank: „Nochmal versuchen“ bei bruecke_weg, dann „Der Dienst versucht es noch einmal“', async ({ page }) => {
  const fehler = wache(page);
  await page.goto('/e2e/werkstatt.html?lauf=bruecke_weg#/werkstatt?werkbank=1');
  await page.getByTestId('wsb-mango').click();
  await expect(page.getByTestId('wsb')).toHaveAttribute('data-fall', 'bruecke_weg');
  await expect(page.getByTestId('wsb-bild')).toHaveAttribute('data-bild', 'pi');
  await page.getByTestId('wsb-knopf-nochmal').click();
  await expect(page.getByTestId('wsb-nochmal-laeuft')).toContainText('Der Dienst versucht es noch einmal.');
  await expect(page.getByTestId('wsb-knopf-nochmal')).toHaveCount(0);
  expect(fehler).toEqual([]);
});

test('Werkbank: „Box zur Seite legen“ steht danach in der Übersicht', async ({ page }) => {
  const fehler = wache(page);
  await page.goto('/e2e/werkstatt.html?lauf=passwort_fremd#/werkstatt?werkbank=1');
  await page.getByTestId('wsb-mango').click();
  await page.getByTestId('wsb-knopf-zur-seite').click();
  await expect(page.getByTestId('wsb')).not.toHaveAttribute('data-fall', 'passwort_fremd');
  await page.getByTestId('wsb-uebersicht').click();
  await expect(page.getByTestId('ws-zur-seite')).toContainText('Diese Mango gehört nicht zur Werkstatt.');
  await expect(page.getByTestId('ws-zur-seite')).toContainText('passwort_fremd');
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
