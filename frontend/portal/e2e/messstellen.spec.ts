import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { FIXTURE_IDS } from '../src/test/standorteFixtures';

/**
 * Die Liste „Messstellen“ (Konzept Messen m1, §6.2/§6.3; UEMS AP-04 IP-5) bei 1440 und 375 px auf der Bühne
 * `startansicht` - die ECHTE Schale mit der ECHTEN Leiste und den ECHTEN Reitern, dieselben reinen Funktionen wie
 * `App.tsx`, das Register des Referenzunternehmens (heute = 20.10.2026 10:15, `src/test/messstellenRegisterFixtures.ts`).
 *
 * GEMESSEN, nicht behauptet: Querlauf des Dokuments (`scrollWidth − clientWidth`), jedes Element, das über den
 * Bildrand ragt (außer in einem lokal scrollenden Rahmen), die Kacheln der Leiste und die SICHTBAREN Reiter.
 *
 * Mit `MESSSTELLEN_BILDER=<Ordner>` legt der Lauf je Fall ein Bild und `messung-<fall>.json` ab - die Vorschau für
 * die Freigabe.
 */

const BILDER = process.env.MESSSTELLEN_BILDER;
const JETZT = new Date('2026-10-20T08:15:30Z');

async function oeffne(page: Page, query: string, breite: number) {
  await page.clock.setFixedTime(JETZT);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/startansicht.html?${query}`);
  await expect(page.locator('.vp-topbar').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
}

async function warteAufListe(page: Page) {
  await expect(page.locator('[data-testid="messstellen"] [data-testid="messstelle-reihe"]').first()).toBeVisible();
}

const reihe = (page: Page, kz: string) =>
  page.getByTestId('messstelle-reihe').filter({ has: page.locator('.vp-ms-kz', { hasText: new RegExp(`^${kz}$`) }) });

async function messe(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const breite = doc.clientWidth;
    const sichtbar = (e: Element) => (e as HTMLElement).offsetParent !== null || getComputedStyle(e).position === 'fixed';
    const bar = document.querySelector<HTMLElement>('.vp-bottombar');
    const leisteSichtbar = bar !== null && getComputedStyle(bar).display !== 'none';
    const ueberstehend = [...document.querySelectorAll<HTMLElement>('.vp-main *')]
      .filter((e) => sichtbar(e) && !e.closest('.vp-bereich-tabs'))
      .filter((e) => e.getBoundingClientRect().right > breite + 0.5)
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`);
    return {
      route: document.body.dataset.route ?? null,
      breite,
      dokument: doc.scrollWidth - doc.clientWidth,
      ueberstehend: [...new Set(ueberstehend)],
      leiste: leisteSichtbar ? [...bar!.querySelectorAll('.vp-bottombar-item .lbl')].map((l) => l.textContent ?? '') : null,
      leisteAktiv: leisteSichtbar ? bar!.querySelector('[aria-current="page"] .lbl')?.textContent ?? null : null,
      // Gemeint sind die Reiter der EBENEN und Welten - nicht das Zeit-Segment (`.vp-seg`) und nicht die Reiter
      // INNERHALB der Welt Messstellen (`.vp-ms-reiter`: Liste · Kostenstellen · Prozesse).
      reiter: [...document.querySelectorAll<HTMLElement>('[role="tablist"]:not(.vp-seg):not(.vp-ms-reiter) [role="tab"]')].filter(sichtbar).map((t) => t.textContent?.trim() ?? ''),
      reiterAktiv: [...document.querySelectorAll<HTMLElement>('[role="tablist"]:not(.vp-seg):not(.vp-ms-reiter) [role="tab"][aria-selected="true"]')].filter(sichtbar).map((t) => t.textContent?.trim() ?? ''),
      // N1: die Einträge der Ebene in der Seitenleiste (am Telefon verborgen) - ohne die Frage des offenen Eintrags.
      seite: [...document.querySelectorAll<HTMLElement>('.vp-ebenennav .vp-navitem')]
        .filter(sichtbar)
        .map((e) => (e.querySelector('.vp-nav-zwei > span:first-child') ?? e.querySelector('.vp-nav-lbl'))?.textContent?.trim() ?? ''),
      seiteAktiv:
        [...document.querySelectorAll<HTMLElement>('.vp-ebenennav .vp-navitem[aria-current="page"]')]
          .filter(sichtbar)
          .map((e) => (e.querySelector('.vp-nav-zwei > span:first-child') ?? e.querySelector('.vp-nav-lbl'))?.textContent?.trim() ?? '')[0] ?? null,
      reihen: document.querySelectorAll('[data-testid="messstelle-reihe"]').length,
      orte: [...document.querySelectorAll('[data-testid="messstellen-ort"] h2')].map((h) => h.textContent ?? ''),
      nochNicht: [...document.querySelectorAll('[data-testid="messstellen-noch-nicht"] .vp-ms-kz')].map((e) => e.textContent ?? ''),
      // Die Statuszeile (der Satz des Servers) bzw. die Hinweiskarten an ihrer Stelle.
      lage: document.querySelector('[data-testid="messstellen-status"], [data-testid="messstellen-hinweise"]')?.textContent ?? null,
      kopf: document.querySelector('.vp-ms-kopf .vp-ms-meta')?.textContent ?? null,
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

test.describe('Messstellen-Liste', () => {
  test('Unternehmen › Messstellen bei 1440 px: je Ort eine Karte, Reiter „Messstellen“, 0 px Überlauf', async ({ page }) => {
    await oeffne(page, 'bild=unternehmen&ansicht=messstellen', 1440);
    await warteAufListe(page);
    // N5: die Reihe von „Messen“ ist vollständig, sobald die Kataloge der Kostenstellen und Prozesse da sind.
    await expect(page.getByTestId('messstellen-reiter-prozesse')).toBeVisible();
    const m = await messe(page);
    ohneQuerlauf(m, 'unternehmen-1440');
    expect(m.route).toBe('#/portfolio/messstellen');
    expect(m.reihen).toBe(22);
    expect(m.orte).toHaveLength(14);
    expect(m.orte.slice(0, 3)).toEqual(['Unternehmen', 'Werk Ahrenberg', 'Halle 1']);
    expect(m.kopf).toBe('Wo Ihr Verbrauch gemessen, abgelesen oder berechnet wird – nach Ort geordnet.');
    expect(m.lage).toBe('21 von 22 Messstellen liefern Daten');
    // N1: am Rechner die Gruppen in der Seitenleiste, über der Seite die Reiter der offenen Gruppe „Messen“.
    expect(m.seite).toEqual(['Übersicht', 'Messen', 'Auswerten', 'Nachweisen']);
    expect(m.seiteAktiv).toBe('Messen');
    expect(m.reiter).toEqual(['Messstellen', 'Kostenstellen', 'Prozesse', 'Bezugsgrößen']);
    expect(m.reiterAktiv).toEqual(['Messstellen']);
    expect(m.leiste).toBeNull();
    // Die Spalten am Rechner: dieselben Wörter wie die Reihen am Telefon.
    await expect(page.locator('.vp-ms-spalten').first()).toHaveText(/MessstelleZustandWoher die Werte kommenLetzter Stand/);
    await expect(page.locator('.vp-ms-kopf').getByRole('button', { name: 'Messstelle anlegen' })).toBeVisible();
    await ablegen(page, 'unternehmen-1440', m);
    await ablegen(page, 'unternehmen-1440-ganz', m, true);
  });

  test('Unternehmen › Messstellen bei 375 px: Reihen, Leiste mit „Messen“ offen, darüber nur deren Reiter', async ({ page }) => {
    await oeffne(page, 'bild=unternehmen&ansicht=messstellen', 375);
    await warteAufListe(page);
    await expect(page.getByTestId('messstellen-reiter-prozesse')).toBeVisible();
    const m = await messe(page);
    ohneQuerlauf(m, 'unternehmen-375');
    expect(m.reihen).toBe(22);
    expect(m.leiste).toEqual(['Übersicht', 'Messen', 'Auswerten', 'Nachweisen']);
    expect(m.leisteAktiv).toBe('Messen');
    expect(m.reiter).toEqual(['Messstellen', 'Kostenstellen', 'Prozesse', 'Bezugsgrößen']);
    expect(m.reiterAktiv).toEqual(['Messstellen']);
    // Am Telefon steht „Messstelle anlegen“ im Menü ⋯, nicht im Kopf.
    await expect(page.locator('.vp-ms-kopf').getByRole('button', { name: 'Messstelle anlegen' })).toHaveCount(0);
    // Eine Reihe ist mindestens 56 px hoch (Ziel für den Daumen).
    const hoehe = await reihe(page, 'MS-06').evaluate((e) => e.getBoundingClientRect().height);
    expect(hoehe).toBeGreaterThanOrEqual(56);
    await ablegen(page, 'unternehmen-375', m);
  });

  test('woher die Werte kommen: das Gerät mit Komponente und Messwert, „noch keine Quelle“ - bei 1440 und 375 px', async ({ page }) => {
    test.slow();
    for (const breite of [1440, 375]) {
      await oeffne(page, 'bild=unternehmen&ansicht=messstellen', breite);
      await warteAufListe(page);
      const ms10 = reihe(page, 'MS-10');
      await expect(ms10).toContainText('Liefert Daten');
      if (breite === 1440) {
        await expect(ms10.locator('.vp-ms-reihe-woher')).toHaveText(
          'automatisch vom GerätZähler Energiekarte EK-1 (Hauptmessung Halle 2) · Wirkenergie Bezug',
        );
      } else {
        await expect(ms10.locator('.vp-ms-reihe-satz')).toHaveText('Liefert Daten · vom Gerät');
      }
      await expect(reihe(page, 'MS-21').locator('.vp-ms-reihe-satz')).toHaveText('Noch keine Quelle · zuordnen');
      const m = await messe(page);
      ohneQuerlauf(m, `woher-${breite}`);
      await ablegen(page, `woher-${breite}`, m);
    }
  });

  test('A4 · Einstellungsänderung steht an MS-01 und MS-02 bei 1440 und 375 px als leise Tatsache unter dem Zustand', async ({ page }) => {
    test.slow();
    for (const breite of [1440, 375]) {
      await oeffne(page, 'bild=unternehmen&ansicht=messstellen&stand=2027-01-15', breite);
      await warteAufListe(page);
      for (const kz of ['MS-01', 'MS-02']) {
        await expect(reihe(page, kz).locator('.vp-ms-reihe-fakt')).toHaveText('Einstellung geändert ab 15.01.2027 09:00');
      }
      const m = await messe(page);
      ohneQuerlauf(m, `einstellungsfakt-${breite}`);
      await ablegen(page, `einstellungsfakt-${breite}`, m);
    }
  });

  test('Standort › Messstellen (Werk Ahrenberg) bei 1440 und 375 px: Übersicht · Aufbau · Gebäude · Messstellen, 16 Messstellen', async ({ page }) => {
    test.slow();
    for (const breite of [1440, 375]) {
      await oeffne(page, 'bild=unternehmen&ansicht=werk-messstellen', breite);
      await warteAufListe(page);
      const m = await messe(page);
      ohneQuerlauf(m, `werk-${breite}`);
      expect(m.route).toBe(`#/standort/${FIXTURE_IDS.st1}/messstellen`);
      expect(m.reihen).toBe(16);
      // AP-13 IP-2: die Bereiche des Standorts. N1: am Rechner in der Seitenleiste, am Telefon in der Leiste.
      expect(m.seite).toEqual(breite === 375 ? [] : ['Übersicht', 'Aufbau', 'Gebäude', 'Messstellen', 'Netzanschlüsse']);
      expect(m.seiteAktiv).toBe(breite === 375 ? null : 'Messstellen');
      expect(m.reiter).toEqual([]);
      expect(m.reiterAktiv).toEqual([]);
      expect(m.leiste).toEqual(breite === 375 ? ['Übersicht', 'Aufbau', 'Gebäude', 'Messstellen', 'Anschlüsse'] : null);
      if (breite === 375) expect(m.leisteAktiv).toBe('Messstellen');
      expect(m.kopf).toBe('Werk Ahrenberg · Wo Ihr Verbrauch gemessen, abgelesen oder berechnet wird – nach Ort geordnet.');
      expect(m.lage).toBe('15 von 16 Messstellen liefern Daten');
      await ablegen(page, `werk-${breite}`, m);
    }
  });

  test('„Summenwert anlegen“ gibt es unter Messen nicht mehr (Konzept §6.10) - weder im Kopf noch im Menü', async ({ page }) => {
    test.slow();
    for (const breite of [1440, 375]) {
      await oeffne(page, 'bild=unternehmen&ansicht=werk-messstellen', breite);
      await warteAufListe(page);
      await expect(page.getByRole('combobox', { name: /Summenwert anlegen/ })).toHaveCount(0);
      await page.getByRole('button', { name: 'Weitere Aktionen' }).click();
      // Erst muss das Menü offen sein, dann zählt, dass KEIN Eintrag „Summenwert“ heißt (`not.toHaveText([…])` bestand
      // bei zwei oder mehr Einträgen immer).
      await expect(page.getByRole('menuitem', { name: /Korrekturen am Standort/ })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: /Summenwert/ })).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText('Summenwert');
      await page.keyboard.press('Escape');
    }
  });

  test('„Messstelle anlegen“ in Standort › Messstellen: am Rechner der Knopf im Kopf, am Telefon im Menü - der Dialog ohne Überlauf', async ({ page }) => {
    test.slow();
    for (const breite of [1440, 375]) {
      await oeffne(page, 'bild=unternehmen&ansicht=werk-messstellen', breite);
      await warteAufListe(page);
      if (breite === 1440) {
        const knopf = page.locator('.vp-ms-kopf').getByRole('button', { name: 'Messstelle anlegen' });
        await expect(knopf).toBeVisible();
        await knopf.click();
      } else {
        await page.getByRole('button', { name: 'Weitere Aktionen' }).click();
        await page.getByRole('menuitem', { name: 'Messstelle anlegen' }).click();
      }
      const dialog = page.getByRole('dialog', { name: 'Messstelle anlegen' });
      await expect(dialog).toBeVisible();
      await expect(page.getByLabel('Kennzeichen', { exact: true })).toHaveValue('MS-0023');
      await expect(page.locator('.vp-modal').last()).toHaveCSS('opacity', '1');
      await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
      const d = await page.evaluate(() => {
        const koerper = document.querySelector<HTMLElement>('.vp-modal .dbody');
        return {
          dokument: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          dialog: koerper ? koerper.scrollWidth - koerper.clientWidth : null,
        };
      });
      expect(d.dokument, `anlegen-dialog-${breite}: Dokument`).toBe(0);
      expect(d.dialog, `anlegen-dialog-${breite}: Dialog`).toBe(0);
      await ablegen(page, `anlegen-dialog-${breite}`, d);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await warteAufListe(page);
    }
  });

  test('„Stand an einem Tag ansehen“ (10.10.2026) bei 1440 und 375 px: die Marke „Stand …“, die Messstellen in Lindach sind benannt', async ({ page }) => {
    test.slow();
    for (const breite of [1440, 375]) {
      await oeffne(page, 'bild=unternehmen&ansicht=messstellen', breite);
      await warteAufListe(page);
      await page.getByRole('button', { name: 'Weitere Aktionen' }).click();
      await page.getByRole('menuitem', { name: /^Stand an einem Tag ansehen/ }).click();
      // Der Kalender klappt gleich auf.
      await page.locator('.vp-kal-tag[data-iso="2026-10-10"]:not(.is-rand)').click();
      await expect(page.getByTestId('stand-am')).toContainText('Stand 10.10.2026');
      await expect(page.getByTestId('messstellen-noch-nicht')).toBeVisible();
      const m = await messe(page);
      ohneQuerlauf(m, `stand-am-${breite}`);
      expect(m.nochNicht).toEqual(['MS-16', 'MS-17', 'MS-18', 'MS-22']);
      expect(m.reihen).toBe(18);
      await expect(page.getByTestId('messstellen-noch-nicht')).toContainText(
        'Am 10.10.2026 gab es MS-16 „Netzbezug Lindach“ im Portal noch nicht.',
      );
      // Mit Stichtag gibt es keinen Schreibweg.
      await expect(page.getByRole('button', { name: 'Messstelle anlegen' })).toHaveCount(0);
      await ablegen(page, `stand-am-${breite}`, m);
      await page.getByTestId('messstellen-noch-nicht').scrollIntoViewIfNeeded();
      await ablegen(page, `stand-am-${breite}-lindach`, m);
      await page.getByRole('button', { name: 'Zurück zu heute' }).click();
      await expect(page.getByTestId('stand-am')).toHaveCount(0);
    }
  });

  test('Suche bei 375 und 1440 px: sofort, tolerant, markiert, in der Adresse; leer mit dem Weg zurück', async ({ page }) => {
    test.slow();
    for (const breite of [375, 1440]) {
      await oeffne(page, 'bild=unternehmen&ansicht=messstellen', breite);
      await warteAufListe(page);
      const feld = page.getByRole('searchbox', { name: 'Messstellen suchen' });
      await feld.fill('druck');
      await expect(page.getByTestId('messstelle-reihe')).toHaveCount(1);
      await expect(page.getByTestId('messstelle-reihe').locator('mark')).toHaveText('Druck');
      await expect(page.locator('.vp-ms-treffer')).toContainText('1 von 22 Messstellen');
      await expect(page).toHaveURL(/\?suche=druck$/);
      const m = await messe(page);
      ohneQuerlauf(m, `suche-${breite}`);
      await ablegen(page, `suche-${breite}`, m);

      await feld.fill('Wärmepumpe');
      await expect(page.getByText('Keine Messstelle passt zu „Wärmepumpe“.')).toBeVisible();
      await expect(page.getByText('Gesucht wird in Name, Kennzeichen, Ort und Gerät.')).toBeVisible();
      const leer = await messe(page);
      ohneQuerlauf(leer, `suche-leer-${breite}`);
      await ablegen(page, `suche-leer-${breite}`, leer);
      await page.getByTestId('messstellen-kein-treffer').getByRole('button', { name: 'Suche leeren' }).click();
      await expect(page.getByTestId('messstelle-reihe')).toHaveCount(22);
    }
  });

  test('Marke „1 ohne Quelle“ bei 375 px: sie filtert auf MS-21, noch einmal getippt ist alles wieder da', async ({ page }) => {
    await oeffne(page, 'bild=unternehmen&ansicht=messstellen', 375);
    await warteAufListe(page);
    const marke = page.getByRole('group', { name: 'Nur diese zeigen' }).getByRole('button', { name: '1 ohne Quelle' });
    await marke.click();
    await expect(page.getByTestId('messstelle-reihe')).toHaveCount(1);
    await expect(marke).toHaveAttribute('aria-pressed', 'true');
    const m = await messe(page);
    ohneQuerlauf(m, 'ohne-quelle-375');
    await ablegen(page, 'ohne-quelle-375', m);
    await marke.click();
    await expect(page.getByTestId('messstelle-reihe')).toHaveCount(22);
  });

  test('Ausfall 03.11.2026: Reihen und Standortkarte sprechen nur aus festgehaltenen Fakten', async ({ page }) => {
    test.slow();
    for (const breite of [1440, 375]) {
      await oeffne(page, 'bild=unternehmen&ansicht=werk-messstellen&ausfall=1', breite);
      await warteAufListe(page);
      const direkt = reihe(page, 'MS-10');
      await expect(direkt).toContainText('Unvollständig seit 14:00 (Box Halle 2)');
      const berechnet = reihe(page, 'MS-15');
      await expect(berechnet).toContainText('fehlt: MS-10, MS-11, MS-12, MS-13, MS-14');
      await expect(berechnet).not.toContainText('Box Halle 2');
      const m = await messe(page);
      ohneQuerlauf(m, `ausfall-messstellen-${breite}`);
      await direkt.scrollIntoViewIfNeeded();
      await ablegen(page, `ausfall-messstellen-${breite}`, m);
    }

    await oeffne(page, 'bild=unternehmen&ansicht=standorte&ausfall=1', 1440);
    const standort = page.getByTestId('standort-ausfall');
    await expect(standort).toHaveText('1 von 2 Boxen meldet sich nicht · 6 Messstellen unvollständig');
    await ablegen(page, 'ausfall-standort-1440', await messe(page), true);
  });
});

test.describe('Leisten-Nachweis: mit der Seite „Messstellen“ schaltet sich die Leiste des Unternehmens zu', () => {
  test('Übersicht bei 375 px — gebaut: Leiste Übersicht · Messen · Auswerten · Nachweisen, Reiter nur die der Gruppe „Übersicht“', async ({ page }) => {
    await oeffne(page, 'bild=unternehmen', 375);
    const m = await messe(page);
    ohneQuerlauf(m, 'leiste-uebersicht-375');
    expect(m.route).toBe('#/portfolio');
    expect(m.leiste).toEqual(['Übersicht', 'Messen', 'Auswerten', 'Nachweisen']);
    expect(m.leisteAktiv).toBe('Übersicht');
    expect(m.reiter).toEqual(['Übersicht', 'Standorte', 'Energie']);
    await ablegen(page, 'leiste-uebersicht-375', m);
    await page.locator('.vp-bottombar').getByRole('button', { name: 'Messen' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-route', '#/portfolio/messstellen');
    await warteAufListe(page);
  });

  test('Übersicht bei 375 px — Variante A (nur Vorschau, `&reiter=alle`): jeder Bereich steht doppelt', async ({ page }) => {
    await oeffne(page, 'bild=unternehmen&reiter=alle', 375);
    const m = await messe(page);
    ohneQuerlauf(m, 'leiste-uebersicht-375-alle-reiter');
    expect(m.leiste).toEqual(['Übersicht', 'Messen', 'Auswerten', 'Nachweisen']);
    expect(m.reiter).toEqual(['Übersicht', 'Standorte', 'Messstellen', 'Bezugsgrößen', 'Kennzahlen', 'Berichte', 'Energie']); // „Energie“ seit main 3e95cc604
    await ablegen(page, 'leiste-uebersicht-375-alle-reiter', m);
  });

  test('am Rechner trägt die Seitenleiste dieselben Einträge — Unternehmen und Standort (N1)', async ({ page }) => {
    await oeffne(page, 'bild=unternehmen', 1440);
    // N1: am Unternehmen stehen die Gruppen in der Seitenleiste; „Messen“ öffnet ihren ersten Bereich, die Messstellen.
    await page.getByTestId('seitenleiste-messen').click();
    await expect(page.locator('body')).toHaveAttribute('data-route', '#/portfolio/messstellen');
    await warteAufListe(page);
    await oeffne(page, 'bild=unternehmen&ansicht=werk', 1440);
    const m = await messe(page);
    // Am Standort seine Bereiche in der Seitenleiste — über der Seite steht keine zweite Reihe derselben Bereiche.
    expect(m.seite).toEqual(['Übersicht', 'Aufbau', 'Gebäude', 'Messstellen', 'Netzanschlüsse']);
    expect(m.reiter).toEqual([]);
    await ablegen(page, 'werk-uebersicht-1440', m);
    await page.getByTestId('seitenleiste-messstellen').click();
    await expect(page.locator('body')).toHaveAttribute('data-route', `#/standort/${FIXTURE_IDS.st1}/messstellen`);
    await warteAufListe(page);
  });

  test('der reine Messkunde (nur Werk Lindach, oberste Ebene): „Messstellen“ führt auf seinen Standort — Seitenleiste am Rechner, Kachel am Telefon', async ({ page }) => {
    await oeffne(page, 'bild=messkunde', 1440);
    const r = await messe(page);
    ohneQuerlauf(r, 'messkunde-1440');
    // AP-13 IP-2: als oberste Ebene hat der Standort auch „Aufbau“ und „Gebäude“. N1: seine Bereiche stehen in der
    // Seitenleiste, dieselben wie am Telefon in der Leiste.
    expect(r.seite).toEqual(['Übersicht', 'Aufbau', 'Gebäude', 'Messstellen', 'Netzanschlüsse']);
    for (const weg of ['Anlagen', 'Boxen']) {
      expect(r.seite).not.toContain(weg);
      expect(r.reiter).not.toContain(weg);
    }
    await page.getByTestId('seitenleiste-messstellen').click();
    await expect(page.locator('body')).toHaveAttribute('data-route', `#/standort/${FIXTURE_IDS.st2}/messstellen`);
    await warteAufListe(page);

    await oeffne(page, 'bild=messkunde', 375);
    const m = await messe(page);
    ohneQuerlauf(m, 'messkunde-375');
    expect(m.leiste).toEqual(['Übersicht', 'Aufbau', 'Gebäude', 'Messstellen', 'Anschlüsse']);
    await page.locator('.vp-bottombar').getByRole('button', { name: 'Messstellen' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-route', `#/standort/${FIXTURE_IDS.st2}/messstellen`);
    await warteAufListe(page);
    const n = await messe(page);
    ohneQuerlauf(n, 'messkunde-messstellen-375');
    expect(n.reihen).toBe(3);
    expect(n.leisteAktiv).toBe('Messstellen');
    await ablegen(page, 'messkunde-messstellen-375', n);
  });
});
