import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * „Unternehmen › Bewertung“ (UEMS AP-16 IP-6, Meilenstein M1) bei 375 px und 1440 px auf der eigenen Bühne
 * `e2e/bewertung.html` — die ECHTE Schale mit der ECHTEN Leiste und den ECHTEN Reitern, die Routen gespielt aus dem
 * Referenzunternehmen (`src/test/bewertungFixtures.ts`).
 *
 * Fälle: leerer Zustand (R11), Umfang festlegen (U1, Ausschluss nur mit Begründung), Anlegen EE-1 Spritzguss durch
 * Ines Kaltenbach (R1: Prozess-Picker mit Vorschlägen, Verantwortlicher aus den Benutzern, Einflussgröße), die volle
 * Liste EE-1 … EE-7 mit der gesperrten Wahl „läuft bereits“ (B1), und Peter Hollerbach, der sieht, aber nicht darf (R14).
 *
 * GEMESSEN: Querlauf des Dokuments, überstehende Elemente, die Kacheln der Leiste (375) und die sichtbaren Reiter (1440).
 * Mit `BEWERTUNG_BILDER=<Ordner>` legt der Lauf je Fall ein Bild ab — die Vorschau. Die Spec importiert keine Fixtures.
 */

const BILDER = process.env.BEWERTUNG_BILDER;
const AM_04_11 = new Date('2026-11-04T09:00:00Z');
const AM_20_11 = new Date('2026-11-20T09:00:00Z');
const LEISTE = ['Übersicht', 'Standorte', 'Messstellen', 'Bezugsgrößen', 'Kennzahlen', 'Berichte', 'Bewertung'];
const REITER = ['Übersicht', 'Standorte', 'Messstellen', 'Bezugsgrößen', 'Kennzahlen', 'Berichte', 'Bewertung', 'Messwerte'];
const GRENZE =
  'VoltPilot unterstützt Ihr Energiemanagement mit Messung, Kennzahlen und Berichten. Eine Aussage zur Konformität mit einer Norm ist damit nicht verbunden.';
const LEER = 'Noch keine Energieeinsätze. Legen Sie fest, welche Prozesse Energie einsetzen — die Rangliste entsteht aus den Messwerten.';

async function oeffne(page: Page, query: string, breite: number, jetzt: Date) {
  await page.clock.setFixedTime(jetzt);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/bewertung.html?${query}`);
  await expect(page.locator('.vp-topbar').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
}

async function messe(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const breite = doc.clientWidth;
    const sichtbar = (e: Element) => (e as HTMLElement).offsetParent !== null || getComputedStyle(e).position === 'fixed';
    const bar = document.querySelector<HTMLElement>('.vp-bottombar');
    const leisteSichtbar = bar !== null && getComputedStyle(bar).display !== 'none';
    const ueberstehend = [...document.querySelectorAll<HTMLElement>('.vp-main *, .vp-modal *')]
      .filter((e) => sichtbar(e) && !e.closest('.vp-bereich-tabs'))
      .filter((e) => e.getBoundingClientRect().right > breite + 0.5)
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`);
    const reiter = (aktiv: boolean) =>
      [...document.querySelectorAll<HTMLElement>(`[role="tablist"] [role="tab"]${aktiv ? '[aria-selected="true"]' : ''}`)]
        .filter((t) => sichtbar(t))
        .map((t) => (t.textContent ?? '').trim());
    return {
      route: document.body.dataset.route ?? null,
      dokument: doc.scrollWidth - doc.clientWidth,
      ueberstehend: [...new Set(ueberstehend)],
      leiste: leisteSichtbar ? [...bar!.querySelectorAll('.vp-bottombar-item .lbl')].map((l) => l.textContent ?? '') : null,
      leisteAktiv: leisteSichtbar ? bar!.querySelector('[aria-current="page"] .lbl')?.textContent ?? null : null,
      reiter: reiter(false),
      reiterAktiv: reiter(true),
      karten: [...document.querySelectorAll('[data-testid="einsatz-karte"]')].map((k) => (k.textContent ?? '').trim()),
    };
  });
}

function ohneQuerlauf(m: Awaited<ReturnType<typeof messe>>, fall: string) {
  expect(m.dokument, `${fall}: Querlauf des Dokuments`).toBe(0);
  expect(m.ueberstehend, `${fall}: überstehende Elemente`).toEqual([]);
}

async function ablegen(page: Page, name: string, ganz = false) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  const path = join(BILDER, `${name}.png`);
  const vp = page.viewportSize();
  // Am Telefon stünde die feste Leiste in einem Vollseitenbild mitten im Inhalt: dort ein hohes Fenster statt `fullPage`.
  if (ganz && vp && vp.width < 720) {
    const hoehe = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: vp.width, height: Math.max(vp.height, hoehe) });
    await page.screenshot({ path });
    await page.setViewportSize(vp);
    return;
  }
  await page.screenshot({ path, fullPage: ganz });
}

async function listeVon(page: Page, feld: Locator): Promise<Locator> {
  await feld.click();
  const id = await feld.getAttribute('id');
  return id ? page.locator(`[id="${id}-liste"]`) : page.locator('body');
}

const picker = (page: Page, name: string) => page.locator('.vp-modal').getByRole('combobox', { name, exact: true });

async function waehle(page: Page, feld: string, option: RegExp) {
  await (await listeVon(page, picker(page, feld))).getByRole('option', { name: option }).click();
}

for (const breite of [375, 1440]) {
  test.describe(`Bewertung bei ${breite} px`, () => {
    test('leerer Zustand (R11): Satz, Vorschlag des Umfangs, Grenz-Satz — die Welt steht in Leiste bzw. Reitern', async ({ page }) => {
      await oeffne(page, 'stand=leer', breite, AM_04_11);
      await expect(page.getByTestId('bewertung-leer')).toHaveText(LEER);
      await expect(page.getByTestId('umfang-fassung')).toHaveText('Noch nicht festgelegt — Vorschlag: alle Standorte, Träger Strom.');
      await expect(page.getByTestId('umfang-anlagen')).toHaveText('am 04.11.2026 im Umfang: 3 Anlagen');
      await expect(page.getByTestId('bewertung-grenze')).toHaveText(GRENZE);
      await expect(page.getByTestId('einsatz-karte')).toHaveCount(0);
      const m = await messe(page);
      ohneQuerlauf(m, `leer-${breite}`);
      expect(m.route).toBe('#/portfolio/bewertung');
      if (breite < 720) {
        expect(m.leiste).toEqual(LEISTE);
        expect(m.leisteAktiv).toBe('Bewertung');
      } else {
        expect(m.reiter).toEqual(REITER);
        expect(m.reiterAktiv).toEqual(['Bewertung']);
      }
      await ablegen(page, `leer-${breite}`, true);
    });

    test('Umfang festlegen (U1): Gas im Umfang ohne Anteil, Ausschluss nur mit Begründung, Speichern = Fassung 1', async ({ page }) => {
      await oeffne(page, 'stand=leer', breite, AM_04_11);
      await page.getByTestId('umfang-knopf').click();
      const dialog = page.getByTestId('umfang-dialog');
      await expect(dialog).toBeVisible();
      await dialog.getByRole('checkbox', { name: /^Gas/ }).check();
      await ablegen(page, `umfang-${breite}`);
      ohneQuerlauf(await messe(page), `umfang-${breite}`);
      await dialog.getByRole('button', { name: 'Ausschluss hinzufügen' }).click();
      await page.getByTestId('umfang-speichern').click();
      await expect(dialog.getByText('Bitte wählen Sie, was ausgeschlossen wird.')).toBeVisible();
      await ablegen(page, `umfang-ausschluss-${breite}`);
      await dialog.getByRole('button', { name: 'Entfernen' }).click();
      await page.getByTestId('umfang-speichern').click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId('umfang-fassung')).toHaveText('Fassung 1 · gültig ab 04.11.2026');
      await expect(page.getByTestId('bewertung-umfang')).toContainText('Gas (im Umfang, ohne Anteil)');
      await expect(page.getByTestId('umfang-knopf')).toHaveText('Umfang ändern');
    });

    test('Anlegen (R1): Ines legt EE-1 Spritzguss an — Vorschlag, Verantwortlicher, Einflussgröße; die Seite zeigt Messstellen und Protokoll', async ({ page }) => {
      await oeffne(page, 'stand=leer', breite, AM_04_11);
      await page.getByTestId('einsatz-anlegen-knopf').click();
      const dialog = page.getByTestId('einsatz-anlegen');
      await expect(picker(page, 'Prozess')).toBeVisible();
      const prozesse = await listeVon(page, picker(page, 'Prozess'));
      await expect(prozesse.getByText('Vorschlag — noch ohne Energieeinsatz')).toBeVisible();
      await prozesse.getByRole('option', { name: /^Spritzguss/ }).click();
      await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Spritzguss');
      await dialog.getByLabel('Verbraucher').fill('Spritzgussmaschinen SG01–SG10');
      await waehle(page, 'Verantwortlich', /^Murat Demirci/);
      await dialog.getByTestId('einfluss-plus').click();
      await waehle(page, 'Bezugsgröße', /^Produktionsmenge Spritzguss/);
      await ablegen(page, `anlegen-${breite}`);
      ohneQuerlauf(await messe(page), `anlegen-${breite}`);
      await page.getByTestId('einsatz-anlegen-senden').click();

      await expect(page.getByTestId('einsatz-seite')).toBeVisible();
      await expect(page.locator('.vp-bw-kopf h1')).toHaveText('Spritzguss');
      await expect(page.getByTestId('einsatz-prozess')).toHaveText('P-1 Spritzguss');
      await expect(page.getByTestId('einsatz-verantwortlich')).toHaveText('Murat Demirci');
      await expect(page.getByTestId('einsatz-einfluesse-liste')).toHaveText('Produktion: Produktionsmenge Spritzguss (BZ-1)');
      await expect(page.getByTestId('einsatz-messstellen').locator('li')).toHaveCount(3);
      await expect(page.getByTestId('einsatz-protokoll')).toContainText('angelegt · Ines Kaltenbach');
      const m = await messe(page);
      ohneQuerlauf(m, `einsatz-${breite}`);
      expect(m.route).toMatch(/^#\/portfolio\/bewertung\/ee000000-/);
      await ablegen(page, `einsatz-${breite}`, true);

      await page.getByRole('button', { name: 'Alle Energieeinsätze' }).click();
      await expect(page.getByTestId('einsatz-karte')).toHaveCount(1);
      await expect(page.getByTestId('bewertung-leer')).toHaveCount(0);
    });

    test('Liste (voll): EE-1 … EE-7, Gas mit „keine Werte“; ein zweiter Spritzguss-Einsatz für Strom ist gesperrt (B1)', async ({ page }) => {
      await oeffne(page, 'stand=voll', breite, AM_20_11);
      await expect(page.getByTestId('einsatz-karte')).toHaveCount(7);
      const m = await messe(page);
      ohneQuerlauf(m, `liste-${breite}`);
      expect(m.karten[6]).toContain('EE-7');
      expect(m.karten[6]).toContain('keine Werte');
      await ablegen(page, `liste-${breite}`, true);
      await page.getByTestId('einsatz-anlegen-knopf').click();
      const prozesse = await listeVon(page, picker(page, 'Prozess'));
      const spritzguss = prozesse.getByRole('option', { name: /^Spritzguss/ });
      await expect(spritzguss).toHaveAttribute('aria-disabled', 'true');
      await expect(prozesse).toContainText('läuft bereits: EE-1 Spritzguss');
    });

    test('Rangliste: Balken, K-Spalten, Rest-Zeile und weitere Träger (R2/R12)', async ({ page }) => {
      await oeffne(page, 'stand=voll', breite, AM_20_11);
      const rangliste = page.getByTestId('rangliste');
      await expect(rangliste).toContainText('Stromeinsatz Oktober 2026: 185.380');
      await expect(rangliste.locator('tbody tr')).toHaveCount(7);
      await expect(page.getByTestId('rang-EE-1')).toContainText('41,8 %');
      await expect(page.getByTestId('rang-EE-1')).toContainText('über Schwelle');
      await expect(page.getByTestId('rest-satz')).toContainText('59.640');
      await expect(page.getByTestId('weitere-traeger')).toContainText('1.240,0 m³');
      ohneQuerlauf(await messe(page), `rangliste-${breite}`);
      await ablegen(page, `rangliste-${breite}`, true);
    });

    test('Einstufen: Begründung Pflicht, Abweichung sichtbar und Vier-Augen wartet (R3/R17)', async ({ page }) => {
      await oeffne(page, 'stand=voll', breite, AM_20_11);
      await page.getByTestId('rang-EE-3').getByRole('button', { name: 'Einstufen' }).click();
      const dialog = page.getByTestId('einstufung-dialog');
      await expect(dialog).toContainText('Kriterien-Fassung 1');
      await expect(dialog).toContainText('Version 1');
      await dialog.getByRole('radio', { name: 'wesentlich', exact: true }).check();
      await expect(page.getByTestId('abweichung-hinweis')).toBeVisible();
      await page.getByTestId('abweichung-hinweis').scrollIntoViewIfNeeded();
      await ablegen(page, `einstufung-abweichung-${breite}`);
      await page.getByTestId('einstufung-speichern').click();
      await expect(dialog.getByRole('alert')).toContainText('ausdrücklich');
      await dialog.getByLabel('Begründung').fill('Querschnitt für Spritzguss und Montage; Leckageverluste werden geprüft.');
      await page.getByTestId('einstufung-speichern').click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId('rang-EE-3')).toContainText('Fassung 2');

      await oeffne(page, 'stand=voll&vieraugen=1', breite, AM_20_11);
      await page.getByTestId('rang-EE-2').getByRole('button', { name: 'Einstufen' }).click();
      const vier = page.getByTestId('einstufung-dialog');
      await vier.getByRole('radio', { name: 'wesentlich', exact: true }).check();
      await vier.getByLabel('Begründung').fill('Montage wird wegen des erwarteten Jahresverbrauchs wesentlich eingestuft.');
      await page.getByTestId('einstufung-speichern').click();
      await expect(page.getByTestId('rang-EE-2')).toContainText('vorgeschlagen, wartet auf Bestätigung');
      await ablegen(page, `vieraugen-${breite}`, true);
    });

    test('Kriterien ändern: acht Zeilen, Begründung Pflicht, neue Fassung gilt für Vorschläge (R15)', async ({ page }) => {
      await oeffne(page, 'stand=voll', breite, AM_20_11);
      await page.getByTestId('kriterien-oeffnen').click();
      const dialog = page.getByTestId('kriterien-dialog');
      await expect(dialog.locator('input[type="number"]')).toHaveCount(8);
      await dialog.getByLabel('K1 · Anteil am Stromeinsatz').fill('5');
      await page.getByTestId('kriterien-speichern').click();
      await expect(dialog.getByRole('alert')).toContainText('Begründung');
      await dialog.getByLabel('Begründung').fill('Bis die Abdeckung reicht, werden Einsätze ab fünf Prozent geprüft.');
      await ablegen(page, `kriterien-${breite}`);
      await page.getByTestId('kriterien-speichern').click();
      await expect(page.getByTestId('kriterien-hinweis')).toContainText('Kriterien-Fassung 2');
      await expect(page.getByTestId('rang-EE-2')).toContainText('über Schwelle');
    });

    test('Historie: Fassungen bleiben auf der Einsatzseite lesbar (R13)', async ({ page }) => {
      await oeffne(page, 'stand=voll&ee=EE-3&historie=r13', breite, AM_20_11);
      await expect(page.getByTestId('einstufung-historie')).toContainText('Fassung 3 · nicht wesentlich');
      await expect(page.getByTestId('einstufung-historie')).toContainText('Fassung 1 · wesentlich');
      await expect(page.getByTestId('einstufung-historie')).toContainText('Grundlage 2026-10');
      ohneQuerlauf(await messe(page), `historie-${breite}`);
      await ablegen(page, `historie-${breite}`, true);
    });

    test('Peter Hollerbach (Bearbeiter) sieht die Einsätze, darf aber nicht anlegen oder ändern (R14)', async ({ page }) => {
      await oeffne(page, 'stand=voll&person=PH', breite, AM_20_11);
      await expect(page.getByTestId('einsatz-karte').first()).toBeVisible();
      await expect(page.getByTestId('bewertung-nur-lesen')).toBeVisible();
      await expect(page.getByTestId('einsatz-anlegen-knopf')).toHaveCount(0);
      await expect(page.getByTestId('umfang-knopf')).toHaveCount(0);
      await expect(page.getByTestId('kriterien-oeffnen')).toHaveCount(0);
      await expect(page.getByTestId('rang-EE-1').getByRole('button', { name: 'Einstufen' })).toHaveCount(0);
      await page.getByTestId('einsatz-karte').nth(1).click();
      await expect(page.getByTestId('einsatz-verantwortlich')).toHaveText('Peter Hollerbach');
      await expect(page.getByTestId('einsatz-bearbeiten-knopf')).toHaveCount(0);
      await expect(page.getByTestId('einsatz-beenden-knopf')).toHaveCount(0);
      ohneQuerlauf(await messe(page), `lesend-${breite}`);
    });
  });
}
