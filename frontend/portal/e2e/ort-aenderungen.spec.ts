import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { OrtAktionen, OrtsbaumAmStichtag, Protokoll } from '../src/api';
import { bereichNurAngelegt, halle2Protokoll, werkAhrenbergProtokoll } from '../src/test/ortAenderungenFixtures';
import { ORT_IDS, ortsbaumLindach } from '../src/test/ortsbaumFixtures';
import { ahrenbergV1 } from '../src/test/ortVerschiebenFixtures';
import { ahrenbergHeute, ahrenbergUnternehmen, werkLindach } from '../src/test/standorteFixtures';

/**
 * Das Änderungsprotokoll der Ortsstruktur (UEMS AP-02 IP-14, Mockup H2) bei 375 und 1440 px: kein
 * Querlauf der Seite, des Menüs, des Dialogs oder eines einzelnen Elements — GEMESSEN am Dokument,
 * nicht behauptet. Bühne ist die Liste „Standorte“ (`standorte.html`); die Cloud ist per
 * `page.route` verdrahtet, die Antworten aus `src/test/ortAenderungenFixtures.ts`.
 *
 * Mit `ORT_AENDERUNGEN_BILDER=<Ordner>` legt der Lauf je Fall ein Bild und `messung-<fall>-<breite>.json`
 * ab — die Vorschau für die Freigabe. `ANSICHT_VARIANTE=b` fotografiert NUR fürs Vergleichsbild die
 * Liste von Halle 2 „nach gilt ab“ (der Server antwortet dann mit `achse: wirkung`) — gebaut ist A,
 * nach dem Eintrag.
 */

const BILDER = process.env.ORT_AENDERUNGEN_BILDER;
const VARIANTE = process.env.ANSICHT_VARIANTE === 'b' ? 'b' : 'a';
const BREITEN = [375, 1440] as const;

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Werk Ahrenberg heute: Archivieren gesperrt (die Anlage ist aktiv) — damit sein Kopf ein Menü hat. */
const STANDORT_AKTIONEN: OrtAktionen = {
  archivieren: {
    erlaubt: false,
    text: 'Werk Ahrenberg kann nicht archiviert werden: die Anlage Werk Ahrenberg – Halle 2 ist aktiv.',
    gruende: [],
    letzterTag: null,
    mitarchiviert: [],
  },
  wiederherstellen: null,
  loeschen: null,
};

async function verdrahte(page: Page) {
  const anfragen: string[] = [];
  const ahrenberg = (): OrtsbaumAmStichtag => ({ ...ahrenbergV1(), stichtag: '2027-05-20', aktionen: STANDORT_AKTIONEN });
  await page.route('**/api/v1/unternehmen', (r) => r.fulfill(json(ahrenbergUnternehmen())));
  await page.route('**/api/v1/standorte**', (r) => {
    const url = new URL(r.request().url());
    if (url.pathname.endsWith('/orte')) {
      return r.fulfill(json(url.pathname.includes(werkLindach().id) ? ortsbaumLindach() : ahrenberg()));
    }
    return r.fulfill(json(ahrenbergHeute()));
  });
  // Später verdrahtet gewinnt: die Protokoll-Wege vor der allgemeinen Standort-Route.
  await page.route('**/api/v1/standorte/*/aenderungen**', (r) => {
    anfragen.push(r.request().url());
    return r.fulfill(json(werkAhrenbergProtokoll()));
  });
  await page.route('**/api/v1/orte/*/aenderungen**', (r) => {
    const url = new URL(r.request().url());
    anfragen.push(url.toString());
    const antwort: Protokoll = url.pathname.includes(ORT_IDS.b4)
      ? bereichNurAngelegt()
      : halle2Protokoll(VARIANTE === 'b' ? 'wirkung' : 'eintrag');
    return r.fulfill(json(antwort));
  });
  return anfragen;
}

async function oeffne(page: Page, breite: number) {
  const anfragen = await verdrahte(page);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto('/e2e/standorte.html');
  await expect(page.getByTestId('ortsbaum')).toHaveCount(2);
  await expect(page.locator('.vp-ob [aria-busy]')).toHaveCount(0);
  return anfragen;
}

async function menue(page: Page, wo: 'ortsbaum' | 'standort-kopf', name: string) {
  const knopf = page.getByTestId(wo).first().getByRole('button', { name: `Aktionen: ${name}`, exact: true });
  await knopf.scrollIntoViewIfNeeded();
  await knopf.click();
  const gruppe = page.getByRole('group', { name: `Aktionen: ${name}`, exact: true });
  await expect(gruppe).toBeVisible();
  return gruppe;
}

async function protokoll(page: Page, wo: 'ortsbaum' | 'standort-kopf', name: string) {
  const gruppe = await menue(page, wo, name);
  await gruppe.getByRole('button', { name: 'Änderungsprotokoll' }).click();
  const dialog = page.locator('.vp-modal').last();
  await expect(dialog.getByText(`Änderungsprotokoll: ${name}`)).toBeVisible();
  await expect(dialog.locator('.vp-befehl').first()).toBeVisible();
  return dialog;
}

/** Querlauf in px: Seite (am Dokument), Dialog-Körper, Menü, jede Protokoll-Zeile und jedes Element über den Rand. */
async function messe(page: Page, breite: number) {
  return page.evaluate((b) => {
    const draussen = [...document.querySelectorAll('.vp-main *, .vp-modal *, .vp-om-pop, .vp-om-pop *')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ el }) => !el.closest('.vp-bereich-tabs'))
      .filter(({ r }) => r.width > 0 && (r.right > b + 0.5 || r.left < -0.5))
      .map(({ el }) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`);
    const koerper = [...document.querySelectorAll('.vp-modal .dbody')] as HTMLElement[];
    const menue = document.querySelector('.vp-om-pop') as HTMLElement | null;
    const zeilen = [...document.querySelectorAll('.vp-modal .vp-befehl')] as HTMLElement[];
    return {
      seite: document.documentElement.scrollWidth - window.innerWidth,
      dialog: koerper.length ? Math.max(...koerper.map((k) => k.scrollWidth - k.clientWidth)) : null,
      menue: menue ? { breite: Math.round(menue.getBoundingClientRect().width), quer: menue.scrollWidth - menue.clientWidth } : null,
      zeilen: zeilen.length ? Math.max(...zeilen.map((z) => z.scrollWidth - z.clientWidth)) : null,
      draussen,
      dialogInhaltHoehe: koerper.length ? koerper[koerper.length - 1].scrollHeight : null,
      dialogSichtHoehe: koerper.length ? koerper[koerper.length - 1].clientHeight : null,
    };
  }, breite);
}

async function messeUndFotografiere(page: Page, breite: number, name: string) {
  if (await page.locator('.vp-modal').count()) {
    await expect(page.locator('.vp-modal').last()).toHaveCSS('opacity', '1');
  }
  await page.waitForFunction(() => document.getAnimations().every((x) => x.playState !== 'running'));
  const m = await messe(page, breite);
  expect(m.seite, `${name} ${breite}: Seite`).toBe(0);
  expect(m.dialog ?? 0, `${name} ${breite}: Dialog`).toBe(0);
  expect(m.menue?.quer ?? 0, `${name} ${breite}: Menü`).toBe(0);
  expect(m.zeilen ?? 0, `${name} ${breite}: Zeilen`).toBe(0);
  expect(m.draussen, `${name} ${breite}: Elemente über dem Rand`).toEqual([]);
  if (!BILDER) return;
  const datei = `${name}-${breite}`;
  mkdirSync(BILDER, { recursive: true });
  writeFileSync(join(BILDER, `messung-${datei}.json`), JSON.stringify(m, null, 2));
  await page.screenshot({ path: join(BILDER, `${datei}.png`) });
  if (m.dialogInhaltHoehe && m.dialogSichtHoehe && m.dialogInhaltHoehe > m.dialogSichtHoehe) {
    const vorher = page.viewportSize()!;
    await page.setViewportSize({ width: breite, height: vorher.height + (m.dialogInhaltHoehe - m.dialogSichtHoehe) + 40 });
    await page.waitForFunction(() => document.getAnimations().every((x) => x.playState !== 'running'));
    await page.screenshot({ path: join(BILDER, `${datei}-ganz.png`) });
    await page.setViewportSize(vorher);
  }
}

for (const breite of BREITEN) {
  test.describe(`${breite} px`, () => {
    test('H2 Menü: „Änderungsprotokoll“ steht direkt hinter „Verschieben …“', async ({ page }) => {
      test.skip(VARIANTE === 'b');
      await oeffne(page, breite);
      const gruppe = await menue(page, 'ortsbaum', 'Halle 2');
      const knoepfe = await gruppe.getByRole('button').allTextContents();
      expect(knoepfe.slice(0, 2)).toEqual(['Verschieben …', 'Änderungsprotokoll']);
      await messeUndFotografiere(page, breite, 'h2-menue');
    });

    test('H2 Halle 2: nach dem Eintrag, „rückwirkend (37 Tage)“, gilt ab einem Tag', async ({ page }) => {
      const anfragen = await oeffne(page, breite);
      const dialog = await protokoll(page, 'ortsbaum', 'Halle 2');
      expect(new URL(anfragen[anfragen.length - 1]).searchParams.get('achse')).toBe('eintrag');
      if (VARIANTE === 'a') {
        await expect(dialog.getByText('Sortiert danach, wann die Änderung eingetragen wurde.')).toBeVisible();
      }
      await expect(dialog.getByText('rückwirkend (37 Tage)')).toBeVisible();
      await expect(dialog.getByText('rückwirkend (14 Tage)')).toBeVisible();
      await expect(dialog.getByText('gilt ab 01.02.2027')).toBeVisible();
      // „Von Steuern soll beim Messen noch nicht die Rede sein“ — auch nicht im Protokoll.
      await expect(dialog.getByText(/Steuer/)).toHaveCount(0);
      await messeUndFotografiere(page, breite, VARIANTE === 'b' ? 'h2-halle2-b' : 'h2-halle2');
    });

    test('H2 Werk Ahrenberg: Kinder und Anlage stehen mit ihrem Objekt da', async ({ page }) => {
      test.skip(VARIANTE === 'b');
      await oeffne(page, breite);
      const dialog = await protokoll(page, 'standort-kopf', 'Werk Ahrenberg');
      await expect(dialog.locator('.vp-befehl-strom').first()).toHaveText('G-2 · Halle 2');
      await expect(dialog.getByText('Anlage zieht um: Werk Ahrenberg – Halle 2 → Werk Ahrenberg Nord')).toBeVisible();
      await messeUndFotografiere(page, breite, 'h2-standort');
    });

    test('Leerzustand: nur der Anlege-Eintrag', async ({ page }) => {
      test.skip(VARIANTE === 'b');
      await oeffne(page, breite);
      const dialog = await protokoll(page, 'ortsbaum', 'Halle 2 Spritzguss');
      await expect(dialog.getByText('Seit dem Anlegen am 01.10.2026 keine Änderung.')).toBeVisible();
      await messeUndFotografiere(page, breite, 'h2-leer');
    });
  });
}
