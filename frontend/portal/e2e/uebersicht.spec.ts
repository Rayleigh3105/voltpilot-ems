import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Die Unternehmens- und Standort-Übersicht (UEMS AP-01 IP-6) bei 375 und 1440 px
 * auf der Bühne `startansicht.html` (Referenzunternehmen Ahrenberg, 20.10.2026
 * 10:15): Kopfzeile, Standort-Gruppen, Filter, die Funktionen je Standort (Steuern nur mit teilnehmender Anlage) —
 * und KEIN Querlauf, GEMESSEN am Dokument (`scrollWidth − clientWidth`), nicht
 * am Fenster: in der Telefon-Emulation ist `innerWidth` nicht zwingend die
 * Gerätebreite. Der Messkunde (A13) zeigt nirgends Euro.
 *
 * Mit `UEBERSICHT_BILDER=<Ordner>` legt der Lauf je Fall ein Bild und die
 * Messwerte (`messung-<fall>-<breite>.json`) ab — die Vorschau für die Freigabe.
 */

const BILDER = process.env.UEBERSICHT_BILDER;
const BREITEN = [375, 1440] as const;
const JETZT = new Date('2026-10-20T08:15:30Z');
const ST1 = '5a1d0000-0000-4000-8000-000000000001';
const ST2 = '5a1d0000-0000-4000-8000-000000000002';

interface Fall {
  name: string;
  query: string;
  route: string;
  /** Texte, die sichtbar sein müssen. */
  sichtbar: string[];
  /** Zahl der Standort-Karten (Gruppen) — 0 auf der Standort-Übersicht. */
  gruppen: number;
  /** Steuern-Regel: auf der Seite steht kein Wort über Steuern (hier nimmt keine Anlage teil). */
  ohneSteuern?: boolean;
}

const FAELLE: Fall[] = [
  {
    name: 'unternehmen',
    query: 'bild=unternehmen',
    route: '#/portfolio',
    sichtbar: ['Kunststoffwerk Ahrenberg GmbH', '2 Standorte · 3 Anlagen · 1 steuert', '3 von 3 Anlagen liefern Daten', '447,6', 'Netz jetzt'],
    gruppen: 2,
  },
  {
    name: 'unternehmen-bestand',
    query: 'bild=unternehmen&messen=bestand',
    route: '#/portfolio',
    sichtbar: ['Kunststoffwerk Ahrenberg GmbH', 'Noch nicht eingerichtet'],
    gruppen: 2,
  },
  {
    name: 'werk-ahrenberg',
    query: 'bild=unternehmen&ansicht=werk',
    route: `#/standort/${ST1}`,
    sichtbar: ['2 von 2 Anlagen liefern Daten', '408,9', 'Läuft mit Werk Ahrenberg – Halle 1'],
    gruppen: 0,
  },
  {
    name: 'messkunde-lindach',
    query: 'bild=messkunde',
    route: `#/standort/${ST2}`,
    sichtbar: ['1 von 1 Anlage liefert Daten', '38,7', '3 von 3 Messstellen liefern Daten'],
    ohneSteuern: true,
    gruppen: 0,
  },
];

async function oeffne(page: Page, query: string, breite: number, jetzt: Date = JETZT) {
  await page.clock.setFixedTime(jetzt);
  await page.setViewportSize({ width: breite, height: breite < 721 ? 812 : 900 });
  await page.goto(`/e2e/startansicht.html?${query}`);
  await expect(page.locator('.vp-portfolio-kopf').first()).toBeVisible();
  await expect(page.getByText('Wird geladen …')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
}

/** Querlauf am DOKUMENT und jedes Element über den Rand (eigene Scrollflächen ausgenommen). */
async function messe(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const rand = doc.clientWidth;
    const draussen = [...document.querySelectorAll('.vp-topbar *, .vp-main *')]
      // Kinder einer eigenen Scrollfläche (Reiterleiste, Tabellen-Rahmen) und Sprungziele zählen nicht.
      .filter((el) => !el.closest('.vp-bereich-tabs, .vp-sr-only, .vp-at-wrap'))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.height > 0 && (r.right > rand + 0.5 || r.left < -0.5))
      .map(({ el }) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`);
    const main = document.querySelector('.vp-main');
    return {
      route: document.body.dataset.route ?? null,
      dokument: doc.scrollWidth - doc.clientWidth,
      clientWidth: rand,
      innerWidth: window.innerWidth,
      draussen,
      gruppen: document.querySelectorAll('[data-testid="standort-gruppe"]').length,
      euro: /€|\bEUR\b|Vorteil|Mehrerlös|Erlös|Spitze/.test(main?.textContent ?? ''),
      steuern: /steuer/i.test(main?.textContent ?? ''),
      kleineTreffer: [...document.querySelectorAll<HTMLElement>('.vp-ueb-standort-name')]
        .map((b) => Math.round(b.getBoundingClientRect().height))
        .filter((h) => h < 44),
    };
  });
}

async function ablegen(page: Page, name: string, breite: number, m: unknown) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  writeFileSync(join(BILDER, `messung-${name}-${breite}.json`), JSON.stringify(m, null, 2));
  await page.screenshot({ path: join(BILDER, `${name}-${breite}.png`) });
  await page.screenshot({ path: join(BILDER, `${name}-${breite}-ganz.png`), fullPage: true });
}

for (const fall of FAELLE) {
  for (const breite of BREITEN) {
    test(`Übersicht ${fall.name} bei ${breite} px: Inhalt, kein Querlauf`, async ({ page }) => {
      await oeffne(page, fall.query, breite);
      for (const text of fall.sichtbar) {
        await expect(page.getByText(text, { exact: false }).first(), `${fall.name} ${breite}: „${text}"`).toBeVisible();
      }
      const m = await messe(page);
      expect(m.route, `${fall.name} ${breite}: Landung`).toBe(fall.route);
      expect(m.dokument, `${fall.name} ${breite}: Querlauf des Dokuments`).toBe(0);
      expect(m.draussen, `${fall.name} ${breite}: Elemente über dem Rand`).toEqual([]);
      expect(m.gruppen, `${fall.name} ${breite}: Standort-Karten`).toBe(fall.gruppen);
      // Das Referenzunternehmen trägt keine Geldwerte — und der Messkunde sieht ohnehin keine (A13).
      expect(m.euro, `${fall.name} ${breite}: Geld auf der Seite`).toBe(false);
      if (fall.ohneSteuern) expect(m.steuern, `${fall.name} ${breite}: ein Wort über Steuern`).toBe(false);
      if (breite < 721) expect(m.kleineTreffer, `${fall.name} ${breite}: Trefferfläche`).toEqual([]);
      await ablegen(page, fall.name, breite, m);
    });
  }
}

/**
 * UEMS AP-13 IP-7 (O2, O3): die Übersichts-Bausteine je Ebene — „Messstellen“ (die Zählung des Registers),
 * „Energiebilanz“ (Summe „x von y Systemen“, am Standort die Gebäude-Zeilen), „Kennzahlen“ — unter der Anlagen-Tabelle
 * und vor der Karte „Funktionen“ (Ü1); kein Querlauf, Tippflächen ≥ 44 px, kein Geld, kein „nicht zugeordnet“ auf
 * der Ebene. O2 liest am 10.11.2026 (der Oktober ist gebildet; die Anlagen-Zeilen der Bühne bleiben die Momentaufnahme
 * vom 20.10.), O3 am 19.10.2026 den Tag davor — Werk Lindach ohne Kennzahl (`welt=leer`).
 */
interface BausteinFall {
  name: string;
  query: string;
  route: string;
  jetzt: Date;
  /** Der Zeitraum der Leiste, der vor dem Prüfen gewählt wird. */
  zeitraum?: { tab: 'Tag' | 'Monat' | 'Jahr'; text: string };
  sichtbar: string[];
  kennzahlen: number;
  gebaeude: number;
}

const BAUSTEIN_FAELLE: BausteinFall[] = [
  {
    name: 'o2-unternehmen',
    query: 'bild=unternehmen',
    route: '#/portfolio',
    jetzt: new Date('2026-11-10T08:00:00Z'),
    sichtbar: [
      '21 von 22 Messstellen liefern Daten',
      '15 von 16 Messstellen liefern Daten',
      'Oktober 2026',
      'Netzbezug 174.400 kWh · 3 von 3 Systemen · Werk Lindach ab 15.10.2026',
      '165.300 kWh · 2 von 2 Systemen',
    ],
    kennzahlen: 5,
    gebaeude: 0,
  },
  {
    name: 'o3-lindach-tag',
    query: 'bild=messkunde&welt=leer',
    route: `#/standort/${ST2}`,
    jetzt: new Date('2026-10-19T08:00:00Z'),
    zeitraum: { tab: 'Tag', text: '18.10.2026' },
    sichtbar: [
      '3 von 3 Messstellen liefern Daten',
      'Netzbezug 100 kWh · 1 von 1 System',
      'Lagerhalle Lindach',
      'gemessen im Gebäude 60 kWh (1 Messstelle)',
      'gemessen im Gebäude 30 kWh (1 Messstelle)',
    ],
    kennzahlen: 0,
    gebaeude: 2,
  },
];

for (const fall of BAUSTEIN_FAELLE) {
  for (const breite of BREITEN) {
    test(`Übersichts-Bausteine ${fall.name} bei ${breite} px (AP-13 IP-7)`, async ({ page }) => {
      const konsole: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error') konsole.push(m.text());
      });
      await oeffne(page, fall.query, breite, fall.jetzt);
      const bausteine = page.getByTestId('uebersicht-bausteine');
      await expect(bausteine).toBeVisible();
      if (fall.zeitraum) {
        await page.getByTestId('baustein-energiebilanz').getByRole('tab', { name: fall.zeitraum.tab }).click();
        await expect(page.getByTestId('energiebilanz-zeitraum')).toHaveText(fall.zeitraum.text);
      }
      await expect(page.getByText('Wird geladen …')).toHaveCount(0);
      await expect(page.getByTestId('energiebilanz-summe')).toBeVisible();
      if (fall.gebaeude > 0) await expect(page.getByTestId('gebaeude-zeilen').getByText('gemessen im Gebäude').first()).toBeVisible();
      if (fall.kennzahlen > 0) await expect(page.getByTestId('kennzahl-zahl').first()).toBeVisible();

      const text = await bausteine.evaluate((el) => (el.textContent ?? '').split(String.fromCharCode(160)).join(' '));
      for (const s of fall.sichtbar) expect(text, `${fall.name} ${breite}: „${s}“`).toContain(s);
      expect(text, `${fall.name} ${breite}: kein Rest und kein Geld auf der Ebene`).not.toMatch(/€|\bEUR\b|nicht zugeordnet/);
      await expect(page.getByTestId('baustein-kennzahlen')).toHaveCount(fall.kennzahlen > 0 ? 1 : 0);
      await expect(page.getByTestId('baustein-kennzahlen').getByTestId('kennzahl-karte')).toHaveCount(fall.kennzahlen);
      await expect(page.getByTestId('gebaeude-zeilen').locator('li')).toHaveCount(fall.gebaeude);

      // Ü1: unter der Anlagen-Tabelle, vor der Karte „Funktionen“.
      const ordnung = await page.evaluate(() => {
        const [tabelle, mitte, funktionen] = ['.vp-portfolio-anlagen', '[data-testid="uebersicht-bausteine"]', '[data-testid="funktionen-karte"]'].map((q) =>
          document.querySelector(q),
        );
        if (!tabelle || !mitte || !funktionen) return false;
        const folgt = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
        return folgt(tabelle, mitte) && folgt(mitte, funktionen);
      });
      expect(ordnung, `${fall.name} ${breite}: Reihenfolge Tabelle → Bausteine → Funktionen`).toBe(true);

      const m = await messe(page);
      expect(m.route, `${fall.name} ${breite}: Landung`).toBe(fall.route);
      expect(m.dokument, `${fall.name} ${breite}: Querlauf des Dokuments`).toBe(0);
      expect(m.draussen, `${fall.name} ${breite}: Elemente über dem Rand`).toEqual([]);
      expect(m.euro, `${fall.name} ${breite}: Geld auf der Seite`).toBe(false);
      if (breite < 721) {
        const klein = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>('.vp-ub-zeile, .vp-ub-schritt, .vp-ub-alle')]
            .map((b) => Math.round(b.getBoundingClientRect().height))
            .filter((h) => h < 44),
        );
        expect(klein, `${fall.name} ${breite}: Tippflächen der Bausteine`).toEqual([]);
      }
      expect(konsole, `${fall.name} ${breite}: Konsolenfehler`).toEqual([]);
      await ablegen(page, fall.name, breite, m);
      if (BILDER) await bausteine.screenshot({ path: join(BILDER, `${fall.name}-${breite}-bausteine.png`) });
    });
  }
}

test('Rechner: „Werk Ahrenberg · 15 von 16“ im Baustein Messstellen springt ins Register des Standorts', async ({ page }) => {
  await oeffne(page, 'bild=unternehmen', 1440, new Date('2026-11-10T08:00:00Z'));
  await page.getByTestId(`datenlage-${ST1}`).click();
  await expect.poll(() => page.evaluate(() => document.body.dataset.route)).toBe(`#/standort/${ST1}/messstellen`);
});

test('Rechner: die Standort-Karte führt zur Standort-Übersicht desselben Standorts', async ({ page }) => {
  await oeffne(page, 'bild=unternehmen', 1440);
  await page.getByRole('button', { name: 'Standort Werk Lindach öffnen' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-route', `#/standort/${ST2}`);
  await expect(page.getByRole('button', { name: 'Anlage Werk Lindach öffnen' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Anlage Werk Ahrenberg/ })).toHaveCount(0);
});
