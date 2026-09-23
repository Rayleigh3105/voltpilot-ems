import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { ahrenbergProzessMessstellen } from '../src/test/kostenstellenFixtures';

/**
 * Unternehmen › Messstellen › Kostenstellen und › Prozesse (UEMS AP-13 IP-9 = AP-10 IP-15, E8 = A, B6) bei 375 und
 * 1440 px auf der Bühne `startansicht.html?bild=unternehmen&ansicht=kostenstellen` (Referenzunternehmen Ahrenberg, Uhr
 * 05.11.2026): O9 (4200 9 700 · 4 770 · 14 470; 4100 mit der Doppelzählungs-Warnung), „nicht verteilt“ EINMAL, KEINE
 * Summe über Kostenstellen mit dem Satz, warum; F12 (9000 „gültig bis 31.12.2026“, am 15.01.2027 vorher beendet); die
 * Prozess-Summe MS-20; ohne Kostenstelle und Prozess keine Reiter. Kein Querlauf, Tippflächen ≥ 44 px, keine
 * Konsolenfehler.
 *
 * Mit `KOSTENSTELLEN_BILDER=<Ordner>` legt der Lauf je Fall die Fläche als Bild und die Messwerte ab.
 */

const BILDER = process.env.KOSTENSTELLEN_BILDER;
const BREITEN = [375, 1440] as const;
const JETZT = new Date('2026-11-05T08:00:00Z');
const KEINE_SUMME = 'Die Kostenstellen sind nicht summierbar — nicht verteilte Mengen gehören keiner.';
const OHNE_MENGEN =
  'Die Mengen je Kostenstelle sehen nur die Rollen Energiemanager und Kundenadministrator, weil eine Kostenstelle Messstellen aller Standorte umfassen kann.';
const PROZESSE_KEINE_SUMME = 'Die Prozesse sind nicht summierbar — eine Messstelle kann zu mehreren Prozessen gehören.';
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
      .map((el) => ({ text: el.textContent?.trim() ?? el.getAttribute('aria-label'), h: Math.round(el.getBoundingClientRect().height) }))
      .filter((x) => x.h < 44);
    const reiter = [...document.querySelectorAll('[role="tablist"][aria-label="Reiter der Messstellen"] [role="tab"]')].map((el) =>
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
const zahl = async (page: Page, kz: string, block: string) => n(await karte(page, kz).getByTestId(`block-${block}`).locator('.vp-ks-zahl').textContent());

for (const breite of BREITEN) {
  test.describe(`UEMS AP-13 IP-9 · Kostenstellen und Prozesse · ${breite} px`, () => {
    test('O9: Oktober 2026 — fünf Karten, 4200 9 700 · 4 770 · 14 470, 4100 mit Warnung, „nicht verteilt“ einmal, keine Gesamtsumme', async ({ page }) => {
      const fehler: string[] = [];
      await oeffne(page, 'ansicht=kostenstellen', breite, fehler, 'kostenstellen');
      await expect(page.getByTestId('organisation-zeitraum')).toHaveText('Oktober 2026');
      await expect(page.getByTestId('kostenstelle-karte')).toHaveCount(5);

      expect([await zahl(page, '4200', 'gemessen'), await zahl(page, '4200', 'verteilt'), await zahl(page, '4200', 'berechnet'), await zahl(page, '4200', 'summe')]).toEqual([
        '9.700 kWh',
        '4.770 kWh',
        '—',
        '14.470 kWh',
      ]);
      const ms18 = karte(page, '4200').locator('.vp-ks-posten-zeile').filter({ hasText: 'MS-18' });
      await expect(ms18).toContainText('ab 15.10.2026');
      await expect(ms18.locator('a')).toHaveAttribute('href', /^#\/portfolio\/messstellen\/[0-9a-f-]+\?periode=2026-10$/);
      await expect(karte(page, '4200').locator('.vp-ks-posten-zeile').filter({ hasText: 'MS-07' })).toContainText('verteilt (30 % von MS-07)');

      expect(await zahl(page, '4100', 'berechnet')).toBe('88.630 kWh');
      const warnung = karte(page, '4100').getByTestId('doppelzaehlung');
      await expect(warnung).toContainText('Doppelt gezählt: MS-06 ist bereits in MS-20 enthalten');
      await expect(warnung).toContainText('MS-11 ist bereits in MS-20 enthalten');
      await expect(page.getByTestId('doppelzaehlung')).toHaveCount(1);
      // Dieselbe Warnung am Posten, der schon in MS-20 steckt — MS-07 mit seinem Anteil; 4200 (30 % von MS-07) ohne.
      await expect(karte(page, '4100').getByTestId('posten-doppelt')).toHaveCount(3);
      await expect(karte(page, '4100').locator('.vp-ks-posten-zeile').filter({ hasText: 'MS-07' }).getByTestId('posten-doppelt')).toHaveText(
        'MS-07 ist bereits in MS-20 enthalten (Anteil 70 %)',
      );
      await expect(karte(page, '4200').getByTestId('posten-doppelt')).toHaveCount(0);

      // „nicht verteilt“ steht einmal, über den Karten — keine Karte trägt ihn.
      await expect(page.getByTestId('nicht-verteilt')).toHaveCount(1);
      await expect(page.getByTestId('nicht-verteilt')).toContainText('7 Messstellen · gehört keiner Kostenstelle und steht in keiner Summe');
      await expect(page.locator('[data-testid="kostenstelle-karte"] [data-testid="nicht-verteilt"]')).toHaveCount(0);
      const oben = await page.evaluate(() => {
        const nv = document.querySelector('[data-testid="nicht-verteilt"]')?.getBoundingClientRect().top ?? 0;
        const erste = document.querySelector('[data-testid="kostenstelle-karte"]')?.getBoundingClientRect().top ?? 0;
        return nv < erste;
      });
      expect(oben).toBe(true);

      // KEINE Summe über Kostenstellen: der Satz wörtlich, vor der ersten Karte — und nirgends doch eine Gesamtsumme.
      await expect(page.getByTestId('kostenstellen-keine-summe')).toHaveText(KEINE_SUMME);
      await expect(page.getByTestId('block-summe')).toHaveCount(5);
      const text = n(await page.getByTestId('kostenstellen').innerText());
      expect(text).not.toMatch(/Gesamtsumme|Summe aller|insgesamt/i);
      for (const gesamt of ['264.110', '272.810']) expect(text).not.toContain(gesamt);

      await expect(karte(page, '9000').getByTestId('kostenstelle-gueltig')).toHaveText('gültig bis 31.12.2026');

      const m = await messe(page, 'kostenstellen');
      expect(m.reiter).toEqual(['Liste', 'Kostenstellen', 'Prozesse']);
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
      for (const weg of ['block-summe', 'nicht-verteilt', 'kostenstellen-keine-summe', 'doppelzaehlung']) await expect(page.getByTestId(weg)).toHaveCount(0);
      await expect(page.getByText('Die Kostenstellen sind gerade nicht abrufbar.')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Erneut versuchen' })).toHaveCount(0);
      expect(n(await page.getByTestId('kostenstellen').innerText())).not.toMatch(/kWh/);
      expect(await page.evaluate(() => (window as unknown as { __energieAufrufe?: number }).__energieAufrufe ?? 0)).toBe(0);

      const m = await messe(page, 'kostenstellen');
      ohneQuerlauf(m, 'bearbeiter-kostenstellen', breite);
      await ablegen(page, 'bearbeiter-kostenstellen', breite, m);
      expect(fehler).toEqual([]);
    });

    test('F12: am 15.01.2027 ist 9000 vor dem Zeitraum beendet, 9010 ohne Zuordnung, MS-03 bleibt „nicht verteilt“', async ({ page }) => {
      const fehler: string[] = [];
      await oeffne(page, 'ansicht=kostenstellen&periode=tag&am=2027-01-15', breite, fehler, 'kostenstellen', new Date('2027-01-16T09:00:00Z'));
      await expect(page.getByTestId('organisation-zeitraum')).toHaveText('15.01.2027');
      await expect(page.getByTestId('kostenstelle-karte')).toHaveCount(6);
      await expect(karte(page, '9000')).toHaveCount(0);
      await expect(page.getByTestId('vorher-beendet')).toHaveText(
        'Vor diesem Zeitraum beendet: 9000 Infrastruktur (Druckluft, Kühlung, PV) (gültig bis 31.12.2026)',
      );
      await expect(karte(page, '9010')).toContainText('Dieser Kostenstelle ist im Zeitraum keine Messstelle zugeordnet.');
      await expect(page.getByTestId('nicht-verteilt')).toContainText('1 Messstelle');
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
      await expect(page.getByTestId('prozess-karte')).toHaveCount(6);
      await expect(page.getByTestId('prozesse-keine-summe')).toHaveText(PROZESSE_KEINE_SUMME);
      const p1 = page.locator('[data-testid="prozess-karte"][data-kennzeichen="P-1"]');
      await expect(p1.getByTestId('prozess-summe')).toContainText('Prozess Spritzguss gesamt');
      expect(n(await p1.getByTestId('prozess-summe').locator('.vp-ks-posten-zahl').textContent())).toBe('88.630 kWh');
      await expect(p1.getByRole('note')).toContainText('MS-20) enthält 70 % von Druckluft Kompressoren K1+K2 (MS-07) über Verteilung 4100');
      await expect(p1.getByRole('note')).toContainText('MS-07 gehört zu Druckluft (P-3). Die Bewertung zählt Druckluft dort.');
      await expect(page.locator('[data-testid="prozess-karte"][data-kennzeichen="P-2"]')).toContainText(
        'Keine Prozess-Summe: sie ist eine berechnete Messstelle, die diesem Prozess zugeordnet ist.',
      );
      await expect(page.getByTestId('prozess-summe')).toHaveCount(1);
      const m = await messe(page, 'prozesse');
      expect(m.reiter).toEqual(['Liste', 'Kostenstellen', 'Prozesse']);
      ohneQuerlauf(m, 'prozesse', breite);
      await ablegen(page, 'prozesse', breite, m);

      // Die Reiter halten die Adresse: Kostenstellen im selben Zeitraum, dann die Liste — das Register von heute.
      await page.getByRole('tab', { name: 'Kostenstellen', exact: true }).click();
      await expect(page.getByTestId('kostenstellen')).toBeVisible();
      await expect(page).toHaveURL(/#\/portfolio\/messstellen\?reiter=kostenstellen&periode=monat&am=2026-10-01$/);
      await page.getByRole('tab', { name: 'Liste', exact: true }).click();
      await expect(page.getByTestId('messstellen')).toBeVisible();
      await expect(page).toHaveURL(/#\/portfolio\/messstellen$/);
      expect(fehler).toEqual([]);
    });

    test('Bestand: ohne Kostenstelle und ohne Prozess gibt es keine Reiter — das Register steht wie zuvor', async ({ page }) => {
      const fehler: string[] = [];
      await oeffne(page, 'ansicht=messstellen&organisation=leer', breite, fehler, 'messstellen');
      await expect(page.locator('[role="tablist"][aria-label="Reiter der Messstellen"]')).toHaveCount(0);
      await expect(page.getByTestId('messstellen-organisation')).toHaveCount(0);
      expect(fehler).toEqual([]);
    });
  });
}
