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
 * Reitern), die Kacheln der Leiste, die SICHTBAREN Reiter, Status-Zeile, Stufen, Kasten „Stand“, Abschnitte, Nachweis
 * und PDF/CSV am Stand (Konzept Nachweisen n1, Runde 2, §6.4: der ganze Bericht steht einen Tipp tiefer).
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
// Die Leiste trägt am Unternehmen Gruppen (`ebenenNav.UNTERNEHMEN_GRUPPEN`); die Berichte wohnen in „Auswerten“,
// über der Seite stehen am Telefon nur deren Reiter.
// K1/D2: die Berichte sind Belege — sie stehen in der Gruppe „Nachweisen“. N1: am Rechner stehen dieselben Gruppen in
// der Seitenleiste.
const LEISTE = ['Übersicht', 'Messen', 'Auswerten', 'Nachweisen'];

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
  await expect(page.getByTestId('bericht-status')).toBeVisible();
  await expect(page.getByTestId('bericht-stand-karte')).toBeVisible();
}

/** Konzept Nachweisen n1, Runde 2 (§6.4): der ganze Bericht steht einen Tipp tiefer - am Handy „Alle Werte“, am Rechner „Ganzer Bericht“. */
async function alleWerte(page: Page) {
  await page.getByTestId('bericht-alle-werte').click();
  const blatt = page.getByTestId('bericht-werte-blatt');
  await expect(blatt).toBeVisible();
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  return blatt;
}

async function messe(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const breite = doc.clientWidth;
    const text = (e: Element | null) => (e?.textContent ?? '').trim();
    const sichtbar = (e: Element) => (e as HTMLElement).offsetParent !== null || getComputedStyle(e).position === 'fixed';
    const bar = document.querySelector<HTMLElement>('.vp-bottombar');
    const leisteSichtbar = bar !== null && getComputedStyle(bar).display !== 'none';
    const ueberstehend = [...document.querySelectorAll<HTMLElement>('.vp-main *, [role="dialog"] *')]
      .filter((e) => sichtbar(e) && !e.closest('.vp-bereich-tabs'))
      .filter((e) => e.getBoundingClientRect().right > breite + 0.5)
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`);
    const eintrag = (e: Element) => text(e.querySelector('.vp-nav-zwei > span:first-child') ?? e.querySelector('.vp-nav-lbl'));
    const reiter = (aktiv: boolean) =>
      [...document.querySelectorAll<HTMLElement>(`[role="tablist"] [role="tab"]${aktiv ? '[aria-selected="true"]' : ''}`)]
        .filter((t) => sichtbar(t))
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
      // N1: die Einträge der Ebene in der Seitenleiste (am Telefon verborgen) — ohne die Frage des offenen Eintrags.
      seite: [...document.querySelectorAll<HTMLElement>('.vp-ebenennav .vp-navitem')].filter((e) => sichtbar(e)).map(eintrag),
      seiteAktiv: [...document.querySelectorAll<HTMLElement>('.vp-ebenennav .vp-navitem[aria-current="page"]')].filter((e) => sichtbar(e)).map(eintrag)[0] ?? null,
      zeilen: [...document.querySelectorAll('[data-testid^="bericht-zeile-BR-"]')].map((k) => text(k)),
      titel: text(document.querySelector('[data-testid="bericht-kopf"] h1')),
      status: text(document.querySelector('[data-testid="bericht-status"]')),
      stufen: [...document.querySelectorAll('[data-testid="bericht-stufen"] li')].map((l) => l.getAttribute('aria-label')),
      freigegeben: text(document.querySelector('[data-testid="bericht-zeile-freigegeben"]')),
      datenstand: text(document.querySelector('[data-testid="bericht-zeile-datenstand"]')),
      pruefsumme: document.querySelector('[data-testid="bericht-zeile-pruefsumme"] code')?.getAttribute('title') ?? '',
      abschnitte: [...document.querySelectorAll('.vp-br-block > h2')].map((h) => text(h)),
      zahlen: document.querySelectorAll('[data-testid="bericht-zahl"]').length,
      knoepfe: [...document.querySelectorAll('[data-testid="bericht-dateien"] button')].map((b) => text(b)),
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
  test('bei 375 px am 13.11.2026: BR-2026-0001 wartet - „Daten geändert“, „Entscheiden“, Datumsblock „seit“; die Leiste mit „Nachweisen“ offen', async ({ page }) => {
    await oeffne(page, 'ansicht=berichte', 375, AM_13_11);
    await expect(page.getByTestId('bericht-zeile-BR-2026-0001')).toHaveCount(1);
    const m = await messe(page);
    ohneQuerlauf(m, 'liste-375');
    expect(m.route).toBe('#/portfolio/berichte');
    expect(m.leiste).toEqual(LEISTE);
    expect(m.leisteAktiv).toBe('Nachweisen');
    // Ohne Energiemanagement trägt „Nachweisen“ nur die Berichte — eine zweite Reihe mit einem Reiter gibt es nicht.
    expect(m.reiter).toEqual([]);
    expect(m.reiterAktiv).toEqual([]);
    const zeile = page.getByTestId('bericht-zeile-BR-2026-0001');
    await expect(zeile).toContainText('Monatsbericht Oktober 2026');
    await expect(zeile).toContainText('Daten geändert');
    await expect(zeile).toContainText('Entscheiden');
    await expect(zeile.getByRole('img')).toHaveAttribute('aria-label', 'seit 12.11.2026');
    await expect(page.getByTestId('zaehler-gelten')).toHaveText('1gilt');
    await expect(page.getByTestId('zaehler-wartet')).toContainText('1wartet');
    await ablegen(page, 'liste-375', m);
  });

  test('bei 1440 px am 20.11.2026: Gruppe „Nachweisen“ offen; die Zeile mit „frei“ und „PDF“ öffnet den Bericht', async ({ page }) => {
    await oeffne(page, 'ansicht=berichte', 1440, AM_20_11);
    await expect(page.getByTestId('bericht-zeile-BR-2026-0001')).toHaveCount(1);
    const m = await messe(page);
    ohneQuerlauf(m, 'liste-1440');
    // N1: am Rechner die Gruppen in der Seitenleiste, die offene ist „Nachweisen“ — mit nur einem Bereich ohne Reihe.
    expect(m.seite).toEqual(LEISTE);
    expect(m.seiteAktiv).toBe('Nachweisen');
    expect(m.reiter).toEqual([]);
    const zeile = page.getByTestId('bericht-zeile-BR-2026-0001');
    await expect(zeile.getByRole('img')).toHaveAttribute('aria-label', 'frei 16.11.2026');
    await expect(zeile).toContainText('Stand 2');
    await expect(page.getByTestId('bericht-pdf-BR-2026-0001')).toHaveText('PDF');
    await ablegen(page, 'liste-1440', m);
    await zeile.click();
    await warteAufSeite(page);
    expect((await messe(page)).route).toBe('#/portfolio/berichte/BR-2026-0001');
  });
});

test.describe('Berichte — die Berichtsseite (§5.1–§5.6, Nachweisen n1 §6.4)', () => {
  test('bei 375 px am 20.11.2026: „Stand 2 gilt“, Stufen, Kasten „Stand“, PDF und CSV; „Geändert ggü. Stand 1“; alle Werte mit Nachweis einen Tipp tiefer', async ({ page }) => {
    await oeffne(page, 'ansicht=bericht&br=BR-2026-0001', 375, AM_20_11);
    await warteAufSeite(page);
    const m = await messe(page);
    ohneQuerlauf(m, 'seite-375');
    expect(m.leisteAktiv).toBe('Nachweisen');
    expect(m.titel).toContain('Monatsbericht Oktober 2026');
    expect(m.status).toBe('Stand 2 gilt· Daten unverändert');
    expect(m.stufen).toEqual(['Entwurf: 10.11.2026', 'Stand 1: 10.11.2026', 'Stand 2: 16.11.2026']);
    expect(m.freigegeben).toContain('Ines Kaltenbach');
    expect(m.datenstand).toContain('12.11.2026, 10:05');
    expect(m.pruefsumme).toBe('sha256:0f0feda03d1979477a2596db5b9723399f227af0226a5397251704384de10d0d');
    // Konzept Nachweisen n1, Befund 1: an jedem Stand PDF (Recht zum Abrufen) und CSV (export.standort); Teilen den Link.
    expect(m.knoepfe).toEqual(['PDF', 'Teilen', 'CSV']);
    const geaendert = page.getByTestId('bericht-geaendert');
    await expect(geaendert.getByRole('heading')).toHaveText('Geändert ggü. Stand 1');
    await expect(geaendert.getByTestId('bericht-grund')).toContainText('Grund:');
    await expect(page.getByTestId('bericht-stand-1')).toContainText('überholt');
    await ablegen(page, 'seite-oben-375', m);
    await ablegen(page, 'seite-nr2-375', m, true);

    const blatt = await alleWerte(page);
    const w = await messe(page);
    ohneQuerlauf(w, 'werte-375');
    expect(w.abschnitte).toEqual(['Kopf', 'Zusammenfassung', 'Verbrauch je Messstelle', 'Tagesverlauf je Messstelle', 'Kennzahlen', 'Qualität', 'Quellenverzeichnis']);
    expect(w.zahlen).toBe(18);
    const paar = blatt.getByTestId('bericht-richtungspaar');
    await expect(paar).toHaveCount(1);
    await expect(paar).toContainText('MS-04 Speicher Halle 1');
    await expect(paar).toContainText(/Laden\s*7\.900\s*kWh/);
    await expect(paar).toContainText(/Entladen\s*7\.100\s*kWh/);
    const leer = blatt.locator('[data-testid="bericht-tagesverlauf"][data-quelle="MS-12"]');
    await expect(leer).toContainText('In diesem Berichtsstand sind keine Tageswerte gespeichert.');
    if (BILDER) {
      await paar.scrollIntoViewIfNeeded();
      await paar.screenshot({ path: join(BILDER, 'richtungspaar-375.png') });
      await leer.scrollIntoViewIfNeeded();
      await leer.screenshot({ path: join(BILDER, 'tagesverlauf-leer-375.png') });
    }

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
    // AP-13 IP-11: am Telefon stehen „heutigen Wert zeigen“ und der Weg zur Messstelle untereinander.
    const aktionen = n.zeile.locator('.vp-br-aktionen');
    await expect(n.zeile.getByTestId('bericht-sprung')).toHaveAttribute('href', '#/portfolio/messstellen/MS-12?periode=2026-10');
    await aktionen.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
    if (BILDER) await aktionen.screenshot({ path: join(BILDER, 'ip11-bericht-aktionen-375.png') });
  });

  test('bei 375 und 1440 px: gespeicherte Tageswerte nutzen den vorhandenen Balken-Verlauf, Lücke und Zustand bleiben ablesbar', async ({ page }) => {
    for (const breite of [375, 1440]) {
      await oeffne(page, 'ansicht=bericht&br=BR-2026-0001&tagesverlauf=gefuellt', breite, AM_20_11);
      await warteAufSeite(page);
      const blatt = await alleWerte(page);
      const reihe = blatt.locator('[data-testid="bericht-tagesverlauf"][data-quelle="MS-12"]');
      await expect(reihe.locator('[data-testid="mini-col"]')).toHaveCount(5);
      await reihe.locator('[data-testid="mini-col"]').nth(2).dispatchEvent('pointerdown');
      await expect(reihe.locator('.vp-mini-cap')).toHaveText(`03.10.2026: — · keine Werte`);
      ohneQuerlauf(await messe(page), `tagesverlauf-${breite}`);
      if (BILDER && breite === 375) {
        await reihe.scrollIntoViewIfNeeded();
        await reihe.screenshot({ path: join(BILDER, 'tagesverlauf-gefuellt-375.png') });
      }
    }
  });

  test('bei 1440 px: Stand 1 ist „überholt“ und nennt 6.100 kWh; seine Korrektur steht in Stand 2', async ({ page }) => {
    await oeffne(page, 'ansicht=bericht&br=BR-2026-0001', 1440, AM_20_11);
    await warteAufSeite(page);
    // Am Rechner stehen links die Werte als Zeilen; der ganze Bericht einen Klick tiefer.
    await expect(page.getByTestId('bericht-werte')).toContainText('Werte');
    await page.getByTestId('bericht-stand-1').click();
    await expect(page.getByTestId('bericht-status')).toHaveText('Stand 1· überholt');
    const m = await messe(page);
    ohneQuerlauf(m, 'nr1-1440');
    expect(m.seiteAktiv).toBe('Nachweisen');
    // R4: die Berichtsseite zeigt ihren Rückweg statt einer Reihe.
    expect(m.reiterAktiv).toEqual([]);
    expect(m.datenstand).toContain('10.11.2026, 08:55');
    expect(m.pruefsumme).toBe('sha256:b113527d108b16714992e6057b7ac201d37998f3765a10e3b12a0fcf3cc7ae03');
    await page.getByTestId('bericht-korrekturen').click();
    await expect(page.getByTestId('bericht-grund-blatt')).toContainText('K-2026-0007');
    await expect(page.getByTestId('bericht-grund-blatt')).toContainText('in Stand 2');
    await page.keyboard.press('Escape');
    await ablegen(page, 'seite-nr1-1440', m);
    await alleWerte(page);
    const n = await nachweis(page, 'MS-12');
    expect(n.zahl).toBe(`6.100${NB}kWh`);
    await n.zeile.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await ablegen(page, 'nachweis-ms12-1440', await messe(page));

    // AP-13 IP-11 (K4, O10 Schritt 6): NEBEN „heutigen Wert zeigen“ steht der Weg zur Messstelle — mit dem
    // ZEITRAUM DES BERICHTS. Der eine Satz ist der des Stands, der andere der von heute; keiner ersetzt den anderen.
    const sprung = n.zeile.getByTestId('bericht-sprung');
    await expect(sprung).toHaveText('Zur Messstelle');
    await expect(sprung).toHaveAttribute('href', '#/portfolio/messstellen/MS-12?periode=2026-10');
    expect(Math.round((await sprung.boundingBox())!.height)).toBeGreaterThanOrEqual(44);

    // Auch das Quellenverzeichnis führt zu seinen Objekten — BZ-6 bleibt Text (D3).
    await page.getByTestId('bericht-quellen').locator('summary').click();
    const quelle = page.getByTestId('bericht-quellen').locator('a', { hasText: /^MS-12$/ });
    await expect(quelle).toHaveAttribute('href', '#/portfolio/messstellen/MS-12?periode=2026-10&version=1');
    await expect(page.getByTestId('bericht-quellen').locator('a', { hasText: /^BZ-6$/ })).toHaveCount(0);

    // „heutigen Wert zeigen“: heute steht Version 2 — Stand 1 bleibt, wie er ist.
    await n.zeile.getByRole('button', { name: 'heutigen Wert zeigen' }).click();
    await expect(n.zeile.getByTestId('bericht-heutiger-wert')).toHaveText(`heute: 6.040${NB}kWh · vollständig · Version 2 · korrigiert (Version 2)`);
  });

  test('am 03.12.2026 (B10): Stand 2 nennt MS-12 mit dem Namen zum Datenstand und ergänzt „heute: Montage Linie M1 (Halle 2)“', async ({ page }) => {
    await oeffne(page, 'ansicht=bericht&br=BR-2026-0001&heute=b10', 375, AM_03_12);
    await warteAufSeite(page);
    await alleWerte(page);
    await expect(page.getByTestId('bericht-heute').first()).toBeVisible();
    const m = await messe(page);
    ohneQuerlauf(m, 'b10-375');
    expect(m.heute).toEqual(['heute: Montage Linie M1 (Halle 2)']);
    await expect(page.locator('[data-testid="bericht-zahl"][data-quelle="MS-12"] summary')).toContainText('Montage Linie M1');
    await page.locator('[data-testid="bericht-zahl"][data-quelle="MS-12"]').scrollIntoViewIfNeeded();
    await ablegen(page, 'b10-heute-375', m);
  });

  test('am 02.11.2036 (B16): Stand 1 erklärt weiter 6.100 kWh — „heutigen Wert zeigen“ sagt ehrlich „nicht mehr gespeichert“', async ({ page }) => {
    await oeffne(page, 'ansicht=bericht&br=BR-2026-0001', 375, AM_2036);
    await warteAufSeite(page);
    await page.getByTestId('bericht-stand-1').click();
    await expect(page.getByTestId('bericht-status')).toHaveText('Stand 1· überholt');
    await alleWerte(page);
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
