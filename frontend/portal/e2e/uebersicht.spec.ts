import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Die Unternehmens- und Standort-Übersicht (UEMS AP-01 IP-6) bei 375 und 1440 px
 * auf der Bühne `startansicht.html` (Referenzunternehmen Ahrenberg, 20.10.2026
 * 10:15): Kopfzeile, Standort-Gruppen, Filter, beide Funktionen je Standort —
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
    sichtbar: ['1 von 1 Anlage liefert Daten', '38,7', 'Noch nicht eingerichtet'],
    gruppen: 0,
  },
];

async function oeffne(page: Page, query: string, breite: number) {
  await page.clock.setFixedTime(JETZT);
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
      if (breite < 721) expect(m.kleineTreffer, `${fall.name} ${breite}: Trefferfläche`).toEqual([]);
      await ablegen(page, fall.name, breite, m);
    });
  }
}

test('Rechner: die Standort-Karte führt zur Standort-Übersicht desselben Standorts', async ({ page }) => {
  await oeffne(page, 'bild=unternehmen', 1440);
  await page.getByRole('button', { name: 'Standort Werk Lindach öffnen' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-route', `#/standort/${ST2}`);
  await expect(page.getByRole('button', { name: 'Anlage Werk Lindach öffnen' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Anlage Werk Ahrenberg/ })).toHaveCount(0);
});
