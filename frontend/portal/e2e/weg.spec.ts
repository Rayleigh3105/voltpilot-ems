import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * UEMS AP-13 IP-13 — DER GEMESSENE WEG (E14 = A, M1–M4; Referenzfall O17).
 *
 * Diese Spec baut keine Fläche. Sie GEHT den Weg, den ein Kunde geht — Ebene → Welt → Zahl → Nachweis —, in EINEM
 * Lauf, mit echten Klicks, bei 375 und 1440 px, und misst an jeder Station:
 *
 *   · Querlauf = 0 (Dokument UND jedes sichtbare Element des Hauptbereichs; im Dialog sein Körper),
 *   · Tippflächen ≥ 44 px (Leiste, Reiter, Register-Einstiege, Zeit- und Vergleichswahl, Versions-Einstieg),
 *   · keine Konsolenfehler,
 *   · ein Bild je Station (`WEG_BILDER=<Ordner>`; dazu `messung-<station>.json` mit den Zahlen).
 *
 * Der Weg läuft auf der Bühne `startansicht` am 21.11.2026: ein Kunde mit nur EINEM Standort landet auf dessen
 * Übersicht (vier Kacheln nach IP-2), klappt in „Gebäude“ die Karte Halle 2 auf, geht ins Register, stellt es über
 * „Stand am …“ auf den 03.11.2026 zurück, öffnet MS-10 und liest die Zahl dieses Tages — die, die drei Versionen
 * hat. Von dort: ihr Verlauf, ihr Vergleich im Monat und ihr Nachweis. Jede Zahl stammt aus den Referenzfällen
 * (`oberflaechenFaelle.json` über die Fixtures der Bühne).
 *
 * Daneben steht die zweite Prüfung: jede Station, die die Bühne ÖFFNEN kann (§8 Zeile 1622 — Gebäude, Werte,
 * Verlauf, Vergleich, Energiebilanz, Kostenstellen), einzeln aufgerufen, gemessen und fotografiert.
 *
 * WebKit läuft hier nicht (im Repo nicht installiert) und wird im PR-Text als nicht gelaufen benannt.
 *
 * ⚠ Die Spec importiert KEINE Fixtures — sie laden `api.ts`, dem im Node-Lauf `import.meta.env` fehlt.
 */

const BILDER = process.env.WEG_BILDER;
/**
 * Der Tag, an dem der Weg gegangen wird (Uhr der Bühne UND Stand des Registers): der 21.11.2026 — nach der
 * Berichtigung vom 20.11., damit die Versionen der Zahl vollständig in der Vergangenheit liegen.
 */
const HEUTE = '2026-11-21';
const JETZT = new Date('2026-11-21T08:20:00Z');
/** Der Tag, dessen Zahl der Weg liest: der Ausfall der Box Halle 2 (O1/F21). Er wird über „Stand am …“ erreicht. */
const GESUCHTER_TAG = '2026-11-03';
const STANDORT_LEISTE = ['Übersicht', 'Boxen', 'Gebäude', 'Anlagen', 'Messstellen', 'Netzanschlüsse'];
const STANDORT_REITER = ['Übersicht', 'Boxen', 'Gebäude', 'Anlagen', 'Messstellen'];

/** Jede Station des Wegs: was gemessen wurde. Wird je Breite gesammelt und am Ende als eine Datei abgelegt. */
interface Station {
  name: string;
  breite: number;
  route: string | null;
  titel: string | null;
  dokument: number;
  ueberstehend: string[];
  dialog: number | null;
  tippflaechen: { kleinste: number; gezaehlt: number; kleinstes: string | null };
}

async function oeffne(page: Page, query: string, breite: number) {
  await page.clock.setFixedTime(JETZT);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/startansicht.html?${query}`);
  await expect(page.locator('.vp-topbar').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
}

/** Nichts bewegt sich mehr — sonst misst das Bild eine halb eingeblendete Fläche. */
async function ruhig(page: Page) {
  const modal = page.locator('.vp-modal');
  if (await modal.count()) await expect(modal.last()).toHaveCSS('opacity', '1');
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
}

/**
 * Die Messung einer Station. Tippflächen sind die Elemente, die der Kunde am Telefon TRIFFT: die Leiste, die
 * Reiter, die Einstiege des Registers, die Zeit- und Vergleichswahl und der Weg zu den Versionen.
 */
const TIPPFLAECHEN = [
  '.vp-bottombar-item',
  '[role="tab"]',
  '.vp-ms-karte-werte',
  '.vp-ms-werte',
  '.vp-ms-oeffnen',
  '.vp-rowmenu-btn',
  '[data-testid="werte-versionen"]',
  '.vp-standort-einstieg',
  '.vp-at-weg',
].join(', ');

async function messe(page: Page, tippflaechen: string) {
  return page.evaluate((sel) => {
    const doc = document.documentElement;
    const breite = doc.clientWidth;
    const main = document.querySelector<HTMLElement>('.vp-main');
    const sichtbar = (e: Element) => (e as HTMLElement).offsetParent !== null || getComputedStyle(e).position === 'fixed';
    // Die Reiter-Leiste der Bereiche ist ihr eigener Rollbereich (wie in `standort-ebenen.spec.ts`); alles andere zählt.
    const ueberstehend = [...document.querySelectorAll<HTMLElement>('.vp-main *, .vp-modal *')]
      .filter((e) => sichtbar(e) && !e.closest('.vp-bereich-tabs'))
      .filter((e) => e.getBoundingClientRect().right > breite + 0.5 || e.getBoundingClientRect().left < -0.5)
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`);
    const koerper = document.querySelector<HTMLElement>('.vp-modal .dbody');
    /**
     * Die Fläche, die ein Finger WIRKLICH trifft. Ein Knopf, dessen `::after` mit `inset: 0` seinen gestellten
     * Vorfahren abdeckt, ist so groß wie dieser Vorfahr — so ist am Telefon die ganze Register-Karte der Einstieg
     * (AP-13 IP-3), obwohl der Knopf selbst nur der Name ist. Wer nur `getBoundingClientRect()` misst, misst die
     * Schrift statt der Fläche.
     */
    const flaeche = (e: HTMLElement): DOMRect => {
      const nach = getComputedStyle(e, '::after');
      const deckend =
        nach.content !== 'none' &&
        nach.position === 'absolute' &&
        ['top', 'right', 'bottom', 'left'].every((k) => nach.getPropertyValue(k) === '0px');
      const wirt = deckend ? (e.offsetParent as HTMLElement | null) : null;
      return (wirt ?? e).getBoundingClientRect();
    };
    const treffer = [...document.querySelectorAll<HTMLElement>(sel)].filter(sichtbar);
    const hoehen = treffer.map((e) => Math.round(flaeche(e).height));
    const kleinstes = treffer.length ? treffer[hoehen.indexOf(Math.min(...hoehen))] : null;
    const bar = document.querySelector<HTMLElement>('.vp-bottombar');
    const leisteSichtbar = bar !== null && getComputedStyle(bar).display !== 'none';
    return {
      route: document.body.dataset.route ?? null,
      titel: main?.querySelector('h1:not(.vp-sr-only)')?.textContent?.trim() ?? null,
      dokument: doc.scrollWidth - doc.clientWidth,
      ueberstehend: [...new Set(ueberstehend)],
      dialog: koerper ? koerper.scrollWidth - koerper.clientWidth : null,
      tippflaechen: {
        kleinste: hoehen.length ? Math.min(...hoehen) : 0,
        gezaehlt: hoehen.length,
        kleinstes: kleinstes ? `${kleinstes.tagName.toLowerCase()}.${[...kleinstes.classList].join('.')} „${(kleinstes.textContent ?? '').trim().slice(0, 40)}“` : null,
      },
      leiste: leisteSichtbar ? [...bar!.querySelectorAll('.vp-bottombar-item .lbl')].map((l) => l.textContent ?? '') : null,
      reiter: [...document.querySelectorAll('[role="tablist"]:not(.vp-seg) [role="tab"]')]
        .filter(sichtbar)
        .map((e) => e.textContent?.trim() ?? ''),
      text: main?.textContent ?? '',
    };
  }, tippflaechen);
}

/** Eine Station: messen, prüfen, fotografieren. Am Telefon zählt auch die Tippfläche. */
async function station(page: Page, breite: number, name: string, gesammelt: Station[], { ganz = false } = {}) {
  await ruhig(page);
  await page.mouse.move(0, 0);
  const m = await messe(page, TIPPFLAECHEN);
  expect(m.dokument, `${name} ${breite}: Querlauf des Dokuments`).toBe(0);
  expect(m.ueberstehend, `${name} ${breite}: Elemente über dem Rand`).toEqual([]);
  expect(m.dialog ?? 0, `${name} ${breite}: Querlauf im Dialog`).toBe(0);
  if (breite === 375) {
    expect(m.tippflaechen.gezaehlt, `${name} ${breite}: keine Tippfläche gefunden`).toBeGreaterThan(0);
    expect(m.tippflaechen.kleinste, `${name} ${breite}: kleinste Tippfläche (${m.tippflaechen.kleinstes})`).toBeGreaterThanOrEqual(44);
  }
  gesammelt.push({
    name,
    breite,
    route: m.route,
    titel: m.titel,
    dokument: m.dokument,
    ueberstehend: m.ueberstehend,
    dialog: m.dialog,
    tippflaechen: m.tippflaechen,
  });
  if (BILDER) {
    mkdirSync(BILDER, { recursive: true });
    await page.screenshot({ path: join(BILDER, `${name}-${breite}.png`), fullPage: ganz });
  }
  return m;
}

function ablegen(gesammelt: Station[]) {
  if (!BILDER || gesammelt.length === 0) return;
  mkdirSync(BILDER, { recursive: true });
  writeFileSync(join(BILDER, `messung-weg-${gesammelt[0].breite}.json`), JSON.stringify(gesammelt, null, 2));
}

/** Konsolenfehler und abgewiesene Versprechen — gesammelt über den GANZEN Lauf, nicht je Station. */
function lauscheAufFehler(page: Page): string[] {
  const fehler: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') fehler.push(m.text());
  });
  page.on('pageerror', (e) => fehler.push(String(e)));
  return fehler;
}

test.describe('AP-13 IP-13 · der gemessene Weg (O17)', () => {
  for (const breite of [1440, 375]) {
    test(`Ebene → Welt → Zahl → Nachweis als EIN Lauf bei ${breite} px`, async ({ page }) => {
      test.slow();
      const fehler = lauscheAufFehler(page);
      const gesammelt: Station[] = [];

      // ---------------------------------------------------------------- 1 · EBENE: die Übersicht des Standorts
      await oeffne(page, `bild=standort&stand=${HEUTE}`, breite);
      await expect(page.locator('.vp-main')).toContainText('Werk Ahrenberg');
      const ebene = await station(page, breite, '01-ebene', gesammelt);
      // Die Bereiche des Standorts — am Telefon als Leiste, am Rechner als Reiter (M3).
      if (breite === 375) expect(ebene.leiste).toEqual(STANDORT_LEISTE);
      else expect(ebene.reiter, `Reiter am Rechner: ${ebene.reiter.join(' · ')}`).toEqual(expect.arrayContaining(STANDORT_REITER));

      // ---------------------------------------------------------------- 2 · EBENE: Gebäude, Halle 2 aufgeklappt
      await zu(page, breite, 'Gebäude');
      await expect(page.locator('[data-testid="ortsbaum"] .vp-ob-knoten').first()).toBeVisible();
      await page.locator('.vp-ob-aufklapper').nth(1).click();
      await expect(page.locator('[data-testid="gebaeude-karte"]').first()).toBeVisible();
      await station(page, breite, '02-gebaeude', gesammelt);

      // ---------------------------------------------------------------- 3 · WELT: das Register der Messstellen
      await zu(page, breite, 'Messstellen');
      await expect(page.locator('[data-testid="messstellen"] .vp-ms-tabelle, [data-testid="messstellen"] .vp-ms-karten').first()).toBeVisible();
      const welt = await station(page, breite, '03-welt', gesammelt);
      expect(welt.text).toContain('MS-10');

      // ------------------------------------------------- 4 · WELT: „Stand am …“ auf den 03.11.2026 zurückgestellt
      // Der Einstieg „Werte“ des Registers führt auf den Stichtag, sonst auf den Vortag (AP-13 IP-3) — so erreicht
      // der Kunde einen älteren Tag, ohne sich durch die Zeit-Leiste zu blättern.
      await standAm(page, GESUCHTER_TAG);
      const stand = await station(page, breite, '04-stand-am', gesammelt);
      expect(stand.text).toContain('Sie sehen den Stand am 03.11.2026');

      // ---------------------------------------------------------------- 5 · ZAHL: MS-10 am 03.11.2026
      await einstieg(page, breite, 'Netzbezug Halle 2');
      await expect(page.locator('[data-testid="messstelle-seite"]')).toBeVisible();
      const werte = page.getByTestId('werte');
      await expect(werte.getByTestId('werte-karte')).toContainText('2.354 kWh');
      await expect(werte.getByTestId('werte-karte')).toContainText('3 Versionen');
      await expect(page.getByTestId('quelle-karte')).toContainText('Zähler Energiekarte EK-1');
      const zahl = await station(page, breite, '05-zahl', gesammelt);
      expect(zahl.route).toMatch(/\?periode=2026-11-03$/);

      // ---------------------------------------------------------------- 6 · ZAHL: der Verlauf desselben Tages
      const verlauf = werte.getByTestId('verlauf');
      await expect(verlauf.getByTestId('verlauf-luecke')).toHaveCount(1);
      await verlauf.scrollIntoViewIfNeeded();
      await station(page, breite, '06-verlauf', gesammelt);

      // ---------------------------------------------------------------- 7 · ZAHL: der Vergleich im Monat
      await werte.locator('.vp-wk-zeitwahl').getByRole('tab', { name: 'Monat' }).click();
      await expect(werte.getByTestId('werte-karte')).toContainText('35.800');
      await werte.getByTestId('vergleich').getByRole('tab', { name: 'Vorperiode' }).click();
      await expect(werte.getByTestId('vergleich-delta')).toContainText('gegenüber Oktober 2026');
      const vergleich = await station(page, breite, '07-vergleich', gesammelt);
      expect(vergleich.route).toMatch(/\?periode=2026-11&v=vorperiode$/);

      // ---------------------------------------------------------------- 8 · NACHWEIS: die Versionen der Zahl
      await werte.locator('.vp-wk-zeitwahl').getByRole('tab', { name: 'Tag' }).click();
      await expect(werte.getByTestId('werte-karte')).toContainText('2.354 kWh');
      await werte.getByTestId('werte-versionen').click();
      const dialog = page.locator('.vp-modal').last();
      await expect(dialog).toContainText('Versionen');
      await station(page, breite, '08-nachweis', gesammelt);

      ablegen(gesammelt);
      expect(fehler, `Konsolenfehler auf dem Weg bei ${breite} px`).toEqual([]);
    });
  }
});

/**
 * Die Stationen, die die Bühne für den Weg ÖFFNEN kann (IP-13, §8 Zeile 1622): jede einzeln aufgerufen, gemessen
 * und fotografiert. Was die Bühne nicht öffnen kann, kann der Weg nicht besuchen — deshalb steht das hier neben
 * dem Lauf und nicht in ihm.
 */
const WELTEN: { name: string; bild: string; jetzt: Date; da: string; text?: RegExp; auf?: string }[] = [
  {
    name: 'w1-gebaeude',
    bild: 'bild=unternehmen&ansicht=werk-gebaeude',
    jetzt: new Date('2026-10-20T08:15:30Z'),
    auf: 'Halle 2: Karte aufklappen',
    da: '[data-testid="gebaeude-karte-G-2"]',
  },
  {
    name: 'w2-werte',
    bild: `bild=standort&stand=${HEUTE}&ansicht=werte&ms=MS-10&tag=${GESUCHTER_TAG}`,
    jetzt: JETZT,
    da: '[data-testid="werte-karte"]',
    text: /2\.354\s?kWh/,
  },
  {
    name: 'w3-verlauf',
    bild: `bild=standort&stand=${HEUTE}&ansicht=verlauf&ms=MS-10&mon=2026-11`,
    jetzt: JETZT,
    da: '[data-testid="verlauf"]',
    text: /35\.800\s?kWh/,
  },
  {
    name: 'w4-vergleich',
    bild: `bild=standort&stand=${HEUTE}&ansicht=vergleich&ms=MS-10&mon=2026-11&v=vorperiode`,
    jetzt: JETZT,
    da: '[data-testid="vergleich-delta"]',
    text: /gegenüber Oktober 2026/,
  },
  {
    name: 'w5-bilanz',
    bild: 'bild=unternehmen&ansicht=bilanz&an=AN-2',
    jetzt: new Date('2026-11-05T08:00:00Z'),
    da: '[data-testid="energiebilanz"]',
  },
  {
    name: 'w6-kostenstellen',
    bild: 'bild=unternehmen&ansicht=kostenstellen',
    jetzt: new Date('2026-11-05T08:00:00Z'),
    da: '[data-testid="kostenstellen"]',
  },
];

test.describe('AP-13 IP-13 · die Welten, die die Bühne öffnet', () => {
  for (const breite of [1440, 375]) {
    test(`jede Station der Bühne steht für sich bei ${breite} px`, async ({ page }) => {
      test.slow();
      const fehler = lauscheAufFehler(page);
      const gesammelt: Station[] = [];
      for (const welt of WELTEN) {
        await page.clock.setFixedTime(welt.jetzt);
        await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
        await page.goto(`/e2e/startansicht.html?${welt.bild}`);
        await expect(page.locator('.vp-topbar').first()).toBeVisible();
        await page.waitForLoadState('networkidle');
        if (welt.auf) await page.getByRole('button', { name: welt.auf }).click();
        await expect(page.locator(welt.da).first()).toBeVisible();
        if (welt.text) await expect(page.locator(welt.da).first()).toContainText(welt.text);
        await station(page, breite, welt.name, gesammelt);
      }
      if (BILDER) {
        mkdirSync(BILDER, { recursive: true });
        writeFileSync(join(BILDER, `messung-welten-${breite}.json`), JSON.stringify(gesammelt, null, 2));
      }
      expect(fehler, `Konsolenfehler in den Welten bei ${breite} px`).toEqual([]);
    });
  }
});

/** „Stand am …“ auf einen früheren Tag stellen — im echten Datumsfeld, Monat für Monat zurückgeblättert. */
async function standAm(page: Page, iso: string) {
  const feld = page.getByRole('combobox', { name: 'Stand am' });
  await feld.click();
  const tag = page.locator(`.vp-kal-tag[data-iso="${iso}"]:not(.is-rand)`);
  for (let i = 0; i < 24 && !(await tag.count()); i++) await page.getByRole('button', { name: 'Voriger Monat' }).click();
  await tag.click();
  await expect(page.locator('.vp-kal-gitter')).toHaveCount(0);
  const [jj, mm, dd] = iso.split('-');
  await expect(page.getByRole('status')).toContainText(`Sie sehen den Stand am ${dd}.${mm}.${jj}`);
}

/** Der Wechsel in einen Bereich der Ebene: am Telefon die Leiste, am Rechner der Reiter (M1/M3). */
async function zu(page: Page, breite: number, bereich: string) {
  if (breite === 375) await page.locator('.vp-bottombar-item', { hasText: bereich }).first().click();
  else await page.getByRole('tab', { name: bereich, exact: true }).first().click();
}

/**
 * Der Einstieg in die Werte einer Zeile (AP-13 IP-3): am Telefon die ganze Karte, am Rechner das Zeilenmenü.
 * ⚠ Der zweite Weg am Rechner — „Letzter Wert“ — steht nur an einer Zeile MIT Wert; das Register des
 * Referenzunternehmens trägt seine Momentanwerte allein am 20.10.2026, der Weg wird also an seinem Stand gegangen.
 */
async function einstieg(page: Page, breite: number, name: string) {
  if (breite === 375) {
    await page.locator('.vp-ms-karte', { hasText: name }).first().getByRole('button', { name }).click();
    return;
  }
  await page.locator('tr', { hasText: name }).first().locator('.vp-rowmenu-btn').click();
  await page.getByRole('menuitem', { name: 'Werte' }).click();
}
