import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnlageOrtUmzugErgebnis, StandorteAmStichtag } from '../src/api';
import { ahrenbergUnternehmen, FIXTURE_IDS, werkAhrenberg } from '../src/test/standorteFixtures';

/**
 * vp-standort-konzept §7, E1 = B: „Ist Ihre Anlage umgezogen?" am echten Weg (Bühne
 * `meine-anlage.html?fall=ahrenberg`, die echte `TechnikSection`). Eine über 2 km entfernte
 * Adresse fragt erst; „Ja" fragt den Umzugstag (Picker-Grenze „nie in der Zukunft") und speichert
 * über `POST …/ort/umzug` — ein neuer Standort entsteht still, die Folgen stehen wie bei „Gehört
 * zu", danach bietet das Blatt den jetzt leeren alten Standort zum Archivieren an. `ORT_BILDER=<Ordner>`
 * legt je Schritt Bilder ab.
 */

const BILDER = process.env.ORT_BILDER;
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

function standorte(): StandorteAmStichtag {
  return { stichtag: '2026-11-27', standorte: [werkAhrenberg()], nichtGezeigt: [], nochNichtZugeordnet: null };
}

async function verdrahte(page: Page) {
  const gesendet: unknown[] = [];
  await page.route('**/api/v1/**', (r) => r.fulfill(json({}, 404)));
  await page.route('**/api/v1/sites/*/assets', (r) => r.fulfill(json([])));
  await page.route('**/api/v1/unternehmen', (r) => r.fulfill(json(ahrenbergUnternehmen())));
  await page.route('**/api/v1/standorte**', (r) => r.fulfill(json(standorte())));
  await page.route('**/api/v1/standorte/*/orte**', (r) =>
    r.fulfill(
      json({
        stichtag: '2026-11-27',
        standort: werkAhrenberg(),
        summeGebaeudeM2: null,
        gebaeudeOhneFlaeche: [],
        gebaeude: [],
        direktAmStandort: null,
        aktionen: {
          archivieren: { erlaubt: true, text: null, gruende: [], letzterTag: '2026-11-26', mitarchiviert: [] },
          wiederherstellen: null,
        },
      }),
    ),
  );
  await page.route('**/api/v1/orte/suche**', (r) =>
    r.fulfill(
      json({
        treffer: [
          {
            text: 'Hauptplatz 1, Wien',
            strasse: 'Hauptplatz',
            hausnummer: '1',
            plz: null,
            ort: 'Wien',
            land: 'AT',
            breitengrad: 48.2085,
            laengengrad: 16.3738,
            genau: 'haus',
          },
        ],
        quelle: '© OpenStreetMap-Mitwirkende',
      }),
    ),
  );
  await page.route('**/api/v1/sites/*/ort/umzug', (r) => {
    const body = r.request().postDataJSON() as {
      adresse: { strasse: string; plz: string | null; ort: string; land: string };
      lage: { breitengrad: number; laengengrad: number };
      gueltigAb: string;
    };
    gesendet.push(body);
    const ergebnis: AnlageOrtUmzugErgebnis = {
      site: {
        id: FIXTURE_IDS.an2,
        name: 'Werk Ahrenberg – Halle 2',
        biddingZone: 'AT',
        latitude: body.lage.breitengrad,
        longitude: body.lage.laengengrad,
        plantKind: 'eigenverbrauch',
        anzulegenderWertCtKwh: null,
        tarifArt: 'ohne',
        tarifParamCtKwh: null,
        netzladenErlaubt: false,
        maxFeedInKw: null,
      } as never,
      neuerStandort: { ...werkAhrenberg(), id: 'st-neu', kurzzeichen: 'ST-3', name: 'Werk Ahrenberg – Halle 2', adresse: body.adresse as never, lage: body.lage },
      umzug: {
        anlageId: FIXTURE_IDS.an2,
        anlageName: 'Werk Ahrenberg – Halle 2',
        bisher: { id: FIXTURE_IDS.st1, kurzzeichen: 'ST-1', name: 'Werk Ahrenberg' },
        neu: { id: 'st-neu', kurzzeichen: 'ST-3', name: 'Werk Ahrenberg – Halle 2' },
        gueltigAb: body.gueltigAb,
        gueltigBis: null,
        danach: null,
        rueckwirkung: { art: 'ab_heute', tage: 0, abzeichen: null },
        zuordnungen: [
          { standort: { id: FIXTURE_IDS.st1, kurzzeichen: 'ST-1', name: 'Werk Ahrenberg' }, gueltigAb: '2026-10-01', gueltigBis: '2026-11-26', zustand: 'beendet' },
          { standort: { id: 'st-neu', kurzzeichen: 'ST-3', name: 'Werk Ahrenberg – Halle 2' }, gueltigAb: body.gueltigAb, gueltigBis: null, zustand: 'gueltig' },
        ],
        bleibt: ['box', 'topics', 'freigaben', 'betriebsmodell', 'ladepark_rahmen', 'fahrplaene', 'messstellen'],
        boxen: 1,
        netzanschluss: null,
        steuern: null,
        befehle: 0,
        begruendung: null,
        protokoll: [],
      },
      boxZugestellt: true,
      wetterNachholungAngestossen: true,
    };
    return r.fulfill(json(ergebnis));
  });
  return gesendet;
}

async function foto(page: Page, name: string) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  await page.screenshot({ path: join(BILDER, `${name}.png`) });
}

test.describe('Umzug (vp-standort-konzept §7, E1 = B)', () => {
  test('eine weit entfernte Adresse fragt, der Umzugstag folgt, danach steht das Ergebnis mit Archiv-Angebot und Merkzettel', async ({ page }) => {
    const gesendet = await verdrahte(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.clock.setFixedTime(new Date('2026-11-27T10:00:00'));
    await page.goto('/e2e/meine-anlage.html?fall=ahrenberg');

    const karte = page.locator('#technik-anlage');
    await karte.getByRole('button', { name: /^Standort bearbeiten/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Standort' });
    const adresse = dialog.getByLabel('Adresse');
    await adresse.fill('Hauptplatz 1 wien');
    await page.getByRole('option', { name: /Hauptplatz 1, Wien/ }).click();

    const frage = page.getByRole('dialog', { name: 'Gehört zu' });
    await expect(frage.getByText('Ist Ihre Anlage umgezogen?')).toBeVisible();
    await expect(frage.getByText(/Hauptplatz 1, Wien ist \d+ km entfernt\./)).toBeVisible();
    await foto(page, 'umzug-1-frage');

    await frage.getByRole('radio', { name: /Ja, wir sind umgezogen/ }).click();
    const umzugstag = frage.getByRole('combobox', { name: 'Seit wann?' });
    await expect(umzugstag).toHaveText('27.11.2026');
    await foto(page, 'umzug-2-datum');

    await frage.getByRole('button', { name: 'Speichern' }).click();

    expect(gesendet).toHaveLength(1);
    expect(gesendet[0]).toMatchObject({
      adresse: { strasse: 'Hauptplatz 1', plz: null, ort: 'Wien', land: 'AT' },
      lage: { breitengrad: 48.2085, laengengrad: 16.3738 },
      gueltigAb: '2026-11-27',
    });

    await expect(frage.getByText(/^Gespeichert\./)).toBeVisible();
    await expect(frage.getByText('Neues Haus? Bitte prüfen')).toBeVisible();
    await expect(frage.getByText('Solaranlage')).toBeVisible();
    await expect(frage.getByText('Stromtarif')).toBeVisible();
    await expect(frage.getByText('Einspeisevergütung')).toBeVisible();
    await expect(frage.getByTestId('standort-archiv-angebot')).toBeVisible();
    await expect(frage.getByRole('button', { name: 'Standort archivieren' })).toBeVisible();
    await foto(page, 'umzug-3-ergebnis');

    await frage.getByRole('button', { name: 'Fertig' }).click();
    await expect(frage).toBeHidden();
  });

  test('der Umzugstag lässt sich nicht in die Zukunft setzen', async ({ page }) => {
    await verdrahte(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.clock.setFixedTime(new Date('2026-11-27T10:00:00'));
    await page.goto('/e2e/meine-anlage.html?fall=ahrenberg');

    const karte = page.locator('#technik-anlage');
    await karte.getByRole('button', { name: /^Standort bearbeiten/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Standort' });
    await dialog.getByLabel('Adresse').fill('Hauptplatz 1 wien');
    await page.getByRole('option', { name: /Hauptplatz 1, Wien/ }).click();

    const frage = page.getByRole('dialog', { name: 'Gehört zu' });
    await frage.getByRole('radio', { name: /Ja, wir sind umgezogen/ }).click();
    await frage.getByRole('combobox', { name: 'Seit wann?' }).click();
    const morgen = page.locator('[data-iso="2026-11-28"]');
    await expect(morgen).toBeDisabled();
  });

  test('„Nein, die Adresse war falsch" bleibt die normale Berichtigung — kein Umzug', async ({ page }) => {
    const gesendet = await verdrahte(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/e2e/meine-anlage.html?fall=ahrenberg');

    const karte = page.locator('#technik-anlage');
    await karte.getByRole('button', { name: /^Standort bearbeiten/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Standort' });
    await dialog.getByLabel('Adresse').fill('Hauptplatz 1 wien');
    await page.getByRole('option', { name: /Hauptplatz 1, Wien/ }).click();

    const frage = page.getByRole('dialog', { name: 'Gehört zu' });
    await frage.getByRole('radio', { name: /Nein, die Adresse war falsch/ }).click();
    const standort = page.getByRole('dialog', { name: 'Standort' });
    await expect(standort.getByLabel('Adresse')).toHaveValue('Hauptplatz 1, Wien');
    expect(gesendet).toHaveLength(0);
  });

  test('alle drei Umzug-Flächen bleiben bei 375 px ohne Querlauf und Überstand', async ({ page }) => {
    await verdrahte(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.clock.setFixedTime(new Date('2026-11-27T10:00:00'));
    await page.goto('/e2e/meine-anlage.html?fall=ahrenberg');

    async function messe(name: string) {
      await page.waitForFunction(() => document.getAnimations().every((x) => x.playState !== 'running'));
      const m = await page.evaluate(() => {
        const draussen = [...document.querySelectorAll('.vp-main *, .vp-modal *')]
          .map((el) => ({ el, r: el.getBoundingClientRect() }))
          .filter(({ el }) => !el.closest('.leaflet-container'))
          .filter(({ r }) => r.width > 0 && (r.right > window.innerWidth + 0.5 || r.left < -0.5))
          .map(({ el }) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`);
        const koerper = [...document.querySelectorAll('.vp-modal .dbody')] as HTMLElement[];
        return {
          seite: document.documentElement.scrollWidth - window.innerWidth,
          dialog: koerper.length ? Math.max(...koerper.map((k) => k.scrollWidth - k.clientWidth)) : null,
          draussen,
        };
      });
      expect(m.seite, `${name}: Seite`).toBe(0);
      expect(m.dialog ?? 0, `${name}: Dialog`).toBe(0);
      expect(m.draussen, `${name}: Elemente über dem Rand`).toEqual([]);
      if (BILDER) {
        mkdirSync(BILDER, { recursive: true });
        await page.screenshot({ path: join(BILDER, `${name}-375.png`) });
      }
    }

    const karte = page.locator('#technik-anlage');
    await karte.getByRole('button', { name: /^Standort bearbeiten/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Standort' });
    await dialog.getByLabel('Adresse').fill('Hauptplatz 1 wien');
    await page.getByRole('option', { name: /Hauptplatz 1, Wien/ }).click();
    await messe('umzug-1-frage');

    const frage = page.getByRole('dialog', { name: 'Gehört zu' });
    await frage.getByRole('radio', { name: /Ja, wir sind umgezogen/ }).click();
    await messe('umzug-2-datum');

    await frage.getByRole('button', { name: 'Speichern' }).click();
    await expect(frage.getByText(/^Gespeichert\./)).toBeVisible();
    await expect(frage.getByTestId('standort-archiv-angebot')).toBeVisible();
    await messe('umzug-3-ergebnis');
  });
});
