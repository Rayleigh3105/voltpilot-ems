import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnlageUmzug, StandorteAmStichtag } from '../src/api';
import { ahrenbergHeute, ahrenbergUnternehmen, FIXTURE_IDS, werkAhrenberg } from '../src/test/standorteFixtures';

/**
 * UEMS AP-02 IP-11 · T6b „Anlage zuordnen“ mit Folgen-Karte, am echten Weg: die Bühne
 * `meine-anlage.html?fall=ahrenberg` (die echte `TechnikSection`), Zeile „Standort“ →
 * „Anderem Standort zuordnen“ → Werk Ahrenberg Nord, „Gültig ab“ 01.03.2027 (A11).
 *
 * Misst bei 375 und 1440 px: Seite UND Dialog 0 px Querlauf, kein Element über dem Rand.
 * Mit `UMZUG_BILDER=<Ordner>` legt der Lauf je Schritt Bilder und `messung-*.json` ab.
 * `ANSICHT_VARIANTE=b` ersetzt NUR fürs Vergleichsbild die Liste „Das bleibt, wie es ist“ im
 * DOM durch einen Sammelsatz — im Code steht die empfohlene Liste (Variante A).
 */

const BILDER = process.env.UMZUG_BILDER;
const VARIANTE = process.env.ANSICHT_VARIANTE === 'b' ? 'b' : 'a';
const BREITEN = [375, 1440] as const;
const HEUTE = '2027-02-20';
const NORD = '5a1d0000-0000-4000-8000-000000000003';
const ST1 = { id: FIXTURE_IDS.st1, kurzzeichen: 'ST-1', name: 'Werk Ahrenberg' };
const ST3 = { id: NORD, kurzzeichen: 'ST-3', name: 'Werk Ahrenberg Nord' };
const BEGRUENDUNG = 'Halle 2 gehört ab März organisatorisch zum Werk Nord.';

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

function standorte(): StandorteAmStichtag {
  const a = ahrenbergHeute();
  const ahrenberg = werkAhrenberg();
  const nord = werkAhrenberg({
    id: NORD,
    kurzzeichen: 'ST-3',
    name: 'Werk Ahrenberg Nord',
    adresse: ahrenberg.adresse ? { ...ahrenberg.adresse, strasse: 'Nordring 3' } : null,
    anlagen: [],
  });
  return { ...a, stichtag: HEUTE, standorte: [...a.standorte, nord] };
}

/** Die Antwort des Servers für Halle 2 → Nord ab `ab` (A11: Box E-2, Ladepark-Rahmen, NA-2). */
function umzug(ab: string, protokoll: AnlageUmzug['protokoll'] = []): AnlageUmzug {
  const tage = Math.round((Date.parse(`${ab}T00:00:00Z`) - Date.parse(`${HEUTE}T00:00:00Z`)) / 86_400_000);
  const vortag = new Date(Date.parse(`${ab}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  return {
    anlageId: FIXTURE_IDS.an2,
    anlageName: 'Werk Ahrenberg – Halle 2',
    bisher: ST1,
    neu: ST3,
    gueltigAb: ab,
    gueltigBis: null,
    danach: null,
    rueckwirkung:
      tage > 0
        ? { art: 'geplant', tage, abzeichen: null }
        : tage < 0
          ? { art: 'rueckwirkend', tage: -tage, abzeichen: `rückwirkend (${-tage} Tage)` }
          : { art: 'ab_heute', tage: 0, abzeichen: null },
    zuordnungen: [
      { standort: ST1, gueltigAb: '2026-10-01', gueltigBis: vortag, zustand: 'gueltig' },
      { standort: ST3, gueltigAb: ab, gueltigBis: null, zustand: tage > 0 ? 'geplant' : 'gueltig' },
    ],
    bleibt: ['box', 'topics', 'freigaben', 'betriebsmodell', 'ladepark_rahmen', 'fahrplaene', 'messstellen'],
    boxen: 1,
    netzanschluss: { id: 'na-2', kennzeichen: 'NA-2' },
    steuern: null,
    befehle: 0,
    begruendung: protokoll.length ? BEGRUENDUNG : null,
    protokoll,
  };
}

async function verdrahte(page: Page) {
  const gesendet: unknown[] = [];
  // Zuerst das Allgemeine: spätere Routen haben Vorrang.
  await page.route((url) => url.hostname !== '127.0.0.1', (r) => r.abort());
  await page.route('**/api/v1/**', (r) => r.fulfill(json({}, 404)));
  await page.route('**/api/v1/sites/*/assets', (r) => r.fulfill(json([])));
  await page.route('**/api/v1/unternehmen', (r) => r.fulfill(json(ahrenbergUnternehmen())));
  await page.route('**/api/v1/standorte**', (r) => r.fulfill(json(standorte())));
  await page.route('**/api/v1/sites/*/standort/vorschau**', (r) =>
    r.fulfill(json(umzug(new URL(r.request().url()).searchParams.get('gueltigAb') ?? HEUTE))),
  );
  await page.route('**/api/v1/sites/*/standort', (r) => {
    const body = r.request().postDataJSON() as { gueltigAb: string };
    gesendet.push(body);
    return r.fulfill(
      json(
        umzug(body.gueltigAb, [
          { id: 41, objektArt: 'anlage', objektId: FIXTURE_IDS.an2 },
          { id: 42, objektArt: 'standort', objektId: NORD },
          { id: 43, objektArt: 'standort', objektId: FIXTURE_IDS.st1 },
        ]),
      ),
    );
  });
  // AP-12 IP-9 · freigegebene Berichte (Ahrenberg): eine geplante Zuordnung trifft keinen gültigen Berichtsstand;
  // rückwirkend vor heute träfe sie den Stand BR-2026-0001 Nr. 2.
  await page.route('**/api/v1/berichte/betroffen**', (r) => {
    const q = new URL(r.request().url()).searchParams;
    const ab = q.get('gilt_ab') ?? '';
    return r.fulfill(
      json({
        anlass: q.get('anlass'),
        gilt_ab: ab,
        berichte_vorhanden: true,
        betroffen: ab < HEUTE ? [{ kennung: 'BR-2026-0001', nr: 2 }] : [],
        zitieren: [
          { kennung: 'BR-2026-0001', nr: 1 },
          { kennung: 'BR-2026-0001', nr: 2 },
        ],
      }),
    );
  });
  return gesendet;
}

/** Querlauf in px und die Maße, mit denen die Vorschau die Varianten vergleicht. */
async function messe(page: Page, breite: number) {
  return page.evaluate((b) => {
    const draussen = [...document.querySelectorAll('.vp-main *, .vp-modal *')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      // Die Landkarte schneidet ihre Kacheln selbst ab (`seite` misst, ob wirklich etwas übersteht).
      .filter(({ el }) => !el.closest('.leaflet-container'))
      .filter(({ r }) => r.width > 0 && (r.right > b + 0.5 || r.left < -0.5))
      .map(({ el }) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`);
    const koerper = [...document.querySelectorAll('.vp-modal .dbody')] as HTMLElement[];
    const folgen = document.querySelector('[data-testid="umzug-folgen"]') as HTMLElement | null;
    const bleibt = document.querySelector('.vp-au-folgen .vp-au-teil:has(.vp-au-bleibt)') as HTMLElement | null;
    return {
      seite: document.documentElement.scrollWidth - window.innerWidth,
      dialog: koerper.length ? Math.max(...koerper.map((k) => k.scrollWidth - k.clientWidth)) : null,
      draussen,
      folgenHoehe: folgen ? Math.round(folgen.getBoundingClientRect().height) : null,
      bleibtHoehe: bleibt ? Math.round(bleibt.getBoundingClientRect().height) : null,
      dialogInhaltHoehe: koerper.length ? koerper[0].scrollHeight : null,
      dialogSichtHoehe: koerper.length ? koerper[0].clientHeight : null,
    };
  }, breite);
}

async function messeUndFotografiere(page: Page, breite: number, name: string, ausschnitt?: Locator) {
  if (await page.locator('.vp-modal').count()) {
    await expect(page.locator('.vp-modal').last()).toHaveCSS('opacity', '1');
  }
  await page.waitForFunction(() => document.getAnimations().every((x) => x.playState !== 'running'));
  const m = await messe(page, breite);
  expect(m.seite, `${name} ${breite}: Seite`).toBe(0);
  expect(m.dialog ?? 0, `${name} ${breite}: Dialog`).toBe(0);
  expect(m.draussen, `${name} ${breite}: Elemente über dem Rand`).toEqual([]);
  if (!BILDER) return;
  const datei = `${name}-${breite}`;
  mkdirSync(BILDER, { recursive: true });
  writeFileSync(join(BILDER, `messung-${datei}.json`), JSON.stringify(m, null, 2));
  await page.screenshot({ path: join(BILDER, `${datei}.png`) });
  if (ausschnitt) await ausschnitt.screenshot({ path: join(BILDER, `${datei}-ausschnitt.png`) });
  // Das ganze Bild: das Fenster so hoch wie der Dialog-Inhalt, damit nichts im Scrollbereich fehlt.
  if (m.dialogInhaltHoehe && m.dialogSichtHoehe && m.dialogInhaltHoehe > m.dialogSichtHoehe) {
    const vorher = page.viewportSize()!;
    await page.setViewportSize({ width: breite, height: vorher.height + (m.dialogInhaltHoehe - m.dialogSichtHoehe) + 40 });
    await page.waitForFunction(() => document.getAnimations().every((x) => x.playState !== 'running'));
    await page.screenshot({ path: join(BILDER, `${datei}-ganz.png`) });
    await page.setViewportSize(vorher);
  }
}

/** Variante B — nur im DOM des Vergleichsbilds: die Liste „bleibt“ als EIN Sammelsatz. */
async function sammelsatz(page: Page) {
  await page.evaluate(() => {
    const liste = document.querySelector('.vp-au-bleibt');
    if (!liste) return;
    const p = document.createElement('p');
    p.className = 'vp-au-sammelsatz';
    p.style.margin = '0';
    p.textContent =
      'Box, Datenwege, Freigaben, Betriebsmodell, Ladepark-Rahmen, Fahrpläne, Messstellen und Netzanschluss NA-2 bleiben, wie sie sind.';
    liste.replaceWith(p);
  });
}

test.describe('T6b · Anlage zuordnen mit Folgen-Karte (AP-02 IP-11)', () => {
  for (const breite of BREITEN) {
    test(`Halle 2 → Werk Ahrenberg Nord ab 01.03.2027 — ${breite} px`, async ({ page }) => {
      const gesendet = await verdrahte(page);
      await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
      await page.goto('/e2e/meine-anlage.html?fall=ahrenberg');

      const karte = page.locator('#technik-anlage');
      await expect(karte).toBeVisible();
      const aufklappen = karte.locator('button[aria-expanded="false"]');
      if (await aufklappen.count()) await aufklappen.first().click();
      const knopf = karte.getByRole('button', { name: 'Anderem Standort zuordnen: Werk Ahrenberg – Halle 2' });
      await expect(knopf).toBeVisible();
      if (VARIANTE === 'a') {
        await karte.scrollIntoViewIfNeeded();
        await messeUndFotografiere(page, breite, 't6a-zeile', karte);
      }

      await knopf.click();
      const dialog = page.locator('.vp-modal').last();
      await expect(dialog.getByRole('heading', { name: 'Anlage zuordnen' })).toBeVisible();
      await dialog.getByRole('combobox', { name: 'Neuer Standort *' }).click();
      await page.getByRole('option', { name: /Werk Ahrenberg Nord \(ST-3\)/ }).click();
      await dialog.getByRole('combobox', { name: 'Gültig ab *' }).click();
      await page.getByRole('button', { name: 'Nächster Monat' }).click();
      await page.getByRole('gridcell', { name: '1', exact: true }).first().click();

      const folgen = dialog.getByTestId('umzug-folgen');
      await expect(folgen.getByText('Ab 01.03.2027 gehört die Anlage zu Werk Ahrenberg Nord (ST-3).')).toBeVisible();
      await expect(folgen.getByText('Geplant: bis dahin ändert sich nichts.')).toBeVisible();
      await expect(folgen.getByText('Es wird kein Befehl an die Anlage gesendet.')).toBeVisible();
      // AP-12 IP-9: eine geplante Zuordnung trifft keinen freigegebenen Berichtsstand.
      const berichte = folgen.getByTestId('berichte-folgen');
      await expect(berichte).toHaveText('Freigegebene Berichte: keine betroffen');
      await dialog.getByLabel('Begründung (freiwillig)').fill(BEGRUENDUNG);
      if (VARIANTE === 'b') {
        await sammelsatz(page);
        await messeUndFotografiere(page, breite, 't6b-folgen-b', dialog);
        return;
      }
      await berichte.scrollIntoViewIfNeeded();
      await messeUndFotografiere(page, breite, 't6b-folgen', dialog);

      await dialog.getByRole('button', { name: 'Zuordnen', exact: true }).click();
      await expect(dialog.getByText('Zuordnung gespeichert')).toBeVisible();
      await expect(dialog.getByText('Werk Ahrenberg – Halle 2 gehört ab 01.03.2027 zu Werk Ahrenberg Nord (ST-3).')).toBeVisible();
      expect(gesendet).toEqual([{ standortId: NORD, gueltigAb: '2027-03-01', begruendung: BEGRUENDUNG }]);
      await expect(dialog.getByTestId('berichte-folgen')).toHaveCount(0);
      await messeUndFotografiere(page, breite, 't6b-ergebnis', dialog);
    });
  }

  test('Halle 2 → Werk Ahrenberg Nord rückwirkend ab 01.12.2026 — BR-2026-0001 Nr. 2 bekommt den Vermerk (AP-12 IP-9) — 375 px', async ({ page }) => {
    test.skip(VARIANTE === 'b', 'nur Variante A');
    await verdrahte(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/e2e/meine-anlage.html?fall=ahrenberg');

    const karte = page.locator('#technik-anlage');
    await expect(karte).toBeVisible();
    const aufklappen = karte.locator('button[aria-expanded="false"]');
    if (await aufklappen.count()) await aufklappen.first().click();
    await karte.getByRole('button', { name: 'Anderem Standort zuordnen: Werk Ahrenberg – Halle 2' }).click();
    const dialog = page.locator('.vp-modal').last();
    await expect(dialog.getByRole('heading', { name: 'Anlage zuordnen' })).toBeVisible();
    await dialog.getByRole('combobox', { name: 'Neuer Standort *' }).click();
    await page.getByRole('option', { name: /Werk Ahrenberg Nord \(ST-3\)/ }).click();
    await dialog.getByRole('combobox', { name: 'Gültig ab *' }).click();
    for (let i = 0; i < 2; i++) await page.getByRole('button', { name: 'Voriger Monat' }).click();
    await page.getByRole('gridcell', { name: '1', exact: true }).first().click();

    const folgen = dialog.getByTestId('umzug-folgen');
    await expect(folgen).toContainText('01.12.2026');
    const berichte = folgen.getByTestId('berichte-folgen');
    await expect(berichte).toHaveText('Freigegebene Berichte: BR-2026-0001 Nr. 2 bekommt den Vermerk „Revision nötig“');
    await berichte.scrollIntoViewIfNeeded();
    await messeUndFotografiere(page, 375, 't6b-folgen-revision', dialog);
  });
});
