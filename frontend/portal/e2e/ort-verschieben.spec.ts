import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { OrtsbaumAmStichtag } from '../src/api';
import { ortsbaumLindach } from '../src/test/ortsbaumFixtures';
import {
  ahrenbergV1,
  ahrenbergV4,
  halle2NachNord,
  halle2Rueckwirkend,
  halle2Verschoben,
} from '../src/test/ortVerschiebenFixtures';
import { ahrenbergHeute, ahrenbergUnternehmen, werkLindach } from '../src/test/standorteFixtures';

/**
 * Gebäude/Bereich verschieben (UEMS AP-02 IP-12, V1–V4) bei 375 und 1440 px: kein Querlauf der Seite, des
 * Menüs, des Dialogs oder eines einzelnen Elements — GEMESSEN am Dokument, nicht behauptet. Bühne ist die
 * Liste „Standorte“ (`standorte.html`); die Cloud ist per `page.route` verdrahtet, die Antworten aus
 * `src/test/ortVerschiebenFixtures.ts`.
 *
 * Mit `ORT_VERSCHIEBEN_BILDER=<Ordner>` legt der Lauf je Fall ein Bild und `messung-<fall>-<breite>.json` ab —
 * die Vorschau für die Freigabe. `ANSICHT_VARIANTE=b` fotografiert NUR fürs Vergleichsbild V1 die Variante
 * „Bearbeiten im Menü, kein Stift“ (Mockup V1) — gebaut ist A (Stift UND Menü, wie IP-15).
 */

const BILDER = process.env.ORT_VERSCHIEBEN_BILDER;
const VARIANTE = process.env.ANSICHT_VARIANTE === 'b' ? 'b' : 'a';
const BREITEN = [375, 1440] as const;
const VOR_BEGINN = 'Halle 2 gibt es im Portal erst seit 01.10.2026. Wählen Sie ein Datum ab dem 01.10.2026.';

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function verdrahte(page: Page, heute: string) {
  let verschoben = false;
  const gesendet: unknown[] = [];
  const ahrenberg = (): OrtsbaumAmStichtag => ({ ...(verschoben ? ahrenbergV4() : ahrenbergV1()), stichtag: heute });
  await page.route('**/api/v1/unternehmen', (r) => r.fulfill(json(ahrenbergUnternehmen())));
  await page.route('**/api/v1/standorte**', (r) => {
    const url = new URL(r.request().url());
    if (url.pathname.endsWith('/orte')) {
      return r.fulfill(json(url.pathname.includes(werkLindach().id) ? ortsbaumLindach() : ahrenberg()));
    }
    return r.fulfill(json(ahrenbergHeute()));
  });
  await page.route('**/api/v1/orte/*/verschieben/vorschau**', (r) => {
    const ab = new URL(r.request().url()).searchParams.get('gueltigAb') ?? '';
    if (ab < '2026-10-01') {
      return r.fulfill(json({ code: 'vor_dem_ersten_intervall', message: VOR_BEGINN, feld: 'gueltigAb' }, 422));
    }
    return r.fulfill(json(ab < heute ? halle2Rueckwirkend() : halle2NachNord()));
  });
  await page.route('**/api/v1/orte/*/verschieben', (r) => {
    gesendet.push(r.request().postDataJSON());
    verschoben = true;
    return r.fulfill(json(halle2Verschoben()));
  });
  return gesendet;
}

async function oeffne(page: Page, breite: number, heute = '2027-02-20') {
  const gesendet = await verdrahte(page, heute);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto('/e2e/standorte.html');
  await expect(page.getByTestId('ortsbaum')).toHaveCount(2);
  await expect(page.locator('.vp-ob [aria-busy]')).toHaveCount(0);
  return gesendet;
}

const baum = (page: Page) => page.getByTestId('ortsbaum').first();

async function menue(page: Page, name: string) {
  const knopf = baum(page).getByRole('button', { name: `Aktionen: ${name}` });
  await knopf.scrollIntoViewIfNeeded();
  await knopf.click();
  const gruppe = page.getByRole('group', { name: `Aktionen: ${name}` });
  await expect(gruppe).toBeVisible();
  return gruppe;
}

/** Den Tag im Feld „Gültig ab *“ wählen — Monat für Monat geblättert, nur Tage des Monats selbst. */
async function waehleTag(page: Page, dialog: Locator, iso: string) {
  const feld = dialog.getByRole('combobox', { name: 'Gültig ab *' });
  const [t, m, j] = (await feld.textContent())!.match(/\d{2}\.\d{2}\.\d{4}/)![0].split('.');
  const richtung = iso < `${j}-${m}-${t}` ? 'Voriger Monat' : 'Nächster Monat';
  await feld.click();
  const tag = page.locator(`.vp-kal-tag[data-iso="${iso}"]:not(.is-rand)`);
  for (let i = 0; i < 24 && !(await tag.count()); i++) await page.getByRole('button', { name: richtung }).click();
  await tag.click();
  await expect(page.locator('.vp-kal-gitter')).toHaveCount(0);
}

async function oeffneDialog(page: Page) {
  await (await menue(page, 'Halle 2')).getByRole('button', { name: 'Verschieben …' }).click();
  const dialog = page.locator('.vp-modal').last();
  await expect(dialog.getByRole('heading', { name: 'Halle 2 verschieben' })).toBeVisible();
  await dialog.getByRole('combobox', { name: 'Neuer Standort *' }).click();
  await expect(page.getByRole('option', { name: /Werk Ahrenberg \(ST-1\)/ })).toHaveCount(0);
  await page.getByRole('option', { name: /Werk Ahrenberg Nord \(ST-3\)/ }).click();
  return dialog;
}

/** Querlauf in px: Seite (am Dokument), Dialog-Körper, Menü und jedes Element über den Rand. */
async function messe(page: Page, breite: number) {
  return page.evaluate((b) => {
    const draussen = [...document.querySelectorAll('.vp-main *, .vp-modal *, .vp-om-pop, .vp-om-pop *')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ el }) => !el.closest('.vp-bereich-tabs'))
      .filter(({ r }) => r.width > 0 && (r.right > b + 0.5 || r.left < -0.5))
      .map(({ el }) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`);
    const koerper = [...document.querySelectorAll('.vp-modal .dbody')] as HTMLElement[];
    const menue = document.querySelector('.vp-om-pop') as HTMLElement | null;
    const texte = [...document.querySelectorAll('[data-testid="ortsbaum"] .vp-ob-zeile:not(.vp-ob-zeile-still) .vp-ob-text')] as HTMLElement[];
    const folgen = document.querySelector('[data-testid="verschieben-folgen"]') as HTMLElement | null;
    return {
      seite: document.documentElement.scrollWidth - window.innerWidth,
      dialog: koerper.length ? Math.max(...koerper.map((k) => k.scrollWidth - k.clientWidth)) : null,
      menue: menue ? { breite: Math.round(menue.getBoundingClientRect().width), quer: menue.scrollWidth - menue.clientWidth } : null,
      draussen,
      // Für den Variantenvergleich V1: wie breit der Text einer Zeile bleibt.
      textBreite: texte.length ? Math.round(Math.min(...texte.map((t) => t.getBoundingClientRect().width))) : null,
      folgenHoehe: folgen ? Math.round(folgen.getBoundingClientRect().height) : null,
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

/** Variante B — nur im DOM des Vergleichsbilds: kein Stift je Zeile, „Bearbeiten“ als erster Menüpunkt. */
async function varianteB(page: Page) {
  await page.addStyleTag({ content: '[data-testid="ortsbaum"] .vp-ob-bearbeiten:not(.vp-om-knopf), [data-testid="ortsbaum"] .vp-ob-bearbeiten-platz { display: none !important; }' });
}

async function bearbeitenImMenue(page: Page) {
  await page.evaluate(() => {
    const pop = document.querySelector('.vp-om-pop');
    if (!pop) return;
    const knopf = document.createElement('button');
    knopf.type = 'button';
    const text = document.createElement('span');
    text.className = 'vp-om-text';
    text.textContent = 'Bearbeiten …';
    knopf.append(text);
    pop.prepend(knopf);
  });
}

for (const breite of BREITEN) {
  test.describe(`${breite} px`, () => {
    test('V1 Menü: Halle 2 — „Verschieben …“ vorn, Löschen nur als Hinweis mit Grund', async ({ page }) => {
      await oeffne(page, breite);
      if (VARIANTE === 'b') await varianteB(page);
      const gruppe = await menue(page, 'Halle 2');
      await expect(gruppe.getByRole('button').first()).toHaveText('Verschieben …');
      await expect(gruppe.getByRole('button', { name: /Löschen/ })).toHaveCount(0);
      await expect(gruppe.getByTestId('hinweis-loeschen_gesperrt')).toContainText('Halle 2 hat Historie (Messstellen, Fläche und Bereiche)');
      if (VARIANTE === 'b') {
        await bearbeitenImMenue(page);
        await messeUndFotografiere(page, breite, 'v1-menue-b');
        return;
      }
      await messeUndFotografiere(page, breite, 'v1-menue');
    });

    test('V2 Ziel und Tag: der bisherige Standort steht nicht zur Wahl, 01.03.2027 ist geplant', async ({ page }) => {
      test.skip(VARIANTE === 'b');
      await oeffne(page, breite);
      const dialog = await oeffneDialog(page);
      await waehleTag(page, dialog, '2027-03-01');
      await expect(dialog.getByText('Geplant: bis 28.02.2027 bleibt alles, wie es ist.')).toBeVisible();
      await dialog.getByRole('combobox', { name: 'Neuer Standort *' }).scrollIntoViewIfNeeded();
      await messeUndFotografiere(page, breite, 'v2-ziel');
    });

    test('V2 rückwirkend: am 10.03.2027 eingetragen, gültig ab 20.02.2027 — gekennzeichnet', async ({ page }) => {
      test.skip(VARIANTE === 'b');
      await oeffne(page, breite, '2027-03-10');
      const dialog = await oeffneDialog(page);
      await waehleTag(page, dialog, '2027-02-20');
      await expect(dialog.getByText('Rückwirkend (18 Tage): wird im Änderungsprotokoll so gekennzeichnet.')).toBeVisible();
      await expect(dialog.getByTestId('verschieben-folgen')).toContainText('Rückwirkend (18 Tage): Auswertungen vom 20.02.2027 bis 09.03.2027 zählen nachträglich anders.');
      await dialog.getByRole('combobox', { name: 'Gültig ab *' }).scrollIntoViewIfNeeded();
      await messeUndFotografiere(page, breite, 'v2-rueckwirkend');
    });

    test('V2 vor dem Beginn: abgelehnt mit dem Grund am Feld, keine Folgen-Karte', async ({ page }) => {
      test.skip(VARIANTE === 'b');
      await oeffne(page, breite);
      const dialog = await oeffneDialog(page);
      await waehleTag(page, dialog, '2026-09-30');
      await expect(dialog.getByText(VOR_BEGINN)).toBeVisible();
      await expect(dialog.getByTestId('verschieben-folgen')).toHaveCount(0);
      await messeUndFotografiere(page, breite, 'v2-abgelehnt');
    });

    test('V3 Folgen-Karte: was mitzieht, was bleibt — und „Nichts ändert sich …“', async ({ page }) => {
      test.skip(VARIANTE === 'b');
      await oeffne(page, breite);
      const dialog = await oeffneDialog(page);
      await waehleTag(page, dialog, '2027-03-01');
      const karte = dialog.getByTestId('verschieben-folgen');
      await expect(karte).toContainText('Die Bereiche Halle 2 Montage, Halle 2 Spritzguss und Halle 2 Lager ziehen mit.');
      await expect(karte).toContainText('Die Anlage „Werk Ahrenberg – Halle 2“ bleibt bei Werk Ahrenberg (ST-1).');
      await expect(karte).toContainText('MS-14 Ladepunkt Parkplatz Halle 2 hängt direkt am Standort Werk Ahrenberg und bleibt dort.');
      await expect(karte).toContainText('Nichts ändert sich an Anlagen, Netzanschlüssen und VoltPilot-Boxen');
      await karte.scrollIntoViewIfNeeded();
      await messeUndFotografiere(page, breite, 'v3-folgen');
    });

    test('V4 Ergebnis: Zeitstrahl und Protokolleintrag, danach das Abzeichen im Baum', async ({ page }) => {
      test.skip(VARIANTE === 'b');
      const gesendet = await oeffne(page, breite);
      const dialog = await oeffneDialog(page);
      await waehleTag(page, dialog, '2027-03-01');
      await expect(dialog.getByTestId('verschieben-folgen')).toBeVisible();
      await dialog.getByRole('button', { name: 'Verschieben', exact: true }).click();
      await expect(dialog.getByRole('heading', { name: 'Verschiebung gespeichert' })).toBeVisible();
      expect(gesendet).toEqual([{ zielId: halle2NachNord().neu.id, gueltigAb: '2027-03-01' }]);
      await expect(dialog.getByTestId('zeitstrahl')).toContainText('Werk Ahrenberg Nord (ST-3)');
      await expect(dialog.getByTestId('verschieben-protokoll')).toContainText('Gebäude verschoben: Werk Ahrenberg → Werk Ahrenberg Nord (ST-3)');
      await messeUndFotografiere(page, breite, 'v4-ergebnis');

      await dialog.getByRole('button', { name: 'Fertig' }).click();
      const abzeichen = baum(page).getByTestId('danach');
      await expect(abzeichen).toHaveText('ab 01.03.2027 → Werk Ahrenberg Nord');
      await abzeichen.scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollBy(0, -120));
      await messeUndFotografiere(page, breite, 'v4-baum');
    });
  });
}
