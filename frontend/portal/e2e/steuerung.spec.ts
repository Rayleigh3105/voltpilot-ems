import { expect, test, type Page } from '@playwright/test';

/**
 * **Die Steuerung im Browser** (Konzept `docs/konzepte/steuerung`).
 *
 * Daten: die Beispielanlage `e2e/steuerung.*` - derselbe Tag wie der Prototyp
 * (Dienstag 29.09.2026, 13:10 Uhr). Geprüft wird Geometrie und Bedienung,
 * kein Pixelvergleich: nichts ragt über den Rand, die Reiter stehen, das Blatt
 * öffnet und schließt mit Rückkehr zum Auslöser, der Satzbaukasten führt bis
 * zu den Folgen. Breiten nach Portal-Regel: 1440 am Rechner, 375 am Telefon.
 */

const GERAETE = '/e2e/steuerung.html#/anlage/help-site/steuerung';
const LADEN = '/e2e/steuerung.html#/anlage/help-site/laden';
const LADEN_BEOBACHTET = '/e2e/steuerung.html?speicher=beobachtet#/anlage/help-site/laden';
const REGELN = '/e2e/steuerung.html#/anlage/help-site/regeln';

test.use({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });

test.beforeEach(async ({ page }, testInfo) => {
  await page.clock.setFixedTime(new Date('2026-09-29T11:10:00Z'));
  const name = testInfo.project.name;
  if (name.startsWith('mobile')) await page.setViewportSize({ width: 375, height: 812 });
  else if (name.startsWith('desktop')) await page.setViewportSize({ width: 1440, height: 1000 });
});

async function oeffnen(page: Page, url: string) {
  const fehler: string[] = [];
  page.on('pageerror', (e) => fehler.push(e.message));
  await page.goto(url);
  await page.locator('.stn').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  return fehler;
}

const ueberlauf = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Ragt ein Element einer Karte über deren Rand? (Liste der Übeltäter) */
const ueberstehend = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [];
    for (const karte of document.querySelectorAll<HTMLElement>('.stn .card, .stn .devs > .dev')) {
      const r = karte.getBoundingClientRect();
      for (const kind of karte.querySelectorAll<HTMLElement>('*')) {
        const k = kind.getBoundingClientRect();
        if (k.width === 0 || getComputedStyle(kind).position === 'absolute') continue;
        if (k.right > r.right + 1.5 || k.left < r.left - 1.5) out.push(`${karte.className} > ${kind.tagName}.${String(kind.getAttribute('class'))}`);
      }
    }
    return out.slice(0, 5);
  });

test('Geräte: Kopf, Reiter, Jetzt, Tagesbild und Liste ohne Überlauf', async ({ page }) => {
  const fehler = await oeffnen(page, GERAETE);
  await expect(page.getByRole('heading', { level: 1, name: 'Steuerung' })).toBeVisible();
  const reiter = page.getByRole('tablist', { name: 'Reiter der Steuerung' });
  await expect(reiter.getByRole('tab')).toHaveText([/Geräte/, /Laden/, /Regeln/]);
  await expect(page.getByRole('region', { name: 'Jetzt' })).toContainText('Sonne 8,0 kW');
  await expect(page.getByRole('region', { name: 'Jetzt' })).toContainText('Wohin geht der Sonnenstrom?');
  await expect(page.getByRole('region', { name: 'Neu in Ihrer Anlage: Spülmaschine' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Tagesbild' })).toBeVisible();
  await expect(page.locator('#devs .dev .rk')).toHaveCount(9);
  expect(await ueberlauf(page)).toBeLessThanOrEqual(0);
  expect(await ueberstehend(page)).toEqual([]);
  expect(fehler).toEqual([]);
});

test('Geräte: das Tagesbild wählt eine Viertelstunde, „Jetzt" kehrt zurück', async ({ page }) => {
  await oeffnen(page, GERAETE);
  const band = page.getByRole('slider', { name: 'Viertelstunde wählen' });
  await band.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('region', { name: 'Jetzt' })).toContainText('Laut Plan · 13:30');
  await page.getByRole('button', { name: 'Jetzt', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Jetzt' })).toContainText('Jetzt · 13:10');
});

test('Geräte: das Blatt eines Geräts öffnet, hält den Fokus und gibt ihn zurück', async ({ page }) => {
  await oeffnen(page, GERAETE);
  const knopf = page.locator('#dev-e-hs');
  await knopf.click();
  const blatt = page.getByRole('dialog', { name: /Heizstab Warmwasser/ });
  await expect(blatt).toBeVisible();
  await expect(blatt).toContainText('Box hat angenommen');
  await blatt.getByRole('button', { name: 'Ein', exact: true }).click();
  await expect(blatt).toContainText('Das passiert:');
  // Das Blatt ragt nicht über den Bildschirm.
  const box = await blatt.boundingBox();
  const vp = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width + 0.5);
  await page.keyboard.press('Escape');
  await expect(blatt).toBeHidden();
  await expect(knopf).toBeFocused();
});

test('Geräte: die Reihenfolge lässt sich mit Pfeilen ändern und speichern', async ({ page }) => {
  await oeffnen(page, GERAETE);
  await page.getByRole('button', { name: /Ändern/ }).click();
  await page.getByRole('button', { name: 'Poolpumpe nach oben' }).click();
  await expect(page.getByText(/Poolpumpe Platz 4 statt 5/)).toBeVisible();
  await page.getByRole('button', { name: 'Reihenfolge speichern' }).click();
  await expect(page.getByRole('status')).toContainText('Reihenfolge gespeichert');
  expect(await ueberlauf(page)).toBeLessThanOrEqual(0);
});

test('Laden: Ladepunkte, Womit laden und Ladeziel ohne Überlauf', async ({ page }) => {
  const fehler = await oeffnen(page, LADEN);
  await expect(page.getByRole('region', { name: 'Netzanschluss' })).toContainText('Netzanschluss 22,0 kW');
  const wb = page.getByRole('region', { name: 'Wallbox Werkstatt' });
  await expect(wb.getByRole('button', { name: /Smart/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(wb.getByRole('group', { name: 'Womit laden' })).toBeVisible();
  await page.getByRole('region', { name: 'Ladepunkt Carport' }).locator('.lziel').click();
  const ziel = page.getByRole('dialog', { name: /Ladeziel/ });
  await expect(ziel).toContainText('Kein Auto angesteckt');
  await page.keyboard.press('Escape');
  expect(await ueberlauf(page)).toBeLessThanOrEqual(0);
  expect(fehler).toEqual([]);
});

test('Laden: Sonne + Speicher mit Erklärzeile, Untergrenze im Ladeplan und Reserve ohne Überlauf', async ({ page }) => {
  const fehler = await oeffnen(page, LADEN);
  const wb = page.getByRole('region', { name: 'Wallbox Werkstatt' });
  const womit = wb.getByRole('group', { name: 'Womit laden' });
  await expect(womit.getByRole('button')).toHaveText(['Nur Sonne', 'Sonne + Minimum', 'Sonne + Speicher', 'Günstig']);
  await womit.getByRole('button', { name: 'Sonne + Speicher' }).click();
  await expect(page.getByRole('status')).toContainText('übernommen');
  await expect(womit.getByRole('button', { name: 'Sonne + Speicher' })).toHaveAttribute('aria-pressed', 'true');
  await expect(wb).toContainText('Der Speicher gibt gerade bis 2,4 kW frei und darf bis 15 % entladen');
  await expect(wb).toContainText('Gestrichelt: bis dorthin darf der Speicher für das Auto entladen.');
  const reserve = page.getByRole('region', { name: 'Reserve für Sonne + Speicher' });
  await expect(reserve.getByRole('button', { name: '1 kWh · Vorgabe' })).toHaveAttribute('aria-pressed', 'true');
  await reserve.getByRole('button', { name: '2 kWh' }).click();
  await expect(page.getByRole('status')).toContainText('Die Reserve ist gespeichert');
  await expect(reserve.getByRole('button', { name: '2 kWh' })).toHaveAttribute('aria-pressed', 'true');
  expect(await ueberlauf(page)).toBeLessThanOrEqual(0);
  expect(await ueberstehend(page)).toEqual([]);
  expect(fehler).toEqual([]);
});

test('Laden: Sonne + Speicher mit einem Speicher, den VoltPilot nur beobachtet', async ({ page }) => {
  const fehler = await oeffnen(page, LADEN_BEOBACHTET);
  const wb = page.getByRole('region', { name: 'Wallbox Werkstatt' });
  await wb.getByRole('group', { name: 'Womit laden' }).getByRole('button', { name: 'Sonne + Speicher' }).click();
  await expect(page.getByRole('status')).toContainText('übernommen');
  await expect(wb).toContainText('Die Box gibt gerade bis 2,4 kW aus dem Speicher frei, bis er bei 15 % steht');
  await expect(wb).toContainText('VoltPilot steuert den Speicher dabei nicht, sondern beobachtet ihn');
  await expect(wb).not.toContainText('darf bis 15 % entladen');
  expect(await ueberlauf(page)).toBeLessThanOrEqual(0);
  expect(await ueberstehend(page)).toEqual([]);
  expect(fehler).toEqual([]);
});

test('Regeln: Satzbaukasten mit Probelauf, Folgen und Aktivieren', async ({ page }) => {
  const fehler = await oeffnen(page, REGELN);
  await expect(page.locator('article.rule')).toHaveCount(2);
  await page.getByRole('button', { name: /Neue Regel/ }).click();
  const blatt = page.getByRole('dialog', { name: 'Neue Regel' });
  await expect(blatt.getByLabel('Regel als Satz')).toContainText('Börsenpreis');
  await blatt.locator('.tok.val').click();
  await expect(blatt.getByRole('slider', { name: 'Börsenpreis' })).toBeVisible();
  await expect(blatt).toContainText('Probelauf ab jetzt bis morgen Abend');
  await blatt.getByRole('button', { name: 'Weiter: Folgen' }).click();
  const folgen = page.getByRole('dialog', { name: 'Folgen prüfen' });
  await expect(folgen).toContainText('Das passiert');
  await folgen.getByRole('button', { name: /Regel aktivieren/ }).click();
  await expect(page.getByRole('status')).toContainText('ist aktiv');
  expect(await ueberlauf(page)).toBeLessThanOrEqual(0);
  expect(fehler).toEqual([]);
});

test('Regeln: eine Szene pausiert die gewählten Geräte und endet mit einem Tipp', async ({ page }) => {
  const fehler = await oeffnen(page, REGELN);
  const szenen = page.getByRole('region', { name: 'Szenen' });
  await szenen.getByRole('button', { name: /Urlaub/ }).click();
  const blatt = page.getByRole('dialog', { name: /Szene Urlaub/ });
  await expect(blatt).toContainText('Das passiert');
  await expect(blatt.getByRole('switch', { name: 'Poolpumpe in der Szene' })).toHaveAttribute('aria-checked', 'true');
  await expect(blatt.getByRole('switch', { name: /Heizstab Warmwasser in der Szene/ })).toHaveAttribute('aria-checked', 'false');
  const box = await blatt.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 0.5);
  await blatt.getByRole('button', { name: /Szene einschalten/ }).click();
  await expect(page.getByText('Szene „Urlaub“ ist an.')).toBeVisible();
  await expect(szenen.getByRole('button', { name: /Urlaub/ })).toHaveAttribute('aria-pressed', 'true');
  expect(await ueberlauf(page)).toBeLessThanOrEqual(0);
  // Auf dem Reiter Geräte steht der Grund am Gerät.
  await page.getByRole('tablist', { name: 'Reiter der Steuerung' }).getByRole('tab', { name: /Geräte/ }).click();
  await expect(page.locator('#dev-e-pool')).toContainText('Szene „Urlaub“: aus');
  await page.getByRole('button', { name: 'Beenden' }).click();
  await expect(page.getByRole('status')).toContainText('Szene beendet');
  await expect(page.getByText('Szene „Urlaub“ ist an.')).toBeHidden();
  expect(fehler).toEqual([]);
});

// ---------------------------------------------------------------------------
// UEMS „Steuern & Optimieren“ auf der Beispielanlage (Captain 04.10.2026, SZ-1 A und SZ-2 A).
// Mit `STEUERUNG_SZ_BILDER=<Ordner>` legt der Lauf die ganze Seite als Bild ab.
// ---------------------------------------------------------------------------

/** Am Rechner die ganze Seite; am Telefon und für Blätter das Fenster (ab `stelle`, wenn genannt). */
async function bild(page: Page, name: string, projekt: string, art: { blatt?: boolean; stelle?: string } = {}) {
  const ordner = process.env.STEUERUNG_SZ_BILDER;
  if (!ordner) return;
  const telefon = projekt.startsWith('mobile');
  await expect(page.locator('.vp-loader')).toHaveCount(0, { timeout: 15_000 });
  if (art.stelle) await page.locator(art.stelle).first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
  // Die laufenden Punkte („lädt“) pulsieren endlos - das Bild hält sie an, statt auf ihr Ende zu warten.
  await page.screenshot({ path: `${ordner}/${name}-${telefon ? 375 : 1440}.png`, fullPage: !telefon && !art.blatt, animations: 'disabled' });
}

test('UEMS SZ-1 A: eine Anlage, die nur misst, zeigt die Messen-Ansicht - nur Gemessenes, Weg zur Steuerart', async ({ page }, testInfo) => {
  const fehler = await oeffnen(page, `/e2e/steuerung.html?funktion=kein_objekt#/anlage/help-site/steuerung`);
  await expect(page.getByTestId('steuern-einstieg')).toContainText('VoltPilot misst hier.');
  const liste = page.getByRole('region', { name: 'Gemessene Geräte' });
  await expect(liste.getByRole('button', { name: /Heizstab/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Jetzt' })).toContainText('gemessen');
  await expect(page.locator('.stn-kopf .auto')).toHaveCount(0);
  for (const nie of ['Wer bekommt Sonnenstrom zuerst?', 'Neu in Ihrer Anlage', 'Gerät fehlt?', 'Automatik', 'Tagesbild']) {
    await expect(page.locator('.stn')).not.toContainText(nie);
  }
  expect(await ueberlauf(page)).toBeLessThanOrEqual(0);
  expect(await ueberstehend(page)).toEqual([]);
  expect(fehler).toEqual([]);
  await bild(page, 'sz1-messanlage', testInfo.project.name);
  if (testInfo.project.name.startsWith('mobile')) await bild(page, 'sz1-messanlage-liste', testInfo.project.name, { stelle: '#devs' });
  await liste.getByRole('button', { name: /Heizstab/ }).first().click();
  await expect(page.getByRole('dialog')).toContainText('Smart heißt hier');
});

test('UEMS SZ-2 A: angehalten - Band mit „Fortsetzen“, Geräte und Regeln abgedimmt mit Grund', async ({ page }, testInfo) => {
  const fehler = await oeffnen(page, `/e2e/steuerung.html?funktion=angehalten#/anlage/help-site/steuerung`);
  await expect(page.locator('.stn-kopf')).toContainText('Angehalten seit 29.09.');
  const band = page.getByTestId('steuern-ruhe');
  await expect(band).toContainText('Steuerung angehalten seit 29.09.2026 08:00.');
  await expect(band.getByRole('button', { name: 'Fortsetzen' })).toBeVisible();
  await expect(page.locator('#devs .dev.matt').first()).toContainText('angehalten');
  await expect(page.locator('#devs').getByRole('button', { name: /Ändern/ })).toHaveCount(0);
  expect(await ueberlauf(page)).toBeLessThanOrEqual(0);
  expect(await ueberstehend(page)).toEqual([]);
  await bild(page, 'sz2-angehalten', testInfo.project.name);
  if (testInfo.project.name.startsWith('mobile')) await bild(page, 'sz2-angehalten-liste', testInfo.project.name, { stelle: '#devs' });
  await page.goto(`/e2e/steuerung.html?funktion=angehalten#/anlage/help-site/regeln`);
  await expect(page.locator('.rule.matt').first()).toContainText('wirkt nicht');
  await bild(page, 'sz2-angehalten-regeln', testInfo.project.name, { stelle: '.rule' });
  expect(fehler).toEqual([]);
});

test('UEMS SZ-2 A: die Plakette öffnet „Steuerung anhalten“ mit den Dauern und „Bis ich fortsetze“', async ({ page }, testInfo) => {
  const fehler = await oeffnen(page, `/e2e/steuerung.html?funktion=aktiv#/anlage/help-site/steuerung`);
  await bild(page, 'sz2-aktiv', testInfo.project.name);
  await page.locator('.stn-kopf').getByRole('button', { name: 'Automatik an' }).click();
  const blatt = page.getByRole('dialog', { name: /Steuerung anhalten/ });
  await blatt.getByRole('button', { name: /Bis ich fortsetze/ }).click();
  await expect(blatt.getByRole('button', { name: 'Anhalten' })).toBeEnabled();
  expect(await ueberlauf(page)).toBeLessThanOrEqual(0);
  await bild(page, 'sz2-blatt', testInfo.project.name, { blatt: true });
  expect(fehler).toEqual([]);
});
