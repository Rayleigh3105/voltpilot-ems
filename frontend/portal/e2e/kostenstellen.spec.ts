import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { ahrenbergProzessMessstellen } from '../src/test/kostenstellenFixtures';

/**
 * Unternehmen › Messstellen › Kostenstellen und › Prozesse (UEMS AP-13 IP-9; Neubau nach dem Messen-Konzept m1
 * §6.6/§6.7) bei 375 und 1440 px auf der Bühne `startansicht.html?bild=unternehmen&ansicht=kostenstellen`
 * (Referenzunternehmen Ahrenberg, Uhr 05.11.2026): O9 (4200 Summe 14.470 kWh mit Posten und Herkunft; 4100 mit der
 * Warnung vor doppelter Zählung und dem Weg zur Messstelle), „Ohne Kostenstelle“ statt „nicht verteilt“, KEINE Summe
 * über Kostenstellen und KEIN Satz darüber; F12 (9000 „gültig bis 31.12.2026“, im Januar 2027 vorher beendet); Prozesse
 * mit den Messstellen, die sie messen (P-1: die Prozess-Summe MS-20); ohne Kostenstelle und Prozess keine Reiter dafür
 * (N5). Kein Querlauf, Tippflächen ≥ 44 px, keine Konsolenfehler.
 *
 * Mit `KOSTENSTELLEN_BILDER=<Ordner>` legt der Lauf je Fall die Fläche als Bild und die Messwerte ab.
 */

const BILDER = process.env.KOSTENSTELLEN_BILDER;
const BREITEN = [375, 1440] as const;
const JETZT = new Date('2026-11-05T08:00:00Z');
const OHNE_MENGEN =
  'Die Mengen je Kostenstelle sehen nur die Rollen Energiemanager, Kundenadministrator und Einsicht, weil eine Kostenstelle Messstellen aller Standorte umfassen kann.';
const n = (s: string | null | undefined): string => (s ?? '').replace(/ /g, ' ');

async function oeffne(page: Page, query: string, breite: number, fehler: string[], testid: string, jetzt = JETZT) {
  page.on('console', (m) => m.type() === 'error' && fehler.push(m.text()));
  page.on('pageerror', (e) => fehler.push(e.message));
  await page.clock.setFixedTime(jetzt);
  await page.setViewportSize({ width: breite, height: breite < 721 ? 812 : 900 });
  await page.goto(`/e2e/startansicht.html?bild=unternehmen&${query}`);
  await expect(page.getByTestId(testid)).toBeVisible();
  await expect(page.getByText('Wird geladen …')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
}

async function messe(page: Page, testid: string) {
  return page.evaluate((id) => {
    const doc = document.documentElement;
    const rand = doc.clientWidth;
    const draussen = [...document.querySelectorAll('.vp-main *')]
      .filter((el) => !el.closest('.vp-bereich-tabs, .vp-sr-only'))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.height > 0 && (r.right > rand + 0.5 || r.left < -0.5))
      .map(({ el }) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`);
    const flaeche = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    const kleine = [...(flaeche?.querySelectorAll<HTMLElement>('button, a, summary') ?? [])]
      .filter((el) => el.getBoundingClientRect().width > 0)
      .map((el) => ({ text: el.textContent?.trim() || el.getAttribute('aria-label'), h: Math.round(el.getBoundingClientRect().height), w: Math.round(el.getBoundingClientRect().width) }))
      // Höhe UND Breite (Prüfung r4 S23: die Blätter-Knöpfe waren 34 × 44 px).
      .filter((x) => x.h < 44 || x.w < 44);
    // N5 (Konzept „Navigation aus einem Guss“): Kostenstellen und Prozesse stehen in der Reihe der Gruppe „Messen“.
    const reiter = [...document.querySelectorAll('[role="tablist"][aria-label="Reiter der Gruppe Messen"] [role="tab"]')].map((el) =>
      el.textContent?.trim(),
    );
    return { dokument: doc.scrollWidth - doc.clientWidth, draussen, kleine, reiter, hoehe: Math.round(flaeche?.getBoundingClientRect().height ?? 0) };
  }, testid);
}

/** Kein Querlauf an jeder Breite; Tippflächen sind eine Touch-Regel und werden am Telefon geprüft (wie IP-8). */
function ohneQuerlauf(m: Awaited<ReturnType<typeof messe>>, name: string, breite: number) {
  expect(m.dokument, `${name} ${breite}: Querlauf des Dokuments`).toBe(0);
  expect(m.draussen, `${name} ${breite}: überstehende Elemente`).toEqual([]);
  if (breite < 721) expect(m.kleine, `${name} ${breite}: Tippflächen`).toEqual([]);
}

async function ablegen(page: Page, name: string, breite: number, messung: unknown) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  await page.screenshot({ path: join(BILDER, `${name}-${breite}.png`), fullPage: true });
  writeFileSync(join(BILDER, `${name}-${breite}.json`), `${JSON.stringify(messung, null, 2)}\n`);
}

const karte = (page: Page, kz: string) => page.locator(`[data-testid="kostenstelle-karte"][data-kennzeichen="${kz}"]`);
const summe = async (page: Page, kz: string) => n(await karte(page, kz).getByTestId('kostenstelle-summe').textContent());

for (const breite of BREITEN) {
  test.describe(`UEMS AP-13 IP-9 · Kostenstellen und Prozesse · ${breite} px`, () => {
    test('O9: Oktober 2026 - fünf Karten mit Summe und Posten, 4100 mit Warnung und Weg, „Ohne Kostenstelle“, keine Gesamtsumme', async ({ page }) => {
      const fehler: string[] = [];
      await oeffne(page, 'ansicht=kostenstellen', breite, fehler, 'kostenstellen');
      await expect(page.getByRole('heading', { level: 1, name: 'Kostenstellen' })).toBeVisible();
      await expect(page.getByText('Wem Ihr Verbrauch in der Kostenrechnung zugerechnet wird.')).toBeVisible();
      await expect(page.getByTestId('organisation-zeitraum')).toHaveText('Oktober 2026');
      await expect(page.getByRole('tablist', { name: 'Zeitraum' }).getByRole('tab')).toHaveText(['Monat', 'Jahr']);
      await expect(page.getByTestId('kostenstelle-karte')).toHaveCount(5);

      expect(await summe(page, '4200')).toBe('14.470kWhvollständig');
      const ms18 = karte(page, '4200').getByTestId('posten').filter({ hasText: 'MS-18' });
      await expect(ms18).toContainText('ganz · ab 15.10.2026');
      await expect(ms18).toHaveAttribute('href', /^#\/portfolio\/messstellen\/[0-9a-f-]+\?periode=2026-10$/);
      await expect(karte(page, '4200').getByTestId('posten').filter({ hasText: 'MS-07' })).toContainText('30 %');

      const warnung = karte(page, '4100').getByTestId('doppelzaehlung');
      await expect(warnung).toContainText('MS-06 ist bereits in MS-20 enthalten');
      await expect(warnung).toContainText('MS-11 ist bereits in MS-20 enthalten');
      await expect(warnung.getByRole('link', { name: 'Verteilung von MS-07 prüfen' })).toHaveAttribute('href', /^#\/portfolio\/messstellen\//);
      await expect(karte(page, '4100').getByText('zählt doppelt', { exact: true })).toBeVisible();
      await expect(page.getByTestId('doppelzaehlung')).toHaveCount(1);
      // Dieselbe Warnung am Posten, der schon in MS-20 steckt — MS-07 mit seinem Anteil; 4200 (30 % von MS-07) ohne.
      await expect(karte(page, '4100').getByTestId('posten-doppelt')).toHaveCount(3);
      await expect(karte(page, '4100').getByTestId('posten').filter({ hasText: 'MS-07' }).getByTestId('posten-doppelt')).toHaveText(
        'MS-07 ist bereits in MS-20 enthalten (Anteil 70 %)',
      );
      await expect(karte(page, '4200').getByTestId('posten-doppelt')).toHaveCount(0);

      // „Ohne Kostenstelle“: einmal, unter den Karten, ruhig - die ersten drei, der Rest auf Tipp.
      const ohne = page.getByTestId('ohne-kostenstelle');
      await expect(ohne).toHaveCount(1);
      await expect(ohne).toContainText('8 Messstellen');
      await expect(ohne.getByTestId('ohne-kostenstelle-reihe')).toHaveCount(3);
      await expect(ohne.getByTestId('ohne-kostenstelle-reihe').first()).toContainText('Netzbezug Halle 1');
      await ohne.getByRole('button', { name: breite < 721 ? '5 weitere' : 'Alle 8' }).click();
      await expect(ohne.getByTestId('ohne-kostenstelle-reihe')).toHaveCount(8);

      // KEINE Summe über Kostenstellen - und kein Satz darüber; Zone und Stand einmal am Fuß.
      const text = n(await page.getByTestId('kostenstellen').innerText());
      expect(text).not.toMatch(/Gesamtsumme|Summe aller|insgesamt|nicht summierbar|nicht verteilt/i);
      for (const gesamt of ['264.110', '272.810']) expect(text).not.toContain(gesamt);
      await expect(page.getByText('Zeiten: Europe/Berlin · Stand 01.11.2026 00:15')).toBeVisible();

      await expect(karte(page, '9000').getByTestId('kostenstelle-gueltig')).toHaveText('gültig bis 31.12.2026');

      const m = await messe(page, 'kostenstellen');
      expect(m.reiter).toEqual(['Messstellen', 'Kostenstellen', 'Prozesse', 'Bezugsgrößen']);
      ohneQuerlauf(m, 'o9-kostenstellen', breite);
      await ablegen(page, 'o9-kostenstellen', breite, m);
      expect(fehler).toEqual([]);
    });

    test('Kostenstelle B: Bearbeiter (Peter Hollerbach, ST-2) sieht Kennzeichen und Namen, EINEN Satz, keine Zahl, keinen Aufruf von …/energie', async ({ page }) => {
      const fehler: string[] = [];
      await oeffne(page, 'ansicht=kostenstellen&person=PH', breite, fehler, 'kostenstellen');
      await expect(page.getByTestId('kostenstelle-karte')).toHaveCount(5);
      await expect(karte(page, '4200')).toContainText('Montage');
      await expect(page.getByTestId('kostenstellen-ohne-mengen')).toHaveText(`${OHNE_MENGEN} Ihr Kundenadministrator: Jonas Wendlinger.`);
      for (const weg of ['kostenstelle-summe', 'ohne-kostenstelle', 'kostenstellen-ablesung', 'doppelzaehlung']) await expect(page.getByTestId(weg)).toHaveCount(0);
      await expect(page.getByText('Die Kostenstellen sind gerade nicht abrufbar.')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Erneut versuchen' })).toHaveCount(0);
      expect(n(await page.getByTestId('kostenstellen').innerText())).not.toMatch(/kWh/);
      expect(await page.evaluate(() => (window as unknown as { __energieAufrufe?: number }).__energieAufrufe ?? 0)).toBe(0);

      const m = await messe(page, 'kostenstellen');
      ohneQuerlauf(m, 'bearbeiter-kostenstellen', breite);
      await ablegen(page, 'bearbeiter-kostenstellen', breite, m);
      expect(fehler).toEqual([]);
    });

    test('F12: im Januar 2027 ist 9000 vor dem Zeitraum beendet, 9010 noch ohne Messstelle - ein alter Tages-Sprung zeigt seinen Monat', async ({ page }) => {
      const fehler: string[] = [];
      await oeffne(page, 'ansicht=kostenstellen&periode=tag&am=2027-01-15', breite, fehler, 'kostenstellen', new Date('2027-02-16T09:00:00Z'));
      await expect(page.getByTestId('organisation-zeitraum')).toHaveText('Januar 2027');
      await expect(page.getByTestId('kostenstelle-karte')).toHaveCount(6);
      await expect(karte(page, '9000')).toHaveCount(0);
      await expect(page.getByTestId('vorher-beendet')).toHaveText(
        'Vor diesem Zeitraum beendet: 9000 Infrastruktur (Druckluft, Kühlung, PV) (gültig bis 31.12.2026)',
      );
      await expect(karte(page, '9010')).toContainText('Noch keine Messstelle zugeordnet.');
      await expect(karte(page, '9010').getByRole('link', { name: 'Messstelle zuordnen' })).toHaveAttribute('href', '#/portfolio/messstellen');
      const m = await messe(page, 'kostenstellen');
      ohneQuerlauf(m, 'f12-kostenstellen', breite);
      await ablegen(page, 'f12-kostenstellen', breite, m);
      expect(fehler).toEqual([]);
    });

    test('Prozesse: P-1 mit der Prozess-Summe MS-20 88 630 kWh, die anderen ohne, keine Summe über Prozesse; Reiter wechseln', async ({ page }) => {
      const fehler: string[] = [];
      await page.route('**/api/v1/unternehmen/prozesse/*/messstellen?*', async (route) => {
        const teile = new URL(route.request().url()).pathname.split('/');
        const id = teile.at(-2) ?? '';
        const am = new URL(route.request().url()).searchParams.get('am') ?? '';
        await route.fulfill({ json: ahrenbergProzessMessstellen(id, am) });
      });
      await oeffne(page, 'ansicht=prozesse', breite, fehler, 'prozesse');
      await expect(page.getByRole('heading', { level: 1, name: 'Prozesse' })).toBeVisible();
      await expect(page.getByTestId('prozess-reihe')).toHaveCount(6);
      const p1 = page.locator('[data-testid="prozess-reihe"][data-kennzeichen="P-1"]');
      await expect(p1).toContainText('zusammengerechnet in MS-20 Prozess Spritzguss gesamt');
      expect(n(await p1.locator('.vp-ms-reihe-wert b').textContent())).toBe('88.630kWh');
      await expect(p1.getByRole('note')).toContainText('MS-20) enthält 70 % von Druckluft Kompressoren K1+K2 (MS-07) über Verteilung 4100');
      await expect(p1.getByRole('note')).toContainText('MS-07 gehört zu Druckluft (P-3). Die Bewertung zählt Druckluft dort.');
      await expect(p1.getByRole('link')).toHaveAttribute('href', /^#\/portfolio\/messstellen\/[^?]+\?periode=2026-10$/);
      const p2 = page.locator('[data-testid="prozess-reihe"][data-kennzeichen="P-2"]');
      await expect(p2).toContainText('noch keine Messstelle zugeordnet');
      await expect(p2.getByRole('link')).toHaveAttribute('href', '#/portfolio/messstellen');
      expect(n(await page.getByTestId('prozesse').innerText())).not.toMatch(/nicht summierbar|Keine Prozess-Summe/);
      // „Was ist ein Prozess?“ klappt Klartext, ein Beispiel aus der eigenen Firma und die Abgrenzung auf.
      await page.getByText('Was ist ein Prozess?', { exact: true }).click();
      await expect(page.getByTestId('begriff-auf-prozess')).toContainText('Bei Ihnen zum Beispiel Spritzguss.');
      await expect(page.getByTestId('begriff-auf-prozess')).toContainText('darum steht hier keine Summe über alle');
      const m = await messe(page, 'prozesse');
      expect(m.reiter).toEqual(['Messstellen', 'Kostenstellen', 'Prozesse', 'Bezugsgrößen']);
      ohneQuerlauf(m, 'prozesse', breite);
      await ablegen(page, 'prozesse', breite, m);

      // Die Reiter halten die Adresse: Kostenstellen im selben Zeitraum, dann die Liste — das Register von heute.
      await page.getByRole('tab', { name: 'Kostenstellen', exact: true }).click();
      await expect(page.getByTestId('kostenstellen')).toBeVisible();
      await expect(page).toHaveURL(/#\/portfolio\/messstellen\?reiter=kostenstellen&periode=monat&am=2026-10-01$/);
      await page.getByRole('tab', { name: 'Messstellen', exact: true }).click();
      await expect(page.getByTestId('messstellen')).toBeVisible();
      await expect(page).toHaveURL(/#\/portfolio\/messstellen$/);
      expect(fehler).toEqual([]);
    });

    test('Bestand: ohne Kostenstelle und ohne Prozess gibt es keine Reiter dafür - das Register steht wie zuvor', async ({ page }) => {
      const fehler: string[] = [];
      await oeffne(page, 'ansicht=messstellen&organisation=leer', breite, fehler, 'messstellen');
      await expect(page.locator('[role="tablist"][aria-label="Reiter der Messstellen"]')).toHaveCount(0);
      await expect(page.getByRole('tablist', { name: 'Reiter der Gruppe Messen' }).getByRole('tab')).toHaveText(['Messstellen', 'Bezugsgrößen']);
      await expect(page.getByTestId('messstellen-organisation')).toHaveCount(0);
      expect(fehler).toEqual([]);
    });
  });
}
