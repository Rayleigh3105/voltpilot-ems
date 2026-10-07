import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Die Seite einer Kennzahl ohne Reiter und die Bezugsbasis eine Ebene tiefer (Konzept Auswerten a1 §6.5, §6.6, §6.12;
 * PR2) bei 375 px und 1440 px auf der Bühne `e2e/kennzahl-seite.html` - die ECHTE `KennzahlenPage` in der Welt des
 * Konzepts zur Bühnen-Uhr 30.04.2029 (`src/test/kennzahlSeiteFixtures.ts`).
 *
 * Fälle: Antwort zuerst mit Verlässlichkeit, Kacheln, Energieziel auf der Skala und dem Fazit · die Grafik als
 * Tippziel: Antippen und mit dem Finger ziehen wechselt die Infozeile, am Rechner die Pfeiltasten · ohne Bezugsbasis
 * das Vorjahr · noch kein Vergleich · die Ebene der Bezugsbasis mit Fassungen und Überprüfung.
 *
 * GEMESSEN: Querlauf des Dokuments und überstehende Elemente; die Grafiken bleiben in ihrer Karte. Mit
 * `KENNZAHL_SEITE_BILDER=<Ordner>` legt der Lauf je Fall ein Bild ab. Die Spec importiert keine Fixtures.
 */

const BILDER = process.env.KENNZAHL_SEITE_BILDER;
const BUEHNEN_UHR = new Date('2029-04-30T08:00:00Z');
const NB = String.fromCharCode(160);

async function oeffne(page: Page, query: string, breite: number) {
  await page.clock.setFixedTime(BUEHNEN_UHR);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/kennzahl-seite.html?${query}`);
  await page.evaluate(() => document.fonts.ready);
}

async function querlauf(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const breite = doc.clientWidth;
    const ueberstehend = [...document.querySelectorAll<HTMLElement>('.vp-main *')]
      .filter((e) => e.offsetParent !== null)
      .filter((e) => e.getBoundingClientRect().right > breite + 0.5)
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`);
    // Jede Grafik bleibt in ihrer Karte - auch die Beschriftungen als HTML.
    const ausDerKarte = [...document.querySelectorAll<HTMLElement>('.vp-graf, .vp-skala')]
      .filter((g) => {
        const k = g.closest('.vp-kzs-karte')!.getBoundingClientRect();
        const r = g.getBoundingClientRect();
        return r.left < k.left - 0.5 || r.right > k.right + 0.5;
      })
      .map((g) => g.className);
    return { dokument: doc.scrollWidth - doc.clientWidth, ueberstehend: [...new Set(ueberstehend)], ausDerKarte };
  });
}

async function ohneQuerlauf(page: Page) {
  expect(await querlauf(page)).toEqual({ dokument: 0, ueberstehend: [], ausDerKarte: [] });
}

async function bild(page: Page, name: string) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  await page.screenshot({ path: join(BILDER, `${name}.png`), fullPage: true });
}

for (const breite of [375, 1440]) {
  test.describe(`Seite einer Kennzahl — ${breite} px`, () => {
    test('Woraus gerechnet mit einem Modell (Review r3, BB-0001 F2): kein „aus der Bezugsbasis mal“, die Bedingung und das Modell', async ({ page }) => {
      await oeffne(page, 'kz=4&methode=modell', breite);
      const erwartet = page.getByTestId('kennzahl-erwartet');
      await expect(erwartet).toHaveText(`Erwartet bei 306.000${NB}kg Produktionsmenge nach dem Modell der Bezugsbasis: 86.812${NB}kWh.`);
      await expect(erwartet).not.toContainText(' mal ');
      await erwartet.scrollIntoViewIfNeeded();
      await ohneQuerlauf(page);
      await bild(page, `woraus-modell-${breite}`);
    });

    test('Antwort zuerst: Satz, Verlässlichkeit, Kachel, Energieziel, Grafik mit Fazit, Rechenweg', async ({ page }) => {
      await oeffne(page, 'kz=4', breite);
      await expect(page.getByTestId('kennzahl-antwort')).toContainText(
        `Im März 2029 brauchte der Prozess Spritzguss 2,2${NB}% mehr Energie, als die Bezugsbasis bei 306.000${NB}kg Produktionsmenge erwarten ließ.`,
      );
      await expect(page.getByTestId('kennzahl-vertrauen')).toContainText('Vorsicht beim Lesen: Die Bezugsbasis stammt aus einem einzigen Monat (Oktober 2026)');
      await expect(page.getByTestId('kennzahl-kacheln')).toContainText('über der Bezugsbasis');
      await expect(page.getByTestId('kennzahl-energieziel')).toContainText(`Stand nach 1 von 10 Monaten: 2,2${NB}% mehr`);
      await expect(page.getByTestId('grafik-infozeile')).toContainText('März 2029');
      await expect(page.getByTestId('kennzahl-fazit')).toContainText('10 von 12 Monaten über der Bezugsbasis, 2 im Rahmen.');
      await expect(page.getByTestId('kennzahl-erwartet')).toHaveText(`Erwartet: 0,2837 kWh je kg aus der Bezugsbasis mal 306.000${NB}kg = 86.812${NB}kWh.`);
      // Am Handy die Kacheln „Gemessen“ und „Erwartet“; am Rechner „Zusammengezählt“ und die Tabelle mit sechs Spalten.
      if (breite < 720) {
        await expect(page.getByTestId('kachel-gemessen')).toContainText(`1.928${NB}kWh mehr als erwartet`);
        await expect(page.getByTestId('kennzahl-zusammen')).toHaveCount(0);
      } else {
        await expect(page.getByTestId('kennzahl-zusammen')).toBeVisible();
        await expect(page.getByTestId('kennzahl-werte').getByRole('columnheader')).toHaveCount(6);
      }
      await ohneQuerlauf(page);
      await bild(page, `seite-${breite}`);
    });

    test('die Grafik: Antippen und Ziehen wechseln den Monat der Infozeile; nichts legt sich über die Säulen', async ({ page }) => {
      await oeffne(page, 'kz=4', breite);
      const grafik = page.getByRole('slider', { name: /Im März 2029 brauchte/ });
      const info = page.getByTestId('grafik-infozeile');
      await expect(info).toContainText('März 2029');
      await grafik.scrollIntoViewIfNeeded();
      const flaeche = (await grafik.locator('.vp-graf-p').boundingBox())!;
      // Antippen auf den ersten Monat, dann mit dem Finger (gedrückt) bis zum siebten ziehen.
      await page.mouse.move(flaeche.x + flaeche.width / 24, flaeche.y + flaeche.height / 2);
      await page.mouse.down();
      await expect(info).toContainText('April 2028');
      await page.mouse.move(flaeche.x + (flaeche.width * 13) / 24, flaeche.y + flaeche.height / 2, { steps: 6 });
      await expect(info).toContainText('Oktober 2028');
      await page.mouse.up();
      await expect(info).toContainText(`89.860${NB}kWh`);
      await expect(page.getByTestId('kennzahl-herkunft')).toContainText('Oktober 2028:');
      if (breite >= 720) {
        await grafik.focus();
        await page.keyboard.press('ArrowRight');
        await expect(info).toContainText('November 2028');
        await expect(grafik).toHaveAttribute('aria-valuenow', '8');
      }
      await ohneQuerlauf(page);
    });

    test('ohne Bezugsbasis: das Vorjahr, keine Urteilsfarbe, Säulen mit Vorjahrespunkt', async ({ page }) => {
      await oeffne(page, 'kz=24', breite);
      await expect(page.getByTestId('kennzahl-antwort')).toContainText(`Im März 2029 lag das Gebäude Halle 1 bei 20,64 kWh je m² - genauso viel wie im März 2028.`);
      await expect(page.getByTestId('kennzahl-vertrauen')).toContainText('Ohne Bezugsbasis vergleicht VoltPilot nur mit dem Vorjahr');
      await expect(page.getByTestId('kennzahl-kacheln')).toHaveCount(0);
      await expect(page.locator('.vp-graf-vorjahr')).toHaveCount(12);
      await expect(page.locator('.vp-graf-s.is-schlechter, .vp-graf-s.is-besser')).toHaveCount(0);
      await ohneQuerlauf(page);
      await bild(page, `ohne-basis-${breite}`);
    });

    test('noch kein Vergleich: ein Satz mit Datum statt zwölf leerer Säulen', async ({ page }) => {
      await oeffne(page, 'kz=4&lage=noch_kein_vergleich', breite);
      await expect(page.getByTestId('kennzahl-vertrauen')).toContainText('Die Bezugsbasis gilt erst ab Mai 2029');
      await expect(page.getByTestId('kennzahl-kacheln')).toContainText('Vergleich ab Juni 2029');
      await expect(page.locator('.vp-graf-leer')).toHaveCount(0);
      await ohneQuerlauf(page);
    });

    test('die Ebene der Bezugsbasis: Antwort, „vorläufig“, Fassungen als Datumsblöcke, Überprüfung - und zurück', async ({ page }) => {
      await oeffne(page, 'kz=4', breite);
      await page.getByTestId('kennzahl-vertrauen').getByRole('button', { name: 'Bezugsbasis ansehen' }).click();
      const ebene = page.getByTestId('bezugsbasis-ebene');
      await expect(ebene.getByRole('heading', { level: 1 })).toHaveText('Bezugsbasis BB-0001');
      await expect(page.getByTestId('bezugsbasis-status')).toHaveText('Gilt seit 01.11.2027nächste Überprüfung bis 30.04.2030');
      await expect(page.getByTestId('bezugsbasis-antwort')).toContainText('VoltPilot erwartet 0,2837 kWh je kg - so viel wie im Oktober 2026.');
      await expect(page.getByTestId('bezugsbasis-fassung-2')).toContainText('Fassung 2 · gilt');
      await expect(page.getByTestId('bezugsbasis-fassung-1')).toContainText('Fassung 1 · abgelöst');
      await expect(page.getByTestId('bezugsbasis-ueberpruefung')).toContainText('Zuletzt bestätigt am 30.04.2029. Ist sie noch die richtige Messlatte?');
      await ohneQuerlauf(page);
      await bild(page, `ebene-${breite}`);
      await page.getByRole('button', { name: 'Stromeinsatz Spritzguss je kg' }).click();
      await expect(page.getByTestId('kennzahl-antwort')).toBeVisible();
    });
  });
}
