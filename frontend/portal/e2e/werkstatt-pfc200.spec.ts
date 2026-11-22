import { expect, test, type Page } from '@playwright/test';

// WebKit braucht im Container mehr Zeit.
test.describe.configure({ timeout: 90_000 });

const BUEHNE = '/e2e/werkstatt-pfc200.html';

/** Kein waagerechter Überlauf und nichts, was über den Rand der Seite ragt; Tabellen und Reiterleiste scrollen in sich. */
async function passt(page: Page) {
  const r = await page.evaluate(() => {
    const breite = document.documentElement.clientWidth;
    const zuBreit = [...document.querySelectorAll<HTMLElement>('.vp-ws *')]
      .filter((e) => e.offsetParent !== null && !e.closest('.vp-table-scroll, .vp-bereich-tabs'))
      .filter((e) => e.getBoundingClientRect().right > breite + 1)
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`);
    return { ueberlauf: document.documentElement.scrollWidth - breite, zuBreit: zuBreit.slice(0, 5) };
  });
  expect(r.ueberlauf).toBeLessThanOrEqual(0);
  expect(r.zuBreit).toEqual([]);
}

function wache(page: Page): string[] {
  const fehler: string[] = [];
  page.on('pageerror', (e) => fehler.push(e.message));
  page.on('console', (m) => m.type() === 'error' && fehler.push(m.text()));
  return fehler;
}

/** Jede Zeichnung des PFC200 steht ganz in ihrer Karte, und ihre Beschriftung ist nicht abgeschnitten. */
async function bilderPassen(page: Page) {
  const r = await page.evaluate(() =>
    [...document.querySelectorAll<SVGSVGElement>('[data-testid="wsb-bild"] svg')].map((svg) => {
      const karte = svg.closest('[data-testid="wsb-bild"]')!.getBoundingClientRect();
      const b = svg.getBoundingClientRect();
      const texte = [...svg.querySelectorAll('text')].map((t) => t.getBoundingClientRect());
      return {
        inDerKarte: b.left >= karte.left - 1 && b.right <= karte.right + 1 && b.width > 40,
        textImBild: texte.every((t) => t.left >= b.left - 1 && t.right <= b.right + 1),
      };
    }),
  );
  expect(r.length).toBeGreaterThan(0);
  expect(r.every((x) => x.inDerKarte && x.textImBild)).toBe(true);
}

for (const breite of [1440, 375]) {
  test(`PFC200 an der Werkbank bei ${breite} px: Kachel, Anschließen mit dem Handgriff „feste Adresse“ in Text und Bild`, async ({ page }) => {
    const fehler = wache(page);
    await page.setViewportSize({ width: breite, height: 900 });
    await page.goto(`${BUEHNE}#/werkstatt?werkbank=1`);
    await expect(page.getByTestId('wsb')).toHaveAttribute('data-bildschirm', 'start');
    await expect(page.getByTestId('wsb-pfc200')).toBeEnabled();
    await passt(page);
    await page.getByTestId('wsb-pfc200').click();
    await expect(page.getByRole('heading', { name: 'PFC200 anschließen' })).toBeVisible();
    const handgriff = page.getByTestId('wsb-feste-adresse');
    await expect(handgriff).toContainText('Den Betriebsartenschalter auf STOP stellen.');
    await expect(handgriff).toContainText('länger als 8 Sekunden');
    await expect(handgriff).toContainText('Den Betriebsartenschalter wieder auf RUN stellen.');
    await expect(handgriff).toContainText('192.168.1.17');
    await expect(handgriff.locator('svg')).toHaveCount(3);
    await expect(handgriff.locator('svg').nth(1)).toBeVisible();
    await bilderPassen(page);
    await passt(page);
    expect(fehler).toEqual([]);
  });

  for (const [zustand, bildschirm, fall, satz] of [
    ['laeuft_netze', 'laeuft', null, 'PFC200 wird eingerichtet'],
    ['wartet_schalter_run', 'fall', 'pfc_schalter_stop', 'Der Betriebsartenschalter steht auf STOP.'],
    ['wartet_kabel_x2', 'fall', 'pfc_kabel_x1', 'Das orange Kabel steckt nicht in der Buchse X2.'],
    ['angehalten_pfc_passwort', 'fall', 'pfc_passwort', 'Dieser PFC200 ist nur halb eingerichtet.'],
    ['angehalten_passwort_fremd', 'fall', 'passwort_fremd', 'Dieser PFC200 gehört nicht zur Werkstatt.'],
    ['fertig', 'fertig', null, 'CODESYS und Zugänge'],
  ] as const) {
    test(`PFC200 bei ${breite} px: ${zustand}`, async ({ page }) => {
      const fehler = wache(page);
      await page.setViewportSize({ width: breite, height: 900 });
      await page.goto(`${BUEHNE}?zustand=${zustand}#/werkstatt?werkbank=1`);
      await page.getByTestId('wsb-pfc200').click();
      const wsb = page.getByTestId('wsb');
      await expect(wsb).toHaveAttribute('data-bildschirm', bildschirm);
      if (fall) await expect(wsb).toHaveAttribute('data-fall', fall);
      await expect(wsb).toContainText(satz);
      await expect(wsb).not.toContainText('Mango');
      if (zustand === 'angehalten_pfc_passwort') {
        await expect(page.locator('[data-bild="pfc-werksreset"] svg')).toHaveCount(3);
        await expect(page.locator('[data-bild="pfc-adresse"] svg')).toHaveCount(3);
        await bilderPassen(page);
      }
      if (zustand.startsWith('wartet_')) await bilderPassen(page);
      if (zustand === 'angehalten_passwort_fremd') await expect(page.getByTestId('wsb-bild')).toHaveCount(0);
      if (zustand === 'fertig') {
        await expect(page.getByTestId('wsb-codesys')).toContainText('nur verschlüsselt an der Abnahme, für den age-Schlüssel „Box-Passwörter“');
        await expect(page.getByTestId('wsb-qr')).toBeVisible();
      }
      await passt(page);
      expect(fehler).toEqual([]);
    });
  }

  test(`PFC200 bei ${breite} px: Übersicht nennt, worauf die Werkstatt für ihn wartet; die Seite der Box zeigt Schild, Netze und die zehn Prüfungen`, async ({ page }) => {
    const fehler = wache(page);
    await page.setViewportSize({ width: breite, height: 900 });
    await page.goto(`${BUEHNE}?regel=wartet#/werkstatt`);
    await expect(page.getByTestId('ws-werkstatt-pfc200')).toContainText('PFC200 wartet: Die Fassung edge-industrie-2026.10.9 trägt Skriptstand und Tunnel-Programm nicht');
    await expect(page.getByTestId('ws-werkstatt')).toHaveAttribute('data-zustand', 'laeuft');
    await passt(page);

    await page.goto(`${BUEHNE}#/werkstatt?box=edge-k7m2xq3`);
    const seite = page.getByTestId('ws-detail');
    await expect(seite).toContainText('PFC200');
    await expect(page.getByTestId('ws-karte-schild')).toBeVisible();
    await expect(page.getByTestId('ws-gehaeuse')).toHaveCount(0);
    await expect(page.getByTestId('ws-codesys')).toBeVisible();
    await passt(page);
    expect(fehler).toEqual([]);
  });
}
