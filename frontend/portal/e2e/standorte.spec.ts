import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { StandortAmStichtag, StandorteAmStichtag, Unternehmen } from '../src/api';
import {
  ahrenbergHeute,
  ahrenbergUnternehmen,
  bestandEineAnlage,
  bestandZweiAnlagen,
  werkAhrenberg,
  werkLindach,
} from '../src/test/standorteFixtures';
import { ortsbaumAhrenberg, ortsbaumLindach, ortsbaumLindachOhneGebaeude } from '../src/test/ortsbaumFixtures';

/**
 * „Unternehmen › Standorte“ und der Standort-Dialog (UEMS AP-02 IP-6) bei 375
 * und 1440 px: kein Querlauf der Seite, der Reiter, des Dialogs oder eines
 * einzelnen Elements — GEMESSEN, nicht behauptet. Die Cloud ist per
 * `page.route` verdrahtet (Referenzunternehmen Ahrenberg: Momentaufnahme
 * 20.10.2026, A5 eine Bestandsanlage, A6 zwei Bestandsanlagen).
 *
 * Mit `STANDORTE_BILDER=<Ordner>` legt der Lauf je Fall ein Bild ab und schreibt
 * die Messwerte je Fall nach `messung-<fall>-<breite>.json` — die Vorschau für die Freigabe.
 */

const BILDER = process.env.STANDORTE_BILDER;
const BREITEN = [375, 1440] as const;

interface Fall {
  liste: () => StandorteAmStichtag;
  unternehmen: () => Unternehmen;
}

const FAELLE = {
  heute: { liste: ahrenbergHeute, unternehmen: () => ahrenbergUnternehmen() },
  bestand: {
    liste: bestandEineAnlage,
    unternehmen: () => ahrenbergUnternehmen({ standortZahl: 1, anlagenZahl: 1, sitz: null }),
  },
  zwei: {
    liste: bestandZweiAnlagen,
    unternehmen: () => ahrenbergUnternehmen({ standortZahl: 0, nochNichtZugeordnetZahl: 2, sitz: null }),
  },
} satisfies Record<string, Fall>;

async function verdrahte(page: Page, fall: Fall) {
  const gesendet: { methode: string; pfad: string; body: unknown }[] = [];
  await page.route('**/api/v1/unternehmen', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fall.unternehmen()) }),
  );
  await page.route('**/api/v1/standorte/kurzzeichen-vorschlag', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ kurzzeichen: 'ST-2' }) }),
  );
  await page.route('**/api/v1/standorte/*/orte', (r) => {
    const standort = fall.liste().standorte.find((s) => r.request().url().includes(s.id))!;
    // Ein Standort ohne Gebäude (A5) bekommt den leeren Baum — sonst den des Referenzunternehmens.
    const baum =
      standort.gebaeudeZahl === 0
        ? { ...ortsbaumLindachOhneGebaeude(), standort, direktAmStandort: { bereiche: [], messstellenZahl: 0 } }
        : standort.id === werkLindach().id
          ? ortsbaumLindach()
          : ortsbaumAhrenberg();
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(baum) });
  });
  await page.route('**/api/v1/standorte**', async (r) => {
    const url = new URL(r.request().url());
    // AP-02 IP-7: jede Karte liest ihren Ortsbaum — dessen Antworten stehen darunter.
    if (url.pathname.endsWith('/kurzzeichen-vorschlag') || url.pathname.endsWith('/orte')) return r.fallback();
    const methode = r.request().method();
    if (methode === 'GET') {
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fall.liste()) });
    }
    gesendet.push({ methode, pfad: url.pathname, body: r.request().postDataJSON() });
    const antwort: StandortAmStichtag = methode === 'POST' ? werkLindach() : werkAhrenberg();
    return r.fulfill({ status: methode === 'POST' ? 201 : 200, contentType: 'application/json', body: JSON.stringify(antwort) });
  });
  return gesendet;
}

async function oeffne(page: Page, breite: number, fall: Fall) {
  const gesendet = await verdrahte(page, fall);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto('/e2e/standorte.html');
  await expect(page.getByRole('heading', { level: 1, name: 'Standorte' })).toBeVisible();
  return gesendet;
}

/** Querlauf in px: Seite, Reiterleiste, Dialog-Körper und jedes Element über den Rand. */
async function ueberlauf(page: Page, breite: number) {
  return page.evaluate((b) => {
    const draussen = [...document.querySelectorAll('.vp-main *, .vp-modal *')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      // Kinder einer eigenen Scrollfläche (Reiterleiste) zählen über deren Maß.
      .filter(({ el }) => !el.closest('.vp-bereich-tabs'))
      .filter(({ r }) => r.width > 0 && (r.right > b + 0.5 || r.left < -0.5))
      .map(({ el }) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`);
    const tabs = document.querySelector('.vp-bereich-tabs') as HTMLElement | null;
    const koerper = [...document.querySelectorAll('.vp-modal .dbody')] as HTMLElement[];
    const gekuerzt = [...document.querySelectorAll('.vp-modal .vp-picker-wert')]
      .filter((el) => el.scrollWidth > el.clientWidth + 0.5)
      .map((el) => el.textContent);
    return {
      seite: document.documentElement.scrollWidth - window.innerWidth,
      reiter: tabs ? tabs.scrollWidth - tabs.clientWidth : null,
      dialog: koerper.length ? Math.max(...koerper.map((k) => k.scrollWidth - k.clientWidth)) : null,
      draussen,
      gekuerzt,
    };
  }, breite);
}

async function messeUndFotografiere(page: Page, breite: number, name: string) {
  if (await page.locator('.vp-modal').count()) {
    await expect(page.locator('.vp-modal').last()).toHaveCSS('opacity', '1');
  }
  await page.waitForFunction(() => document.getAnimations().every((x) => x.playState !== 'running'));
  const m = await ueberlauf(page, breite);
  expect(m.seite, `${name} ${breite}: Seite`).toBe(0);
  expect(m.reiter ?? 0, `${name} ${breite}: Reiter`).toBe(0);
  expect(m.dialog ?? 0, `${name} ${breite}: Dialog`).toBe(0);
  expect(m.draussen, `${name} ${breite}: Elemente`).toEqual([]);
  expect(m.gekuerzt, `${name} ${breite}: gekürzte Auswahl`).toEqual([]);
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  writeFileSync(join(BILDER, `messung-${name}-${breite}.json`), JSON.stringify(m));
  await page.screenshot({ path: join(BILDER, `${name}-${breite}.png`) });
  if (await page.locator('.vp-modal').count()) {
    // Die ganze Dialogfläche, nicht nur der erste Bildschirm.
    const hoehe = await page.evaluate(() => {
      const oben = [...document.querySelectorAll('.vp-modal')].at(-1) as HTMLElement;
      const k = oben.querySelector('.dbody') as HTMLElement;
      const kopf = (oben.querySelector('.dhead') as HTMLElement).offsetHeight;
      const fuss = (oben.querySelector('.dfoot') as HTMLElement | null)?.offsetHeight ?? 0;
      return kopf + k.scrollHeight + fuss + 8;
    });
    const vorher = page.viewportSize()!;
    await page.setViewportSize({ width: breite, height: Math.max(vorher.height, hoehe) });
    await page.screenshot({ path: join(BILDER, `${name}-${breite}-ganz.png`) });
    await page.setViewportSize(vorher);
  } else {
    await page.screenshot({ path: join(BILDER, `${name}-${breite}-ganz.png`), fullPage: true });
  }
}

async function waehle(page: Page, feld: string, optionen: string[]) {
  await page.getByRole('combobox', { name: feld }).click();
  for (const o of optionen) await page.getByRole('option', { name: o }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
}

for (const breite of BREITEN) {
  test.describe(`${breite} px`, () => {
    test('Liste: Werk Ahrenberg und Werk Lindach, Standort-Kopf mit „Bearbeiten“', async ({ page }) => {
      await oeffne(page, breite, FAELLE.heute);
      await expect(page.getByRole('tab', { name: 'Standorte' })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('standort-kopf')).toHaveCount(2);
      await expect(page.getByTestId('standort-kopf').first()).toContainText('Gewerbering 7, Ahrenberg · 3 Gebäude · 2 Anlagen · 8 450 m²');
      await expect(page.getByTestId('noch-nicht-zugeordnet')).toHaveCount(0);
      await messeUndFotografiere(page, breite, 'liste');
    });

    test('Dialog anlegen (T2): Werk Lindach, Zeitzone vorbelegt, Nutzung in Reihenfolge', async ({ page }) => {
      const gesendet = await oeffne(page, breite, FAELLE.heute);
      await page.getByRole('button', { name: 'Standort anlegen' }).click();
      const dialog = page.getByRole('dialog', { name: 'Standort anlegen' });
      await expect(dialog.getByText('Name und Adresse sind Pflicht; Kurzzeichen ST-2 wird vergeben.')).toBeVisible();
      await expect(dialog.getByRole('combobox', { name: 'Zeitzone *' })).toHaveText('Europe/Berlin');
      await expect(dialog.getByText('vom Unternehmen', { exact: true })).toBeVisible();
      await dialog.getByLabel('Name *').fill('Werk Lindach 2');
      await dialog.getByLabel('Straße und Hausnummer *').fill('Am Bahndamm 12');
      await dialog.getByLabel('Ort *').fill('Lindach');
      await waehle(page, 'Nutzung', ['Lager', 'Logistik', 'Montage']);
      await messeUndFotografiere(page, breite, 'anlegen');
      await dialog.getByRole('button', { name: 'Standort anlegen' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(gesendet).toEqual([
        {
          methode: 'POST',
          pfad: '/api/v1/standorte',
          body: {
            name: 'Werk Lindach 2',
            adresse: { strasse: 'Am Bahndamm 12', plz: null, ort: 'Lindach', land: 'DE' },
            zeitzone: 'Europe/Berlin',
            nutzung: ['lager', 'logistik', 'montage'],
            notiz: null,
          },
        },
      ]);
    });

    test('Dialog anlegen leer senden: Pflichtfelder, Fokus auf dem Namen', async ({ page }) => {
      await oeffne(page, breite, FAELLE.zwei);
      await page.getByRole('button', { name: 'Standort anlegen' }).click();
      const dialog = page.getByRole('dialog', { name: 'Standort anlegen' });
      await dialog.getByRole('button', { name: 'Standort anlegen' }).click();
      await expect(dialog.getByText('Bitte geben Sie einen Namen an.')).toBeVisible();
      await expect(dialog.getByLabel('Name *')).toBeFocused();
      await messeUndFotografiere(page, breite, 'pflichtfelder');
    });

    test('Dialog anlegen mit belegtem Namen (§5.10)', async ({ page }) => {
      await oeffne(page, breite, FAELLE.heute);
      await page.getByRole('button', { name: 'Standort anlegen' }).click();
      const dialog = page.getByRole('dialog', { name: 'Standort anlegen' });
      await dialog.getByLabel('Name *').fill('Werk Ahrenberg');
      await dialog.getByLabel('Straße und Hausnummer *').fill('Gewerbering 7');
      await dialog.getByLabel('PLZ').fill('8440');
      await dialog.getByLabel('Ort *').fill('Ahrenberg');
      await dialog.getByRole('button', { name: 'Standort anlegen' }).click();
      await expect(
        dialog.getByText('Diesen Namen gibt es hier schon: Werk Ahrenberg (ST-1). Wählen Sie einen anderen Namen — oder öffnen Sie Werk Ahrenberg.'),
      ).toBeVisible();
      await expect(dialog.getByText('Die PLZ 8440 passt nicht zu Deutschland (fünfstellig).')).toBeVisible();
      await messeUndFotografiere(page, breite, 'name-belegt');
    });

    test('Dialog bearbeiten: Werk Ahrenberg, Fläche lesend, Rückkehr zum Auslöser', async ({ page }) => {
      const gesendet = await oeffne(page, breite, FAELLE.heute);
      const knopf = page.getByRole('button', { name: 'Werk Ahrenberg bearbeiten' });
      await knopf.click();
      const dialog = page.getByRole('dialog', { name: 'Standort bearbeiten' });
      await expect(dialog.getByLabel('Kurzzeichen *')).toHaveValue('ST-1');
      await expect(dialog.locator('.vp-sd-flaeche')).toContainText('8 450 m²');
      await messeUndFotografiere(page, breite, 'bearbeiten');
      await dialog.getByRole('button', { name: 'Speichern' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(knopf).toBeFocused();
      expect(gesendet[0]).toMatchObject({
        methode: 'PUT',
        body: { kurzzeichen: 'ST-1', lage: { breitengrad: 48.25, laengengrad: 11.43 }, nutzung: ['produktion', 'buero'] },
      });
    });

    test('A5 Bestandsanlage: Entwurf, „Adresse nachtragen“ öffnet „Standort vervollständigen“', async ({ page }) => {
      await oeffne(page, breite, FAELLE.bestand);
      await expect(page.getByText('Noch nicht eingerichtet — es fehlt: Adresse')).toBeVisible();
      await messeUndFotografiere(page, breite, 'bestand-liste');
      await page.getByRole('button', { name: /Adresse nachtragen/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Standort vervollständigen' });
      await expect(dialog.getByLabel('Name *')).toHaveValue('Werk Ahrenberg – Halle 1');
      await messeUndFotografiere(page, breite, 'vervollstaendigen');
    });

    test('A6 zwei Bestandsanlagen: Gruppe „Noch nicht zugeordnet“', async ({ page }) => {
      await oeffne(page, breite, FAELLE.zwei);
      const gruppe = page.getByTestId('noch-nicht-zugeordnet');
      await expect(gruppe.getByRole('link')).toHaveText(['Werk Ahrenberg – Halle 1', 'Werk Ahrenberg – Halle 2']);
      await messeUndFotografiere(page, breite, 'noch-nicht-zugeordnet');
    });
  });
}
