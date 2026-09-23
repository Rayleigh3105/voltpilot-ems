import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Die Kennung von KZ-0001 in `src/test/kennzahlWerteFixtures.ts` — hier abgeschrieben, weil die Fixture-Datei `api.ts`
 * lädt und die im Node-Lauf von Playwright kein `import.meta.env` hat.
 */
const KZ = { kz1: 'c0de0000-0000-4000-8000-00000000a001' } as const;

/**
 * „Unternehmen › Kennzahlen“ und die Kennzahl-Seite (UEMS AP-11 IP-13) bei 1440 px und 375 px auf der Bühne
 * `startansicht` — die ECHTE Schale mit der ECHTEN Leiste und den ECHTEN Reitern, dieselben reinen Funktionen wie
 * `App.tsx`, die Werte aus den Vektoren (`src/test/kennzahlWerteFixtures.ts`: K1, K7, K8, K10, K11).
 *
 * Zwei Uhren: am 10.11.2026 steht KZ-0001 im Oktober als Version 1 (K1, der Satz von §5.3); am 03.12.2026 fehlt der
 * November (K8), der Oktober ist nach K-2026-0007 Version 2 (K7), KZ-0007 hat den 05.11. (K10), KZ-0008 den 02.12. (K11).
 *
 * GEMESSEN, nicht behauptet: Querlauf des Dokuments, jedes Element über dem Bildrand (außer im lokal scrollenden
 * Verlauf und in den Reitern), die Kacheln der Leiste, die SICHTBAREN Reiter und die Sätze der Karte.
 *
 * Mit `KENNZAHLEN_BILDER=<Ordner>` legt der Lauf je Fall ein Bild und `messung-<fall>.json` ab — die Vorschau.
 */

const BILDER = process.env.KENNZAHLEN_BILDER;
const NOVEMBER = new Date('2026-11-10T08:00:00Z');
const DEZEMBER = new Date('2026-12-03T08:00:00Z');
const NB = String.fromCharCode(160);

async function oeffne(page: Page, query: string, breite: number, jetzt: Date) {
  await page.clock.setFixedTime(jetzt);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/startansicht.html?bild=unternehmen&${query}`);
  await expect(page.locator('.vp-topbar').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
}

async function warteAufListe(page: Page) {
  await expect(page.locator('[data-testid="kennzahl-zahl"], [data-testid="kennzahl-hinweis"]')).toHaveCount(5);
}

async function warteAufKarte(page: Page) {
  await expect(page.locator('[data-testid="werte-karte"]')).toBeVisible();
  await expect(page.locator('[data-testid="kennzahl-verlauf"]')).toBeVisible();
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
      .filter((e) => sichtbar(e) && !e.closest('.vp-kz-balken-rahmen, .vp-bereich-tabs'))
      .filter((e) => e.getBoundingClientRect().right > breite + 0.5)
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`);
    const karte = document.querySelector('[data-testid="werte-karte"]');
    return {
      route: document.body.dataset.route ?? null,
      breite,
      dokument: doc.scrollWidth - doc.clientWidth,
      ueberstehend: [...new Set(ueberstehend)],
      leiste: leisteSichtbar ? [...bar!.querySelectorAll('.vp-bottombar-item .lbl')].map((l) => l.textContent ?? '') : null,
      leisteAktiv: leisteSichtbar ? bar!.querySelector('[aria-current="page"] .lbl')?.textContent ?? null : null,
      // Die Reiter an der Kennzahl (AP-17 IP-9/IP-20) misst `kennzahlReiter` für sich.
      reiter: [...document.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"]')]
        .filter((t) => sichtbar(t) && !t.closest('.vp-kz-perioden, .vp-kz-reiter'))
        .map((t) => text(t)),
      reiterAktiv: [...document.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"][aria-selected="true"]')]
        .filter((t) => sichtbar(t) && !t.closest('.vp-kz-perioden, .vp-kz-reiter'))
        .map((t) => text(t)),
      kennzahlReiter: [...document.querySelectorAll<HTMLElement>('.vp-kz-reiter [role="tab"]')].map(
        (t) => `${text(t)}${t.getAttribute('aria-selected') === 'true' ? ' (gewählt)' : ''}`,
      ),
      karten: [...document.querySelectorAll('[data-testid="kennzahl-karte"]')].map((k) => text(k)),
      titel: text(document.querySelector('.vp-kz-kopf h1')),
      unter: text(document.querySelector('.vp-kz-kopf p')),
      perioden: [...document.querySelectorAll('.vp-kz-perioden [role="tab"]')].map((t) => text(t)),
      kartenKopf: text(karte?.querySelector('.vp-wk-kopf') ?? null),
      zahl: text(karte?.querySelector('.vp-wk-zahl') ?? null),
      abzeichen: [...(karte?.querySelectorAll('.vp-wk-abzeichen > *') ?? [])].map((a) => text(a)),
      kennzeichen: [...(karte?.querySelectorAll('.vp-wk-kennzeichen li') ?? [])].map((a) => text(a)),
      grund: text(document.querySelector('[data-testid="werte-grund"]')),
      versionen: text(document.querySelector('[data-testid="werte-versionen"]')),
      herkunft: [...document.querySelectorAll('[data-testid="kennzahl-herkunft"] p, [data-testid="kennzahl-herkunft"] li')].map((p) => text(p)),
      berechnung: [...document.querySelectorAll('[data-testid="kennzahl-berechnung"] p')].map((p) => text(p)),
      stammdaten: [...document.querySelectorAll('[data-testid="kennzahl-stammdaten"] dd')].map((p) => text(p)),
      balken: [...document.querySelectorAll('[data-testid="verlauf-balken"]')].map((b) => b.getAttribute('aria-label')),
    };
  });
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

test.describe('Kennzahlen — die Liste', () => {
  test('bei 375 px am 03.12.2026: fünf Karten, die Leiste mit „Kennzahlen“ offen, keine doppelten Reiter', async ({ page }) => {
    await oeffne(page, 'ansicht=kennzahlen', 375, DEZEMBER);
    await warteAufListe(page);
    const m = await messe(page);
    ohneQuerlauf(m, 'liste-375');
    expect(m.route).toBe('#/portfolio/kennzahlen');
    expect(m.titel).toBe('Kennzahlen');
    expect(m.leiste).toEqual(['Übersicht', 'Standorte', 'Messstellen', 'Bezugsgrößen', 'Kennzahlen', 'Berichte']);
    expect(m.leisteAktiv).toBe('Kennzahlen');
    expect(m.reiter).toEqual([]);
    expect(m.karten).toHaveLength(5);
    expect(m.karten[0]).toContain('keine Werte');
    expect(m.karten[3]).toContain(`mindestens 30,83${NB}kWh je Person`);
    expect(m.karten[4]).toContain(`höchstens 10,55${NB}kWh je h`);
    await ablegen(page, 'liste-375', m);
    await ablegen(page, 'liste-375-ganz', m, true);
  });

  test('bei 1440 px: Reiter „Kennzahlen“ neben „Messstellen“, Karten im Raster; ein Klick öffnet die Kennzahl', async ({ page }) => {
    await oeffne(page, 'ansicht=kennzahlen', 1440, NOVEMBER);
    await warteAufListe(page);
    const m = await messe(page);
    ohneQuerlauf(m, 'liste-1440');
    expect(m.reiter).toEqual(['Übersicht', 'Standorte', 'Messstellen', 'Bezugsgrößen', 'Kennzahlen', 'Berichte', 'Messwerte']);
    expect(m.reiterAktiv).toEqual(['Kennzahlen']);
    expect(m.leiste).toBeNull();
    expect(m.karten[0]).toContain(`0,15${NB}kWh je Stück`);
    expect(m.karten[0]).toContain('Oktober 2026 · endgültig');
    await ablegen(page, 'liste-1440', m);
    await page.getByTestId('kennzahl-karte').first().click();
    await expect(page.locator('body')).toHaveAttribute('data-route', `#/portfolio/kennzahlen/${KZ.kz1}`);
    await warteAufKarte(page);
  });

  test('R-A7 bei 375 px: eine Kennzahl über fremde Standorte steht ohne Wert, mit der Hinweiszeile', async ({ page }) => {
    await oeffne(page, 'ansicht=kennzahlen&ausserhalb=KZ-0003', 375, NOVEMBER);
    await warteAufListe(page);
    await expect(page.getByTestId('kennzahl-hinweis')).toHaveText('umfasst Standorte außerhalb Ihres Zugriffs');
    const m = await messe(page);
    ohneQuerlauf(m, 'liste-ra7-375');
    await page.getByTestId('kennzahl-hinweis').scrollIntoViewIfNeeded();
    await ablegen(page, 'liste-ra7-375', m);
  });
});

test.describe('Kennzahlen — die Kennzahl-Seite (§5.3, §5.5)', () => {
  test('K1 bei 375 px am 10.11.2026: der Satz von §5.3 — 0,15 kWh je Stück · vollständig · Verlauf 100 % · Oktober 2026 · endgültig', async ({ page }) => {
    await oeffne(page, 'ansicht=kennzahl&kz=KZ-0001', 375, NOVEMBER);
    await warteAufKarte(page);
    const m = await messe(page);
    ohneQuerlauf(m, 'k1-375');
    expect(m.route).toBe(`#/portfolio/kennzahlen/${KZ.kz1}`);
    expect(`${m.titel} · ${m.unter}`).toBe('KZ-0001 · Stromeinsatz Montage je Stück — Halle 2 · Gebäude Halle 2 · verantwortlich Ines Kaltenbach');
    expect(m.leisteAktiv).toBe('Kennzahlen');
    expect(m.perioden).toEqual(['Monat', 'Jahr']);
    expect(m.zahl).toBe(`0,15${NB}kWh je Stück`);
    expect(m.abzeichen).toEqual(['vollständig', `Verlauf 100${NB}%`]);
    expect(m.kartenKopf).toBe('Oktober 2026endgültig');
    expect(m.kennzeichen).toEqual(['berechnet (Kennzahl)']);
    expect(m.versionen).toBe('');
    expect(m.herkunft).toEqual([
      `Menge 6.100${NB}kWh (MS-12, vollständig, Version 1) je 41.000${NB}Stück (BZ-6, Fassung 1)`,
      'Berechnung Fassung 1 · gerechnet 01.11.2026 00:20',
    ]);
    expect(m.berechnung[0]).toBe('Menge je Bezugsgröße · MS-12 je BZ-6 · Fassung 1 gilt seit Beginn');
    expect(m.stammdaten).toEqual([
      'Spezifischer Stromeinsatz der Montagelinie M1 je Gutteil; Basis für den Vergleich mit Lindach.',
      'Ines Kaltenbach',
      'Gebäude Halle 2',
    ]);
    await ablegen(page, 'k1-375', m);
    await ablegen(page, 'k1-375-ganz', m, true);
    // Unter der Karte: Herkunft, Berechnung, Stammdaten — ein Bild im Sichtfenster (das ganze Bild legt die Leiste in die Mitte).
    await page.getByTestId('kennzahl-herkunft').evaluate((e) => e.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => window.scrollBy(0, -72));
    await ablegen(page, 'k1-375-unten', m);
  });

  test('K1 bei 1440 px: Werte-Karte und Verlauf links, Herkunft, Berechnung und Stammdaten rechts', async ({ page }) => {
    await oeffne(page, 'ansicht=kennzahl&kz=KZ-0001', 1440, NOVEMBER);
    await warteAufKarte(page);
    const m = await messe(page);
    ohneQuerlauf(m, 'k1-1440');
    expect(m.reiterAktiv).toEqual(['Kennzahlen']);
    // AP-17 IP-9/IP-20 (§5.1, §6.3): an einer Quotient-Kennzahl stehen „Bezugsbasis“ und „Vergleich mit Bezugsbasis“ —
    // vorgewählt bleibt „Kennzahl“ mit dem Inhalt von vorher.
    expect(m.kennzahlReiter).toEqual(['Kennzahl (gewählt)', 'Bezugsbasis', 'Vergleich mit Bezugsbasis']);
    expect(m.zahl).toBe(`0,15${NB}kWh je Stück`);
    await ablegen(page, 'k1-1440', m);
  });

  test('K8 und K7 bei 375 px am 03.12.2026: „—“ mit dem Kundensatz; Oktober ist Version 2 mit „2 Versionen“', async ({ page }) => {
    await oeffne(page, 'ansicht=kennzahl&kz=KZ-0001', 375, DEZEMBER);
    await warteAufKarte(page);
    const m = await messe(page);
    ohneQuerlauf(m, 'k8-375');
    expect(m.zahl).toBe('—');
    expect(m.abzeichen).toEqual(['keine Werte', `Verlauf 0${NB}%`]);
    expect(m.grund).toBe('Für November 2026 fehlt der Wert der Bezugsgröße BZ-6 Gutteile Montage Halle 2.');
    expect(m.herkunft).toEqual([]);
    expect(m.balken).toEqual([
      `Oktober 2026 · 0,15${NB}kWh je Stück · vollständig`,
      'November 2026 · — · keine Werte',
      'Dezember 2026 · —',
    ]);
    await ablegen(page, 'k8-375', m);
    await page.getByTestId('verlauf-balken').first().click();
    await expect(page.getByTestId('werte-versionen')).toContainText('2 Versionen');
    const k7 = await messe(page);
    ohneQuerlauf(k7, 'k7-375');
    expect(k7.kennzeichen).toEqual(['berechnet (Kennzahl)', 'korrigiert (Version 2)']);
    expect(k7.herkunft[1]).toBe('Berechnung Fassung 1 · gerechnet 12.11.2026 10:05:33 · Anlass K-2026-0007 (freigegeben 12.11.2026)');
    await ablegen(page, 'k7-375', k7);
    await page.getByTestId('werte-versionen').click();
    const dialog = page.getByTestId('versionen-dialog');
    await expect(dialog.getByTestId('version')).toHaveCount(2);
    await expect(dialog).toContainText(`0,1488${NB}kWh je Stück`);
    await expect(dialog).toContainText('Korrektur K-2026-0007');
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
    await ablegen(page, 'k7-versionen-375', await messe(page));
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  /**
   * UEMS AP-13 IP-11 (O10): „Die Kette bricht am Text ab“ war der Befund, mit dem AP-13 anfing. Hier ist
   * gemessen, dass sie es nicht mehr tut: die Herkunfts-Zeile von KZ-0001 Oktober Version 2 ist ein LINK
   * auf MS-12 › Werte, und er trägt die Periode UND die Version — die Bezugsgröße BZ-6 bleibt Text (D3).
   */
  test('O10 bei 375 px: die Herkunfts-Zeile springt zu MS-12 › Werte › Oktober mit Version 2; BZ-6 bleibt Text', async ({ page }) => {
    await oeffne(page, 'ansicht=kennzahl&kz=KZ-0001', 375, DEZEMBER);
    await warteAufKarte(page);
    // Der Oktober ist nach der Korrektur K-2026-0007 Version 2 (K7) — der Balken öffnet ihn.
    await page.getByTestId('verlauf-balken').first().click();
    await expect(page.getByTestId('werte-versionen')).toContainText('2 Versionen');
    const herkunft = page.getByTestId('kennzahl-herkunft');
    const spruenge = herkunft.locator('a');
    await expect(spruenge).toHaveCount(1);
    await expect(spruenge).toHaveText('MS-12');
    await expect(spruenge).toHaveAttribute('href', '#/portfolio/messstellen/MS-12?periode=2026-10&version=2');
    // Die Bezugsgröße steht im selben Satz und ist KEIN Link — AP-09 hat keine Kundenfläche.
    await expect(herkunft).toContainText('BZ-6');
    const m = await messe(page);
    ohneQuerlauf(m, 'o10-375');
    // Der Satz ist zeichengleich der von vorher: die Zeile bekam Kanten, keinen neuen Wortlaut.
    expect(m.herkunft[0]).toBe(`Menge 6.040${NB}kWh (MS-12, vollständig, Version 2, korrigiert (Version 2)) je 41.000${NB}Stück (BZ-6, Fassung 1)`);
    await page.getByTestId('kennzahl-herkunft').evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await ablegen(page, 'o10-375', m);
  });

  test('O10 bei 1440 px: derselbe Sprung am Rechner, mit Tippfläche', async ({ page }) => {
    await oeffne(page, 'ansicht=kennzahl&kz=KZ-0001', 1440, DEZEMBER);
    await warteAufKarte(page);
    await page.getByTestId('verlauf-balken').first().click();
    const sprung = page.getByTestId('kennzahl-herkunft').locator('a');
    await expect(sprung).toHaveAttribute('href', '#/portfolio/messstellen/MS-12?periode=2026-10&version=2');
    const kasten = await sprung.boundingBox();
    expect(kasten!.width).toBeGreaterThan(0);
    await ablegen(page, 'o10-1440', await messe(page));
  });

  test('K10 bei 375 px: mindestens 30,83 kWh je Person · unvollständig · Untergrenze — Menge unvollständig (MS-16 fehlt)', async ({ page }) => {
    await oeffne(page, 'ansicht=kennzahl&kz=KZ-0007', 375, DEZEMBER);
    await warteAufKarte(page);
    const m = await messe(page);
    ohneQuerlauf(m, 'k10-375');
    expect([m.zahl, m.abzeichen[0], m.kennzeichen.find((k) => k.startsWith('Untergrenze'))].join(' · ')).toBe(
      `mindestens 30,83${NB}kWh je Person · unvollständig · Untergrenze — Menge unvollständig (MS-16 fehlt)`,
    );
    expect(m.kartenKopf).toBe('05.11.2026vorläufig');
    await ablegen(page, 'k10-375', m);
    await ablegen(page, 'k10-375-ganz', m, true);
  });

  test('K11 bei 375 px: höchstens 10,55 kWh je h mit der Obergrenze der Ladezeit', async ({ page }) => {
    await oeffne(page, 'ansicht=kennzahl&kz=KZ-0008', 375, DEZEMBER);
    await warteAufKarte(page);
    const m = await messe(page);
    ohneQuerlauf(m, 'k11-375');
    expect(m.zahl).toBe(`höchstens 10,55${NB}kWh je h`);
    expect(m.kennzeichen).toContain(`Obergrenze — Bezugsgröße unvollständig (Ladezeit: 1${NB}h ohne Statuswerte)`);
    await ablegen(page, 'k11-375', m);
  });

  test('der Perioden-Umschalter bei 375 px: „Jahr“ zeigt fünf Jahre, jedes ohne Zeile als „—“', async ({ page }) => {
    await oeffne(page, 'ansicht=kennzahl&kz=KZ-0001', 375, DEZEMBER);
    await warteAufKarte(page);
    await page.locator('.vp-kz-perioden').getByRole('tab', { name: 'Jahr' }).click();
    await expect(page.getByTestId('verlauf-balken')).toHaveCount(5);
    const m = await messe(page);
    ohneQuerlauf(m, 'jahr-375');
    expect(m.zahl).toBe('—');
  });
});
