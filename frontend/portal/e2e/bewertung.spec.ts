import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { grenzHinweisZeigt } from './grenzHinweis';

/**
 * „Unternehmen › Bewertung“ (UEMS AP-16 IP-6, Meilenstein M1) bei 375 px und 1440 px auf der eigenen Bühne
 * `e2e/bewertung.html` — die ECHTE Schale mit der ECHTEN Leiste und den ECHTEN Reitern, die Routen gespielt aus dem
 * Referenzunternehmen (`src/test/bewertungFixtures.ts`).
 *
 * Fälle: leerer Zustand (R11), Umfang festlegen (U1, Ausschluss nur mit Begründung), Anlegen EE-1 Spritzguss durch
 * Ines Kaltenbach (R1: Prozess-Picker mit Vorschlägen, Verantwortlicher aus den Benutzern, Einflussgröße), das Ergebnis
 * (Konzept Auswerten a1 §6.7: Antwort, Kacheln, Bereiche nach der Einstufung, kein Kürzel), Einstufen am Bereich,
 * Kriterien ändern und - mit Vier-Augen - freigeben oder ablehnen (Befund 6), die gesperrte Wahl „läuft bereits“ (B1),
 * und Peter Hollerbach, der sieht, aber nicht darf (R14).
 *
 * GEMESSEN: Querlauf des Dokuments, überstehende Elemente, die Kacheln der Leiste (375) und die sichtbaren Reiter (1440).
 * Mit `BEWERTUNG_BILDER=<Ordner>` legt der Lauf je Fall ein Bild ab — die Vorschau. Die Spec importiert keine Fixtures.
 */

const BILDER = process.env.BEWERTUNG_BILDER;
const AM_04_11 = new Date('2026-11-04T09:00:00Z');
const AM_20_11 = new Date('2026-11-20T09:00:00Z');
// Die Leiste trägt am Unternehmen Gruppen (`ebenenNav.UNTERNEHMEN_GRUPPEN`); die Bewertung wohnt in „Auswerten“.
// K1/D2: fünf Gruppen nach Arbeitsfragen; die Berichte stehen in „Nachweisen“.
const LEISTE = ['Übersicht', 'Messen', 'Auswerten', 'Nachweisen'];
// N1: am Rechner stehen die Gruppen in der Seitenleiste; über der Seite nur die Reiter der offenen Gruppe „Auswerten“.
// Konzept Auswerten a1 (Richtungsfrage 1 = A): drei Fragen, drei Reiter.
const REITER = ['Verbrauch', 'Kennzahlen', 'Bewertung'];
const GRENZE =
  'VoltPilot unterstützt Ihr Energiemanagement mit Messung, Kennzahlen und Berichten. Eine Aussage zur Konformität mit einer Norm ist damit nicht verbunden.';
const LEER = 'Noch keine Bereiche festgelegt. Legen Sie fest, wofür Ihr Betrieb Energie einsetzt - dann zeigt VoltPilot hier die Verteilung.';
/** Konzept Auswerten a1 §10.10: auf der Seite kein Kürzel der Kriterien. */
const KUERZEL = /(^|[^\p{L}\p{N}])K[1-8]([^\p{L}\p{N}]|$)/u;

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
    // N1: die Einträge der Ebene in der Seitenleiste (am Telefon verborgen) — ohne die Frage des offenen Eintrags.
    const eintrag = (e: Element) =>
      (e.querySelector('.vp-nav-zwei > span:first-child') ?? e.querySelector('.vp-nav-lbl'))?.textContent?.trim() ?? '';
    const seite = [...document.querySelectorAll<HTMLElement>('.vp-ebenennav .vp-navitem')].filter((e) => sichtbar(e));
    return {
      route: document.body.dataset.route ?? null,
      dokument: doc.scrollWidth - doc.clientWidth,
      ueberstehend: [...new Set(ueberstehend)],
      leiste: leisteSichtbar ? [...bar!.querySelectorAll('.vp-bottombar-item .lbl')].map((l) => l.textContent ?? '') : null,
      leisteAktiv: leisteSichtbar ? bar!.querySelector('[aria-current="page"] .lbl')?.textContent ?? null : null,
      reiter: reiter(false),
      reiterAktiv: reiter(true),
      seite: seite.map(eintrag),
      seiteAktiv: seite.filter((e) => e.getAttribute('aria-current') === 'page').map(eintrag)[0] ?? null,
      karten: [...document.querySelectorAll('[data-testid^="bereich-EE-"]')].map((k) => (k.textContent ?? '').trim()),
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

/** „Energieeinsatz anlegen“: am Rechner der Rahmenknopf im Kopf, am Telefon im Menü ⋯ (Konzept Auswerten a1 §6.7). */
async function anlegenOeffnen(page: Page, breite: number) {
  if (breite >= 720) {
    await page.getByTestId('einsatz-anlegen-knopf').click();
    return;
  }
  await expect(page.getByTestId('einsatz-anlegen-knopf')).toBeHidden();
  await page.getByTestId('bewertung-menue').getByRole('button', { name: 'Weitere Aktionen' }).click();
  await page.getByRole('menuitem', { name: 'Energieeinsatz anlegen' }).click();
}

for (const breite of [375, 1440]) {
  test.describe(`Bewertung bei ${breite} px`, () => {
    test('leerer Zustand (R11): erst der Satz, dann der Knopf; Umfang als Vorschlag, Grenz-Satz am Fuß', async ({ page }) => {
      await oeffne(page, 'stand=leer', breite, AM_04_11);
      await expect(page.getByTestId('bewertung-leer')).toContainText(LEER);
      await expect(page.getByTestId('umfang-fassung')).toHaveText('noch nicht festgelegt - Vorschlag: alle Standorte, Strom');
      await expect(page.getByTestId('umfang-standorte')).toHaveText('Werk Ahrenberg (2 Anlagen) · Werk Lindach (1 Anlage)');
      await expect(page.getByTestId('bewertung-status')).toHaveText('Noch keine Bewertung festgestellt');
      await grenzHinweisZeigt(page, GRENZE);
      const m = await messe(page);
      expect(m.karten).toEqual([]);
      ohneQuerlauf(m, `leer-${breite}`);
      expect(m.route).toBe('#/portfolio/bewertung');
      if (breite < 720) {
        expect(m.leiste).toEqual(LEISTE);
        expect(m.leisteAktiv).toBe('Auswerten');
      } else {
        expect(m.seite).toEqual(LEISTE);
        expect(m.seiteAktiv).toBe('Auswerten');
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
      await expect(page.getByTestId('umfang-fassung')).toHaveText('seit 04.11.2026 · festgelegt von Ines Kaltenbach');
      await expect(page.getByTestId('umfang-traeger')).toHaveText('Strom mit Anteil · Gas ohne Anteil');
      await expect(page.getByTestId('bewertung-umfang')).toContainText('Gas hat keinen gemeinsamen Maßstab mit Strom und steht daneben.');
      await expect(page.getByTestId('umfang-knopf')).toHaveText('Ändern');
    });

    test('Anlegen (R1): Ines legt EE-1 Spritzguss an — Vorschlag, Verantwortlicher, Einflussgröße; die Seite zeigt Messstellen und Protokoll', async ({ page }) => {
      await oeffne(page, 'stand=leer', breite, AM_04_11);
      await anlegenOeffnen(page, breite);
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

      const seite = page.getByTestId('einsatz-seite');
      await expect(seite).toBeVisible();
      await expect(seite.getByRole('heading', { level: 1 })).toHaveText('Spritzguss');
      await expect(page.getByTestId('einsatz-prozess')).toHaveText('Prozess Spritzguss');
      await expect(page.getByTestId('einsatz-verantwortlich')).toHaveText('Murat Demirci');
      await expect(page.getByTestId('einsatz-einfluesse-liste')).toHaveText('Produktion: Produktionsmenge Spritzguss (BZ-1)');
      await expect(page.getByTestId('einsatz-messstellen').locator('li')).toHaveCount(3);
      const m = await messe(page);
      ohneQuerlauf(m, `einsatz-${breite}`);
      // Konzept Auswerten a1, Entscheid 10.1: die Seite eines Einsatzes wohnt unter „Verbrauch“.
      expect(m.route).toMatch(/^#\/portfolio\/verbrauch\/ee000000-/);
      await ablegen(page, `einsatz-${breite}`, true);
      // Das Änderungsprotokoll liegt im Menü ⋯.
      await page.getByTestId('einsatz-menue').getByRole('button', { name: 'Weitere Aktionen' }).click();
      await page.getByRole('menuitem', { name: 'Änderungsprotokoll' }).click();
      await expect(page.getByTestId('einsatz-protokoll')).toContainText('angelegt · Ines Kaltenbach');
      await page.keyboard.press('Escape');

      // Der Rückweg führt zu „Verbrauch“; die Bewertung ist der dritte Reiter von „Auswerten“.
      await seite.getByRole('button', { name: 'Verbrauch' }).click();
      await expect(page.getByTestId('verbrauch')).toBeVisible();
      await page.getByRole('tab', { name: 'Bewertung' }).click();
      await expect(page.getByTestId('bereich-EE-1')).toBeVisible();
      await expect(page.getByTestId('bewertung-antwort')).toContainText('Der Bereich ist noch nicht eingestuft.');
      await expect(page.getByTestId('bewertung-leer')).toHaveCount(0);
    });

    test('Ergebnis (§6.7): Antwort zuerst, Kacheln, Bereiche nach der Einstufung, Abweichung ohne Alarm - kein Kürzel', async ({ page }) => {
      await oeffne(page, 'stand=voll&bewertungsstand=nr2', breite, AM_20_11);
      const antwort = page.getByTestId('bewertung-antwort');
      await expect(antwort).toContainText('2 von 7 Bereichen sind wesentlich - zusammen 50 % des Stroms.');
      await expect(antwort).toContainText('Datengrundlage November 2025 bis Oktober 2026 · Strom aus 3 Anlagen · Gas ohne Anteil');
      // Die Zusatz-Sätze stehen nur am Rechner im Antwortsatz (am Telefon sagt es die Marke an der Reihe).
      const zusatz = antwort.getByText('Eine Einstufung weicht begründet vom Vorschlag ab.');
      if (breite < 720) await expect(zusatz).toBeHidden();
      else await expect(zusatz).toBeVisible();
      await expect(page.getByTestId('bewertung-status')).toContainText('Gilt · Stand Nr. 2 vom 17.11.2026');
      await expect(page.getByTestId('bewertung-vertrauen')).toHaveText('Vorläufig: die Datengrundlage umfasst 1 Monat; belastbar ist der Vorschlag ab 12 Monaten.');
      await expect(page.getByTestId('kachel-rest')).toContainText('32');
      await expect(page.getByTestId('kachel-rest')).toContainText('zu wenig');
      // Wie viel zugeordnet ist, sagt die Route mit einer Stelle — nie ein stilles „80 %“ neben „zu wenig“.
      await expect(page.getByTestId('kachel-rest')).toContainText('67,8 % zugeordnet, belastbar ab 80 %');
      if (breite < 720) await expect(page.getByTestId('kachel-anteil')).toBeHidden();
      else await expect(page.getByTestId('kachel-anteil')).toContainText('93.400 kWh in einem Monat');
      const wesentlich = page.getByTestId('bereiche-wesentlich');
      await expect(wesentlich.getByRole('link')).toHaveCount(2);
      await expect(page.getByTestId('bereich-EE-3')).toContainText('weicht vom Vorschlag ab');
      await expect(page.getByTestId('bereich-EE-3')).toContainText('Vorschlag „nicht wesentlich“ · eingestuft als wesentlich am 06.11.2026');
      await expect(page.getByTestId('bereiche-nicht_wesentlich').getByRole('link')).toHaveCount(5);
      await expect(page.getByTestId('bereich-EE-7')).toContainText('1.240,0 m³');
      await expect(page.getByText('Er braucht mindestens 10 % des Stroms.')).toBeVisible();
      // R16 zitiert Namen aus den Kundendaten („Kompressoren K1+K2“); geprüft wird der Text der Seite ohne diese Sätze.
      await expect(page.getByTestId('bereich-EE-1').getByRole('note')).toContainText('MS-20) enthält 70 % von Druckluft Kompressoren K1+K2 (MS-07) über Verteilung 4100');
      expect(await page.locator('.vp-main').evaluate((m) => {
        const kopie = m.cloneNode(true) as HTMLElement;
        kopie.querySelectorAll('.vp-be-hinweis-satz').forEach((h) => h.remove());
        return kopie.innerText ?? kopie.textContent ?? '';
      })).not.toMatch(KUERZEL);
      await expect(page.getByTestId('rangliste')).toHaveCount(0);
      const m = await messe(page);
      expect(m.karten).toHaveLength(7);
      ohneQuerlauf(m, `ergebnis-${breite}`);
      await ablegen(page, `ergebnis-${breite}`, true);
      await page.getByTestId('bereich-EE-1').click();
      await expect(page.getByTestId('einsatz-seite')).toBeVisible();
    });

    test('Liste (voll): ein zweiter Spritzguss-Einsatz für Strom ist gesperrt (B1)', async ({ page }) => {
      await oeffne(page, 'stand=voll', breite, AM_20_11);
      await expect(page.getByTestId('bereich-EE-7')).toBeVisible();
      await anlegenOeffnen(page, breite);
      const prozesse = await listeVon(page, picker(page, 'Prozess'));
      const spritzguss = prozesse.getByRole('option', { name: /^Spritzguss/ });
      await expect(spritzguss).toHaveAttribute('aria-disabled', 'true');
      await expect(prozesse).toContainText('läuft bereits: EE-1 Spritzguss');
    });

    test('Einstufen am Bereich: Vorschlag in Worten, Begründung Pflicht, Abweichung sichtbar und Vier-Augen wartet (R3/R17)', async ({ page }) => {
      await oeffne(page, 'stand=voll&ee=EE-3', breite, AM_20_11);
      await page.getByTestId('einsatz-einstufen-knopf').click();
      const dialog = page.getByTestId('einstufung-dialog');
      await expect(page.getByTestId('einstufung-vorschlag')).toContainText('VoltPilot schlägt „nicht wesentlich“ vor - kein Kriterium trifft zu.');
      await expect(dialog).toContainText('Kriterien-Fassung 1');
      await expect(dialog).toContainText('Version 1');
      await expect(dialog.getByRole('checkbox', { name: 'begründete Einschätzung einer Person' })).toBeVisible();
      expect(await dialog.innerText()).not.toMatch(KUERZEL);
      await dialog.getByRole('radio', { name: 'wesentlich', exact: true }).check();
      await expect(page.getByTestId('abweichung-hinweis')).toBeVisible();
      await page.getByTestId('abweichung-hinweis').scrollIntoViewIfNeeded();
      await ablegen(page, `einstufung-abweichung-${breite}`);
      ohneQuerlauf(await messe(page), `einstufung-${breite}`);
      await page.getByTestId('einstufung-speichern').click();
      await expect(dialog.getByRole('alert')).toContainText('ausdrücklich');
      await dialog.getByLabel('Begründung').fill('Querschnitt für Spritzguss und Montage; Leckageverluste werden geprüft.');
      await page.getByTestId('einstufung-speichern').click();
      await expect(dialog).toHaveCount(0);
      // Seit PR3 liegen alle Fassungen im Änderungsprotokoll (Menü ⋯) — eine freigegebene steht nicht mehr auf der Seite.
      await page.getByTestId('einsatz-menue').getByRole('button', { name: 'Weitere Aktionen' }).click();
      await page.getByRole('menuitem', { name: 'Änderungsprotokoll' }).click();
      await expect(page.getByRole('dialog').getByTestId('einstufung-historie')).toContainText('Fassung 2 · wesentlich');
      await page.keyboard.press('Escape');

      await oeffne(page, 'stand=voll&vieraugen=1&ee=EE-2', breite, AM_20_11);
      await page.getByTestId('einsatz-einstufen-knopf').click();
      const vier = page.getByTestId('einstufung-dialog');
      await vier.getByRole('radio', { name: 'wesentlich', exact: true }).check();
      await vier.getByLabel('Begründung').fill('Montage wird wegen des erwarteten Jahresverbrauchs wesentlich eingestuft.');
      await page.getByTestId('einstufung-speichern').click();
      await expect(vier).toHaveCount(0);
      // Eine beantragte Fassung steht auf der Seite (sie wartet auf eine zweite Person).
      await expect(page.getByTestId('einsatz-seite').getByTestId('einstufung-historie')).toContainText('wartet auf Bestätigung');
      // Der Rückweg führt zu „Verbrauch“; die Bewertung ist der Reiter daneben.
      await page.getByTestId('einsatz-seite').getByRole('button', { name: 'Verbrauch' }).click();
      await page.getByRole('tab', { name: 'Bewertung' }).click();
      await expect(page.getByTestId('bereich-EE-2')).toContainText('neue Einstufung wartet auf Bestätigung');
    });

    test('Kriterien ändern: Wort und Kürzel im Dialog, Begründung Pflicht, die neue Fassung gilt für den Vorschlag (R15)', async ({ page }) => {
      await oeffne(page, 'stand=voll', breite, AM_20_11);
      await expect(page.getByTestId('bereich-EE-2')).not.toContainText('weicht vom Vorschlag ab');
      await page.getByTestId('kriterien-oeffnen').click();
      const dialog = page.getByTestId('kriterien-dialog');
      await expect(dialog.locator('input[type="number"]')).toHaveCount(8);
      await dialog.getByLabel('Anteil am Strom, ab dem VoltPilot vorschlägt (K1)').fill('5');
      await page.getByTestId('kriterien-speichern').click();
      await expect(dialog.getByRole('alert')).toContainText('Begründung');
      await dialog.getByLabel('Begründung').fill('Bis die Abdeckung reicht, werden Einsätze ab fünf Prozent geprüft.');
      await ablegen(page, `kriterien-${breite}`);
      ohneQuerlauf(await messe(page), `kriterien-dialog-${breite}`);
      await page.getByTestId('kriterien-speichern').click();
      await expect(page.getByTestId('kriterien-hinweis')).toContainText('Die neuen Kriterien gelten ab sofort für den Vorschlag (Fassung 2).');
      await expect(page.getByText('Er braucht mindestens 5 % des Stroms.')).toBeVisible();
      // Montage hat 5,2 %: jetzt schlägt VoltPilot „wesentlich“ vor, eingestuft ist sie als nicht wesentlich.
      await expect(page.getByTestId('bereich-EE-2')).toContainText('weicht vom Vorschlag ab');
    });

    test('Vier-Augen (Befund 6): die Meldung sagt „wartet“; die zweite Person gibt frei oder lehnt begründet ab', async ({ page }) => {
      await oeffne(page, 'stand=voll&kriterienvieraugen=1', breite, AM_20_11);
      await page.getByTestId('kriterien-oeffnen').click();
      const dialog = page.getByTestId('kriterien-dialog');
      await dialog.getByLabel('Anteil am Strom, ab dem VoltPilot vorschlägt (K1)').fill('8');
      await dialog.getByLabel('Begründung').fill('Druckluft und Montage früher sehen.');
      await page.getByTestId('kriterien-speichern').click();
      await expect(page.getByTestId('kriterien-hinweis')).toHaveText(
        'Die neuen Kriterien (Fassung 2) warten auf die Freigabe durch eine zweite Person. Bis dahin gelten die bisherigen.',
      );
      await expect(page.getByTestId('kriterien-antrag')).toContainText('Freigeben oder ablehnen kann eine zweite Person, die Kriterien ändern darf.');
      await expect(page.getByTestId('kriterien-oeffnen')).toHaveCount(0);

      // Jonas Wendlinger (Kundenadministrator) entscheidet über den Antrag von Ines Kaltenbach.
      await oeffne(page, 'stand=voll&person=JW&kriterienantrag=IK', breite, AM_20_11);
      const antrag = page.getByTestId('kriterien-antrag');
      await expect(antrag).toContainText('Neue Kriterien warten auf Freigabe');
      await expect(antrag).toContainText('Anteil am Strom, ab dem VoltPilot vorschlägt: 10 % → 8 %');
      await expect(antrag).toContainText('Beantragt von Ines Kaltenbach am 20.11.2026');
      await expect(page.getByTestId('bereich-EE-3')).toContainText('weicht vom Vorschlag ab');
      await antrag.scrollIntoViewIfNeeded();
      await ablegen(page, `kriterien-antrag-${breite}`);
      ohneQuerlauf(await messe(page), `kriterien-antrag-${breite}`);
      await antrag.getByRole('button', { name: 'Freigeben' }).click();
      await expect(page.getByTestId('kriterien-hinweis')).toContainText('Die neuen Kriterien gelten ab sofort für den Vorschlag (Fassung 2).');
      await expect(page.getByTestId('kriterien-antrag')).toHaveCount(0);
      // Druckluft (8,6 %) liegt jetzt über der Schwelle: der Vorschlag stimmt mit der Einstufung überein.
      await expect(page.getByTestId('bereich-EE-3')).not.toContainText('weicht vom Vorschlag ab');

      await oeffne(page, 'stand=voll&person=JW&kriterienantrag=IK', breite, AM_20_11);
      await page.getByTestId('kriterien-antrag').getByRole('button', { name: 'Ablehnen' }).click();
      const ab = page.getByTestId('kriterien-ablehnen-dialog');
      await page.getByTestId('kriterien-ablehnen-senden').click();
      await expect(ab.getByRole('alert')).toHaveText('Bitte begründen Sie die Ablehnung.');
      await ab.getByLabel('Begründung').fill('Erst nach dem Sommer neu bewerten.');
      await page.getByTestId('kriterien-ablehnen-senden').click();
      await expect(page.getByTestId('kriterien-hinweis')).toHaveText('Die beantragten Kriterien (Fassung 2) sind abgelehnt. Es gelten weiter die bisherigen.');
      await expect(page.getByText('Er braucht mindestens 10 % des Stroms.')).toBeVisible();
    });

    test('Historie: Fassungen bleiben auf der Einsatzseite lesbar, Gründe in Worten (R13)', async ({ page }) => {
      await oeffne(page, 'stand=voll&ee=EE-3&historie=r13', breite, AM_20_11);
      // Die Gründe der geltenden Einstufung stehen auf der Seite, alle Fassungen im Änderungsprotokoll (Menü ⋯).
      await expect(page.getByTestId('einsatz-warum')).toBeVisible();
      await page.getByTestId('einsatz-menue').getByRole('button', { name: 'Weitere Aktionen' }).click();
      await page.getByRole('menuitem', { name: 'Änderungsprotokoll' }).click();
      // Eine beantragte Fassung zeigt die Historie auch auf der Seite — gelesen wird die im Protokoll.
      const historie = page.getByRole('dialog').getByTestId('einstufung-historie');
      await expect(historie).toContainText('Fassung 3 · nicht wesentlich');
      await expect(historie).toContainText('Fassung 1 · wesentlich');
      await expect(historie).toContainText('Gründe: Anteil am Strom über der Schwelle und unter den größten Bereichen · Zahlen aus November 2027 bis Oktober 2028');
      await expect(historie).toContainText('Gründe: begründete Einschätzung einer Person · Zahlen aus Oktober 2026 · Kriterien-Fassung 1');
      expect(await historie.innerText()).not.toMatch(KUERZEL);
      ohneQuerlauf(await messe(page), `historie-${breite}`);
      await ablegen(page, `historie-${breite}`, true);
    });

    test('Peter Hollerbach (Bearbeiter) sieht das Ergebnis, darf aber nicht anlegen oder ändern (R14)', async ({ page }) => {
      await oeffne(page, 'stand=voll&person=PH', breite, AM_20_11);
      await expect(page.getByTestId('bereich-EE-1')).toBeVisible();
      await expect(page.getByTestId('bewertung-nur-lesen')).toBeVisible();
      await expect(page.getByTestId('einsatz-anlegen-knopf')).toHaveCount(0);
      await expect(page.getByTestId('bewertung-menue')).toHaveCount(0);
      await expect(page.getByTestId('umfang-knopf')).toHaveCount(0);
      await expect(page.getByTestId('kriterien-oeffnen')).toHaveCount(0);
      await page.getByTestId('bereich-EE-2').click();
      await expect(page.getByTestId('einsatz-verantwortlich')).toHaveText('Peter Hollerbach');
      // Lesend: im Menü ⋯ nur das Änderungsprotokoll, kein Bearbeiten und kein Beenden.
      await page.getByTestId('einsatz-menue').getByRole('button', { name: 'Weitere Aktionen' }).click();
      await expect(page.getByRole('menuitem', { name: 'Änderungsprotokoll' })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: 'Bearbeiten' })).toHaveCount(0);
      await expect(page.getByRole('menuitem', { name: 'Beenden' })).toHaveCount(0);
      await page.keyboard.press('Escape');
      ohneQuerlauf(await messe(page), `lesend-${breite}`);
    });
  });
}
