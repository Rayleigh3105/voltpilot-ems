import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * UEMS AP-13 IP-2 — die Ebenen-Seiten am Standort (E4, Ü7, Ü8; O17, O18) auf der Bühne `startansicht`, bei 375 und
 * 1440 px: Standort › Gebäude (Ortsbaum mit „Stand am …“), Standort › Aufbau (der EINE Ort für Anlagen, Boxen, Datenquellen
 * und Geräte — früher „Boxen“ und „Anlagen“), Kennzahlen und Berichte des Standorts mit ihren Einstiegen auf der Übersicht,
 * die Leerzustände Z4 und die Reiter der obersten Ebene.
 *
 * Querlauf GEMESSEN am Dokument und an jedem sichtbaren Element des Hauptbereichs. Mit `STANDORT_EBENEN_BILDER=<Ordner>`
 * legt der Lauf je Fall ein Bild und `messung-<fall>.json` ab — die Vorschau.
 * Die Spec importiert keine Fixtures (sie laden `api.ts`, dem im Node-Lauf `import.meta.env` fehlt).
 */

const BILDER = process.env.STANDORT_EBENEN_BILDER;
const JETZT = new Date('2026-10-20T08:15:30Z');
const AM_20_11 = new Date('2026-11-20T08:00:00Z');
// N1: dieselben Bereiche stehen am Rechner in der Seitenleiste (volle Wörter).
const STANDORT_SEITE = ['Übersicht', 'Aufbau', 'Gebäude', 'Messstellen', 'Netzanschlüsse'];
// Die Leiste trägt höchstens fünf Kacheln und kürzt „Netzanschlüsse“ (`ebenenNav.LEISTE_KURZ`).
const STANDORT_LEISTE = ['Übersicht', 'Aufbau', 'Gebäude', 'Messstellen', 'Anschlüsse'];

async function oeffne(page: Page, query: string, breite: number, jetzt = JETZT) {
  await page.clock.setFixedTime(jetzt);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/startansicht.html?${query}`);
  await expect(page.locator('.vp-topbar').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  // Endlose Animationen (der Live-Punkt im Kopf der Geräte-/Box-Seite seit main d1b97ac39) enden nie — gewartet wird
  // auf alle endlichen.
  await page.waitForFunction(() => document.getAnimations()
    .every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity));
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
      // N1: die Einträge der Ebene in der Seitenleiste (am Telefon verborgen).
      seite: texte('.vp-ebenennav .vp-navitem .vp-nav-lbl'),
      seiteAktiv: texte('.vp-ebenennav .vp-navitem[aria-current="page"] .vp-nav-lbl')[0] ?? null,
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

function leisteOderSeite(m: Awaited<ReturnType<typeof messe>>, breite: number, aktiv: string, fall: string) {
  if (breite === 375) {
    // Am Telefon trägt die Leiste die Bereiche — was sie trägt, ist kein zweites Mal Reiter.
    expect(m.leiste, `${fall}: Kacheln`).toEqual(STANDORT_LEISTE);
    expect(m.leisteAktiv, `${fall}: offene Kachel`).toBe(aktiv);
    expect(m.reiter, `${fall}: Reiter am Telefon`).toEqual([]);
    for (const h of m.tippflaechen) expect(h, `${fall}: Tippfläche`).toBeGreaterThanOrEqual(44);
  } else {
    // N1: am Rechner trägt die Seitenleiste dieselben Bereiche — über der Seite steht keine Reihe derselben Bereiche.
    expect(m.leiste, `${fall}: keine Leiste am Rechner`).toBeNull();
    expect(m.seite, `${fall}: Seitenleiste`).toEqual(STANDORT_SEITE);
    expect(m.seiteAktiv, `${fall}: offener Eintrag`).toBe(aktiv);
    expect(m.reiter, `${fall}: Reiter`).toEqual([]);
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
      leisteOderSeite(m, breite, 'Gebäude', `gebaeude-${breite}`);
      await ablegen(page, `gebaeude-${breite}`, m);
      await ablegen(page, `gebaeude-${breite}-ganz`, m, true);
    }
  });

  test('Standort › Aufbau (Werk Ahrenberg) bei 1440 und 375 px: EIN Baum für Anlagen, Boxen, Datenquellen und Geräte — und EIN „Hinzufügen“', async ({ page }) => {
    for (const breite of [1440, 375]) {
      await oeffne(page, 'bild=unternehmen&ansicht=werk-aufbau', breite);
      const flaeche = page.getByTestId('standort-aufbau');
      await expect(flaeche.locator('.vp-auf-t-zeile.is-anlage').first()).toBeVisible();
      const m = await messe(page);
      ohneQuerlauf(m, `aufbau-${breite}`);
      expect(m.route).toMatch(/^#\/standort\/[^/]+\/aufbau$/);
      expect(m.titel).toBe('Aufbau');
      // Beide Anlagen des Standorts, keine fremde; die erste ist aufgeklappt.
      const anlagen = flaeche.locator('.vp-auf-t-zeile.is-anlage');
      await expect(anlagen).toHaveCount(2);
      await expect(anlagen.nth(0)).toContainText('Werk Ahrenberg – Halle 1');
      await expect(anlagen.nth(1)).toContainText('Werk Ahrenberg – Halle 2');
      await expect(flaeche).not.toContainText('Lindach');
      await expect(flaeche).not.toContainText('Sie sind hier');
      // Die Box nennt ihre Datenquellen (AP-06) — sie stehen im Baum unter ihr, mit Weg und Rückmeldung.
      await expect(flaeche).toContainText('Box Halle 1');
      await expect(flaeche).toContainText('liest 3 Datenquellen');
      const quellen = flaeche.locator('.vp-auf-t-zeile.is-quelle');
      await expect(quellen).toHaveCount(3);
      await expect(quellen.first()).toContainText('DQ-1');
      await expect(quellen.first()).toContainText('Modbus TCP · 192.168.10.21');
      await expect(quellen.first()).toContainText('Liefert Daten');
      // Die andere Anlage öffnet sich hier, im Standort — nicht in der Anlage.
      await expect(anlagen.nth(1).getByRole('link', { name: /öffnen/i })).toHaveAttribute('href', /^#\/standort\/[^/]+\/aufbau\?anlage=/);
      // EIN Ort zum Hinzufügen: Gerät, VoltPilot-Box und Anlage stehen hier — und nur hier.
      await expect(flaeche.getByRole('button', { name: 'Gerät hinzufügen' }).first()).toBeVisible();
      await flaeche.getByRole('button', { name: 'Box oder Anlage hinzufügen' }).click();
      await expect(page.getByRole('menuitem', { name: 'VoltPilot-Box hinzufügen' })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: 'Anlage hinzufügen' })).toBeVisible();
      await page.keyboard.press('Escape');
      leisteOderSeite(m, breite, 'Aufbau', `aufbau-${breite}`);
      await ablegen(page, `aufbau-${breite}`, m, true);
    }
  });

  test('AP-06 IP-16 · Box-Seite bei 1440 und 375 px: Datenquellen ersetzen die alte reine Geräteliste', async ({ page }) => {
    for (const breite of [1440, 375]) {
      await oeffne(page, 'bild=unternehmen&ansicht=box-halle1', breite);
      await expect(page.getByRole('heading', { name: 'Box Halle 1', level: 1 })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Datenquellen und Geräte' })).toBeVisible(); // seit main d1b97ac39 eine offene Karte
      await expect(page.locator('.vp-box-quellen')).toContainText('DQ-1');
      await expect(page.locator('.vp-box-quellen')).toContainText('Liefert Daten');
      await expect(page.locator('.vp-box-quellen')).toContainText('Budget-Anteil');
      // „Update planen“ steht seit main d1b97ac39 in „Gerät & Verbindung“ — am Telefon zugeklappt.
      const details = page.getByTestId('baustein-details');
      if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open))) await details.locator(':scope > summary').click();
      await expect(page.getByRole('link', { name: 'Update planen' })).toHaveAttribute('href', '#/edge-updates');
      const m = await messe(page);
      expect(m.dokument, `box-seite-${breite}: Querlauf des Dokuments`).toBe(0);
      expect(m.route).toMatch(/^#\/anlage\/[^/]+\/box\/VP-BOX-2024-0117$/);
      await ablegen(page, `box-seite-${breite}`, m, true);
    }
  });

  test('AP-06 IP-12 · Quellenübergabe: Prüfung, Folgen, geplanter Wechsel und Rücknahme bei 375/1440', async ({ page }) => {
    for (const breite of [375, 1440]) {
      await oeffne(page, 'bild=unternehmen&ansicht=box-halle1', breite);
      await expect(page.getByRole('heading', { name: 'Datenquellen und Geräte' })).toBeVisible(); // seit main d1b97ac39 eine offene Karte
      await page.getByRole('button', { name: 'Zuständige Box wechseln' }).first().click();
      const dialog = page.getByRole('dialog', { name: 'Zuständige Box wechseln' });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel('Geplant').check();
      await dialog.getByRole('button', { name: 'Von Box Halle 2 prüfen' }).click();
      await expect(dialog).toContainText('Erreichbar · 38 ms');
      await dialog.getByRole('button', { name: 'Folgen prüfen' }).click();
      await expect(dialog).toContainText('Die Messstellen an DQ-2 behalten ihre Quelle.');
      await expect(dialog).toContainText('kurzen Lücke (unter 1 Minute), sichtbar im Verlauf');
      expect((await messe(page)).dokument).toBe(0);
      if (BILDER) await page.screenshot({ path: join(BILDER, `quellenwechsel-folgen-${breite}.png`), fullPage: true });
      await dialog.getByRole('button', { name: 'Wechsel bestätigen' }).click();
      const aktualisiert = page.getByRole('dialog', { name: 'Zuständigkeit aktualisiert' });
      await expect(aktualisiert).toContainText('Der Wechsel ist geplant.');
      await aktualisiert.getByRole('button', { name: 'Schließen' }).last().click();

      await page.getByRole('button', { name: 'Zuständige Box wechseln' }).first().click();
      const erneut = page.getByRole('dialog', { name: 'Zuständige Box wechseln' });
      await erneut.getByRole('button', { name: 'Geplanten Wechsel zurücknehmen' }).click();
      await expect(erneut).toContainText('bleibt zuständig');
      await erneut.getByRole('button', { name: 'Rücknahme bestätigen' }).click();
      await expect(page.getByRole('dialog', { name: 'Zuständigkeit aktualisiert' }))
        .toContainText('Der geplante Wechsel wurde zurückgenommen.');
    }
  });

  test('AP-06 IP-12 · Box-Tausch beim Claim bleibt bei ausstehender Zustellung ehrlich (375)', async ({ page }) => {
    await oeffne(page, 'bild=unternehmen&ansicht=box-halle1', 375);
    // „Box tauschen“ steht seit main d1b97ac39 im Menü „⋯“ (Weitere Aktionen) des Box-Kopfs.
    await page.getByRole('button', { name: 'Weitere Aktionen' }).click();
    await page.getByRole('menuitem', { name: 'Box tauschen' }).click();
    const dialog = page.getByRole('dialog', { name: 'Box tauschen' });
    await dialog.getByLabel('Geräte-ID *').fill('VP-BOX-2027-0090');
    await dialog.getByRole('button', { name: 'VoltPilot-Box hinzufügen' }).click();
    await expect(dialog).toContainText('Der Tausch ist noch nicht bestätigt.');
    await expect(dialog).toContainText('Heimat-Anlage, Rolle führende Box');
    await expect(dialog).toContainText('Werte und Protokolle bleiben');
    if (BILDER) await page.screenshot({ path: join(BILDER, 'box-tausch-folgen-375.png'), fullPage: true });
    await dialog.getByRole('button', { name: 'Box-Tausch bestätigen' }).click();
    await expect(dialog).toContainText('wird zugestellt, sobald die Box erreichbar ist');
  });

  test('Z4 · Werk Lindach: eine Anlage — ihr Aufbau zeigt genau sie; ohne Gebäude L1 und die Messbereiche', async ({ page }) => {
    await oeffne(page, 'bild=unternehmen&ansicht=lindach-aufbau', 375);
    await expect(page.locator('.vp-auf-t-zeile.is-anlage').first()).toBeVisible();
    const a = await messe(page);
    ohneQuerlauf(a, 'lindach-aufbau-375');
    expect(a.leiste).toEqual(['Übersicht', 'Aufbau', 'Gebäude', 'Messstellen', 'Anschlüsse']);
    await expect(page.locator('.vp-auf-t-zeile.is-anlage')).toHaveCount(1);
    await ablegen(page, 'lindach-aufbau-375', a);

    for (const breite of [1440, 375]) {
      await oeffne(page, 'bild=unternehmen&ansicht=lindach-gebaeude&orte=leer', breite);
      await expect(page.locator('[data-testid="ortsbaum-leer"]')).toBeVisible();
      await expect(page.locator('[data-testid="ortsbaum-leer"]')).toContainText('Gebäude sind optional');
      const m = await messe(page);
      ohneQuerlauf(m, `lindach-leer-${breite}`);
      expect(m.titel).toBe('Gebäude');
      // AP-10 IP-13: Übersicht · Messstellen · Netzanschlüsse tragen jetzt auch ohne Gebäude die Leiste. N1: am Rechner
      // stehen dieselben Bereiche in der Seitenleiste.
      expect(m.leiste).toEqual(breite < 721 ? ['Übersicht', 'Aufbau', 'Messstellen', 'Anschlüsse'] : null);
      expect(m.seite).toEqual(breite < 721 ? [] : ['Übersicht', 'Aufbau', 'Messstellen', 'Netzanschlüsse']);
      expect(m.reiter).toEqual([]);
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
    // Konzept Auswerten a1 §6.4: Karten mit Bezugsbasis, Reihen zum Beobachten - beide tragen `data-kennzeichen`.
    await expect(page.locator('[data-kennzeichen]').first()).toBeVisible();
    const k = await messe(page);
    ohneQuerlauf(k, 'werk-kennzahlen-1440');
    expect(k.titel).toBe('Kennzahlen dieses Standorts');
    const amStandort = await page.locator('[data-kennzeichen]').count();
    await ablegen(page, 'werk-kennzahlen-1440', k);

    // Das Lesezeichen des Unternehmens gilt unverändert — und zeigt auch die Kennzahlen, die dort nicht gelten.
    await oeffne(page, 'bild=unternehmen&ansicht=kennzahlen', 1440, AM_20_11);
    await expect(page.locator('[data-kennzeichen]').first()).toBeVisible();
    const u = await messe(page);
    expect(u.route).toBe('#/portfolio/kennzahlen');
    expect(u.titel).toBe('Kennzahlen');
    expect(await page.locator('[data-kennzeichen]').count()).toBeGreaterThan(amStandort);

    await oeffne(page, 'bild=unternehmen&messen=bestand&ansicht=werk', 375, AM_20_11);
    const betrieb = await messe(page);
    ohneQuerlauf(betrieb, 'betriebskunde-werk-375');
    expect(betrieb.einstiege).toEqual([]);
  });

  test('oberste Ebene (nur Werk Ahrenberg) bei 1440 px: die Seitenleiste trägt Aufbau, Gebäude und Netzanschlüsse — auf ihrer Seite ist „Übersicht“ nicht gewählt', async ({ page }) => {
    await oeffne(page, 'bild=standort', 1440);
    const m = await messe(page);
    ohneQuerlauf(m, 'oben-1440');
    // N1: die Bereiche des Standorts stehen in der Seitenleiste, über der Seite nur die Reiter der Übersicht.
    expect(m.seite).toEqual(['Übersicht', 'Aufbau', 'Gebäude', 'Messstellen', 'Netzanschlüsse']);
    expect(m.seiteAktiv).toBe('Übersicht');
    for (const b of ['Aufbau', 'Gebäude', 'Netzanschlüsse']) expect(m.reiter).not.toContain(b);
    expect(m.reiterAktiv).toEqual(['Übersicht']);
    await page.getByTestId('seitenleiste-gebaeude').click();
    await expect(page.locator('body')).toHaveAttribute('data-route', /^#\/standort\/[^/]+\/gebaeude$/);
    await expect(page.locator('[data-testid="ortsbaum"]')).toBeVisible();
    const g = await messe(page);
    ohneQuerlauf(g, 'oben-gebaeude-1440');
    expect(g.seiteAktiv).toBe('Gebäude');
    expect(g.reiterAktiv).toEqual([]);
    await ablegen(page, 'oben-gebaeude-1440', g);
    await page.getByTestId('seitenleiste-uebersicht').click();
    await expect(page.locator('body')).toHaveAttribute('data-route', /^#\/standort\/[^/]+$/);
  });
});


for (const breite of [1440, 375]) {
  test(`O18 · Betriebskunde bei ${breite} px: keine neuen Standort-Reiter; alte AP-13-Direktlinks landen auf der Übersicht`, async ({ page }) => {
    test.slow(); // sieben Adressen nacheinander, jede lädt die ganze Bühne
    let uebersichtText = '';
    for (const bereich of ['', '-gebaeude', '-aufbau', '-anlagen', '-boxen', '-kennzahlen', '-berichte']) {
      await oeffne(page, `bild=unternehmen&messen=bestand&ansicht=werk${bereich}`, breite);
      const m = await messe(page);
      ohneQuerlauf(m, `betrieb${bereich}-${breite}`);
      expect(m.titel).toBe('Werk AhrenbergST-1');
      if (!bereich) uebersichtText = m.text;
      expect(m.text).toBe(uebersichtText);
      expect(m.leiste).toBeNull();
      expect(m.reiter).toEqual([]);
      expect(m.einstiege).toEqual([]);
      await expect(page.getByTestId('uebersicht-bausteine')).toHaveCount(0);
      if (!bereich) await ablegen(page, `betrieb-${breite}`, m, true);
    }
  });
}
