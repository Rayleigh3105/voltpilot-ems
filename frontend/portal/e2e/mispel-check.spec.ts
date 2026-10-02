import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * MiSpeL MP-48 (BK-48 Variante A „Urteil zuerst“): der MiSpeL-Check in Schritt 1 des Dialogs „Förderweg ändern“,
 * sobald „Marktprämie mit Abgrenzungsoption“ gewählt ist — positiv (Kundentyp a4), negativ (a2) und „wird gerechnet“,
 * je bei 375 und 1440 px (Bühne `foerderweg.tsx` mit `?check=`). Mit `MC_FOTOS=<ordner>` legt die Spec Fotos der
 * Kurzfassung und der offenen Karte ab (Ansicht für den Captain); ohne die Variable schreibt sie nichts.
 */
const FOTOS = process.env.MC_FOTOS ?? null;
const NBSP = String.fromCharCode(160);
const BREITEN = [
  { name: '1440', width: 1440, height: 1000 },
  { name: '375', width: 375, height: 812 },
] as const;

test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'desktop-chromium', 'Die Spec setzt 375 und 1440 px selbst');
});

/** Foto des ganzen Schritts: das Fenster wird so hoch wie der Dialog samt Bildlauf, danach wieder wie vorher. */
async function foto(page: Page, name: string, ende = false) {
  if (!FOTOS) return;
  const vp = page.viewportSize()!;
  const noetig = await page.evaluate(() => {
    const rumpf = document.querySelector('.vp-anlegen-rumpf') as HTMLElement | null;
    const dialog = document.querySelector('.vp-anlegen-dialog') as HTMLElement | null;
    return (dialog?.offsetHeight ?? 0) + (rumpf ? rumpf.scrollHeight - rumpf.clientHeight : 0);
  });
  await page.setViewportSize({ width: vp.width, height: Math.max(vp.height, Math.ceil(noetig) + 48) });
  await page.waitForTimeout(200);
  if (ende) {
    // Die offene Karte: bis an ihr Ende (Summe und „Was die Abgrenzungsoption verlangt“); die Kurzfassung zeigt das Foto davor.
    await page.evaluate(() => {
      const r = document.querySelector('.vp-anlegen-rumpf') as HTMLElement | null;
      if (r) r.scrollTop = r.scrollHeight;
    });
  } else {
    await page.getByTestId('mispel-check').scrollIntoViewIfNeeded();
  }
  await page.screenshot({ path: `${FOTOS}/${name}.png` });
  await page.setViewportSize(vp);
}

async function ohneUeberlauf(page: Page, wo: string) {
  const ueber = await page.evaluate(() => {
    const d = document.querySelector('.vp-anlegen-rumpf') as HTMLElement | null;
    return Math.max(document.documentElement.scrollWidth - window.innerWidth, d ? d.scrollWidth - d.clientWidth : 0);
  });
  expect(ueber, `horizontaler Überlauf ${wo}`).toBeLessThanOrEqual(1);
}

async function abgrenzungWaehlen(page: Page, b: (typeof BREITEN)[number], check: string | null, fehler: string[]) {
  page.on('pageerror', (e) => fehler.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && fehler.push(m.text()));
  await page.route((url) => url.hostname !== '127.0.0.1', (r) => r.abort());
  await page.route('**/api/v1/**', (r) => r.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
  await page.setViewportSize({ width: b.width, height: b.height });
  await page.goto(`/e2e/foerderweg.html${check ? `?check=${check}` : ''}`);
  await expect(page.locator('#technik-foerderweg')).not.toContainText('…');
  await page.locator('#technik-foerderweg').getByRole('button').click();
  const d = page.getByRole('dialog', { name: 'Förderweg ändern' });
  await expect(d).toBeVisible();
  await expect(d.getByTestId('mispel-check')).toHaveCount(0);
  await d.locator('label', { hasText: 'Marktprämie mit Abgrenzungsoption' }).click();
  return d;
}

/** „Weiter zur Einrichtung“ und „Beim heutigen Förderweg bleiben“ sind gleich groß (BK-48 A). */
async function gleichGross(d: Locator) {
  const bleiben = await d.getByRole('button', { name: 'Beim heutigen Förderweg bleiben' }).boundingBox();
  const weiter = await d.getByRole('button', { name: 'Weiter zur Einrichtung' }).boundingBox();
  expect(bleiben && weiter).toBeTruthy();
  expect(Math.abs(bleiben!.width - weiter!.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(bleiben!.height - weiter!.height)).toBeLessThanOrEqual(1);
  // Keine Beschriftung abgeschnitten (am Telefon brechen beide um).
  for (const name of ['Beim heutigen Förderweg bleiben', 'Weiter zur Einrichtung']) {
    const ueber = await d.getByRole('button', { name }).evaluate((e) => e.scrollWidth - e.clientWidth);
    expect(ueber, `Knopf „${name}“ abgeschnitten`).toBeLessThanOrEqual(1);
  }
}

for (const b of BREITEN) {
  test(`positives Ergebnis, Kundentyp a4: Urteil zuerst, Rechnung auf Wunsch, weiter zur Einrichtung (${b.name} px)`, async ({ page }) => {
    const fehler: string[] = [];
    const d = await abgrenzungWaehlen(page, b, 'a4', fehler);
    const karte = d.getByTestId('mispel-check');
    await expect(karte).toHaveAttribute('data-stand', 'fertig');
    await expect(karte).toContainText('MiSpeL-Check · Werk Ahrenberg');
    await expect(d.getByTestId('mispel-check-betrag')).toHaveText(`+${NBSP}1.899${NBSP}€ im Jahr`);
    await expect(karte).toContainText('Lohnt sich für diese Anlage voraussichtlich.');
    await expect(karte).toContainText(`ungünstig +${NBSP}158${NBSP}€`);
    await expect(karte).toContainText(`günstig +${NBSP}8.043${NBSP}€`);
    await expect(karte).toContainText('Ganzjahr 10/2025–09/2026');
    await expect(karte).toContainText('nie gegen „ohne Speicher“');
    await expect(d.getByTestId('mispel-check-rechnung')).toHaveCount(0);
    await gleichGross(d);
    await ohneUeberlauf(page, 'Kurzfassung a4');
    await foto(page, `${b.name}-a4-kurz`);

    await karte.getByRole('button', { name: 'Wie gerechnet?' }).click();
    const rechnung = d.getByTestId('mispel-check-rechnung');
    await expect(rechnung.locator('[data-art="handel_saldierung"] dd')).toHaveText(`+${NBSP}2.749${NBSP}€`);
    await expect(rechnung.locator('[data-art="jahresmarktwert"] dd')).toHaveText(`0${NBSP}€`);
    await expect(rechnung.locator('[data-art="zaehler_z2"] dd')).toHaveText(`−${NBSP}600${NBSP}€`);
    await expect(rechnung.locator('[data-art="bilanzkreis"] dd')).toHaveText(`−${NBSP}250${NBSP}€`);
    await expect(rechnung).toContainText('Unterschied im Jahr');
    await expect(rechnung).toContainText('Was die Abgrenzungsoption verlangt');
    await expect(rechnung).toContainText('Tenor Ziff. 9a');
    await ohneUeberlauf(page, 'offene Karte a4');
    await foto(page, `${b.name}-a4-offen`, true);

    await d.getByRole('button', { name: 'Weiter zur Einrichtung' }).click();
    await expect(d.getByText('Z1 · Zweirichtungszähler am Netzanschluss')).toBeVisible();
    expect(fehler).toEqual([]);
  });

  test(`negatives Ergebnis, Kundentyp a2: „lohnt sich nicht“ mit Grund, beim heutigen Förderweg bleiben (${b.name} px)`, async ({ page }) => {
    const fehler: string[] = [];
    const d = await abgrenzungWaehlen(page, b, 'a2', fehler);
    const karte = d.getByTestId('mispel-check');
    await expect(karte).toContainText('MiSpeL-Check · Autohaus Brenner');
    await expect(d.getByTestId('mispel-check-betrag')).toHaveText(`−${NBSP}555${NBSP}€ im Jahr`);
    await expect(karte).toContainText('Lohnt sich für diese Anlage voraussichtlich nicht.');
    await expect(karte).toContainText(`+${NBSP}330${NBSP}€ Handel trägt −${NBSP}885${NBSP}€ für Jahresmarktwert, Zähler und Bilanzkreis nicht.`);
    await expect(karte).toContainText(`ungünstig −${NBSP}1.321${NBSP}€`);
    await expect(karte).toContainText(`günstig +${NBSP}691${NBSP}€`);
    await gleichGross(d);
    await ohneUeberlauf(page, 'Kurzfassung a2');
    await foto(page, `${b.name}-a2-kurz`);

    await karte.getByRole('button', { name: 'Wie gerechnet?' }).click();
    const rechnung = d.getByTestId('mispel-check-rechnung');
    await expect(rechnung.locator('[data-art="jahresmarktwert"] dd')).toHaveText(`−${NBSP}285${NBSP}€`);
    await expect(rechnung.locator('.vp-mc-summe dd')).toHaveText(`−${NBSP}555${NBSP}€`);
    await expect(rechnung).toContainText('Angenommen, weil noch nicht gemessen: Jahresverbrauch');
    await ohneUeberlauf(page, 'offene Karte a2');
    await foto(page, `${b.name}-a2-offen`, true);

    await d.getByRole('button', { name: 'Beim heutigen Förderweg bleiben' }).click();
    await expect(page.getByRole('dialog', { name: 'Förderweg ändern' })).toHaveCount(0);
    await expect(page.locator('#technik-foerderweg')).toContainText('Marktprämie mit Ausschließlichkeitsoption');
    expect(fehler).toEqual([]);
  });

  test(`ohne Ergebnis: „wird gerechnet“, nie 0 € (${b.name} px)`, async ({ page }) => {
    const fehler: string[] = [];
    const d = await abgrenzungWaehlen(page, b, null, fehler);
    const karte = d.getByTestId('mispel-check');
    await expect(karte).toHaveAttribute('data-stand', 'wird_gerechnet');
    await expect(karte.getByRole('status')).toHaveText('wird gerechnet');
    await expect(karte).not.toContainText('€');
    await expect(karte.getByRole('button', { name: 'Wie gerechnet?' })).toHaveCount(0);
    await gleichGross(d);
    await ohneUeberlauf(page, 'wird gerechnet');
    await foto(page, `${b.name}-wird-gerechnet`);
    expect(fehler).toEqual([]);
  });
}
