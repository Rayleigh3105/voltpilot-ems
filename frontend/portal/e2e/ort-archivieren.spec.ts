import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { OrtsbaumAmStichtag } from '../src/api';
import {
  ahrenbergA8Archiviert,
  ahrenbergA8Archivieren,
  ahrenbergA9,
  lindachA7,
} from '../src/test/ortArchivFixtures';
import { ortNachSchreiben, ortsbaumLindach } from '../src/test/ortsbaumFixtures';
import { ahrenbergHeute, ahrenbergUnternehmen, werkLindach } from '../src/test/standorteFixtures';

/**
 * Archivieren, Wiederherstellen und Löschen im Ortsbaum (UEMS AP-02 IP-15, Z1–Z3, A9) bei 375
 * und 1440 px: kein Querlauf der Seite, des Menüs, des Dialogs oder eines einzelnen Elements —
 * GEMESSEN, nicht behauptet. Bühne ist die Liste „Standorte“ (`standorte.html`); die Cloud ist per
 * `page.route` verdrahtet, die Antworten aus `src/test/ortArchivFixtures.ts`.
 *
 * Mit `ORT_ARCHIV_BILDER=<Ordner>` legt der Lauf je Fall ein Bild und `messung-<fall>-<breite>.json`
 * ab — die Vorschau für die Freigabe.
 */

const BILDER = process.env.ORT_ARCHIV_BILDER;
const BREITEN = [375, 1440] as const;

async function verdrahte(
  page: Page,
  baeume: { ahrenberg: OrtsbaumAmStichtag; lindach: OrtsbaumAmStichtag; ahrenbergAm?: (tag: string) => OrtsbaumAmStichtag },
) {
  await page.route('**/api/v1/unternehmen', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ahrenbergUnternehmen()) }),
  );
  await page.route('**/api/v1/standorte**', (r) => {
    const url = new URL(r.request().url());
    const tag = url.searchParams.get('stichtag');
    if (url.pathname.endsWith('/orte')) {
      const lindach = url.pathname.includes(werkLindach().id);
      const baum = lindach
        ? { ...baeume.lindach, stichtag: tag ?? baeume.lindach.stichtag }
        : tag && baeume.ahrenbergAm
          ? baeume.ahrenbergAm(tag)
          : baeume.ahrenberg;
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(baum) });
    }
    const liste = ahrenbergHeute();
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...liste, stichtag: tag ?? liste.stichtag }),
    });
  });
  await page.route('**/api/v1/orte/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ortNachSchreiben()) }),
  );
  // AP-12 IP-9 · freigegebene Berichte (Ahrenberg): vier Berichtsstände zitieren Messstellen des Orts.
  await page.route('**/api/v1/berichte/betroffen**', (r) => {
    const q = new URL(r.request().url()).searchParams;
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        anlass: q.get('anlass'),
        gilt_ab: q.get('gilt_ab'),
        berichte_vorhanden: true,
        betroffen: [],
        zitieren: [
          { kennung: 'BR-2026-0001', nr: 1 },
          { kennung: 'BR-2026-0001', nr: 2 },
          { kennung: 'BR-2026-0002', nr: 1 },
          { kennung: 'BR-2026-0004', nr: 1 },
        ],
      }),
    });
  });
}

async function oeffne(
  page: Page,
  breite: number,
  ahrenberg: OrtsbaumAmStichtag,
  lindach = ortsbaumLindach(),
  ahrenbergAm?: (tag: string) => OrtsbaumAmStichtag,
) {
  await verdrahte(page, { ahrenberg, lindach, ahrenbergAm });
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto('/e2e/standorte.html');
  await expect(page.getByTestId('ortsbaum')).toHaveCount(2);
  await expect(page.locator('.vp-ob [aria-busy]')).toHaveCount(0);
}

/** Querlauf in px: Seite, Dialog-Körper, Menü und jedes Element über den Rand. */
async function ueberlauf(page: Page, breite: number) {
  return page.evaluate((b) => {
    const draussen = [...document.querySelectorAll('.vp-main *, .vp-modal *, .vp-om-pop, .vp-om-pop *')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ el }) => !el.closest('.vp-bereich-tabs'))
      .filter(({ r }) => r.width > 0 && (r.right > b + 0.5 || r.left < -0.5))
      .map(({ el }) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`);
    const koerper = [...document.querySelectorAll('.vp-modal .dbody')] as HTMLElement[];
    const menue = document.querySelector('.vp-om-pop') as HTMLElement | null;
    const texte = [...document.querySelectorAll('.vp-ob-text')] as HTMLElement[];
    return {
      seite: document.documentElement.scrollWidth - window.innerWidth,
      dialog: koerper.length ? Math.max(...koerper.map((k) => k.scrollWidth - k.clientWidth)) : null,
      menue: menue ? { breite: Math.round(menue.getBoundingClientRect().width), quer: menue.scrollWidth - menue.clientWidth } : null,
      draussen,
      // Für die Vorschau: wie breit der Text einer Zeile mit Stift UND Menü bleibt.
      textBreite: texte.length ? Math.round(Math.min(...texte.map((t) => t.getBoundingClientRect().width))) : null,
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
  expect(m.dialog ?? 0, `${name} ${breite}: Dialog`).toBe(0);
  expect(m.menue?.quer ?? 0, `${name} ${breite}: Menü`).toBe(0);
  expect(m.draussen, `${name} ${breite}: Elemente`).toEqual([]);
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  writeFileSync(join(BILDER, `messung-${name}-${breite}.json`), JSON.stringify(m));
  await page.screenshot({ path: join(BILDER, `${name}-${breite}.png`) });
  if (await page.locator('.vp-modal').count()) {
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
  }
}

const baum = (page: Page, nr: 0 | 1) => page.getByTestId('ortsbaum').nth(nr);

/** Wie `stand-am.spec.ts`: der Tag im Datumsfeld „Stand am“, Monat für Monat geblättert. */
async function waehleTag(page: Page, iso: string) {
  const feld = page.getByRole('combobox', { name: 'Stand am' });
  const [t, m, j] = (await feld.textContent())!.match(/\d{2}\.\d{2}\.\d{4}/)![0].split('.');
  const richtung = iso < `${j}-${m}-${t}` ? 'Voriger Monat' : 'Nächster Monat';
  await feld.click();
  const tag = page.locator(`.vp-kal-tag[data-iso="${iso}"]:not(.is-rand)`);
  for (let i = 0; i < 24 && !(await tag.count()); i++) await page.getByRole('button', { name: richtung }).click();
  await tag.click();
  await expect(page.locator('.vp-kal-gitter')).toHaveCount(0);
  const [jj, mm, dd] = iso.split('-');
  await expect(page.getByRole('status')).toContainText(`Sie sehen den Stand am ${dd}.${mm}.${jj}`);
  await expect(page.getByText('Gebäude werden geladen …')).toHaveCount(0);
}

async function menue(page: Page, nr: 0 | 1, name: string) {
  const knopf = baum(page, nr).getByRole('button', { name: `Aktionen: ${name}` });
  await knopf.scrollIntoViewIfNeeded();
  await knopf.click();
  const gruppe = page.getByRole('group', { name: `Aktionen: ${name}` });
  await expect(gruppe).toBeVisible();
  return gruppe;
}

for (const breite of BREITEN) {
  test.describe(`${breite} px`, () => {
    test('Z1 Menü: Montagehalle Lindach — „Archivieren nicht möglich …“ mit Grund, Löschen nur als Hinweis', async ({ page }) => {
      await oeffne(page, breite, ahrenbergA9(), lindachA7());
      const gruppe = await menue(page, 1, 'Montagehalle Lindach');
      await expect(gruppe.getByRole('button', { name: /Archivieren nicht möglich/ })).toContainText('1 Messstelle ist hier aktiv');
      await expect(gruppe.getByRole('button', { name: /Löschen/ })).toHaveCount(0);
      await expect(gruppe.getByTestId('hinweis-loeschen_gesperrt')).toContainText('Montagehalle Lindach hat Historie');
      await messeUndFotografiere(page, breite, 'z1-menue');
    });

    test('Z1 Dialog: „Archivieren nicht möglich“ — der Satz des Vertrags und der Weg', async ({ page }) => {
      await oeffne(page, breite, ahrenbergA9(), lindachA7());
      await (await menue(page, 1, 'Montagehalle Lindach')).getByRole('button', { name: /Archivieren nicht möglich/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Archivieren nicht möglich' });
      await expect(dialog).toContainText('Ziehen Sie die Messstelle zuerst um oder legen Sie sie still');
      await expect(dialog).toContainText('Messstelle umziehen oder stilllegen');
      await expect(dialog.getByRole('button', { name: 'Archivieren' })).toHaveCount(0);
      await messeUndFotografiere(page, breite, 'z1-dialog');
    });

    test('Z2: „Halle 2 Lager archivieren?“ mit der Folgenliste', async ({ page }) => {
      await oeffne(page, breite, ahrenbergA8Archivieren());
      await (await menue(page, 0, 'Halle 2 Lager')).getByRole('button', { name: 'Archivieren …' }).click();
      const dialog = page.getByRole('dialog', { name: 'Halle 2 Lager archivieren?' });
      await expect(dialog).toContainText('Zuordnung endet am 29.06.2027');
      await expect(dialog).toContainText('Wiederherstellen jederzeit möglich');
      // AP-12 IP-9: die letzte Folge nennt, wie viele freigegebene Berichtsstände den Ort zitieren.
      const berichte = dialog.getByRole('listitem').last();
      await expect(berichte).toContainText('Freigegebene Berichte');
      await expect(berichte).toContainText('4 zitieren Messstellen dieses Orts — sie bleiben unverändert.');
      await berichte.scrollIntoViewIfNeeded();
      await messeUndFotografiere(page, breite, 'z2-dialog');
    });

    test('Z3 Baum: Halle 2 Lager ausgegraut mit „Archiviert am 30.06.2027“, Menü mit „Wiederherstellen …“', async ({ page }) => {
      await oeffne(page, breite, ahrenbergA8Archiviert());
      const zeile = baum(page, 0).locator('.vp-ob-zeile-still', { hasText: 'Halle 2 Lager' });
      await expect(zeile.getByTestId('archiviert-am')).toHaveText('Archiviert am 30.06.2027');
      // Erst der Baum selbst (das offene Menü verdeckte die Zeile „Archiviert am …“), dann das Menü.
      await zeile.scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollBy(0, -160));
      await messeUndFotografiere(page, breite, 'z3-grabstein');
      const gruppe = await menue(page, 0, 'Halle 2 Lager');
      await expect(gruppe.getByRole('button', { name: 'Wiederherstellen …' })).toBeVisible();
      await expect(gruppe.getByRole('button', { name: /Löschen/ })).toHaveCount(0);
      await messeUndFotografiere(page, breite, 'z3-baum');
    });

    test('Z3 in „Stand am 15.07.2027“: Halle 2 Lager ausgegraut mit Archivtag — ohne Menü, ohne Schreibweg', async ({ page }) => {
      await oeffne(page, breite, ahrenbergA8Archiviert(), ortsbaumLindach(), (tag) => ahrenbergA8Archiviert({ stichtag: tag }));
      await waehleTag(page, '2027-07-15');
      const zeile = baum(page, 0).locator('.vp-ob-zeile-still', { hasText: 'Halle 2 Lager' });
      await expect(zeile.getByTestId('archiviert-am')).toHaveText('Archiviert am 30.06.2027');
      await expect(page.getByRole('button', { name: /^Aktionen: / })).toHaveCount(0);
      await zeile.scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollBy(0, -160));
      await messeUndFotografiere(page, breite, 'z3-stand-am');
    });

    test('Z3 Dialog: Wiederherstellen mit inzwischen vergebenem Namen — der Satz am Feld', async ({ page }) => {
      await oeffne(page, breite, ahrenbergA8Archiviert({ nameBelegt: true }));
      await (await menue(page, 0, 'Halle 2 Lager')).getByRole('button', { name: 'Wiederherstellen …' }).click();
      const dialog = page.getByRole('dialog', { name: 'Halle 2 Lager wiederherstellen' });
      await expect(dialog).toContainText('Diesen Namen gibt es hier schon');
      await expect(dialog).toContainText('Gilt wieder ab 01.02.2028');
      await messeUndFotografiere(page, breite, 'z3-dialog');
    });

    test('A9: „Halle 2 Test löschen?“ — die Rückfrage vor dem endgültigen Löschen', async ({ page }) => {
      await oeffne(page, breite, ahrenbergA9());
      await (await menue(page, 0, 'Halle 2 Test')).getByRole('button', { name: 'Löschen …' }).click();
      const dialog = page.getByRole('dialog', { name: 'Halle 2 Test löschen?' });
      await expect(dialog).toContainText('Kurzzeichen B-8 wird nicht wieder vergeben');
      await messeUndFotografiere(page, breite, 'a9-loeschen');
    });
  });
}
