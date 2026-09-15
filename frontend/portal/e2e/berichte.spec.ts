import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * „Unternehmen › Berichte“ und die Berichtsseite (UEMS AP-12 IP-13) bei 1440 px und 375 px auf der Bühne
 * `startansicht` — die ECHTE Schale mit der ECHTEN Leiste und den ECHTEN Reitern, dieselben reinen Funktionen wie
 * `App.tsx`, die Antworten entlang der Zeitachse des Referenzunternehmens (`src/test/berichtFixtures.ts`; die Abzüge
 * sind die Vektor-Abzüge BR-2026-0001/1 und /2).
 *
 * Vier Uhren: 13.11.2026 (Nr. 1 mit offenem Anstoß — „Revision nötig“), 20.11.2026 (Nr. 2 gültig, Nr. 1 ersetzt),
 * 03.12.2026 mit `heute=b10` (MS-12 heißt heute anders, B10) und 02.11.2036 (die Oktober-Zeilen sind weg, B16).
 *
 * GEMESSEN, nicht behauptet: Querlauf des Dokuments, jedes Element über dem Bildrand (außer in den lokal scrollenden
 * Reitern), die Kacheln der Leiste, die SICHTBAREN Reiter, Kopf, Abschnitte, Nachweis — und dass es keinen Knopf
 * „PDF“ oder „CSV“ gibt, solange IP-10/IP-11 ihr Ziel nicht eingehängt haben.
 *
 * Mit `BERICHTE_BILDER=<Ordner>` legt der Lauf je Fall ein Bild und `messung-<fall>.json` ab — die Vorschau.
 * Die Spec importiert keine Fixtures (sie laden `api.ts`, dem im Node-Lauf `import.meta.env` fehlt).
 */

const BILDER = process.env.BERICHTE_BILDER;
const AM_13_11 = new Date('2026-11-13T08:00:00Z');
const AM_20_11 = new Date('2026-11-20T08:00:00Z');
const AM_03_12 = new Date('2026-12-03T08:00:00Z');
const AM_2036 = new Date('2036-11-02T09:00:00Z');
const NB = String.fromCharCode(160);
const LEISTE = ['Übersicht', 'Standorte', 'Messstellen', 'Kennzahlen', 'Berichte'];

async function oeffne(page: Page, query: string, breite: number, jetzt: Date) {
  await page.clock.setFixedTime(jetzt);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/startansicht.html?bild=unternehmen&${query}`);
  await expect(page.locator('.vp-topbar').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
}

async function warteAufSeite(page: Page) {
  await expect(page.getByTestId('bericht-kopf')).toBeVisible();
  await expect(page.getByTestId('bericht-verlauf')).toBeVisible();
}

async function messe(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const breite = doc.clientWidth;
    const text = (e: Element | null) => (e?.textContent ?? '').trim();
    const sichtbar = (e: Element) => (e as HTMLElement).offsetParent !== null || getComputedStyle(e).position === 'fixed';
    const bar = document.querySelector<HTMLElement>('.vp-bottombar');
    const leisteSichtbar = bar !== null && getComputedStyle(bar).display !== 'none';
    const ueberstehend = [...document.querySelectorAll<HTMLElement>('.vp-main *')]
      .filter((e) => sichtbar(e) && !e.closest('.vp-bereich-tabs, .vp-br-wahl'))
      .filter((e) => e.getBoundingClientRect().right > breite + 0.5)
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`);
    const reiter = (aktiv: boolean) =>
      [...document.querySelectorAll<HTMLElement>(`[role="tablist"] [role="tab"]${aktiv ? '[aria-selected="true"]' : ''}`)]
        .filter((t) => sichtbar(t) && !t.closest('.vp-br-wahl'))
        .map((t) => text(t));
    return {
      route: document.body.dataset.route ?? null,
      breite,
      dokument: doc.scrollWidth - doc.clientWidth,
      ueberstehend: [...new Set(ueberstehend)],
      leiste: leisteSichtbar ? [...bar!.querySelectorAll('.vp-bottombar-item .lbl')].map((l) => l.textContent ?? '') : null,
      leisteAktiv: leisteSichtbar ? bar!.querySelector('[aria-current="page"] .lbl')?.textContent ?? null : null,
      reiter: reiter(false),
      reiterAktiv: reiter(true),
      karten: [...document.querySelectorAll('[data-testid="bericht-karte"]')].map((k) => text(k)),
      stand: [...document.querySelectorAll('[data-testid="bericht-stand"]')].map((k) => text(k)),
      titel: text(document.querySelector('.vp-br-kopf h1')),
      stände: [...document.querySelectorAll('.vp-br-wahl [role="tab"]')].map((t) => text(t)),
      standAktiv: text(document.querySelector('.vp-br-wahl [role="tab"][aria-selected="true"]')),
      kopfZeile: text(document.querySelector('.vp-br-zeile-kopf')),
      abzeichen: [...document.querySelectorAll('.vp-br-abzeichen > *')].map((a) => text(a)),
      pruefsumme: text(document.querySelector('[data-testid="bericht-pruefsumme"] code')),
      abschnitte: [...document.querySelectorAll('.vp-br-block > h2')].map((h) => text(h)),
      zahlen: document.querySelectorAll('[data-testid="bericht-zahl"]').length,
      knoepfe: [...document.querySelectorAll('button')].map((b) => text(b)).filter((t) => t === 'PDF' || t === 'CSV'),
      verlauf: [...document.querySelectorAll('.vp-br-verlauf > li')].map((l) => text(l)),
      heute: [...document.querySelectorAll('[data-testid="bericht-heute"]')].map((h) => text(h)),
    };
  });
}

async function nachweis(page: Page, quelle: string) {
  const zeile = page.locator(`[data-testid="bericht-zahl"][data-quelle="${quelle}"]`);
  await zeile.locator('summary').click();
  const n = zeile.getByTestId('bericht-nachweis');
  await expect(n).toBeVisible();
  return {
    zeile,
    zahl: ((await n.locator('.vp-wk-zahl').textContent()) ?? '').trim(),
    kopf: ((await n.locator('.vp-wk-kopf').textContent()) ?? '').trim(),
    herkunft: (await n.locator('.vp-br-herkunft li').allTextContents()).map((t) => t.trim()),
  };
}

async function ablegen(page: Page, name: string, m: unknown, ganz = false) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  writeFileSync(join(BILDER, `messung-${name}.json`), JSON.stringify(m, null, 2));
  await page.screenshot({ path: join(BILDER, `${name}.png`), fullPage: ganz });
}

function ohneQuerlauf(m: Awaited<ReturnType<typeof messe>>, fall: string) {
  expect(m.dokument, `${fall}: Querlauf des Dokuments`).toBe(0);
  expect(m.ueberstehend, `${fall}: überstehende Elemente`).toEqual([]);
}

test.describe('Berichte — die Liste', () => {
  test('bei 375 px am 13.11.2026: BR-2026-0001 mit „Revision nötig — Korrektur K-2026-0007“, die Leiste mit „Berichte“ offen', async ({ page }) => {
    await oeffne(page, 'ansicht=berichte', 375, AM_13_11);
    await expect(page.getByTestId('bericht-karte')).toHaveCount(1);
    const m = await messe(page);
    ohneQuerlauf(m, 'liste-375');
    expect(m.route).toBe('#/portfolio/berichte');
    expect(m.leiste).toEqual(LEISTE);
    expect(m.leisteAktiv).toBe('Berichte');
    expect(m.reiter).toEqual([]);
    expect(m.stand).toEqual(['Revision nötig — Korrektur K-2026-0007']);
    expect(m.karten[0]).toContain('Monatsbericht Werk Ahrenberg Oktober 2026');
    expect(m.karten[0]).toContain('Monatsbericht Standort · Fassung 1');
    await ablegen(page, 'liste-375', m);
  });

  test('bei 1440 px am 20.11.2026: Reiter „Berichte“ neben „Kennzahlen“; ein Klick öffnet den Bericht', async ({ page }) => {
    await oeffne(page, 'ansicht=berichte', 1440, AM_20_11);
    await expect(page.getByTestId('bericht-karte')).toHaveCount(1);
    const m = await messe(page);
    ohneQuerlauf(m, 'liste-1440');
    expect(m.reiter).toEqual(['Übersicht', 'Standorte', 'Messstellen', 'Kennzahlen', 'Berichte', 'Messwerte']);
    expect(m.reiterAktiv).toEqual(['Berichte']);
    expect(m.stand).toEqual(['Berichtsstand Nr. 2']);
    await ablegen(page, 'liste-1440', m);
    await page.getByTestId('bericht-karte').click();
    await warteAufSeite(page);
    expect((await messe(page)).route).toBe('#/portfolio/berichte/BR-2026-0001');
  });
});

test.describe('Berichte — die Berichtsseite (§5.1–§5.6)', () => {
  test('bei 375 px am 20.11.2026: Nr. 2 vorgewählt — Kopf, Prüfsumme, Abschnitte der Vorlage, kein PDF/CSV; MS-12 klappt seinen Nachweis auf', async ({ page }) => {
    await oeffne(page, 'ansicht=bericht&br=BR-2026-0001', 375, AM_20_11);
    await warteAufSeite(page);
    const m = await messe(page);
    ohneQuerlauf(m, 'seite-375');
    expect(m.leisteAktiv).toBe('Berichte');
    expect(m.titel).toBe('Monatsbericht Werk Ahrenberg Oktober 2026');
    expect(m.stände).toEqual(['Nr. 1', 'Nr. 2', 'Entwurf']);
    expect(m.standAktiv).toBe('Nr. 2');
    expect(m.kopfZeile).toBe('Datenstand 12.11.2026 10:05 (MEZ) · Berichtsstand Nr. 2 · freigegeben 16.11.2026 14:20 von Ines Kaltenbach');
    expect(m.abzeichen).toEqual(['Berichtsstand Nr. 2']);
    expect(m.pruefsumme).toBe('sha256:d2073f76be088dd37208be95df8e57796aac2fdfb295da702e79f77afb285b18');
    expect(m.abschnitte).toEqual(['Kopf', 'Zusammenfassung', 'Verbrauch je Messstelle', 'Kennzahlen', 'Qualität', 'Quellenverzeichnis', 'Verlauf der Berichtsstände']);
    expect(m.zahlen).toBe(18);
    expect(m.knoepfe).toEqual([]);
    expect(m.verlauf[0]).toContain('Anlass Korrektur K-2026-0007');
    expect(m.verlauf[1]).toContain('ersetzt durch Nr. 2 (16.11.2026)');
    await ablegen(page, 'seite-oben-375', m);
    await ablegen(page, 'seite-nr2-375', m, true);

    const n = await nachweis(page, 'MS-12');
    expect(n.zahl).toBe(`6.040${NB}kWh`);
    expect(n.kopf).toContain('Oktober 2026');
    expect(n.herkunft).toEqual([
      'Ort zum Datenstand B-3',
      'Version 2 · endgültig ab 08.11.2026 · gerechnet 12.11.2026 10:05',
      'Regelwerk verbrauch <schema_version zur Bildung>',
    ]);
    const offen = await messe(page);
    ohneQuerlauf(offen, 'nachweis-375');
    await n.zeile.scrollIntoViewIfNeeded();
    await ablegen(page, 'nachweis-ms12-375', offen);
  });

  test('bei 1440 px: Nr. 1 ist „ersetzt durch Nr. 2“ und nennt 6.100 kWh; der Entwurf trägt keine Prüfsumme', async ({ page }) => {
    await oeffne(page, 'ansicht=bericht&br=BR-2026-0001', 1440, AM_20_11);
    await warteAufSeite(page);
    await page.locator('.vp-br-wahl [role="tab"]', { hasText: 'Nr. 1' }).click();
    await expect(page.locator('.vp-br-zeile-kopf')).toContainText('Berichtsstand Nr. 1');
    const m = await messe(page);
    ohneQuerlauf(m, 'nr1-1440');
    expect(m.reiterAktiv).toEqual(['Berichte']);
    expect(m.kopfZeile).toBe('Datenstand 10.11.2026 08:55 (MEZ) · Berichtsstand Nr. 1 · freigegeben 10.11.2026 09:02 von Ines Kaltenbach');
    expect(m.abzeichen).toEqual(['ersetzt durch Nr. 2 (16.11.2026)']);
    expect(m.pruefsumme).toBe('sha256:b79d0fb859e2a84a70c37da5e7e06545b3b4c6c3767a98dec6b67fcba2541f7d');
    await ablegen(page, 'seite-nr1-1440', m);
    const n = await nachweis(page, 'MS-12');
    expect(n.zahl).toBe(`6.100${NB}kWh`);
    await n.zeile.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await ablegen(page, 'nachweis-ms12-1440', await messe(page));

    // „heutigen Wert zeigen“: heute steht Version 2 — Nr. 1 bleibt, wie er ist.
    await n.zeile.getByRole('button', { name: 'heutigen Wert zeigen' }).click();
    await expect(n.zeile.getByTestId('bericht-heutiger-wert')).toHaveText(`heute: 6.040${NB}kWh · vollständig · Version 2 · korrigiert (Version 2)`);

    await page.locator('.vp-br-wahl [role="tab"]', { hasText: 'Entwurf' }).click();
    await expect(page.locator('.vp-br-zeile-kopf')).toHaveText('Entwurf · Datenstand 12.11.2026 10:05 (MEZ)');
    const e = await messe(page);
    expect(e.pruefsumme).toBe('');
    expect(e.knoepfe).toEqual([]);
  });

  test('am 03.12.2026 (B10): Nr. 2 nennt MS-12 mit dem Namen zum Datenstand und ergänzt „heute: Montage Linie M1 (Halle 2)“', async ({ page }) => {
    await oeffne(page, 'ansicht=bericht&br=BR-2026-0001&heute=b10', 375, AM_03_12);
    await warteAufSeite(page);
    await expect(page.getByTestId('bericht-heute').first()).toBeVisible();
    const m = await messe(page);
    ohneQuerlauf(m, 'b10-375');
    expect(m.heute).toEqual(['heute: Montage Linie M1 (Halle 2)']);
    await expect(page.locator('[data-testid="bericht-zahl"][data-quelle="MS-12"] summary')).toContainText('Montage Linie M1');
    await page.locator('[data-quelle="MS-12"]').scrollIntoViewIfNeeded();
    await ablegen(page, 'b10-heute-375', m);
  });

  test('am 02.11.2036 (B16): Nr. 1 erklärt weiter 6.100 kWh — „heutigen Wert zeigen“ sagt ehrlich „nicht mehr gespeichert“', async ({ page }) => {
    await oeffne(page, 'ansicht=bericht&br=BR-2026-0001', 375, AM_2036);
    await warteAufSeite(page);
    await page.locator('.vp-br-wahl [role="tab"]', { hasText: 'Nr. 1' }).click();
    await expect(page.locator('.vp-br-zeile-kopf')).toContainText('Berichtsstand Nr. 1');
    const n = await nachweis(page, 'MS-12');
    expect(n.zahl).toBe(`6.100${NB}kWh`);
    await n.zeile.getByRole('button', { name: 'heutigen Wert zeigen' }).click();
    await expect(n.zeile.getByTestId('bericht-heutiger-wert')).toHaveText(
      'Der Wert vom Oktober 2026 wird nicht mehr gespeichert (Aufbewahrung 10 Jahre). Der Berichtsstand Nr. 1 vom 10.11.2026 hält ihn fest.',
    );
    const m = await messe(page);
    ohneQuerlauf(m, 'b16-375');
    await n.zeile.scrollIntoViewIfNeeded();
    await ablegen(page, 'b16-375', m);
  });
});
