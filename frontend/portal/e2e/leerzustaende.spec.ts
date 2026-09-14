import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * UEMS AP-01 IP-8 — die Karte „Funktionen", der Leerzustand der
 * Standort-Übersicht und die Steuerung einer Anlage, die nur misst, auf der
 * Bühne `startansicht.html` bei 375 und 1440 px: der Wortlaut steht da, Knöpfe
 * gibt es nur mit heutigem Ziel, und es gibt KEINEN Querlauf — GEMESSEN am
 * Dokument (`scrollWidth − clientWidth`), nicht am Fenster.
 *
 * Mit `LEERZUSTAENDE_BILDER=<Ordner>` legt der Lauf je Fall das Bild der
 * Stelle, die ganze Seite und die Messung ab.
 */

const BILDER = process.env.LEERZUSTAENDE_BILDER;
const BREITEN = [375, 1440] as const;
const JETZT = new Date('2026-10-20T08:15:30Z');

interface Fall {
  name: string;
  query: string;
  /** Die Fläche dieses Pakets. */
  ziel: string;
  sichtbar: string[];
  /** Die Knöpfe IN der Fläche — leer heißt: bewusst keiner. */
  knoepfe: string[];
  /** Die Seite gehört einer Anlage bzw. einem Standort ohne Geld (A13). */
  ohneGeld: boolean;
}

const FAELLE: Fall[] = [
  {
    name: 'karte-unternehmen',
    query: 'bild=unternehmen',
    ziel: '[data-testid="funktionen-karte"]',
    sichtbar: [
      'Läuft an 2 von 2 Standorten',
      'Läuft an 1 von 2 Standorten',
      'Werk Ahrenberg – Halle 2 aufnehmen',
      'Steuern & Optimieren für Werk Lindach einrichten',
    ],
    knoepfe: [],
    ohneGeld: false,
  },
  {
    name: 'karte-werk',
    query: 'bild=unternehmen&ansicht=werk',
    ziel: '[data-testid="funktionen-karte"]',
    sichtbar: ['Läuft mit Werk Ahrenberg – Halle 1', 'Werk Ahrenberg – Halle 2 aufnehmen'],
    knoepfe: [],
    ohneGeld: false,
  },
  {
    name: 'standort-leer',
    query: 'bild=vor-lindach&ansicht=lindach',
    ziel: '.vp-empty',
    sichtbar: ['Werk Lindach ist angelegt — noch ohne Anlage', 'Nächster Schritt:'],
    knoepfe: [],
    ohneGeld: true,
  },
  {
    name: 'steuerung-halle2',
    query: 'bild=unternehmen&ansicht=steuerung-halle2',
    ziel: '[data-testid="nur-messen"]',
    sichtbar: ['Diese Anlage misst nur.', 'Werk Ahrenberg – Halle 1', 'Werk Ahrenberg – Halle 2 aufnehmen'],
    knoepfe: [],
    ohneGeld: true,
  },
  {
    name: 'steuerung-lindach',
    query: 'bild=unternehmen&ansicht=steuerung-lindach',
    ziel: '[data-testid="nur-messen"]',
    sichtbar: ['Diese Anlage misst nur.', 'heute ist keine angebunden', 'Gerät anbinden'],
    knoepfe: ['Gerät anbinden'],
    ohneGeld: true,
  },
];

async function oeffne(page: Page, fall: Fall, breite: number) {
  await page.clock.setFixedTime(JETZT);
  await page.setViewportSize({ width: breite, height: breite < 721 ? 812 : 900 });
  await page.goto(`/e2e/startansicht.html?${fall.query}`);
  await expect(page.locator(fall.ziel).first()).toBeVisible();
  await expect(page.getByText('Wird geladen …')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
}

/** Querlauf am DOKUMENT, jedes Element über den Rand, die Knöpfe der Fläche und ihre Trefferhöhe. */
async function messe(page: Page, ziel: string) {
  return page.evaluate((sel) => {
    const doc = document.documentElement;
    const rand = doc.clientWidth;
    const draussen = [...document.querySelectorAll('.vp-topbar *, .vp-main *')]
      .filter((el) => !el.closest('.vp-bereich-tabs, .vp-sr-only, .vp-at-wrap'))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.height > 0 && (r.right > rand + 0.5 || r.left < -0.5))
      .map(({ el }) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`);
    const flaeche = document.querySelector<HTMLElement>(sel)!;
    const knoepfe = [...flaeche.querySelectorAll<HTMLElement>('button, a')];
    const r = flaeche.getBoundingClientRect();
    return {
      route: document.body.dataset.route ?? null,
      dokument: doc.scrollWidth - doc.clientWidth,
      clientWidth: rand,
      innerWidth: window.innerWidth,
      draussen,
      flaeche: { breite: Math.round(r.width), hoehe: Math.round(r.height) },
      seitenhoehe: doc.scrollHeight,
      knoepfe: knoepfe.map((k) => (k.textContent ?? '').trim()),
      kleineTreffer: knoepfe.map((k) => Math.round(k.getBoundingClientRect().height)).filter((h) => h < 44),
      euro: /€|\bEUR\b|ct\/kWh|Unterm Strich|Marktpreis|Erlös/.test(document.querySelector('.vp-main')?.textContent ?? ''),
    };
  }, ziel);
}

async function ablegen(page: Page, fall: Fall, breite: number, m: unknown) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  writeFileSync(join(BILDER, `messung-${fall.name}-${breite}.json`), JSON.stringify(m, null, 2));
  const flaeche = page.locator(fall.ziel).first();
  await flaeche.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(BILDER, `${fall.name}-${breite}.png`) });
  await page.screenshot({ path: join(BILDER, `${fall.name}-${breite}-ganz.png`), fullPage: true });
}

for (const fall of FAELLE) {
  for (const breite of BREITEN) {
    test(`IP-8 ${fall.name} bei ${breite} px: Wortlaut, Knöpfe, kein Querlauf`, async ({ page }) => {
      await oeffne(page, fall, breite);
      const flaeche = page.locator(fall.ziel).first();
      for (const text of fall.sichtbar) await expect(flaeche).toContainText(text);
      const m = await messe(page, fall.ziel);
      expect(m.knoepfe).toEqual(fall.knoepfe);
      expect(m.dokument).toBe(0);
      expect(m.draussen).toEqual([]);
      expect(m.kleineTreffer).toEqual([]);
      if (fall.ohneGeld) expect(m.euro).toBe(false);
      await ablegen(page, fall, breite, m);
    });
  }
}
