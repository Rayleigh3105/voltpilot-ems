import { expect, test, type Page } from '@playwright/test';

/**
 * MiSpeL MP-27 (BK-27 Variante A „Jahresband“, abgestimmt am 04.10.2026): Haushalt mit der Pauschaloption bei 375 und
 * 1440 px (Bühne `haushalt.tsx`): die Karte „MiSpeL · Jahresstand nach Anlage 2“ in drei Ständen und im Rumpfjahr, die
 * Zeile im Monat, die Einrichtung im Förderweg-Dialog mit „vormerken, Termin offen“ und der Check Haushalt unter der
 * Pauschaloption. Mit `HH_FOTOS=<ordner>` legt die Spec Bildschirmfotos für die Ansicht ab; ohne schreibt sie nichts.
 */
const FOTOS = process.env.HH_FOTOS ?? null;
const BREITEN = [
  { name: '1440', width: 1440, height: 1000 },
  { name: '375', width: 375, height: 812 },
] as const;

test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'desktop-chromium', 'Die Spec setzt 375 und 1440 px selbst');
});

async function foto(page: Page, name: string, ziel?: string) {
  if (!FOTOS) return;
  if (ziel) {
    // Ganze Seite, auf das Element beschnitten: so liegt die klebende Zeitraum-Leiste nicht über der Karte.
    const box = await page.locator(ziel).first().evaluate((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: `${FOTOS}/${name}.png`,
      fullPage: true,
      clip: { x: Math.max(box.x - 8, 0), y: Math.max(box.y - 8, 0), width: box.width + 16, height: box.height + 16 },
    });
    return;
  }
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

async function oeffnen(page: Page, b: (typeof BREITEN)[number], query: string, fehler: string[]) {
  page.on('pageerror', (e) => fehler.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && fehler.push(m.text()));
  await page.route((url) => url.hostname !== '127.0.0.1', (r) => r.abort());
  await page.route('**/api/v1/**', (r) => r.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
  await page.setViewportSize({ width: b.width, height: b.height });
  await page.goto(`/e2e/haushalt.html?${query}`);
}

for (const b of BREITEN) {
  for (const stand of ['foerderfaehig', 'indifferent', 'saldierungsfaehig', 'rumpfjahr'] as const) {
    test(`Jahresband ${stand} in Verlauf › Erlöse (${b.name} px)`, async ({ page }) => {
      const fehler: string[] = [];
      const jahr = stand === 'rumpfjahr' ? '2027' : '2028';
      await oeffnen(page, b, `seite=erloese&z=jahr&at=${jahr}-09-15&stand=${stand}&jetzt=${jahr}-09-15T12:00:00%2B02:00`, fehler);
      const karte = page.getByRole('region', { name: 'MiSpeL · Jahresstand nach Anlage 2' });
      await expect(karte).toBeVisible();
      await expect(karte).toContainText(`MiSpeL · Jahresstand nach Anlage 2 · ${jahr}`);
      const band = page.getByTestId('pj-band');
      await expect(band).toBeVisible();
      await expect(page.getByTestId('pauschal-jahr')).toHaveAttribute('data-bereich', stand === 'rumpfjahr' ? 'foerderfaehig' : stand);
      if (stand === 'foerderfaehig') {
        await expect(karte).toContainText('Sie stehen bei 3.900 von 5.000 kWh förderfähiger Einspeisung');
        await expect(page.getByTestId('pj-naechste')).toContainText('Die nächste eingespeiste kWh bekommt die Marktprämie');
      } else if (stand === 'indifferent') {
        await expect(karte).toContainText('120 kWh im Indifferenzbereich');
      } else if (stand === 'saldierungsfaehig') {
        await expect(karte).toContainText('über der Saldierungsgrenze');
      } else {
        await expect(page.getByTestId('pj-rumpfjahr')).toContainText('Rumpfjahr 01.07.2027 bis 31.12.2027');
        await expect(karte).toContainText('von 2.514 kWh');
      }
      // Die Marke „heute …“ bleibt im Band und überdeckt keine Grenze.
      const bb = await band.boundingBox();
      const mb = await band.locator('.vp-pj-marke span').boundingBox();
      expect(mb!.x).toBeGreaterThanOrEqual(bb!.x - 2);
      expect(mb!.x + mb!.width).toBeLessThanOrEqual(bb!.x + bb!.width + 2);
      await ohneUeberlauf(page, `Jahresband ${stand}`);
      await foto(page, `band-${stand}-${b.name}`, '.vp-pj');
      expect(fehler).toEqual([]);
    });
  }

  test(`Monat: eine Zeile mit Sprung ins Jahr (${b.name} px)`, async ({ page }) => {
    const fehler: string[] = [];
    await oeffnen(page, b, 'seite=erloese&z=monat&at=2028-09-15&stand=foerderfaehig&jetzt=2028-09-15T12:00:00%2B02:00', fehler);
    const zeile = page.getByTestId('pj-zeile');
    await expect(zeile).toContainText('MiSpeL · Jahresstand 2028: 3.900 von 5.000 kWh förderfähig');
    await foto(page, `monat-zeile-${b.name}`, '[data-testid="pj-zeile"]');
    await zeile.click();
    await expect(page.getByRole('region', { name: 'MiSpeL · Jahresstand nach Anlage 2' })).toBeVisible();
    await ohneUeberlauf(page, 'Monat');
    expect(fehler).toEqual([]);
  });

  test(`Einrichtung: Voraussetzungen · Pauschalgrenzen · Partner · vormerken, Termin offen (${b.name} px)`, async ({ page }) => {
    const fehler: string[] = [];
    await oeffnen(page, b, 'seite=einstellungen', fehler);
    await expect(page.locator('#technik-foerderweg')).toContainText('Einspeisevergütung');
    await page.locator('#technik-foerderweg').getByRole('button').click();
    const d = page.getByRole('dialog', { name: 'Förderweg ändern' });
    await expect(d).toBeVisible();
    await d.getByRole('radio', { name: /Pauschaloption/ }).check();
    await expect(d.getByTestId('fw-pauschal-vormerkbar')).toContainText('vormerken möglich');
    // Der Check Haushalt (MP-29) unter der Pauschaloption — eigene Wörter, der Hinweis steht da.
    const check = d.getByTestId('mispel-check');
    await expect(check).toContainText('heute gegen Pauschaloption');
    await expect(d.getByTestId('mispel-check-hinweis')).toContainText('Information vor dem Wechsel');
    await d.getByRole('button', { name: 'Wie gerechnet?' }).click();
    await expect(d.getByTestId('mispel-check-rechnung')).toContainText('Was die Pauschaloption verlangt');
    await ohneUeberlauf(page, 'Schritt 1');
    await foto(page, `schritt1-check-${b.name}`);
    await d.getByRole('button', { name: 'Weiter zur Einrichtung' }).click();

    await expect(d.getByTestId('fw-voraussetzungen')).toContainText('Solarleistung 9,2 kWp — höchstens 30 kWp');
    await d.getByRole('radio', { name: 'Ja, zusätzlich' }).check();
    await d.getByLabel('Installierte Leistung der Steckersolargeräte (kWp)').fill('0,8');
    await d.getByRole('checkbox', { name: /betreibe alle Anlagen/ }).check();
    await d.getByRole('checkbox', { name: /nimmt das Steckersolargerät mit auf/ }).check();
    await ohneUeberlauf(page, 'Voraussetzungen');
    await foto(page, `schritt2-voraussetzungen-${b.name}`);
    await d.getByTestId('fw-weiter-voraussetzungen').click();

    await expect(d.getByTestId('fw-grenzen')).toContainText('5.500');
    await expect(d).toContainText('Fallkonstellation P1 · Stromspeicher');
    await ohneUeberlauf(page, 'Pauschalgrenzen');
    await foto(page, `schritt3-grenzen-${b.name}`);
    await d.getByRole('button', { name: 'Weiter: Partner' }).click();
    await d.getByLabel('Name des Direktvermarkters').fill('Nordstrom Direkt');
    await d.getByRole('button', { name: 'Weiter: Prüfen' }).click();

    await expect(d.getByTestId('fw-gilt-ab')).toHaveText('Termin offen');
    await expect(d.getByTestId('fw-rumpfjahr')).toContainText('Rumpfjahr');
    await ohneUeberlauf(page, 'Prüfen');
    await foto(page, `schritt5-pruefen-${b.name}`);
    await d.getByRole('button', { name: 'Vormerken' }).click();
    await expect(d).toBeHidden();
    await expect(page.getByTestId('fw-pauschal-vorgemerkt')).toContainText('Vorgemerkt: Marktprämie mit Pauschaloption');
    await expect(page.getByTestId('fw-pauschal-vorgemerkt')).toContainText('Termin ist offen');
    await ohneUeberlauf(page, 'Einstellungen');
    await foto(page, `einstellungen-vorgemerkt-${b.name}`, ':is(ul, ol):has(> #technik-foerderweg)');
    await page.getByRole('button', { name: 'Vormerkung zurücknehmen' }).click();
    await expect(page.getByTestId('fw-vormerkung')).toContainText('zurückgenommen');
    expect(fehler).toEqual([]);
  });

  test(`über 30 kWp: der Grund steht im Schritt, weiter geht es nicht (${b.name} px)`, async ({ page }) => {
    const fehler: string[] = [];
    await oeffnen(page, b, 'seite=einstellungen&pv=32.4', fehler);
    await page.locator('#technik-foerderweg').getByRole('button').click();
    const d = page.getByRole('dialog', { name: 'Förderweg ändern' });
    await d.getByRole('radio', { name: /Pauschaloption/ }).check();
    await d.getByRole('button', { name: 'Weiter zur Einrichtung' }).click();
    await expect(d.getByTestId('fw-ueber-30')).toBeVisible();
    await expect(d.getByTestId('fw-weiter-voraussetzungen')).toBeDisabled();
    await foto(page, `schritt2-ueber30-${b.name}`);
    expect(fehler).toEqual([]);
  });
}
