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
      // N1: die Einträge der Ebene in der Seitenleiste (am Telefon verborgen) — ohne die Frage des offenen Eintrags.
      seite: [...document.querySelectorAll<HTMLElement>('.vp-ebenennav .vp-navitem')]
        .filter((e) => sichtbar(e))
        .map((e) => (e.querySelector('.vp-nav-zwei > span:first-child') ?? e.querySelector('.vp-nav-lbl'))?.textContent?.trim() ?? ''),
      seiteAktiv:
        [...document.querySelectorAll<HTMLElement>('.vp-ebenennav .vp-navitem[aria-current="page"]')]
          .filter((e) => sichtbar(e))
          .map((e) => (e.querySelector('.vp-nav-zwei > span:first-child') ?? e.querySelector('.vp-nav-lbl'))?.textContent?.trim() ?? '')[0] ?? null,
      kennzahlReiter: [...document.querySelectorAll<HTMLElement>('.vp-kz-reiter [role="tab"]')].map(
        (t) => `${text(t)}${t.getAttribute('aria-selected') === 'true' ? ' (gewählt)' : ''}`,
      ),
      karten: [...document.querySelectorAll('[data-testid="kennzahl-karte"]')].map((k) => text(k)),
      // Die Reihen zum Beobachten - ohne die zugeklappten Archivierten.
      reihen: [...document.querySelectorAll('[data-testid="kennzahl-reihe"]')].filter((k) => !k.closest('details:not([open])')).map((k) => text(k)),
      titel: text(document.querySelector('.vp-kzs-kopf h1, .vp-kzl-kopf-zeile h1')),
      unter: text(document.querySelector('.vp-kzs-meta, .vp-kzl-unterzeile')),
      perioden: [...document.querySelectorAll('.vp-kz-perioden [role="tab"]')].map((t) => text(t)),
      kartenKopf: text(karte?.querySelector('.vp-wk-kopf') ?? null),
      zahl: text(karte?.querySelector('.vp-wk-zahl') ?? null),
      abzeichen: [...(karte?.querySelectorAll('.vp-wk-abzeichen > *') ?? [])].map((a) => text(a)),
      kennzeichen: [...(karte?.querySelectorAll('.vp-wk-kennzeichen li') ?? [])].map((a) => text(a)),
      grund: text(document.querySelector('[data-testid="werte-grund"]')),
      versionen: text(document.querySelector('[data-testid="werte-versionen"]')),
      // Die Herkunft ohne die Berechnung, die im selben Aufklapper „Wie wird gerechnet?“ steht (Konzept Auswerten a1 §6.5).
      herkunft: [...document.querySelectorAll('[data-testid="kennzahl-herkunft"] p, [data-testid="kennzahl-herkunft"] li')]
        .filter((p) => !p.closest('[data-testid="kennzahl-berechnung"]'))
        .map((p) => text(p)),
      berechnung: [...document.querySelectorAll('[data-testid="kennzahl-berechnung"] p')].map((p) => text(p)),
      // „Über diese Kennzahl“ (Konzept Auswerten a1 §6.5): Zweck und Geltung als Sätze.
      stammdaten: [...document.querySelectorAll('[data-testid="kennzahl-stammdaten"] p')].map((p) => text(p)),
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

/** Die Welt des Konzepts Auswerten a1 (§6.4) zur Bühnen-Uhr 30.04.2029: Urteile für März 2029 (`&liste=referenz`). */
const REFERENZ_UHR = new Date('2029-04-30T08:00:00Z');

test.describe('Kennzahlen - die Liste (Konzept Auswerten a1 §6.4)', () => {
  test('bei 375 px: Hinweiskarte, „Mit Bezugsbasis“ als Karten mit Urteil, „Zum Beobachten“ als Reihen, Archiv zugeklappt', async ({ page }) => {
    await oeffne(page, 'ansicht=kennzahlen&liste=referenz', 375, REFERENZ_UHR);
    await expect(page.getByTestId('kennzahl-karte')).toHaveCount(3);
    const m = await messe(page);
    ohneQuerlauf(m, 'liste-375');
    expect(m.route).toBe('#/portfolio/kennzahlen');
    expect(m.titel).toBe('Kennzahlen');
    expect(m.unter).toBe('Wie effizient Sie Energie einsetzen - je kg, je Stück oder je m², verglichen mit dem, was zu erwarten war.');
    expect(m.leiste).toEqual(['Übersicht', 'Messen', 'Auswerten', 'Nachweisen']);
    expect(m.leisteAktiv).toBe('Auswerten');
    expect(m.reiter).toEqual([]);
    // Handlungsbedarf zuerst: die zwei über der Bezugsbasis, dann die im Rahmen.
    await expect(page.getByTestId('kennzahlen-hinweis')).toContainText('2 Kennzahlen liegen über der Bezugsbasis');
    expect(m.karten.map((k) => k.match(/KZ-\d{4}/)?.[0])).toEqual(['KZ-0004', 'KZ-0023', 'KZ-0021']);
    expect(m.karten[0]).toContain('0,29 kWh je kg');
    expect(m.karten[0]).toContain('März 2029 · Prozess Spritzguss');
    expect(m.karten[0]).toContain('über der Bezugsbasis');
    expect(m.karten[0]).toContain(`2,2${NB}% mehr als erwartet`);
    expect(m.karten[0]).toContain(`Energieziel 2029: 4${NB}% weniger · bisher 2,2${NB}% mehr (1 von 10 Monaten)`);
    expect(m.karten[1]).toContain('Bezugsbasis vorläufig');
    expect(m.karten[2]).toContain('im Rahmen der Bezugsbasis');
    // Die Leitkennzahl (dieselbe wie die Leitkachel der Übersicht) trägt den Stern.
    await expect(page.getByTestId('kennzahl-karte').first().locator('.vp-kzl-stern')).toHaveCount(1);
    expect(m.reihen).toHaveLength(3);
    expect(m.reihen[1]).toContain('Netzbezug je m²');
    expect(m.reihen[1]).toContain('unverändert ggü. Vorjahr · März 2029');
    // Keine Farbe ohne Bezugsbasis: Reihen zum Beobachten tragen keine Urteils-Marke.
    await expect(page.getByTestId('kennzahlen-ohne').locator('.vp-k-marke')).toHaveCount(0);
    await expect(page.getByTestId('kennzahlen-archiv').locator('summary')).toHaveText('Archiviert · 5 Kennzahlen');
    // Am Handy steht „Kennzahl anlegen“ im Menü ⋯ des Kopfs (§6.4: Werkzeuge ins Menü).
    await expect(page.getByTestId('kennzahl-anlegen-knopf')).toHaveCount(0);
    await page.getByRole('button', { name: 'Weitere Aktionen' }).click();
    await expect(page.getByRole('menuitem', { name: 'Kennzahl anlegen' })).toBeVisible();
    await page.keyboard.press('Escape');
    // Mini-Grafik: zwölf Säulen, die Farbe folgt dem Urteil des Servers.
    const arten = await page.getByTestId('kennzahl-mini').first().locator('path').evaluateAll((p) => p.map((e) => e.getAttribute('data-art')));
    expect(arten).toEqual(['schlechter', 'im_rahmen', 'schlechter', 'schlechter', 'schlechter', 'schlechter', 'im_rahmen',
      'schlechter', 'schlechter', 'schlechter', 'schlechter', 'schlechter']);
    await ablegen(page, 'liste-375', m);
    await ablegen(page, 'liste-375-ganz', m, true);
  });

  test('bei 1440 px: zwei Gruppen mit Spalten statt Karten; ein Klick öffnet die Kennzahl', async ({ page }) => {
    await oeffne(page, 'ansicht=kennzahlen&liste=referenz', 1440, REFERENZ_UHR);
    await expect(page.getByTestId('kennzahl-karte')).toHaveCount(3);
    const m = await messe(page);
    ohneQuerlauf(m, 'liste-1440');
    expect(m.seite).toEqual(['Übersicht', 'Messen', 'Auswerten', 'Nachweisen']);
    expect(m.seiteAktiv).toBe('Auswerten');
    expect(m.leiste).toBeNull();
    await expect(page.getByTestId('kennzahlen-mit').locator('.vp-kzl-spalten')).toHaveText(
      'KennzahlWertGegen die BezugsbasisEnergieziel12 Monate',
    );
    await expect(page.getByTestId('kennzahlen-ohne').locator('.vp-kzl-spalten')).toHaveText(
      'KennzahlWertGegen das VorjahrBezugsbasis12 Monate',
    );
    expect(m.karten[0]).toContain(`2029: 4${NB}% weniger`);
    expect(m.karten[1]).toContain(`6,5${NB}% mehr · Bezugsbasis vorläufig`);
    expect(m.karten[2]).toContain(`0,0${NB}% · Band ± 2${NB}%`);
    // Am Rechner ein Knopf statt des Menüs ⋯.
    await expect(page.getByTestId('kennzahl-anlegen-knopf')).toBeVisible();
    await ablegen(page, 'liste-1440', m);
    await page.getByTestId('kennzahl-karte').first().click();
    await expect(page.locator('body')).toHaveAttribute('data-route', /#\/portfolio\/kennzahlen\/c0de0000-0000-4000-8000-00000000a004$/);
  });

  test('bei 1100 px: die Spalte „12 Monate“ entfällt, nichts läuft quer (§6.14)', async ({ page }) => {
    await oeffne(page, 'ansicht=kennzahlen&liste=referenz', 1100, REFERENZ_UHR);
    await expect(page.getByTestId('kennzahl-karte')).toHaveCount(3);
    await expect(page.getByTestId('kennzahl-mini').first()).toBeHidden();
    ohneQuerlauf(await messe(page), 'liste-1100');
  });

  test('Archiviert: die Werte erst beim Aufklappen', async ({ page }) => {
    await oeffne(page, 'ansicht=kennzahlen&liste=referenz', 375, REFERENZ_UHR);
    await expect(page.getByTestId('kennzahl-karte')).toHaveCount(3);
    const archiv = page.getByTestId('kennzahlen-archiv');
    await expect(archiv.getByTestId('kennzahl-reihe').first()).toBeHidden();
    await archiv.locator('summary').click();
    await expect(archiv.getByTestId('kennzahl-reihe')).toHaveCount(5);
    await expect(archiv.getByTestId('kennzahl-reihe').first()).toContainText('KZ-0001');
  });

  test('„Ansehen“ an der Hinweiskarte: bei zwei Kennzahlen zur ersten Karte über der Bezugsbasis', async ({ page }) => {
    await oeffne(page, 'ansicht=kennzahlen&liste=referenz', 375, REFERENZ_UHR);
    await page.getByTestId('kennzahlen-hinweis').click();
    await expect(page.getByTestId('kennzahl-karte').first()).toBeFocused();
  });

  test('die Welt von 2026 bei 375 px am 03.12.2026: ohne Bezugsbasis alles zum Beobachten, mit den Monatswerten', async ({ page }) => {
    await oeffne(page, 'ansicht=kennzahlen', 375, DEZEMBER);
    await expect(page.getByTestId('kennzahl-reihe').first()).toBeVisible();
    const m = await messe(page);
    ohneQuerlauf(m, 'liste-2026-375');
    expect(m.karten).toEqual([]);
    await expect(page.getByTestId('kennzahlen-hinweis')).toHaveCount(0);
    expect(m.reihen[0]).toContain('KZ-0001');
    expect(m.reihen[0]).toContain('0,15 kWh je Stück');
    expect(m.reihen[0]).toContain('Oktober 2026');
  });

  test('R-A7 bei 375 px: eine Kennzahl über fremde Standorte steht ohne Wert, mit der Hinweiszeile', async ({ page }) => {
    await oeffne(page, 'ansicht=kennzahlen&ausserhalb=KZ-0003', 375, NOVEMBER);
    const reihe = page.locator('[data-testid="kennzahl-reihe"][data-kennzeichen="KZ-0003"]');
    await expect(reihe).toContainText('umfasst Standorte außerhalb Ihres Zugriffs');
    const m = await messe(page);
    ohneQuerlauf(m, 'liste-ra7-375');
    await reihe.scrollIntoViewIfNeeded();
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
    // K5: der Name zuerst, das Kennzeichen klein dahinter.
    expect(`${m.titel} · ${m.unter}`).toBe('Stromeinsatz Montage je Stück — Halle 2 KZ-0001 · Gebäude Halle 2 · verantwortlich Ines Kaltenbach');
    expect(m.leisteAktiv).toBe('Auswerten');
    expect(m.perioden).toEqual(['Monat', 'Jahr']);
    expect(m.zahl).toBe(`0,15${NB}kWh je Stück`);
    expect(m.abzeichen).toEqual(['vollständig', `Verlauf 100${NB}%`]);
    expect(m.kartenKopf).toBe('Oktober 2026endgültig');
    expect(m.kennzeichen).toEqual(['berechnet (Kennzahl)']);
    expect(m.versionen).toBe('');
    // K5: der Rechenweg in Worten zuerst; der Satz in Kennzeichen und die zwei Erklärsätze stehen im Aufklapper.
    expect(m.herkunft).toEqual([
      `Gerechnet aus 6.100${NB}kWh (Montage Linie M1) geteilt durch 41.000${NB}Stück (Gutteile Montage Halle 2).`,
      `Menge 6.100${NB}kWh (MS-12, vollständig, Version 1) je 41.000${NB}Stück (BZ-6, Fassung 1)`,
      'Berechnung Fassung 1 · gerechnet 01.11.2026 00:20',
      'Fassung: ein festgehaltener Stand einer Eintragung — einer Berechnung ab einem Tag oder eines eingegebenen Werts. Eine Änderung ergibt eine neue Fassung, die alte bleibt lesbar.',
      'Version: ein Rechenstand des Werts einer Periode. Er wird neu gebildet, wenn sich ein Eingang ändert, etwa nach einer Korrektur.',
    ]);
    expect(m.berechnung[0]).toBe('Menge je Bezugsgröße · Montage Linie M1 (MS-12) je Gutteile Montage Halle 2 (BZ-6) · Fassung 1 gilt seit Beginn');
    expect(m.stammdaten[0]).toBe('Spezifischer Stromeinsatz der Montagelinie M1 je Gutteil; Basis für den Vergleich mit Lindach.');
    expect(m.stammdaten[1]).toMatch(/^Gilt für das Gebäude Halle 2 · verantwortlich Ines Kaltenbach · berechnet seit \d{2}\.\d{2}\.\d{4}$/);
    await ablegen(page, 'k1-375', m);
    await ablegen(page, 'k1-375-ganz', m, true);
    // Unter der Karte: Rechenweg und „Über diese Kennzahl“ — ein Bild im Sichtfenster (das ganze Bild legt die Leiste in die Mitte).
    await page.getByTestId('kennzahl-herkunft').evaluate((e) => e.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => window.scrollBy(0, -72));
    await ablegen(page, 'k1-375-unten', m);
  });

  test('K1 bei 1440 px: Werte-Karte, Verlauf, Rechenweg und „Über diese Kennzahl“ ohne Reiter', async ({ page }) => {
    await oeffne(page, 'ansicht=kennzahl&kz=KZ-0001', 1440, NOVEMBER);
    await warteAufKarte(page);
    const m = await messe(page);
    ohneQuerlauf(m, 'k1-1440');
    // N1/R4: „Auswerten“ leuchtet in der Seitenleiste; die Kennzahl zeigt ihren Rückweg statt der Reihe der Gruppe.
    expect(m.seiteAktiv).toBe('Auswerten');
    expect(m.reiterAktiv).toEqual([]);
    // Konzept Auswerten a1 §6.5: die Seite hat keine Reiter mehr - die Bezugsbasis steht eine Ebene tiefer.
    expect(m.kennzahlReiter).toEqual([]);
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
    // K5: vor der Berechnungs-Fassung stehen der Rechenweg in Worten und der Satz in Kennzeichen.
    expect(k7.herkunft[2]).toBe('Berechnung Fassung 1 · gerechnet 12.11.2026 10:05:33 · Anlass K-2026-0007 (freigegeben 12.11.2026)');
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
    // K5: der Name der Messstelle ist der Sprung — dasselbe Ziel wie vorher ihr Kennzeichen.
    await expect(spruenge).toHaveText('Montage Linie M1');
    await expect(spruenge).toHaveAttribute('href', '#/portfolio/messstellen/MS-12?periode=2026-10&version=2');
    // Die Bezugsgröße steht im selben Satz und ist KEIN Link — AP-09 hat keine Kundenfläche.
    await expect(herkunft).toContainText('BZ-6');
    const m = await messe(page);
    ohneQuerlauf(m, 'o10-375');
    expect(m.herkunft[0]).toBe(`Gerechnet aus 6.040${NB}kWh (Montage Linie M1) geteilt durch 41.000${NB}Stück (Gutteile Montage Halle 2).`);
    // Der Satz in Kennzeichen ist zeichengleich der von vorher — er steht im Aufklapper „Wie wird gerechnet?“.
    expect(m.herkunft[1]).toBe(`Menge 6.040${NB}kWh (MS-12, vollständig, Version 2, korrigiert (Version 2)) je 41.000${NB}Stück (BZ-6, Fassung 1)`);
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
