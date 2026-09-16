import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * UEMS AP-13 IP-2 — die Ebenen-Seiten am Standort (E4, Ü7, Ü8; O17, O18) auf der Bühne `startansicht`, bei 375 und
 * 1440 px: Standort › Gebäude (Ortsbaum mit „Stand am …“), Standort › Anlagen (die heutige Tabelle), Kennzahlen und
 * Berichte des Standorts mit ihren Einstiegen auf der Übersicht, die Leerzustände Z4 und die Reiter der obersten Ebene.
 *
 * Querlauf GEMESSEN am Dokument und an jedem sichtbaren Element des Hauptbereichs. Mit `STANDORT_EBENEN_BILDER=<Ordner>`
 * legt der Lauf je Fall ein Bild und `messung-<fall>.json` ab — die Vorschau.
 * Die Spec importiert keine Fixtures (sie laden `api.ts`, dem im Node-Lauf `import.meta.env` fehlt).
 */

const BILDER = process.env.STANDORT_EBENEN_BILDER;
const JETZT = new Date('2026-10-20T08:15:30Z');
const AM_20_11 = new Date('2026-11-20T08:00:00Z');
const STANDORT_REITER = ['Übersicht', 'Boxen', 'Gebäude', 'Anlagen', 'Messstellen', 'Netzanschlüsse'];

async function oeffne(page: Page, query: string, breite: number, jetzt = JETZT) {
  await page.clock.setFixedTime(jetzt);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/startansicht.html?${query}`);
  await expect(page.locator('.vp-topbar').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
}

async function messe(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const breite = doc.clientWidth;
    const main = document.querySelector<HTMLElement>('.vp-main');
    const sichtbar = (e: Element) => (e as HTMLElement).offsetParent !== null || getComputedStyle(e).position === 'fixed';
    const bar = document.querySelector<HTMLElement>('.vp-bottombar');
    const leisteSichtbar = bar !== null && getComputedStyle(bar).display !== 'none';
    const ueberstehend = [...document.querySelectorAll<HTMLElement>('.vp-main *')]
      .filter((e) => sichtbar(e) && !e.closest('.vp-bereich-tabs'))
      .filter((e) => e.getBoundingClientRect().right > breite + 0.5)
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`);
    const texte = (sel: string) => [...document.querySelectorAll(sel)].filter(sichtbar).map((e) => e.textContent?.trim() ?? '');
    return {
      route: document.body.dataset.route ?? null,
      dokument: doc.scrollWidth - doc.clientWidth,
      ueberstehend: [...new Set(ueberstehend)],
      titel: main?.querySelector('h1:not(.vp-sr-only)')?.textContent?.trim() ?? null,
      leiste: leisteSichtbar ? [...bar!.querySelectorAll('.vp-bottombar-item .lbl')].map((l) => l.textContent ?? '') : null,
      leisteAktiv: leisteSichtbar ? bar!.querySelector('[aria-current="page"] .lbl')?.textContent ?? null : null,
      // Ein Zeitraum-Segment (`ZeitSegment`, `.vp-seg`) ist kein Reiter — die Übersicht trägt eines seit AP-13 IP-7.
      reiter: texte('[role="tablist"]:not(.vp-seg) [role="tab"]'),
      reiterAktiv: texte('[role="tablist"]:not(.vp-seg) [role="tab"][aria-selected="true"]'),
      gebaeude: texte('.vp-ob-knoten[data-art="gebaeude"] > .vp-ob-zeile .vp-st-name-text'),
      aufklapper: document.querySelectorAll('.vp-ob-aufklapper').length,
      anlagen: texte('.vp-at-name-text, .vp-at-karte-name'),
      kennzahlLeiste: main?.querySelectorAll('.vp-leiste').length ?? 0,
      funktionenKarte: document.querySelectorAll('[data-testid="funktionen-karte"]').length,
      einstiege: texte('.vp-standort-einstieg'),
      tippflaechen: [...document.querySelectorAll<HTMLElement>('.vp-standort-einstieg, .vp-bottombar-item')]
        .filter(sichtbar)
        .map((e) => Math.round(e.getBoundingClientRect().height)),
      text: main?.textContent ?? '',
    };
  });
}

async function ablegen(page: Page, name: string, m: Awaited<ReturnType<typeof messe>>, ganz = false) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  const { text: _text, ...ohneText } = m;
  writeFileSync(join(BILDER, `messung-${name}.json`), JSON.stringify(ohneText, null, 2));
  await page.screenshot({ path: join(BILDER, `${name}.png`), fullPage: ganz });
}

function ohneQuerlauf(m: Awaited<ReturnType<typeof messe>>, fall: string) {
  expect(m.dokument, `${fall}: Querlauf des Dokuments`).toBe(0);
  expect(m.ueberstehend, `${fall}: überstehende Elemente`).toEqual([]);
}

function leisteOderReiter(m: Awaited<ReturnType<typeof messe>>, breite: number, aktiv: string, fall: string) {
  if (breite === 375) {
    // Am Telefon trägt die Leiste die vier Bereiche — was sie trägt, ist kein zweites Mal Reiter.
    expect(m.leiste, `${fall}: Kacheln`).toEqual(STANDORT_REITER);
    expect(m.leisteAktiv, `${fall}: offene Kachel`).toBe(aktiv);
    expect(m.reiter, `${fall}: Reiter am Telefon`).toEqual([]);
    for (const h of m.tippflaechen) expect(h, `${fall}: Tippfläche`).toBeGreaterThanOrEqual(44);
  } else {
    expect(m.leiste, `${fall}: keine Leiste am Rechner`).toBeNull();
    expect(m.reiter, `${fall}: Reiter`).toEqual(STANDORT_REITER);
    expect(m.reiterAktiv, `${fall}: offener Reiter`).toEqual([aktiv]);
  }
}

test.describe('AP-13 IP-2 · Ebenen-Seiten am Standort', () => {
  test('Standort › Gebäude (Werk Ahrenberg) bei 1440 und 375 px: Ortsbaum mit „Stand am“, drei Gebäude, keine Hülle ohne Inhalt', async ({ page }) => {
    for (const breite of [1440, 375]) {
      await oeffne(page, 'bild=unternehmen&ansicht=werk-gebaeude', breite);
      await expect(page.locator('[data-testid="ortsbaum"] .vp-ob-knoten').first()).toBeVisible();
      await expect(page.locator('[data-testid="stand-am"]')).toBeVisible();
      const m = await messe(page);
      ohneQuerlauf(m, `gebaeude-${breite}`);
      expect(m.route).toMatch(/^#\/standort\/[^/]+\/gebaeude$/);
      expect(m.titel).toBe('Gebäude');
      expect(m.gebaeude).toEqual(['Halle 1', 'Halle 2', 'Verwaltung']);
      // AP-13 IP-10: jedes Gebäude trägt jetzt seine Karte — der Aufklapper hat ein Ziel (die Blöcke prüft
      // `gebaeude-karte.spec.ts`).
      expect(m.aufklapper).toBe(3);
      leisteOderReiter(m, breite, 'Gebäude', `gebaeude-${breite}`);
      await ablegen(page, `gebaeude-${breite}`, m);
      await ablegen(page, `gebaeude-${breite}-ganz`, m, true);
    }
  });

  test('Standort › Anlagen (Werk Ahrenberg) bei 1440 und 375 px: die heutige Tabelle mit den zwei Anlagen, ohne die Bausteine der Übersicht', async ({ page }) => {
    for (const breite of [1440, 375]) {
      await oeffne(page, 'bild=unternehmen&ansicht=werk-anlagen', breite);
      await expect(page.locator(breite === 375 ? '.vp-at-karte' : 'table.vp-at').first()).toBeVisible();
      const m = await messe(page);
      ohneQuerlauf(m, `anlagen-${breite}`);
      expect(m.route).toMatch(/^#\/standort\/[^/]+\/anlagen$/);
      expect(m.titel).toBe('Anlagen');
      // Der Standort steht unter dem Titel — wie auf „Gebäude“ und „Messstellen“.
      await expect(page.locator('.vp-main .vp-portfolio-zahlen')).toHaveText(/^Werk Ahrenberg/);
      expect(m.anlagen).toHaveLength(2);
      expect(m.anlagen.join(' · ')).toContain('Halle 1');
      expect(m.anlagen.join(' · ')).toContain('Halle 2');
      expect(m.anlagen.join(' · ')).not.toContain('Lindach');
      // Kennzahlen-Leiste, „Anpassen“ und die Karte „Funktionen“ gehören der Übersicht; den Weg „Energiebilanz“ je Zeile bringt IP-8.
      expect(m.kennzahlLeiste).toBe(0);
      expect(m.funktionenKarte).toBe(0);
      await expect(page.locator('.vp-main').getByRole('button', { name: 'Anpassen' })).toHaveCount(0);
      // AP-13 IP-8: beide Anlagen haben einen Hauptzähler — je Zeile der Weg in ihren Reiter Verlauf › Energiebilanz.
      await expect(page.locator('.vp-main .vp-at-weg')).toHaveCount(2);
      leisteOderReiter(m, breite, 'Anlagen', `anlagen-${breite}`);
      await ablegen(page, `anlagen-${breite}`, m);
    }
  });

  test('AP-06 IP-16 · Standort › Boxen bei 1440 und 375 px: Rolle, Rückmeldung, Budget und Software je Box', async ({ page }) => {
    for (const breite of [1440, 375]) {
      await oeffne(page, 'bild=unternehmen&ansicht=werk-boxen', breite);
      const flaeche = page.getByTestId('standort-boxen');
      await expect(flaeche).toBeVisible();
      await expect(flaeche.locator('.vp-boxen-karte')).toHaveCount(2);
      await expect(flaeche).toContainText('Führt Werk Ahrenberg – Halle 1');
      await expect(flaeche).toContainText('Liefert Daten');
      await expect(flaeche).toContainText('Budget-Anteil');
      await expect(flaeche).toContainText('Update nötig für: Rückmeldung je Datenquelle');
      await expect(flaeche.getByRole('link', { name: 'Update planen' }).first()).toHaveAttribute('href', '#/edge-updates');
      const m = await messe(page);
      ohneQuerlauf(m, `boxen-${breite}`);
      expect(m.route).toMatch(/^#\/standort\/[^/]+\/boxen$/);
      expect(m.titel).toBe('Boxen');
      leisteOderReiter(m, breite, 'Boxen', `boxen-${breite}`);
      await ablegen(page, `boxen-${breite}`, m, true);
    }
  });

  test('AP-06 IP-16 · Box-Seite bei 1440 und 375 px: Datenquellen ersetzen die alte reine Geräteliste', async ({ page }) => {
    for (const breite of [1440, 375]) {
      await oeffne(page, 'bild=unternehmen&ansicht=box-halle1', breite);
      await expect(page.getByRole('heading', { name: 'Box Halle 1', level: 1 })).toBeVisible();
      await page.getByRole('button', { name: 'Datenquellen und Geräte' }).click();
      await expect(page.locator('.vp-box-quellen')).toContainText('DQ-1');
      await expect(page.locator('.vp-box-quellen')).toContainText('Liefert Daten');
      await expect(page.locator('.vp-box-quellen')).toContainText('Budget-Anteil');
      await expect(page.getByRole('link', { name: 'Update planen' })).toHaveAttribute('href', '#/edge-updates');
      const m = await messe(page);
      expect(m.dokument, `box-seite-${breite}: Querlauf des Dokuments`).toBe(0);
      expect(m.route).toMatch(/^#\/anlage\/[^/]+\/box\/VP-BOX-2024-0117$/);
      await ablegen(page, `box-seite-${breite}`, m, true);
    }
  });

  test('Z4 · Werk Lindach: eine Anlage — keine Kachel „Anlagen“, die Adresse zeigt trotzdem ihre Zeile; ohne Gebäude L1 und die Messbereiche', async ({ page }) => {
    await oeffne(page, 'bild=unternehmen&ansicht=lindach-anlagen', 375);
    await expect(page.locator('.vp-at-karte').first()).toBeVisible();
    const a = await messe(page);
    ohneQuerlauf(a, 'lindach-anlagen-375');
    expect(a.leiste).toEqual(['Übersicht', 'Boxen', 'Gebäude', 'Messstellen', 'Netzanschlüsse']);
    expect(a.anlagen).toHaveLength(1);
    await ablegen(page, 'lindach-anlagen-375', a);

    for (const breite of [1440, 375]) {
      await oeffne(page, 'bild=unternehmen&ansicht=lindach-gebaeude&orte=leer', breite);
      await expect(page.locator('[data-testid="ortsbaum-leer"]')).toBeVisible();
      await expect(page.locator('[data-testid="ortsbaum-leer"]')).toContainText('Gebäude sind optional');
      const m = await messe(page);
      ohneQuerlauf(m, `lindach-leer-${breite}`);
      expect(m.titel).toBe('Gebäude');
      // AP-10 IP-13: Übersicht · Messstellen · Netzanschlüsse tragen jetzt auch ohne Gebäude die Leiste.
      expect(m.leiste).toEqual(breite < 721 ? ['Übersicht', 'Boxen', 'Messstellen', 'Netzanschlüsse'] : null);
      expect(m.reiter).toEqual(breite < 721 ? [] : ['Übersicht', 'Boxen', 'Messstellen', 'Netzanschlüsse']);
      await ablegen(page, `lindach-leer-${breite}`, m);
    }
  });

  test('Ü8 · Einstiege auf der Standort-Übersicht führen zu „Berichte/Kennzahlen dieses Standorts“ — der Betriebskunde bekommt keinen', async ({ page }) => {
    await oeffne(page, 'bild=unternehmen&ansicht=werk', 375, AM_20_11);
    await expect(page.getByTestId('einstieg-berichte')).toBeVisible();
    const m = await messe(page);
    ohneQuerlauf(m, 'werk-einstiege-375');
    expect(m.einstiege).toEqual(['Kennzahlen dieses Standorts', 'Berichte dieses Standorts']);
    for (const h of m.tippflaechen) expect(h).toBeGreaterThanOrEqual(44);
    await ablegen(page, 'werk-einstiege-375', m);

    await page.getByTestId('einstieg-berichte').click();
    await expect(page.locator('body')).toHaveAttribute('data-route', /^#\/standort\/[^/]+\/berichte$/);
    await expect(page.locator('[data-testid="bericht-karte"]').first()).toBeVisible();
    const b = await messe(page);
    ohneQuerlauf(b, 'werk-berichte-375');
    expect(b.titel).toBe('Berichte dieses Standorts');
    expect(b.leisteAktiv).toBe('Übersicht');
    await ablegen(page, 'werk-berichte-375', b);
    // Die Berichtsseite bleibt im Standort, und der Rückweg sagt, wohin er führt.
    await page.locator('[data-testid="bericht-karte"]').first().click();
    await expect(page.locator('body')).toHaveAttribute('data-route', /^#\/standort\/[^/]+\/berichte\/BR-2026-0001$/);
    await page.getByRole('button', { name: 'Berichte dieses Standorts' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-route', /^#\/standort\/[^/]+\/berichte$/);

    await oeffne(page, 'bild=unternehmen&ansicht=werk', 1440, AM_20_11);
    await page.getByTestId('einstieg-kennzahlen').click();
    await expect(page.locator('body')).toHaveAttribute('data-route', /^#\/standort\/[^/]+\/kennzahlen$/);
    await expect(page.locator('[data-testid="kennzahl-karte"]').first()).toBeVisible();
    const k = await messe(page);
    ohneQuerlauf(k, 'werk-kennzahlen-1440');
    expect(k.titel).toBe('Kennzahlen dieses Standorts');
    const amStandort = await page.locator('[data-testid="kennzahl-karte"]').count();
    await ablegen(page, 'werk-kennzahlen-1440', k);

    // Das Lesezeichen des Unternehmens gilt unverändert — und zeigt auch die Kennzahlen, die dort nicht gelten.
    await oeffne(page, 'bild=unternehmen&ansicht=kennzahlen', 1440, AM_20_11);
    await expect(page.locator('[data-testid="kennzahl-karte"]').first()).toBeVisible();
    const u = await messe(page);
    expect(u.route).toBe('#/portfolio/kennzahlen');
    expect(u.titel).toBe('Kennzahlen');
    expect(await page.locator('[data-testid="kennzahl-karte"]').count()).toBeGreaterThan(amStandort);

    await oeffne(page, 'bild=unternehmen&messen=bestand&ansicht=werk', 375, AM_20_11);
    const betrieb = await messe(page);
    ohneQuerlauf(betrieb, 'betriebskunde-werk-375');
    expect(betrieb.einstiege).toEqual([]);
  });

  test('oberste Ebene (nur Werk Ahrenberg) bei 1440 px: die Reiter tragen Boxen, Gebäude und Anlagen — auf ihrer Seite ist „Übersicht“ nicht gewählt', async ({ page }) => {
    await oeffne(page, 'bild=standort', 1440);
    const m = await messe(page);
    ohneQuerlauf(m, 'oben-1440');
    expect(m.reiter.slice(0, 4)).toEqual(['Übersicht', 'Boxen', 'Gebäude', 'Anlagen']);
    expect(m.reiterAktiv).toEqual(['Übersicht']);
    await page.getByRole('tab', { name: 'Gebäude' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-route', /^#\/standort\/[^/]+\/gebaeude$/);
    await expect(page.locator('[data-testid="ortsbaum"]')).toBeVisible();
    const g = await messe(page);
    ohneQuerlauf(g, 'oben-gebaeude-1440');
    expect(g.reiterAktiv).toEqual(['Gebäude']);
    await ablegen(page, 'oben-gebaeude-1440', g);
    await page.getByRole('tab', { name: 'Übersicht' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-route', /^#\/standort\/[^/]+$/);
  });
});


test('O18 · Betriebskunde: nur Übersicht und Boxen; alte AP-13-Direktlinks landen auf der Übersicht', async ({ page }) => {
  for (const breite of [1440, 375]) {
    let uebersichtText = '';
    for (const bereich of ['', '-gebaeude', '-anlagen', '-kennzahlen', '-berichte']) {
      await oeffne(page, `bild=unternehmen&messen=bestand&ansicht=werk${bereich}`, breite);
      const m = await messe(page);
      ohneQuerlauf(m, `betrieb${bereich}-${breite}`);
      expect(m.titel).toBe('Werk AhrenbergST-1');
      if (!bereich) uebersichtText = m.text;
      expect(m.text).toBe(uebersichtText);
      expect(m.leiste).toBeNull();
      expect(m.reiter).toEqual(['Übersicht', 'Boxen']);
      expect(m.einstiege).toEqual([]);
      await expect(page.getByTestId('uebersicht-bausteine')).toHaveCount(0);
      if (!bereich) await ablegen(page, `betrieb-${breite}`, m, true);
    }
  }
});
