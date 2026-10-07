import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * „Prüfung von außen“ im Überblick von Nachweisen (Konzept n1, Runde 2, Entscheide 6, 7 und 8, PR 6) bei 375 px und
 * 1440 px auf der Bühne von IP-9 `e2e/energiemanagement.html` mit `&mp=…` - die ECHTE Schale, die ECHTEN Reiter, die
 * Mappen-Routen und das Anlegen eines Zugangs gespielt von `mappeBuehne` (MOCK; Rechte, Mandant, Frist und Protokoll
 * prüft die Route selbst in `EnergiemanagementMappeApiTest`).
 *
 * Fälle: Kundenadministrator stellt Unterlagen zusammen (am Telefon zwei Schritte, am Rechner ein Dialog mit dem Kasten
 * „Die Mappe · Grenze“), die Seite der Mappe mit Öffnen, Speichern, CSV und Teilen (am Telefon das Teilen-Menü, am
 * Rechner „Link kopiert“), Einsicht geben mit Frist ab dem Tag der Route · „Einsicht“ sieht nur „Mappen“, liest und lädt,
 * gibt keine Einsicht weiter · nach 30 Tagen „Nicht mehr abrufbar“.
 *
 * GEMESSEN: Querlauf des Dokuments und überstehende Elemente je Schritt. Mit `ENERGIEMANAGEMENT_BILDER=<Ordner>` legt der
 * Lauf je Schritt ein Bild ab. Die Spec importiert keine Fixtures.
 */

const BILDER = process.env.ENERGIEMANAGEMENT_BILDER;
/** Die Uhr der Route: 30.04.2029, 10:20 (die Bühne spielt die Mappen auf dieser Uhr). */
const AM_30_04_2029 = new Date('2029-04-30T10:20:00+02:00');
const IDS = { abrufbar: '6a990000-0000-4000-8000-000000000001', abgelaufen: '6a990000-0000-4000-8000-000000000002' };
const GRUPPEN = [
  'grundlagen', 'verantwortung', 'risiken_chancen', 'kompetenz_kommunikation', 'betrieb_auslegung_beschaffung', 'bewertung_messplanung',
  'kennzahlen_bezugsbasen', 'ziele_massnahmen_abweichungen', 'audits_feststellungen', 'managementbewertung', 'berichte',
];

async function oeffne(page: Page, query: string, breite: number) {
  await page.clock.setFixedTime(AM_30_04_2029);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/energiemanagement.html?${query}`);
  await expect(page.locator('.vp-topbar').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
}

async function ohneQuerlauf(page: Page, fall: string) {
  const m = await page.evaluate(() => {
    const doc = document.documentElement;
    const breite = doc.clientWidth;
    const sichtbar = (e: Element) => (e as HTMLElement).offsetParent !== null || getComputedStyle(e).position === 'fixed';
    const ueberstehend = [...document.querySelectorAll<HTMLElement>('.vp-main *, .vp-modal *, .vp-bs-wrap *')]
      .filter((e) => sichtbar(e) && !e.closest('.vp-bereich-tabs'))
      .filter((e) => e.getBoundingClientRect().right > breite + 0.5)
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`);
    return { dokument: doc.scrollWidth - doc.clientWidth, ueberstehend: [...new Set(ueberstehend)] };
  });
  expect(m.dokument, `${fall}: Querlauf des Dokuments`).toBe(0);
  expect(m.ueberstehend, `${fall}: überstehende Elemente`).toEqual([]);
}

async function ablegen(page: Page, name: string) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  await page.screenshot({ path: join(BILDER, `${name}.png`) });
}

const blatt = (page: Page) => page.locator('.vp-bs-wrap, .vp-modal').last();
const gesendet = (page: Page) => page.evaluate(() => (window as unknown as { __mpGesendet: { route: string; body?: unknown }[] }).__mpGesendet);

for (const breite of [375, 1440]) {
  const telefon = breite < 720;
  test.describe(`Nachweisen › Prüfung von außen bei ${breite} px`, () => {
    test('Kundenadministrator: Unterlagen zusammenstellen, Mappe abrufen und teilen, Einsicht geben', async ({ page, context }) => {
      if (telefon) {
        // Das Teilen-Menü des Telefons (Web Share API): die Bühne merkt sich, was geteilt wurde.
        await page.addInitScript(() => {
          const w = window as unknown as { __geteilt: unknown[] };
          w.__geteilt = [];
          Object.defineProperty(navigator, 'share', { value: async (d: unknown) => void w.__geteilt.push(d), configurable: true });
        });
      } else {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      }
      await oeffne(page, 'person=JW&lage=ahrenberg&mb=r13&mp=leer', breite);
      const aussen = page.getByTestId('ueberblick-aussen');
      await aussen.scrollIntoViewIfNeeded();
      await expect(aussen.getByRole('heading', { level: 2 })).toHaveText('Prüfung von außen');
      await expect(aussen.getByRole('button')).toHaveText(['Unterlagen zusammenstellen', 'Einsicht geben']);
      await expect(page.getByTestId('aussen-mappen')).toHaveCount(0);
      await ohneQuerlauf(page, 'Überblick');
      await ablegen(page, `mp-ueberblick-${breite}`);

      // Unterlagen zusammenstellen: Audit von außen, 12 Monate bis zum Tag der Route, alles hinein.
      await page.getByTestId('aussen-mappe').click();
      await expect(blatt(page)).toContainText('Unterlagen zusammenstellen');
      await expect(page.getByTestId('mappe-anlass').getByRole('radio', { name: /Audit von außen/ })).toBeChecked();
      await expect(page.getByTestId('mappe-zeitraum').getByRole('radio', { name: '12 Monate' })).toBeChecked();
      if (telefon) {
        await expect(blatt(page)).toContainText('Schritt 1 von 3');
        await expect(blatt(page)).toContainText('meist 6 Wochen vorher');
        await ohneQuerlauf(page, 'Mappe Schritt 1');
        await ablegen(page, `mp-schritt-1-${breite}`);
        await page.getByTestId('mappe-weiter').click();
        await expect(blatt(page)).toContainText('Schritt 2 von 3');
      } else {
        await expect(blatt(page)).toContainText('seit 01.05.2028');
        await expect(blatt(page).getByRole('complementary', { name: 'Die Mappe' })).toContainText('Ob es genügt, beurteilt, wer Sie prüft.');
        // Die drei Antwort-Karten brechen höchstens zweizeilig (Mock r2d-dlg-mp).
        const zeilen = await page.getByTestId('mappe-anlass').locator('label > b').evaluateAll((es) =>
          es.map((e) => Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight))),
        );
        expect(zeilen).toHaveLength(3);
        expect(Math.max(...zeilen)).toBeLessThanOrEqual(2);
      }
      await expect(page.getByTestId('mappe-inhalt').getByRole('checkbox')).toHaveCount(4);
      await expect(page.getByTestId('mappe-offen')).toContainText('Teile offen');
      await ohneQuerlauf(page, 'Mappe Inhalt');
      await ablegen(page, `mp-inhalt-${breite}`);
      await page.getByTestId('mappe-erstellen').click();

      // Die Seite der Mappe (Mock MP3).
      await expect(page).toHaveURL(/#\/portfolio\/energiemanagement\/mappen\/6a990000-0000-4000-8000-000000000100$/);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Unterlagen für das Audit');
      await expect(page.getByTestId('mappe-kopf')).toContainText('30.04.2029, 10:20');
      await expect(page.getByTestId('mappe-fertig')).toHaveText('Die Mappe ist fertigPDF mit Inhaltsverzeichnis');
      await expect(page.getByTestId('mappe-oeffnen')).toContainText('Nachweise Ahrenberg, 30.04.2029');
      await expect(page.getByTestId('mappe-oeffnen')).toContainText('PDF · CSV · noch 30 Tage');
      await expect(page.getByTestId('mappe-zeitraum-zeile')).toContainText('01.05.2028 bis 30.04.2029');
      const [anlegen] = (await gesendet(page)).filter((g) => g.route === 'POST /mappen');
      expect(anlegen.body).toEqual({ anlass: 'audit_von_aussen', von: '2028-05-01', gruppen: GRUPPEN, offen: expect.any(Array) });
      await ohneQuerlauf(page, 'Seite der Mappe');
      await ablegen(page, `mp-seite-${breite}`);

      // Review P6-4: „Öffnen“ lädt das PDF (kein Fenster mit einem Blob-Dokument unter der Portal-CSP).
      const geoeffnet = page.waitForEvent('download');
      await page.getByTestId('mappe-oeffnen').click();
      expect((await geoeffnet).suggestedFilename()).toBe('nachweise-2029-04-30.pdf');
      expect(page.context().pages()).toHaveLength(1);
      const pdf = page.waitForEvent('download');
      await page.getByTestId('mappe-speichern').click();
      expect((await pdf).suggestedFilename()).toBe('nachweise-2029-04-30.pdf');
      const csv = page.waitForEvent('download');
      await page.getByTestId('mappe-csv').click();
      expect((await csv).suggestedFilename()).toBe('nachweise-2029-04-30.csv');
      await expect(page.getByTestId('mappe-abruf')).toHaveText('Abgerufen, der Abruf ist protokolliert.');
      expect((await gesendet(page)).map((g) => g.route).filter((r) => r.startsWith('GET'))).toEqual([
        'GET /mappen/6a990000-0000-4000-8000-000000000100/pdf',
        'GET /mappen/6a990000-0000-4000-8000-000000000100/pdf',
        'GET /mappen/6a990000-0000-4000-8000-000000000100/csv',
      ]);

      // Teilen: ein Link in den Kundenbereich, nie die Datei.
      await page.getByTestId('weitergeben-teilen').click();
      if (telefon) {
        await expect.poll(() => page.evaluate(() => (window as unknown as { __geteilt: { title: string; url: string }[] }).__geteilt)).toEqual([
          { title: 'Unterlagen für das Audit', url: expect.stringMatching(/#\/portfolio\/energiemanagement\/mappen\/6a990000-0000-4000-8000-000000000100$/) },
        ]);
      } else {
        await expect(page.getByTestId('mappe-weitergeben')).toContainText('Link kopiert');
        expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/#\/portfolio\/energiemanagement\/mappen\/6a990000-0000-4000-8000-000000000100$/);
      }

      // Einsicht geben: bis zum 14. Tag nach dem Tag der Route, das Startpasswort einmal.
      await page.getByTestId('mappe-einsicht').click();
      await expect(blatt(page)).toContainText('Einsicht geben');
      await page.getByTestId('einsicht-name').fill('Petra Prüfer');
      await page.getByTestId('einsicht-email').fill('petra.pruefer@audit.example');
      // Review P6-3: der Umfang ohne Aufklappen - alle Daten aller Standorte, nur lesend, bis wann.
      await expect(page.getByTestId('einsicht-umfang')).toHaveText('Sieht alle Daten aller Standorte, nur lesend, bis 14.05.2029.');
      await ohneQuerlauf(page, 'Einsicht geben');
      await ablegen(page, `mp-einsicht-${breite}`);
      await page.getByTestId('einsicht-anlegen').click();
      await expect(page.getByTestId('einsicht-angelegt')).toHaveText('Zugang angelegt· bis 14.05.2029');
      await expect(page.getByTestId('einsicht-passwort')).toHaveText('Buehne-Start-7Kq2');
      expect((await gesendet(page)).find((g) => g.route === 'POST /benutzer')?.body).toEqual({
        username: 'petra.pruefer@audit.example', email: 'petra.pruefer@audit.example', vorname: 'Petra', nachname: 'Prüfer',
        rolle: 'einsicht', standorte: [], gueltig_bis: '2029-05-14',
      });
      await ohneQuerlauf(page, 'Zugang angelegt');
      await ablegen(page, `mp-einsicht-angelegt-${breite}`);
      await page.getByTestId('einsicht-fertig').click();
      await expect(page.locator('.vp-bs-wrap, .vp-modal')).toHaveCount(0);

      // Zurück im Überblick: die Mappe steht unter „Mappen“.
      await page.getByTestId('mappe-kopf').getByRole('button', { name: /Überblick/ }).or(page.getByTestId('mappe-kopf').getByRole('link', { name: /Überblick/ })).click();
      await expect(page.getByTestId('aussen-mappen')).toContainText('1');
    });

    test('„Einsicht“ sieht nur die Mappen, liest und lädt, gibt keine Einsicht weiter', async ({ page }) => {
      await oeffne(page, 'person=RF&lage=ahrenberg&mb=r13&mp=r6', breite);
      const aussen = page.getByTestId('ueberblick-aussen');
      await aussen.scrollIntoViewIfNeeded();
      await expect(aussen.getByRole('button', { name: /Unterlagen zusammenstellen|Einsicht geben/ })).toHaveCount(0);
      // Die abgelaufene zählt nicht mit.
      await expect(page.getByTestId('aussen-mappen')).toContainText('Mappen');
      await expect(page.getByTestId('aussen-mappen')).toContainText('1');
      await page.getByTestId('aussen-mappen').click();
      await expect(blatt(page)).toContainText('Unterlagen für das Audit');
      await expect(blatt(page)).toContainText('noch 28 Tage');
      await ohneQuerlauf(page, 'Mappen');
      await ablegen(page, `mp-einsicht-mappen-${breite}`);
      await page.getByTestId(`aussen-mappe-${IDS.abrufbar}`).click();
      await expect(page).toHaveURL(new RegExp(`mappen/${IDS.abrufbar}$`));
      await expect(page.getByTestId('mappe-offen')).toHaveText('2 Teile als offen aufgeführt');
      await expect(page.getByTestId('mappe-einsicht')).toHaveCount(0);
      const pdf = page.waitForEvent('download');
      await page.getByTestId('mappe-speichern').click();
      expect((await pdf).suggestedFilename()).toBe('nachweise-2029-04-28.pdf');
      await ohneQuerlauf(page, 'Mappe als Einsicht');
    });

    test('nach 30 Tagen: „Nicht mehr abrufbar“, kein Abruf, „Neu zusammenstellen“', async ({ page }) => {
      await oeffne(page, 'person=JW&lage=ahrenberg&mp=r6&mappe=alt', breite);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Unterlagen für die Behörde');
      await expect(page.getByTestId('mappe-abgelaufen')).toContainText('Nicht mehr abrufbar');
      await expect(page.getByTestId('mappe-oeffnen')).toContainText('nicht mehr abrufbar');
      await expect(page.getByTestId('mappe-speichern')).toHaveCount(0);
      await expect(page.getByTestId('mappe-einsicht')).toHaveCount(0);
      await expect(page.getByTestId('mappe-zeitraum-zeile')).toContainText('alles bis 10.03.2029');
      await ohneQuerlauf(page, 'abgelaufen');
      await ablegen(page, `mp-abgelaufen-${breite}`);
      await page.getByTestId('mappe-neu').click();
      await expect(page.getByTestId('ueberblick-aussen')).toBeVisible();
    });
  });
}
