import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * UEMS AP-16 IP-18 (M3 „Messabdeckung sichtbar“) bei 375 und 1440 px auf den ECHTEN Flächen:
 *
 * - Bewertung (`e2e/bewertung.html?stand=voll`): Abdeckungs-Tabelle je Einsatz und je Ort mit vier Spalten,
 *   Rest-Zeilen und Summe mit K8 — „geplant“ nie als 0 — und die Prüfaufgaben-Zeile (EE-3 Druckluft ist wesentlich,
 *   sein Zähler GR-5 ohne Angabe, R8).
 * - Geräteseite (`e2e/geraet-herkunft.html?…&messmittel=1`): Messmittel-Blatt „nicht erhoben“, Angaben eintragen mit
 *   Datei → Prüfsumme im Browser (gesendet wird nur sie), danach das Blatt mit Beleg und Wandler-Klasse.
 *
 * GEMESSEN: kein Querlauf, keine überstehenden Elemente. Mit `IP18_BILDER=<Ordner>` legt der Lauf die Bilder der
 * Ansicht ab. Die Spec importiert keine Fixtures (die Bühnen spielen die Routen).
 */

const BILDER = process.env.IP18_BILDER;
const breiteFuer = (projekt: string) => (projekt.includes('mobile') ? 375 : 1440);

async function querlauf(page: Page) {
  return page.evaluate(() => {
    const breite = document.documentElement.clientWidth;
    const sichtbar = (e: Element) => (e as HTMLElement).offsetParent !== null;
    return {
      dokument: document.documentElement.scrollWidth - breite,
      ueberstehend: [...document.querySelectorAll<HTMLElement>('.vp-ma *, .vp-mm *, .vp-modal *, .vp-bw-pruefaufgaben *')]
        .filter((e) => sichtbar(e) && e.getBoundingClientRect().right > breite + 0.5)
        .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`),
    };
  });
}

async function bild(page: Page, name: string, ziel?: ReturnType<Page['getByTestId']>) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  if (!ziel) return void (await page.screenshot({ path: join(BILDER, `${name}.png`), fullPage: true }));
  // Ganzseiten-Aufnahme, auf das Element zugeschnitten: die klebende Kopfzeile bleibt oben, statt sich beim
  // Zusammensetzen einer Element-Aufnahme mitten ins Bild zu legen. Im Dialog scrollt der Inhalt selbst.
  const r = await ziel.evaluate((e) => {
    const b = e.getBoundingClientRect();
    return { x: b.x + window.scrollX, y: b.y + window.scrollY, width: b.width, height: b.height };
  });
  await page.screenshot({ path: join(BILDER, `${name}.png`), fullPage: true, clip: r });
}

test('IP-18 · Abdeckungs-Tabelle je Einsatz und Ort: vier Spalten, Rest-Zeilen, Summe mit K8 — geplant nie 0', async ({ page }, info) => {
  const breite = breiteFuer(info.project.name);
  await page.clock.setFixedTime(new Date('2026-11-30T09:00:00Z'));
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  await page.goto('/e2e/bewertung.html?stand=voll');
  const karte = page.getByTestId('messabdeckung');
  await expect(karte).toBeVisible();

  await expect(page.getByTestId('messabdeckung-k8')).toHaveText('K8 · Messabdeckung: unter Schwelle');
  const summe = page.getByTestId('messabdeckung-summe');
  await expect(summe).toContainText('185.380 kWh aus 3 von 3 Anlagen');
  await expect(summe).toContainText('125.740 kWh = 67,8 %');
  await expect(summe).toContainText('MS-23 — noch keine Werte');
  await expect(summe).toContainText('59.640 kWh = 32,2 %');

  const einsaetze = page.getByTestId('messabdeckung-einsaetze');
  if (breite === 1440) {
    await expect(einsaetze.locator('thead th')).toHaveText(['Energieeinsatz', 'gemessen', 'geplant', 'Ersatz', 'ungemessen', 'Menge']);
  }
  const ee8 = page.getByTestId('messabdeckung-zeile-EE-8');
  await expect(ee8).toContainText('MS-23 (G-1 Halle 1) — keine Datenquelle seit 27.11.2026 · für MB-1');
  await expect(ee8).toContainText('geplant — keine Werte');
  await expect(ee8).not.toContainText(/(^|[^0-9.])0 kWh/);
  await expect(ee8).toContainText('Rest Halle 1: 54.580 kWh (39,2 % der Anlage)');
  await expect(page.getByTestId('messabdeckung-zeile-EE-1')).toContainText('MS-06 (B-1 Halle 1 Nord): 55.100 kWh');
  await expect(einsaetze.locator('tr.is-rest')).toHaveCount(3);
  await expect(page.getByTestId('messabdeckung-orte')).toContainText('Gas — ohne Anteil');
  await expect(karte).toContainText('Eine Aussage zur Konformität mit einer Norm ist damit nicht verbunden.');

  // Prüfaufgaben-Zeile (G3, R8): EE-3 Druckluft ist wesentlich, GR-5 trägt keine Angabe.
  await expect(page.getByTestId('pruefaufgaben')).toHaveText(
    'Prüfaufgabe · EE-3 Druckluft (wesentlich): Messmittel-Angaben fehlen — MS-07 · GR-5: Klasse und Prüfung nicht erhoben. Nichts wird geschätzt; die Angaben stehen am Gerät.');

  expect(await querlauf(page)).toEqual({ dokument: 0, ueberstehend: [] });
  await bild(page, `abdeckung-${breite}`, karte);
  await bild(page, `pruefaufgaben-${breite}`, page.getByTestId('pruefaufgaben'));
});

test('IP-18 · Prüfaufgabe und Messmittel an der Seite des wesentlichen Einsatzes EE-3', async ({ page }, info) => {
  const breite = breiteFuer(info.project.name);
  await page.clock.setFixedTime(new Date('2026-11-30T09:00:00Z'));
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  await page.goto('/e2e/bewertung.html?stand=voll&ee=EE-3');
  const karte = page.getByTestId('einsatz-messmittel');
  await expect(karte).toBeVisible();
  await expect(karte.getByTestId('pruefaufgabe')).toContainText('MS-07 · GR-5: Klasse und Prüfung nicht erhoben');
  await expect(karte).toContainText('MS-07 · GR-5: Klasse und Prüfung nicht erhoben.');
  expect(await querlauf(page)).toEqual({ dokument: 0, ueberstehend: [] });
  await bild(page, `einsatz-messmittel-${breite}`, karte);
});

test('IP-18 · Messmittel-Blatt: nicht erhoben → Angaben mit Datei eintragen → Blatt mit Beleg, nur die Prüfsumme gesendet', async ({ page }, info) => {
  const breite = breiteFuer(info.project.name);
  await page.clock.setFixedTime(new Date('2027-02-10T09:00:00+01:00'));
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  const gesendet: string[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET') gesendet.push(`${r.method()} ${r.url()} ${r.postData() ?? ''}`);
  });
  await page.goto('/e2e/geraet-herkunft.html?fall=ek2&messmittel=1');
  const sektion = page.getByTestId('baustein-details');
  // Am Rechner steht der Baustein offen, am Telefon zu — nur aufklappen, was zu ist.
  if (!(await sektion.evaluate((el) => (el as HTMLDetailsElement).open))) await sektion.locator(':scope > summary').click();
  const blatt = page.getByTestId('messmittel-blatt');
  await expect(blatt).toBeVisible();
  await expect(blatt.getByTestId('messmittel-klasse')).toContainText('nicht erhoben');
  await expect(blatt.getByTestId('messmittel-beleg')).toContainText('nicht erhoben');
  await expect(blatt.getByTestId('messmittel-wandler')).toContainText('Stromwandler 400/5 A');
  await expect(blatt.getByTestId('messmittel-wandler')).toContainText('Klasse nicht erhoben');
  // G4 (IP-16): „laut Hersteller“ getrennt unter den Einbau-Angaben, mit Fundstelle; die Einbau-Klasse bleibt leer.
  await expect(blatt.getByTestId('messmittel-hersteller')).toContainText('Energiekarte K-8.2 (WAGO 750-494)');
  await expect(blatt.getByTestId('messmittel-hersteller')).toContainText('Messfehler ± 0,5 % v. Messbereichsendwert der Wirkleistung');
  await expect(blatt.getByTestId('messmittel-hersteller')).toContainText('Handbuch Version 1.5.0, Tabelle 16 „Messfehler“, Seite 37');
  await blatt.scrollIntoViewIfNeeded();
  await bild(page, `blatt-leer-${breite}`, blatt);

  await blatt.getByTestId('messmittel-eintragen').click();
  const dialog = page.getByRole('dialog', { name: 'Messmittel eintragen' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Genauigkeitsklasse').fill('0,5 S');
  const art = dialog.getByRole('combobox', { name: 'Prüfungsart', exact: true });
  await art.click();
  await page.locator(`[id="${await art.getAttribute('id')}-liste"]`).getByRole('option', { name: 'Werksbescheinigung' }).click();
  await dialog.getByLabel('Bezeichnung').fill('Werksprüfprotokoll Karte K-8.2');
  await dialog.getByLabel('Ablage bei Ihnen').fill('Schaltschrank Halle 2, Ordner Prüfungen');
  const inhalt = 'PRUEFPROTOKOLL-K-8.2-INHALT-DER-NIE-GESENDET-WIRD';
  await dialog.getByTestId('messmittel-datei').setInputFiles({ name: 'protokoll-k82.pdf', mimeType: 'application/pdf', buffer: Buffer.from(inhalt) });
  await expect(dialog.getByTestId('messmittel-pruefsumme')).toContainText('aus „protokoll-k82.pdf“ — die Datei bleibt auf Ihrem Gerät.');
  await dialog.getByLabel(/Klasse Stromwandler/).fill('0,5');
  expect(await querlauf(page)).toEqual({ dokument: 0, ueberstehend: [] });
  await bild(page, `dialog-${breite}`, page.locator('.vp-modal').first());

  await dialog.getByTestId('messmittel-speichern').click();
  await expect(dialog).toBeHidden();
  await expect(blatt.getByTestId('messmittel-klasse')).toContainText('0,5 S');
  await expect(blatt.getByTestId('messmittel-pruefung')).toContainText('Werksbescheinigung');
  await expect(blatt.getByTestId('messmittel-beleg')).toContainText('Werksprüfprotokoll Karte K-8.2 · Ablage: Schaltschrank Halle 2, Ordner Prüfungen');
  await expect(blatt.getByTestId('messmittel-beleg')).toContainText(/Prüfsumme [0-9a-f]{4}…[0-9a-f]{4} · eingetragen von/);
  await expect(blatt.getByTestId('messmittel-wandler')).toContainText('Klasse 0,5');
  await expect(blatt.getByRole('status')).toHaveText('Die Angaben sind eingetragen und stehen im Protokoll dieses Geräts.');
  // Die Bühne spielt die Route im Browser: KEIN Datei-Inhalt ging über das Netz.
  expect(gesendet.filter((g) => g.includes(inhalt))).toEqual([]);
  expect(await querlauf(page)).toEqual({ dokument: 0, ueberstehend: [] });
  await blatt.scrollIntoViewIfNeeded();
  await bild(page, `blatt-${breite}`, blatt);
});
