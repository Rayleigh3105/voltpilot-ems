import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * MiSpeL MP-17 (BK-17 Variante A): die Zeile „Förderweg“ in Anlage › Einstellungen und der Dialog „Förderweg ändern“,
 * je Förderweg bei 375 und 1440 px (Bühne `foerderweg.tsx`, heute = 20.10.2026). Mit `FW_FOTOS=<ordner>` legt die
 * Spec von jedem Schritt ein Bildschirmfoto ab (Ansicht für den Captain); ohne die Variable schreibt sie nichts.
 */
const FOTOS = process.env.FW_FOTOS ?? null;
const BREITEN = [
  { name: '1440', width: 1440, height: 1000 },
  { name: '375', width: 375, height: 812 },
] as const;

test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'desktop-chromium', 'Die Spec setzt 375 und 1440 px selbst');
});

/**
 * Ein Foto für die Ansicht. Steht der Dialog offen, wird das Fenster für das Foto so hoch, dass der ganze Schritt
 * sichtbar ist (am Telefon ist der Dialog ein Vollbild-Blatt mit eigenem Bildlauf); danach wieder wie vorher.
 */
async function foto(page: Page, name: string) {
  if (!FOTOS) return;
  const vp = page.viewportSize()!;
  if ((await page.getByRole('dialog').count()) === 0) {
    await page.screenshot({ path: `${FOTOS}/${name}.png`, fullPage: true });
    return;
  }
  const noetig = await page.evaluate(() => {
    const rumpf = document.querySelector('.vp-anlegen-rumpf') as HTMLElement | null;
    const dialog = document.querySelector('.vp-anlegen-dialog') as HTMLElement | null;
    return (dialog?.offsetHeight ?? 0) + (rumpf ? rumpf.scrollHeight - rumpf.clientHeight : 0);
  });
  await page.setViewportSize({ width: vp.width, height: Math.max(vp.height, Math.ceil(noetig) + 48) });
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${FOTOS}/${name}.png` });
  await page.setViewportSize(vp);
}

async function ohneUeberlauf(page: Page, wo: string) {
  const ueber = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(ueber, `horizontaler Überlauf ${wo}`).toBeLessThanOrEqual(1);
}

async function oeffnen(page: Page, b: (typeof BREITEN)[number], fall: string, fehler: string[]) {
  page.on('pageerror', (e) => fehler.push(e.message));
  // Was die Bühne nicht im Gedächtnis hält (Standort, Funktionen, Gemeinsame Steuerung), ist hier 404 — nie eine echte Cloud.
  page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && fehler.push(m.text()));
  await page.route((url) => url.hostname !== '127.0.0.1', (r) => r.abort());
  await page.route('**/api/v1/**', (r) => r.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
  await page.setViewportSize({ width: b.width, height: b.height });
  await page.goto(`/e2e/foerderweg.html?fall=${fall}`);
  await expect(page.locator('#technik-foerderweg')).not.toContainText('…');
}

async function dialogOeffnen(page: Page): Promise<Locator> {
  await page.locator('#technik-foerderweg').getByRole('button').click();
  const d = page.getByRole('dialog', { name: 'Förderweg ändern' });
  await expect(d).toBeVisible();
  return d;
}

for (const b of BREITEN) {
  test(`Abgrenzungsoption: Förderweg · Zähler · Formelsatz · Partner · Prüfen (${b.name} px)`, async ({ page }) => {
    const fehler: string[] = [];
    await oeffnen(page, b, 'ausschliesslichkeit', fehler);
    const zeile = page.locator('#technik-foerderweg');
    await expect(zeile).toContainText('Marktprämie mit Ausschließlichkeitsoption');
    await expect(zeile).toContainText('aus Ihren bisherigen Einstellungen');
    await expect(page.getByTestId('netzladen-satz')).toContainText('In der Ausschließlichkeitsoption nicht möglich — Förderweg ändern');
    await expect(page.getByRole('switch', { name: 'Netzladen' })).toHaveCount(0);
    await ohneUeberlauf(page, 'Einstellungen');
    await foto(page, `${b.name}-abgrenzung-0-einstellungen`);

    const d = await dialogOeffnen(page);
    await expect(d.getByRole('radio')).toHaveCount(5);
    await expect(d.getByRole('radio', { name: /Pauschaloption/ })).toBeDisabled();
    await d.locator('label', { hasText: 'Marktprämie mit Abgrenzungsoption' }).click();
    await ohneUeberlauf(page, 'Schritt Förderweg');
    await foto(page, `${b.name}-abgrenzung-1-foerderweg`);

    await d.getByRole('button', { name: 'Weiter: Zähler' }).click();
    await expect(d.getByText('Z1 · Zweirichtungszähler am Netzanschluss')).toBeVisible();
    await expect(d.getByText('Z2 · Zähler für die Stromspeicher und/oder Ladepunkte')).toBeVisible();
    await expect(d).toContainText('geeichte DC-Messung');
    await ohneUeberlauf(page, 'Schritt Zähler');
    await foto(page, `${b.name}-abgrenzung-2-zaehler`);

    await d.getByRole('button', { name: 'Weiter: Formelsatz' }).click();
    await expect(d).toContainText('Vorschlag: Formelsatz A1');
    await expect(d).toContainText('Gebunden bis 31.12.2026');
    await ohneUeberlauf(page, 'Schritt Formelsatz');
    await foto(page, `${b.name}-abgrenzung-3-formelsatz`);

    await d.getByRole('button', { name: 'Weiter: Partner' }).click();
    await expect(d.getByRole('radio', { name: /VoltPilot-Partner/ })).toBeDisabled();
    await d.getByLabel('Name des Direktvermarkters').fill('Nordstrom Direkt GmbH');
    await d.getByRole('checkbox', { name: /Gesonderter Bilanzkreis/ }).check();
    await ohneUeberlauf(page, 'Schritt Partner');
    await foto(page, `${b.name}-abgrenzung-4-partner`);

    // Ohne Einverständnis lehnt der Vertrag ab — der Satz steht im Schritt „Partner“, wo die Angabe fehlt.
    await d.getByRole('button', { name: 'Weiter: Prüfen' }).click();
    await d.getByRole('button', { name: 'Ab 01.11. eintragen' }).click();
    await expect(d.getByTestId('fw-fehler')).toContainText('Bis 30.09.2027 gilt die Festlegung nur');
    await expect(d.locator('[data-schritt="partner"]')).toBeVisible();
    await foto(page, `${b.name}-abgrenzung-4b-partner-ablehnung`);
    await d.getByRole('checkbox', { name: /einverstanden/ }).check();

    await d.getByRole('button', { name: 'Weiter: Prüfen' }).click();
    await expect(d.getByTestId('fw-gilt-ab')).toHaveText('01.11.2026');
    await expect(d).toContainText('A1 · gebunden bis 31.12.2026');
    await expect(d).toContainText('Nordstrom Direkt GmbH');
    await expect(d).toContainText('Jahresmarktwert');
    await ohneUeberlauf(page, 'Schritt Prüfen');
    await foto(page, `${b.name}-abgrenzung-5-pruefen`);

    await d.getByRole('button', { name: 'Ab 01.11. eintragen' }).click();
    await expect(d).toBeHidden();
    await expect(page.getByTestId('fw-vormerkung')).toContainText('Ab 01.11.2026: Marktprämie mit Abgrenzungsoption (vorgemerkt)');
    await expect(zeile).toContainText('Marktprämie mit Ausschließlichkeitsoption');
    await ohneUeberlauf(page, 'Einstellungen nachher');
    await foto(page, `${b.name}-abgrenzung-6-vorgemerkt`);

    await page.getByRole('button', { name: 'Vormerkung zurücknehmen' }).click();
    await expect(page.getByTestId('fw-vormerkung')).toContainText('Die Vormerkung ist zurückgenommen');
    expect(fehler).toEqual([]);
  });

  for (const [fall, ziel, begriff] of [
    ['ausschliesslichkeit', 'ungeförderte Direktvermarktung', 'ungeförderte Direktvermarktung'],
    ['ungefoerdert', 'Einspeisevergütung', 'Einspeisevergütung'],
    ['einspeiseverguetung', 'Marktprämie mit Ausschließlichkeitsoption', 'Marktprämie mit Ausschließlichkeitsoption'],
  ] as const) {
    test(`Kurzweg ${begriff}: Förderweg → Prüfen, vorgemerkt zum 01.11. (${b.name} px)`, async ({ page }) => {
      const fehler: string[] = [];
      await oeffnen(page, b, fall, fehler);
      if (fall === 'ungefoerdert') {
        // Netzladen ist in der ungeförderten Direktvermarktung die Einstellung des Kunden.
        await expect(page.getByRole('switch', { name: 'Netzladen' })).toHaveAttribute('aria-checked', 'true');
        await expect(page.getByTestId('netzladen-satz')).toContainText('Ihre Einstellung — in der ungeförderten Direktvermarktung erlaubt');
      }
      await foto(page, `${b.name}-kurzweg-${fall}-0-einstellungen`);
      const d = await dialogOeffnen(page);
      await d.locator('label', { hasText: ziel }).first().click();
      await expect(d.getByRole('button', { name: 'Weiter: Prüfen' })).toBeVisible();
      await foto(page, `${b.name}-kurzweg-${fall}-1-foerderweg`);
      await d.getByRole('button', { name: 'Weiter: Prüfen' }).click();
      await expect(d.getByTestId('fw-gilt-ab')).toHaveText('01.11.2026');
      await expect(d).toContainText('§ 21b Abs. 1 S. 2 EEG');
      await ohneUeberlauf(page, `Prüfen ${begriff}`);
      await foto(page, `${b.name}-kurzweg-${fall}-2-pruefen`);
      await d.getByRole('button', { name: 'Ab 01.11. eintragen' }).click();
      await expect(d).toBeHidden();
      await expect(page.getByTestId('fw-vormerkung')).toContainText(`Ab 01.11.2026: ${begriff} (vorgemerkt)`);
      expect(fehler).toEqual([]);
    });
  }
}
