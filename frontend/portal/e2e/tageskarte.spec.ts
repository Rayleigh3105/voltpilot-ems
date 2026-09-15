import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { MessstelleWerte, MessstelleWerteHistorie } from '../src/api';
import { f10Historie, f10Stunden, f10Tag, f21Historie, f21Stunden, f21Tag } from '../src/test/wertVersionenFixtures';
import {
  f13Stunden,
  f13Tag,
  f13Viertelstunden,
  f14Stunden,
  f14Tag,
  f14Viertelstunden,
  f16Monat,
  f16Tage,
  f8Stunden,
  f8Tag,
  f8Viertelstunden,
  nochNichtGebildetStunden,
  nochNichtGebildetTag,
  nochNichtGebildetViertelstunden,
  normalStunden,
  normalTag,
  normalViertelstunden,
  ohneQuelleStunden,
  ohneQuelleTag,
  ohneQuelleViertelstunden,
} from '../src/test/werteKarteFixtures';

/**
 * Die Tages- und Monatskarte (UEMS AP-08 IP-11) bei 375 px: kein Querlauf,
 * `null` als Strich, MESZ/MEZ an der doppelten Stunde, 23/25 Stunden. Die Cloud
 * ist per `page.route` verdrahtet (Ahrenberg F8, F13, F14, F16, MS-21 ohne
 * Quelle). Mit `TAGESKARTE_BILDER=<Ordner>` legt der Lauf je Fall ein Bild des
 * ersten Bildschirms und eines der ganzen Fläche ab — die Vorschau für die
 * Freigabe.
 *
 * Seit ergebnis-zustand 1.7 (Captain 14.09.2026 „Ja, immer zeigen“) sagt die
 * Karte in BEIDEN Fällen, ob die Zahl vorläufig oder endgültig ist — im Kopf,
 * getrennt von Zustand und Verlauf.
 *
 * Versionen am Wert (AP-08 IP-18): hat die Zahl der Karte zwei oder mehr
 * Versionen, öffnet ihr Einstieg die Historie im gestapelten Dialog — F21 (drei
 * Versionen) und F10 (Freigabe ohne Grund) sind zwei Geschichten desselben
 * Tages, je Test ist genau eine verdrahtet.
 */

const ANTWORTEN: Record<string, () => MessstelleWerte> = {
  'MS-10|tag|2026-11-02': normalTag,
  'MS-10|stunde|2026-11-02': normalStunden,
  'MS-10|viertelstunde|2026-11-02': normalViertelstunden,
  'MS-10|tag|2026-11-03': f8Tag,
  'MS-10|stunde|2026-11-03': f8Stunden,
  'MS-10|viertelstunde|2026-11-03': f8Viertelstunden,
  'MS-06|tag|2026-10-25': f13Tag,
  'MS-06|stunde|2026-10-25': f13Stunden,
  'MS-06|viertelstunde|2026-10-25': f13Viertelstunden,
  'MS-06|tag|2027-03-28': f14Tag,
  'MS-06|stunde|2027-03-28': f14Stunden,
  'MS-06|viertelstunde|2027-03-28': f14Viertelstunden,
  'MS-06|monat|2026-10-01': f16Monat,
  'MS-06|tag|2026-10-01': f16Tage,
  'MS-21|tag|2026-11-03': ohneQuelleTag,
  'MS-21|stunde|2026-11-03': ohneQuelleStunden,
  'MS-21|viertelstunde|2026-11-03': ohneQuelleViertelstunden,
  'MS-10|tag|2026-11-05': nochNichtGebildetTag,
  'MS-10|stunde|2026-11-05': nochNichtGebildetStunden,
  'MS-10|viertelstunde|2026-11-05': nochNichtGebildetViertelstunden,
};

const BILDER = process.env.TAGESKARTE_BILDER;
const BREITE = 375;

async function verdrahte(page: Page, antworten: Record<string, () => MessstelleWerte> = ANTWORTEN) {
  await page.route('**/api/v1/messstellen/*/werte?*', async (route) => {
    const url = new URL(route.request().url());
    const ms = decodeURIComponent(url.pathname.split('/')[4]);
    const key = `${ms}|${url.searchParams.get('raster')}|${url.searchParams.get('von')}`;
    const antwort = antworten[key];
    if (!antwort) return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(antwort()) });
  });
}

async function oeffne(page: Page, q: string, antworten?: Record<string, () => MessstelleWerte>) {
  await verdrahte(page, antworten);
  await page.setViewportSize({ width: BREITE, height: 812 });
  await page.goto(`/e2e/tageskarte.html?${q}`);
  await expect(page.getByTestId('werte-karte')).toBeVisible();
  await expect(page.getByTestId('werte-zeile').first()).toBeVisible();
}

/** Kein Querlauf: weder die Seite noch der Dialog noch ein Element ragt über 375 px. */
async function keinQuerlauf(page: Page) {
  const befund = await page.evaluate((breite) => {
    // Gestapelt: jeder Körper, nicht nur der erste.
    const koerper = [...document.querySelectorAll('.vp-modal .dbody')] as HTMLElement[];
    const raus = [...document.querySelectorAll('.vp-modal *')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.right > breite + 0.5 || r.left < -0.5))
      .map(({ el }) => `${el.tagName.toLowerCase()}.${(el as HTMLElement).className}`);
    // Ein abgeschnittenes Datum (Auslassungspunkte) ist auch ein Querlauf — nur unsichtbar.
    const gekuerzt = [...document.querySelectorAll('.vp-modal .vp-picker-wert')]
      .filter((el) => el.scrollWidth > el.clientWidth + 0.5)
      .map((el) => el.textContent);
    return {
      gekuerzt,
      seite: document.documentElement.scrollWidth,
      koerper: koerper.length ? Math.max(...koerper.map((k) => k.scrollWidth - k.clientWidth)) : -1,
      raus,
    };
  }, BREITE);
  expect(befund.seite).toBeLessThanOrEqual(BREITE);
  expect(befund.gekuerzt).toEqual([]);
  expect(befund.koerper).toBe(0);
  expect(befund.raus).toEqual([]);
}

async function bilder(page: Page, datei: string) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  // Erst nach dem Einblenden des Dialogs — sonst zeigt das Bild die leere Bühne.
  await expect(page.locator('.vp-modal').last()).toHaveCSS('opacity', '1');
  await page.waitForFunction(() => document.getAnimations().every((x) => x.playState !== 'running'));
  await page.screenshot({ path: join(BILDER, `${datei}-telefon.png`) });
  // Die ganze Fläche des OBERSTEN Dialogs (gestapelt: die Versionen).
  const hoehe = await page.evaluate(() => {
    const oben = [...document.querySelectorAll('.vp-modal')].at(-1) as HTMLElement;
    const k = oben.querySelector('.dbody') as HTMLElement;
    const kopf = (oben.querySelector('.dhead') as HTMLElement).offsetHeight;
    return kopf + k.scrollHeight + 8;
  });
  await page.setViewportSize({ width: BREITE, height: Math.max(812, hoehe) });
  await page.screenshot({ path: join(BILDER, `${datei}-ganz.png`) });
  await page.setViewportSize({ width: BREITE, height: 812 });
}

/** Die Fassung steht im Kopf der Karte, nicht bei Zustand und Verlauf — und sie ist genau eine. */
async function fassung(page: Page, wort: 'vorläufig' | 'endgültig') {
  const karte = page.getByTestId('werte-karte');
  await expect(karte.getByTestId('werte-fassung')).toHaveCount(1);
  await expect(karte.locator('.vp-wk-kopf').getByTestId('werte-fassung')).toHaveText(wort);
  await expect(karte.locator('.vp-wk-abzeichen')).not.toContainText(wort);
  await expect(page.locator('.vp-wk-liste')).not.toContainText(/vorläufig|endgültig/);
}

const zeile = (page: Page, name: string) =>
  page.getByTestId('werte-zeile').filter({ has: page.locator('.vp-wk-zeile-name', { hasText: new RegExp(`^${name}$`) }) });

test.describe('Tages- und Monatskarte bei 375 px', () => {
  test('ein gewöhnlicher Tag: vollständig aus Zählerständen, Verlauf 100 %', async ({ page }) => {
    await oeffne(page, 'ms=MS-10&name=Netzbezug%20Halle%202&art=tag&wert=2026-11-02');
    const karte = page.getByTestId('werte-karte');
    await expect(karte).toContainText('2.304 kWh');
    await expect(karte).toContainText('vollständig (Menge aus Zählerständen)');
    await expect(karte).toContainText('Verlauf 100 %');
    await expect(page.getByTestId('werte-zeile')).toHaveCount(24);
    await fassung(page, 'endgültig');
    await keinQuerlauf(page);
    await bilder(page, '1-gewoehnlicher-tag');
  });

  test('ein Tag mit Lücke: Menge vollständig, Verlauf 85 %, leere Stunden als Strich', async ({ page }) => {
    await oeffne(page, 'ms=MS-10&name=Netzbezug%20Halle%202&art=tag&wert=2026-11-03');
    const karte = page.getByTestId('werte-karte');
    await expect(karte).toContainText('2.304 kWh');
    await expect(karte).toContainText('vollständig (Menge aus Zählerständen)');
    await expect(karte).toContainText('Verlauf 85 %');
    await expect(karte).toContainText('Lücke 14:00–17:31: Zuwachs 337,6 kWh gemessen, nicht auf Viertelstunden verteilbar');
    for (const leer of ['15:00–16:00', '16:00–17:00']) {
      await expect(zeile(page, leer).locator('.vp-wk-zeile-zahl')).toHaveText('—');
      await expect(zeile(page, leer)).toContainText('keine Werte');
    }
    await expect(zeile(page, '17:00–18:00').locator('.vp-wk-zeile-zahl')).toHaveText('46,4 kWh');
    await expect(page.locator('.vp-wk-zeile-zahl', { hasText: /^0,0/ })).toHaveCount(0);
    await fassung(page, 'vorläufig');
    await keinQuerlauf(page);
    await bilder(page, '2-tag-mit-luecke');
  });

  test('der 25-Stunden-Tag: 25 Zeilen, die doppelte Stunde mit MESZ und MEZ', async ({ page }) => {
    await oeffne(page, 'ms=MS-06&name=Spritzguss%20SG01–SG06&art=tag&wert=2026-10-25');
    await expect(page.getByTestId('werte-karte')).toContainText('25 Stunden (Zeitumstellung)');
    await expect(page.getByTestId('werte-karte')).toContainText('720 kWh');
    await expect(page.getByTestId('werte-zeile')).toHaveCount(25);
    await expect(zeile(page, '02:00–03:00 MESZ')).toHaveCount(1);
    await expect(zeile(page, '02:00–03:00 MEZ')).toHaveCount(1);
    // Kopf mit Titel, Fassung und Tagesdauer — der engste Kopf, den die Karte hat.
    await fassung(page, 'endgültig');
    await keinQuerlauf(page);
    await bilder(page, '3-fuenfundzwanzig-stunden');
  });

  test('der 23-Stunden-Tag: 23 Zeilen, keine Stunde 02:00', async ({ page }) => {
    await oeffne(page, 'ms=MS-06&name=Spritzguss%20SG01–SG06&art=tag&wert=2027-03-28');
    await expect(page.getByTestId('werte-karte')).toContainText('23 Stunden (Zeitumstellung)');
    await expect(page.getByTestId('werte-karte')).toContainText('662 kWh');
    await expect(page.getByTestId('werte-zeile')).toHaveCount(23);
    await expect(page.locator('.vp-wk-zeile-name', { hasText: /^02:00/ })).toHaveCount(0);
    await keinQuerlauf(page);
    await bilder(page, '4-dreiundzwanzig-stunden');
  });

  test('ein Monat: 55.100 kWh, 31 Tage, der 25.10. nennt seine 25 Stunden', async ({ page }) => {
    await oeffne(page, 'ms=MS-06&name=Spritzguss%20SG01–SG06&art=monat&wert=2026-10');
    const karte = page.getByTestId('werte-karte');
    await expect(karte).toContainText('Oktober 2026');
    await expect(karte).toContainText('55.100 kWh');
    await expect(page.getByTestId('werte-zeile')).toHaveCount(31);
    await expect(zeile(page, 'So 25.10.')).toContainText('25 Stunden (Zeitumstellung)');
    // Der Oktober ist vorläufig, obwohl der 25.10. darin endgültig ist — jede Periode sagt ihre eigene.
    await fassung(page, 'vorläufig');
    await keinQuerlauf(page);
    await bilder(page, '5-monat');
  });

  // AP-13 IP-6 (Z4): hat der ganze Zeitraum keine Datenquelle, steht statt Karte und 24 Strichen der Leerzustand.
  test('eine Messstelle ohne Datenquelle: der Leerzustand mit dem Satz des Grundes — kein Strich-Bild, nie 0', async ({ page }) => {
    await verdrahte(page);
    await page.setViewportSize({ width: BREITE, height: 812 });
    await page.goto('/e2e/tageskarte.html?ms=MS-21&name=Gas%20Heizung%20Verwaltung&art=tag&wert=2026-11-03');
    const leer = page.getByTestId('werte-leer');
    await expect(leer.getByRole('heading', { name: 'Keine Datenquelle' })).toBeVisible();
    await expect(leer).toContainText(
      'Keine Quelle: MS-21 Gas Heizung Verwaltung hatte in diesem Zeitraum keine führende Quelle — es gibt keine Zahl, auch keine 0.',
    );
    // Der Dialog kennt das Register nicht: kein nächster Schritt, den er nicht gehen kann.
    await expect(leer.getByRole('button')).toHaveCount(0);
    await expect(page.getByTestId('werte-karte')).toHaveCount(0);
    await expect(page.getByTestId('werte-zeile')).toHaveCount(0);
    await expect(page.locator('.vp-modal')).not.toContainText(/\b0,0\b|\b0 m³/);
    // Die Route kennt keine Fassung: es steht keine da, auch nicht „endgültig“.
    await expect(page.getByTestId('werte-fassung')).toHaveCount(0);
    await keinQuerlauf(page);
    await bilder(page, '6-ohne-werte');
  });

  // Captain 15.09.2026: die ANZAHL der Lücken steht auf der Karte — im Abzeichen des Verlaufs, nicht daneben.
  test('die Anzahl der Lücken: F8 „Verlauf 85 % · 1 Lücke“, der gewöhnliche Tag ohne Anzahl', async ({ page }) => {
    await oeffne(page, 'ms=MS-10&name=Netzbezug%20Halle%202&art=tag&wert=2026-11-03');
    const karte = page.getByTestId('werte-karte');
    await expect(karte.getByTestId('werte-verlauf')).toHaveText(/^Verlauf 85\s%\s·\s1\sLücke$/);
    // Kein eigenes Abzeichen: Zustand und Verlauf, sonst nichts (Falle 9).
    await expect(karte.locator('.vp-wk-abzeichen > *')).toHaveCount(2);
    // Der Satz der Lücke steht weiter unter den Kennzeichen.
    await expect(karte.locator('.vp-wk-kennzeichen li')).toHaveCount(1);
    await keinQuerlauf(page);
    await bilder(page, '15-anzahl-der-luecken');
    await page.goto('/e2e/tageskarte.html?ms=MS-10&name=Netzbezug%20Halle%202&art=tag&wert=2026-11-02');
    await expect(page.getByTestId('werte-verlauf')).toHaveText(/^Verlauf 100\s%$/);
    await expect(page.getByTestId('werte-karte')).not.toContainText('Lücke');
  });

  // Captain 15.09.2026: „noch nicht gerechnet“ und „keine Werte“ sind zwei Lagen — und nur eine löst sich von selbst.
  test('ein noch nicht gebildeter Tag: Strich und eigener Satz, nie „keine Werte“; die letzte Stunde sagt es auch', async ({ page }) => {
    await oeffne(page, 'ms=MS-10&name=Netzbezug%20Halle%202&art=tag&wert=2026-11-05');
    const karte = page.getByTestId('werte-karte');
    await expect(karte.locator('.vp-wk-zahl')).toHaveText('—');
    await expect(karte.getByTestId('werte-grund')).toHaveText('Noch nicht gerechnet — der Wert erscheint von selbst, Sie müssen nichts tun.');
    await expect(karte).not.toContainText('keine Werte');
    await expect(karte.locator('.vp-wk-abzeichen')).toHaveCount(0);
    await expect(page.getByTestId('werte-fassung')).toHaveCount(0);
    // Die Liste: 23 Stunden mit Zahl, die letzte ohne — mit dem Wort, nicht mit dem Satz.
    const letzte = page.getByTestId('werte-zeile').last();
    await expect(letzte.locator('.vp-wk-zeile-zahl')).toHaveText('—');
    await expect(letzte.locator('.vp-wk-zeile-info')).toHaveText('noch nicht gerechnet');
    await expect(page.locator('.vp-wk-zeile', { hasText: 'noch nicht gerechnet' })).toHaveCount(1);
    await expect(page.locator('.vp-wk-liste')).not.toContainText('keine Werte');
    await keinQuerlauf(page);
    await bilder(page, '14-noch-nicht-gebildet');
  });

  // ergebnis-zustand 1.7: immer zeigen, beide Fälle — blättern wechselt die Fassung mit der Periode.
  test('die Fassung: der vorläufige 03.11., der endgültige 02.11., der vorläufige Oktober mit dem endgültigen 25.10.', async ({ page }) => {
    await oeffne(page, 'ms=MS-10&name=Netzbezug%20Halle%202&art=tag&wert=2026-11-03');
    await fassung(page, 'vorläufig');
    await expect(page.getByTestId('werte-fassung')).toHaveAttribute('data-fassung', 'vorlaeufig');
    // Die Fassung steht im Kopf neben dem Titel, in einer Zeile mit ihm.
    const titel = (await page.locator('.vp-wk-titel').boundingBox())!;
    const abzeichen = (await page.getByTestId('werte-fassung').boundingBox())!;
    expect(Math.abs(titel.y + titel.height / 2 - (abzeichen.y + abzeichen.height / 2))).toBeLessThan(4);
    await keinQuerlauf(page);
    await bilder(page, '7-vorlaeufiger-tag');
    await page.getByRole('group', { name: 'Zeitraum' }).getByLabel('Vorheriger Zeitraum').click();
    await expect(page.getByRole('group', { name: 'Zeitraum' })).toContainText('02.11.2026');
    await fassung(page, 'endgültig');
    await expect(page.getByTestId('werte-fassung')).toHaveAttribute('data-fassung', 'endgueltig');
    await keinQuerlauf(page);
    await bilder(page, '8-endgueltiger-tag');
    await page.goto('/e2e/tageskarte.html?ms=MS-06&name=Spritzguss%20SG01–SG06&art=monat&wert=2026-10');
    await expect(page.getByTestId('werte-karte')).toContainText('55.100\u00a0kWh');
    await fassung(page, 'vorläufig');
    await keinQuerlauf(page);
    await bilder(page, '9-vorlaeufiger-monat');
    await page.goto('/e2e/tageskarte.html?ms=MS-06&name=Spritzguss%20SG01–SG06&art=tag&wert=2026-10-25');
    await expect(page.getByTestId('werte-karte')).toContainText('720\u00a0kWh');
    await fassung(page, 'endgültig');
    await keinQuerlauf(page);
    await bilder(page, '10-endgueltiger-tag-im-vorlaeufigen-monat');
  });

  // Die Zeitraum-Wahl als EIN Bedienelement (Captain 14.09.2026: Variante B, ein Kasten mit zwei Zeilen).
  test('Zeitraum-Wahl: Tag|Monat und Datum in einem Rahmen, blättern und umschalten behält den Zeitraum', async ({ page }) => {
    await oeffne(page, 'ms=MS-10&name=Netzbezug%20Halle%202&art=tag&wert=2026-11-03');
    const wahl = page.getByRole('group', { name: 'Zeitraum' });
    await expect(wahl.getByRole('tab', { name: 'Tag' })).toHaveAttribute('aria-selected', 'true');
    await expect(wahl).toContainText('03.11.2026');
    // Segment, Knöpfe und Datumsfeld liegen IN einem Rahmen.
    const rahmen = await wahl.boundingBox();
    for (const teil of [wahl.getByRole('tab', { name: 'Monat' }), wahl.getByLabel('Vorheriger Zeitraum'), wahl.getByLabel('Nächster Zeitraum')]) {
      const b = (await teil.boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(rahmen!.x);
      expect(b.x + b.width).toBeLessThanOrEqual(rahmen!.x + rahmen!.width + 0.5);
    }
    await keinQuerlauf(page);
    await bilder(page, 'zeitwahl-tag');
    await wahl.getByLabel('Vorheriger Zeitraum').click();
    await expect(wahl).toContainText('02.11.2026');
    await expect(page.getByTestId('werte-karte')).toContainText('Verlauf 100\u00a0%');
    // Vom Tag in SEINEN Monat — nicht in den heutigen (Fehler der ersten Vorschau).
    await wahl.getByRole('tab', { name: 'Monat' }).click();
    await expect(wahl).toContainText('November 2026');
    await page.goto('/e2e/tageskarte.html?ms=MS-06&name=Spritzguss%20SG01–SG06&art=monat&wert=2026-10');
    await expect(page.getByTestId('werte-karte')).toContainText('55.100\u00a0kWh');
    await expect(page.getByRole('group', { name: 'Zeitraum' })).toContainText('Oktober 2026');
    await keinQuerlauf(page);
    await bilder(page, 'zeitwahl-monat');
    // Der längste Monatsname steht ganz — auch ohne Werte (die Wahl steht über der Auskunft). Der Bühne fehlt die Antwort
    // (404): seit AP-13 IP-6 ist das eine ruhige Auskunft, kein Alarm mit „Erneut versuchen“.
    await page.goto('/e2e/tageskarte.html?ms=MS-06&art=monat&wert=2026-09');
    await expect(page.getByRole('group', { name: 'Zeitraum' })).toContainText('September 2026');
    await expect(page.getByTestId('werte-auskunft')).toBeVisible();
    await keinQuerlauf(page);
  });
});

const VERSIONEN_F21: Record<string, () => MessstelleWerte> = {
  'MS-10|tag|2026-11-03': f21Tag,
  'MS-10|stunde|2026-11-03': f21Stunden,
};
const VERSIONEN_F10: Record<string, () => MessstelleWerte> = {
  'MS-10|tag|2026-11-03': f10Tag,
  'MS-10|stunde|2026-11-03': f10Stunden,
};

/** Die Historie-Route; `anfragen` sammelt, womit gefragt wurde (entschlüsselt). */
async function verdrahteVersionen(page: Page, historie: () => MessstelleWerteHistorie) {
  const anfragen: Array<{ raster: string | null; von: string | null; bis: string | null }> = [];
  await page.route('**/api/v1/messstellen/*/werte/versionen?*', async (route) => {
    const url = new URL(route.request().url());
    anfragen.push({ raster: url.searchParams.get('raster'), von: url.searchParams.get('von'), bis: url.searchParams.get('bis') });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(historie()) });
  });
  return anfragen;
}

const versionen = (page: Page) => page.getByTestId('versionen-dialog');

test.describe('Versionen am Wert bei 375 px', () => {
  test('F21: die Karte zeigt „3 Versionen“, der Dialog Version 3 · 2 · 1 mit wer, wann, warum', async ({ page }) => {
    const anfragen = await verdrahteVersionen(page, f21Historie);
    await oeffne(page, 'ms=MS-10&name=Netzbezug%20Halle%202&art=tag&wert=2026-11-03', VERSIONEN_F21);
    const karte = page.getByTestId('werte-karte');
    await expect(karte).toContainText('2.354\u00a0kWh');
    const einstieg = karte.getByTestId('werte-versionen');
    await expect(einstieg).toContainText('3 Versionen');
    // Die Stunden ab 14:00 haben keine eigenen Versionen: Strich, kein Wort (Befund F11-Stunde, nicht hier gerechnet).
    await expect(zeile(page, '14:00–15:00').locator('.vp-wk-zeile-zahl')).toHaveText('—');
    await expect(zeile(page, '14:00–15:00').locator('.vp-wk-zeile-info')).toHaveCount(0);
    expect(anfragen).toEqual([]);
    await keinQuerlauf(page);
    await bilder(page, '11-karte-mit-versionen');

    await einstieg.click();
    await expect(versionen(page)).toBeVisible();
    await expect(versionen(page).getByTestId('version')).toHaveCount(3);
    // Genau der Schritt der Karte — von und bis mit Versatz, unverändert angekommen.
    expect(anfragen).toEqual([{ raster: 'tag', von: '2026-11-03T00:00:00+01:00', bis: '2026-11-04T00:00:00+01:00' }]);
    const [v3, v2, v1] = [0, 1, 2].map((i) => versionen(page).getByTestId('version').nth(i));
    await expect(v3).toContainText('Version 3');
    await expect(v3).toContainText('gilt jetzt');
    await expect(v3.getByTestId('wert-alt')).toContainText('2.304\u00a0kWh');
    await expect(v3.getByTestId('wert-neu')).toContainText('2.354\u00a0kWh');
    await expect(v3.getByTestId('entscheidung')).toHaveCount(2);
    await expect(v3.getByTestId('entscheidung').first()).toContainText('zurückgenommen von Ines Kaltenbach · 20.11.2026 15:10');
    await expect(v3.getByTestId('entscheidung').first()).toContainText('„Profil aus Netzbetreiber-Lastgang verfügbar“');
    await expect(v3.getByTestId('angelegt')).toContainText('eingetragen von Ines Kaltenbach · 06.11.2026 11:20');
    await expect(v2.getByTestId('entscheidung')).toContainText('eingetragen von Ines Kaltenbach');
    await expect(v1).toContainText('Original');
    await expect(v1).toContainText('gebildet am 04.11.2026 00:15');
    await expect(v1.getByTestId('wert-alt')).toHaveCount(0);
    await expect(versionen(page)).not.toContainText('geändert');
    await keinQuerlauf(page);
    await bilder(page, '12-versionen-f21');

    // Escape schließt nur die Versionen; der Fokus kehrt zum Einstieg zurück.
    await page.keyboard.press('Escape');
    await expect(versionen(page)).toHaveCount(0);
    await expect(page.getByTestId('werte-karte')).toBeVisible();
    await expect(einstieg).toBeFocused();
  });

  test('F10: freigegeben ohne Grund — ein ehrlicher Satz, der Vorschlag von VoltPilot darunter', async ({ page }) => {
    await verdrahteVersionen(page, f10Historie);
    await oeffne(page, 'ms=MS-10&name=Netzbezug%20Halle%202&art=tag&wert=2026-11-03', VERSIONEN_F10);
    await page.getByTestId('werte-versionen').click();
    const v2 = versionen(page).getByTestId('version').first();
    await expect(v2.getByTestId('wert-alt')).toContainText('Verlauf 85\u00a0%');
    await expect(v2.getByTestId('wert-neu')).toContainText('Verlauf 100\u00a0%');
    const freigabe = v2.getByTestId('entscheidung');
    await expect(freigabe).toContainText('Korrektur K-2026-0007');
    await expect(freigabe).toContainText('freigegeben von Jonas Wendlinger · 12.11.2026 10:15');
    await expect(freigabe.getByTestId('warum').first()).toHaveText('Kein Grund angegeben — eine Freigabe verlangt keinen.');
    await expect(freigabe.getByTestId('warum').first()).toHaveClass(/vp-wv-ehrlich/);
    await expect(freigabe.getByTestId('angelegt')).toContainText('vorgeschlagen von VoltPilot · 12.11.2026 09:02');
    await keinQuerlauf(page);
    await bilder(page, '13-versionen-f10');
  });

  test('ein Tag mit einer Version: kein Einstieg, keine Anfrage', async ({ page }) => {
    const anfragen = await verdrahteVersionen(page, f21Historie);
    await oeffne(page, 'ms=MS-10&name=Netzbezug%20Halle%202&art=tag&wert=2026-11-02');
    await expect(page.getByTestId('werte-karte')).toContainText('2.304\u00a0kWh');
    await expect(page.getByTestId('werte-versionen')).toHaveCount(0);
    expect(anfragen).toEqual([]);
  });
});
