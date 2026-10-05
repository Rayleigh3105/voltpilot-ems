import { join } from 'node:path';

const NBSP = String.fromCharCode(160);
import { expect, test, type Page } from '@playwright/test';

/**
 * **MiSpeL MP-41b - die Wallbox-Karte in Steuerung › Laden** (Bedienkonzept BK-41 Variante A).
 *
 * Bühne `e2e/wallbox-karte.*`: die Beispielanlage der Steuerung, die „Wallbox
 * Werkstatt“ ist bidirektional (V2H und V2G). Vier Fälle wie im Brief - fähiges
 * Auto mit Ladestand, fähiges Auto ohne Ladestand, Auto ohne Rückspeise-Funktion,
 * Anlage ohne Ladepunkt - und der Bestandsschutz: ein Ladepunkt „nur laden“
 * zeichnet den Reiter byte-gleich wie ohne Ladepunkte-Antwort (so lädt die
 * geteilte Bühne `steuerung.spec.ts`). Breiten: 1440 am Rechner, 375 am Telefon.
 */

const LADEN = (fall: string, mehr = '') => `/e2e/wallbox-karte.html?fall=${fall}${mehr}#/anlage/help-site/laden`;
const FOTOS = process.env.WALLBOX_FOTOS;

test.use({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });

test.beforeEach(async ({ page }, testInfo) => {
  await page.clock.setFixedTime(new Date('2026-09-29T11:10:00Z'));
  const name = testInfo.project.name;
  if (name.startsWith('mobile')) await page.setViewportSize({ width: 375, height: 812 });
  else if (name.startsWith('desktop')) await page.setViewportSize({ width: 1440, height: 1000 });
});

async function oeffnen(page: Page, fall: string, mehr = '') {
  const fehler: string[] = [];
  page.on('pageerror', (e) => fehler.push(e.message));
  await page.goto(LADEN(fall, mehr));
  await page.locator('.stn').first().waitFor();
  await expect(page.getByRole('region', { name: 'Netzanschluss' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return fehler;
}

const wallbox = (page: Page) => page.getByRole('region', { name: 'Wallbox Werkstatt' });
const carport = (page: Page) => page.getByRole('region', { name: 'Ladepunkt Carport' });

async function ohneUeberlauf(page: Page) {
  const b = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(b.s).toBeLessThanOrEqual(b.c);
  const raus = await page.evaluate(() => {
    const out: string[] = [];
    for (const karte of document.querySelectorAll<HTMLElement>('.stn .card, .stn-blatt')) {
      const r = karte.getBoundingClientRect();
      for (const kind of karte.querySelectorAll<HTMLElement>('*')) {
        const k = kind.getBoundingClientRect();
        if (k.width === 0 || getComputedStyle(kind).position === 'absolute') continue;
        if (k.right > r.right + 1.5 || k.left < r.left - 1.5) out.push(`${karte.className} > ${kind.tagName}.${String(kind.getAttribute('class'))}`);
      }
    }
    return out.slice(0, 5);
  });
  expect(raus).toEqual([]);
}

async function foto(page: Page, name: string, ziel?: ReturnType<typeof wallbox>) {
  if (!FOTOS) return;
  const breite = page.viewportSize()?.width ?? 0;
  const projekt = test.info().project.name;
  if (projekt !== 'desktop-chromium' && projekt !== 'mobile-chromium') return;
  const datei = join(FOTOS, `${name}-${breite}.png`);
  // Der Start-Lader der App hebt spätestens nach 3 s ab (Sicherheitsgrenze in App.tsx) - erst dann fotografieren.
  await page.locator('.vp-loader-screen').waitFor({ state: 'detached', timeout: 10_000 });
  // Am Telefon mit hohem Fenster: so liegen Kopf- und Fußleiste nicht über Karte oder Blatt, und das Blatt steht ganz da.
  const vorher = page.viewportSize()!;
  const hoch = breite < 600 && !name.startsWith('blatt');
  if (hoch) {
    await page.setViewportSize({ width: breite, height: 2600 });
    await page.waitForTimeout(150);
  }
  if (ziel) {
    await page.evaluate(() => window.scrollTo(0, 0));
    const box = (await ziel.boundingBox())!;
    await page.screenshot({ path: datei, clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: Math.min(box.width + 16, breite), height: box.height + 16 } });
  } else {
    await page.screenshot({ path: datei, fullPage: !name.startsWith('blatt') });
  }
  if (hoch) await page.setViewportSize(vorher);
}

test('fähiges Auto mit Ladestand: Ladestand, Reserve, Zurückspeisen in drei Stufen, Abfahrt und Reserve, Monat', async ({ page }) => {
  const fehler = await oeffnen(page, 'mit-ladestand');
  const k = wallbox(page);
  await expect(k.locator('[data-ladestand="62"]')).toContainText('62 %');
  await expect(k.locator('[data-ladestand="62"]')).toContainText(`≈${NBSP}240${NBSP}km · jetzt`);
  await expect(k.locator('[data-ladestand="62"]')).toContainText('Reserve 40 %');
  await expect(k.locator('[data-ladestand="62"]')).toContainText('Abfahrt 80 %');
  const stufen = k.getByRole('group', { name: 'Zurückspeisen' });
  await expect(stufen.getByRole('button')).toHaveText(['Aus', 'Ins Haus', 'Haus + Netz']);
  await expect(stufen.getByRole('button', { name: 'Ins Haus' })).toHaveAttribute('aria-pressed', 'true');
  await expect(k.locator('.wb-satz')).toHaveText(`Das Auto darf Strom ans Haus abgeben — nie unter 40 % (≈${NBSP}150${NBSP}km).`);
  await expect(k.locator('[data-hinweis="plant-noch-nicht"]')).toBeVisible();
  // BK-41 A: kein „Womit laden?“ und kein Ladeziel in kWh - das Ladeziel ist „Abfahrt und Reserve“.
  await expect(k.getByText('Womit laden?')).toHaveCount(0);
  await expect(k.locator('[data-zeile="abfahrt"]')).toContainText(`Abfahrt Mo–Fr 07:15 · 80 % (≈${NBSP}310${NBSP}km)`);
  await expect(k.locator('[data-zeile="abfahrt"]')).toContainText('Reserve 40 % · höchstens eine volle Ladung am Tag zurück');
  await expect(k.locator('[data-zeile="ertrag"]')).toContainText('September: 108 kWh ins Haus · 34 kWh ins Netz');
  await expect(k.locator('[data-zeile="ertrag"]')).toContainText('+15,42 € gegenüber nur laden · in Verlauf › Erlöse');
  // Der Ladepunkt „nur laden“ daneben bleibt wie heute.
  await expect(carport(page).getByText('Womit laden?')).toBeVisible();
  await expect(carport(page).getByRole('group', { name: 'Zurückspeisen' })).toHaveCount(0);
  await ohneUeberlauf(page);
  await foto(page, 'karte-mit-ladestand', k);
  await foto(page, 'reiter-mit-ladestand');

  await stufen.getByRole('button', { name: 'Haus + Netz' }).click();
  await expect(stufen.getByRole('button', { name: 'Haus + Netz' })).toHaveAttribute('aria-pressed', 'true');
  await expect(k.locator('.wb-satz')).toHaveText(`Das Auto darf Strom erst ans Haus, dann ins Netz abgeben — nie unter 40 % (≈${NBSP}150${NBSP}km).`);

  await k.locator('[data-zeile="abfahrt"]').click();
  const blatt = page.getByRole('dialog', { name: /Abfahrt und Reserve/ });
  await expect(blatt).toBeVisible();
  await expect(blatt.getByRole('group', { name: 'Wochentage' }).getByRole('button', { name: 'Fr' })).toHaveAttribute('aria-pressed', 'true');
  await expect(blatt.getByLabel('losfahren um')).toHaveValue('07:15');
  await expect(blatt).toContainText(`80 % (≈${NBSP}310${NBSP}km)`);
  await expect(blatt).toContainText(`40 % (≈${NBSP}150${NBSP}km)`);
  await expect(blatt).toContainText('(1 Ladung = 64 kWh)');
  await ohneUeberlauf(page);
  await foto(page, 'blatt-abfahrt-reserve');
  await blatt.getByRole('group', { name: 'Wochentage' }).getByRole('button', { name: 'Sa' }).click();
  await blatt.getByRole('button', { name: 'Übernehmen' }).click();
  await expect(blatt).toBeHidden();
  await expect(k.locator('[data-zeile="abfahrt"]')).toContainText(`Abfahrt Mo–Sa 07:15 · 80 % (≈${NBSP}310${NBSP}km)`);

  await k.locator('[data-zeile="ertrag"]').click();
  await expect(page).toHaveURL(/erloese/);
  expect(fehler).toEqual([]);
});

test('fähiges Auto ohne Ladestand: das heutige Ladeziel bleibt, Zurückspeisen und Reserve sind erreichbar', async ({ page }) => {
  const fehler = await oeffnen(page, 'ohne-ladestand');
  const k = wallbox(page);
  await expect(k.locator('[data-ladestand]')).toHaveCount(0);
  await expect(k.getByRole('group', { name: 'Zurückspeisen' })).toBeVisible();
  await expect(k.getByText('Womit laden?')).toBeVisible();
  await expect(k.locator('.lziel').filter({ hasText: 'Kein Ziel · lädt, wenn es passt' })).toBeVisible();
  await expect(k.locator('[data-zeile="abfahrt-reserve"]')).toContainText(`Abfahrt und Reserve · Reserve 40 % (≈${NBSP}150${NBSP}km)`);
  await expect(k.locator('[data-zeile="abfahrt-reserve"]')).toContainText('Gilt, sobald ein Auto mit Rückspeise-Funktion seinen Ladestand meldet');
  await ohneUeberlauf(page);
  await foto(page, 'karte-ohne-ladestand', k);
  expect(fehler).toEqual([]);
});

test('Auto ohne Rückspeise-Funktion: die Karte sagt es, das Auto lädt wie heute', async ({ page }) => {
  const fehler = await oeffnen(page, 'ohne-rueckspeisen');
  const k = wallbox(page);
  await expect(k.getByRole('note').filter({ hasText: 'Dieses Auto kann nicht zurückspeisen' })).toBeVisible();
  const stufen = k.getByRole('group', { name: 'Zurückspeisen' });
  for (const b of await stufen.getByRole('button').all()) await expect(b).toBeDisabled();
  await expect(stufen.getByRole('button', { name: 'Ins Haus' })).toHaveAttribute('aria-pressed', 'true');
  await expect(k.locator('.wb-satz')).toHaveText('„Ins Haus“ gilt wieder, sobald ein Auto mit Rückspeise-Funktion ansteckt.');
  await expect(k.locator('[data-ladestand]')).toHaveCount(0);
  await expect(k.getByText('Womit laden?')).toBeVisible();
  await expect(k.locator('[data-zeile="abfahrt-reserve"]')).toHaveCount(0);
  await ohneUeberlauf(page);
  await foto(page, 'karte-ohne-rueckspeisen', k);
  expect(fehler).toEqual([]);
});

test('Anlage ohne Ladepunkt: kein Zurückspeisen, der Reiter wie heute', async ({ page }) => {
  const fehler = await oeffnen(page, 'ohne-ladepunkt');
  await expect(page.getByText('Noch ist kein Ladepunkt mit dieser Anlage verbunden.', { exact: false })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Zurückspeisen' })).toHaveCount(0);
  await ohneUeberlauf(page);
  expect(fehler).toEqual([]);
});

test('Bestandsschutz: Ladepunkte „nur laden“ zeichnen den Reiter byte-gleich wie ohne Ladepunkte-Antwort', async ({ page }) => {
  const reiter = async (fall: string) => {
    await oeffnen(page, fall);
    await expect(wallbox(page).getByText('Womit laden?')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Fahrzeuge' })).toBeVisible();
    return page.locator('.stn-main').innerHTML();
  };
  const ohne = await reiter('unbekannt');
  const nurLaden = await reiter('nur-laden');
  expect(nurLaden).toBe(ohne);
  expect(nurLaden).not.toContain('Zurückspeisen');
  expect(nurLaden).toContain('Den Ladestand des Autos kennt VoltPilot nicht; ein Ziel ist deshalb eine Menge in kWh.');
});

test('Abfahrt und Reserve: beide Öffner geben den Fokus zurück - auch wenn der Browser beim Tippen nicht fokussiert', async ({ page }) => {
  // Safari/WebKit fokussiert einen angetippten Knopf nicht; der Öffner fokussiert ihn selbst (Gesamtlauf uems 04./05.10.2026).
  for (const [fall, zeile] of [['mit-ladestand', 'abfahrt'], ['ohne-ladestand', 'abfahrt-reserve']] as const) {
    const fehler = await oeffnen(page, fall);
    const knopf = wallbox(page).locator(`[data-zeile="${zeile}"]`);
    await knopf.click();
    const blatt = page.getByRole('dialog', { name: /Abfahrt und Reserve/ });
    await expect(blatt).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(blatt).toBeHidden();
    await expect(knopf).toBeFocused();
    expect(fehler).toEqual([]);
  }
});

test('angehaltener Standort (UEMS SZ-2 A): die Wallbox-Karte steht abgedimmt wie jede Ladekarte, Eingriffe gesperrt mit Grund', async ({ page }) => {
  const fehler = await oeffnen(page, 'mit-ladestand', '&funktion=angehalten');
  await expect(page.getByTestId('steuern-ruhe')).toContainText('angehalten');
  const k = wallbox(page);
  await expect(k).toHaveClass(/\bmatt\b/);
  await expect(carport(page)).toHaveClass(/\bmatt\b/);
  await expect(k.getByRole('group', { name: 'Lademodus' }).getByRole('button', { name: 'Schnell' })).toBeDisabled();
  await expect(k.getByRole('note').filter({ hasText: 'sobald die Steuerung fortgesetzt ist' })).toBeVisible();
  // Zurückspeisen ist die Freigabe des Fahrers, kein Eingriff - wie „Womit laden?“ am Carport bleibt sie einstellbar.
  await expect(k.getByRole('group', { name: 'Zurückspeisen' }).getByRole('button', { name: 'Haus + Netz' })).toBeEnabled();
  await expect(carport(page).getByRole('group', { name: 'Womit laden' }).getByRole('button').first()).toBeEnabled();
  await ohneUeberlauf(page);
  expect(fehler).toEqual([]);
});
