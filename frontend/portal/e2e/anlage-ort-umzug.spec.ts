import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnlageOrtUmzugErgebnis, StandorteAmStichtag, UmzugMerkzettel } from '../src/api';
import { ahrenbergUnternehmen, FIXTURE_IDS, werkAhrenberg } from '../src/test/standorteFixtures';

/**
 * vp-standort-konzept §7, E1 = B: „Ist Ihre Anlage umgezogen?" am echten Weg (Bühne
 * `meine-anlage.html?fall=ahrenberg`, die echte `TechnikSection`). Eine über 2 km entfernte
 * Adresse fragt erst; „Ja" fragt den Umzugstag (Picker-Grenze „nie in der Zukunft") und speichert
 * über `POST …/ort/umzug` — ein neuer Standort entsteht still, die Ergebnis-Sätze sind eigene
 * Umzugs-Sätze (kein „X gehört zu X", Captain-Korrektur), der Titel bleibt durchgehend „Standort"
 * (nicht „Gehört zu"), danach bietet das Blatt den jetzt leeren alten Standort zum Archivieren an.
 * `ORT_BILDER=<Ordner>` legt je Schritt Bilder ab.
 */

const BILDER = process.env.ORT_BILDER;
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

function standorteVorDemUmzug(): StandorteAmStichtag {
  return { stichtag: '2026-11-27', standorte: [werkAhrenberg()], nichtGezeigt: [], nochNichtZugeordnet: null };
}

/**
 * Wie ein echter Server nach `POST …/ort/umzug` antworten würde: die Anlage (Halle 2) gehört ab
 * `gueltigAb` zum NEUEN Standort mit der neuen Adresse; der bisherige bleibt mit SEINEN übrigen
 * Geschwistern (Halle 1 zieht nicht mit, §6.6-Regel). Beweist Inbox 017: die Zeile/das Blatt lesen
 * `GET /api/v1/standorte` neu (`standortNeuLaden`), keine statische Kopie der alten Adresse.
 */
function standorteNachDemUmzug(
  adresse: { strasse: string; plz: string | null; ort: string; land: string },
  lage: { breitengrad: number; laengengrad: number },
  gueltigAb: string,
): StandorteAmStichtag {
  const bisher = werkAhrenberg({
    anlagen: werkAhrenberg().anlagen.filter((a) => a.id !== FIXTURE_IDS.an2),
    anlagenZahl: 1,
  });
  const neu = werkAhrenberg({
    id: 'st-neu',
    kurzzeichen: 'ST-3',
    name: 'Werk Ahrenberg – Halle 2',
    adresse: adresse as never,
    lage,
    anlagen: [{ id: FIXTURE_IDS.an2, name: 'Werk Ahrenberg – Halle 2', gueltigAb, gueltigBis: null }],
    anlagenZahl: 1,
  });
  return { stichtag: '2026-11-27', standorte: [bisher, neu], nichtGezeigt: [], nochNichtZugeordnet: null };
}

async function verdrahte(page: Page) {
  const gesendet: unknown[] = [];
  let merkzettel: UmzugMerkzettel | null = null;
  let standorteAntwort = standorteVorDemUmzug();
  await page.route('**/api/v1/**', (r) => r.fulfill(json({}, 404)));
  await page.route('**/api/v1/sites/*/assets', (r) => r.fulfill(json([])));
  await page.route('**/api/v1/unternehmen', (r) => r.fulfill(json(ahrenbergUnternehmen())));
  await page.route('**/api/v1/standorte**', (r) => r.fulfill(json(standorteAntwort)));
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
    merkzettel = { seit: '2026-11-27T10:00:00Z', solaranlageErledigt: false, stromtarifErledigt: false, einspeiseverguetungErledigt: false };
    standorteAntwort = standorteNachDemUmzug(body.adresse, body.lage, body.gueltigAb);
    return r.fulfill(json(ergebnis));
  });
  await page.route('**/api/v1/sites/*/umzug-merkzettel', (r) => {
    if (r.request().method() !== 'GET') return r.fallback();
    return merkzettel ? r.fulfill(json(merkzettel)) : r.fulfill({ status: 204, body: '' });
  });
  await page.route('**/api/v1/sites/*/umzug-merkzettel/erledigen', (r) => {
    const { teil } = r.request().postDataJSON() as { teil: string };
    if (merkzettel) {
      const feld = teil === 'solaranlage' ? 'solaranlageErledigt' : teil === 'stromtarif' ? 'stromtarifErledigt' : 'einspeiseverguetungErledigt';
      merkzettel = { ...merkzettel, [feld]: true };
      if (merkzettel.solaranlageErledigt && merkzettel.stromtarifErledigt && merkzettel.einspeiseverguetungErledigt) {
        merkzettel = null;
      }
    }
    return r.fulfill({ status: 204, body: '' });
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

    await expect(dialog.getByText('Ist Ihre Anlage umgezogen?')).toBeVisible();
    await expect(dialog.getByText(/Hauptplatz 1, Wien ist \d+ km entfernt\./)).toBeVisible();
    await foto(page, 'umzug-1-frage');

    await dialog.getByRole('radio', { name: /Ja, wir sind umgezogen/ }).click();
    const umzugstag = dialog.getByRole('combobox', { name: 'Seit wann?' });
    await expect(umzugstag).toHaveText('27.11.2026');
    await foto(page, 'umzug-2-datum');

    await dialog.getByRole('button', { name: 'Speichern' }).click();

    expect(gesendet).toHaveLength(1);
    expect(gesendet[0]).toMatchObject({
      adresse: { strasse: 'Hauptplatz 1', plz: null, ort: 'Wien', land: 'AT' },
      lage: { breitengrad: 48.2085, laengengrad: 16.3738 },
      gueltigAb: '2026-11-27',
    });

    await expect(dialog.getByText(/^Gespeichert\./)).toBeVisible();
    await expect(dialog.getByText(/Ab 27\.11\.2026 steht die Anlage in Hauptplatz 1, Wien\./)).toBeVisible();
    await expect(dialog.getByText('Neues Haus? Bitte prüfen')).toBeVisible();
    await expect(dialog.getByText('Solaranlage')).toBeVisible();
    await expect(dialog.getByText('Stromtarif')).toBeVisible();
    await expect(dialog.getByText('Einspeisevergütung')).toBeVisible();
    await expect(dialog.getByTestId('standort-archiv-angebot')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Standort archivieren' })).toBeVisible();
    await foto(page, 'umzug-3-ergebnis');

    await dialog.getByRole('button', { name: 'Fertig' }).click();
    await expect(dialog).toBeHidden();

    // Inbox 017: "Fertig" löst `standortNeuLaden()` aus (AnlageOrtZeile → AnlageTechnik) - die
    // Zeile zeigt jetzt die NEUE Adresse, nicht mehr "Gewerbering 7, Ahrenberg". Kein Neuladen der
    // Seite nötig - derselbe `useAnlageStandort`-Hook liest live neu. Ab zwei Standorten (der
    // bisherige, jetzt nur noch mit Halle 1, UND der neue) trägt die Zeile zusätzlich den
    // Standort-Namen voran (§6.2, E3) - "Hauptplatz 1, Wien" reicht als Beleg.
    const zeile = karte.getByRole('button', { name: /^Standort bearbeiten:.*Hauptplatz 1, Wien/ });
    await expect(zeile).toBeVisible();
    await expect(karte.getByRole('button', { name: /Gewerbering 7/ })).toHaveCount(0);
    await foto(page, 'umzug-4-standort-zeile-neue-adresse');

    // Auch das Blatt selbst zeigt beim erneuten Öffnen die neue Adresse, nicht die alte.
    await zeile.click();
    const standortBlatt = page.getByRole('dialog', { name: 'Standort' });
    await expect(standortBlatt.getByLabel('Adresse')).toHaveValue('Hauptplatz 1, Wien');
    await standortBlatt.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(standortBlatt).toBeHidden();

    // Bericht 6.6 Punkt 7: je Anlage gespeichert, auf jedem Gerät sichtbar - ein voller Neuladen
    // (wie ein zweites Gerät) zeigt ihn als eigene Zeile über den Einstellungsgruppen.
    await page.reload();
    const banner = page.getByTestId('umzug-merkzettel');
    await expect(banner).toBeVisible();
    await expect(banner.getByText('Neues Haus? Bitte prüfen')).toBeVisible();
    await foto(page, 'umzug-5-merkzettel-anlageseite');

    // Ein Tipp erledigt nur diesen Teil - "geprüft" und "weggeklickt" sind dieselbe Handlung.
    await banner.getByRole('button', { name: 'Solaranlage: geprüft' }).click();
    await expect(banner.getByText('Solaranlage')).toBeHidden();
    await expect(banner.getByText('Stromtarif')).toBeVisible();
    await banner.getByRole('button', { name: 'Stromtarif: geprüft' }).click();
    await banner.getByRole('button', { name: 'Einspeisevergütung: geprüft' }).click();
    // Alle drei erledigt - die ganze Karte verschwindet.
    await expect(page.getByTestId('umzug-merkzettel')).toBeHidden();
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

    await dialog.getByRole('radio', { name: /Ja, wir sind umgezogen/ }).click();
    await dialog.getByRole('combobox', { name: 'Seit wann?' }).click();
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

    await dialog.getByRole('radio', { name: /Nein, die Adresse war falsch/ }).click();
    await expect(dialog.getByLabel('Adresse')).toHaveValue('Hauptplatz 1, Wien');
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

    await dialog.getByRole('radio', { name: /Ja, wir sind umgezogen/ }).click();
    await messe('umzug-2-datum');

    await dialog.getByRole('button', { name: 'Speichern' }).click();
    await expect(dialog.getByText(/^Gespeichert\./)).toBeVisible();
    await expect(dialog.getByTestId('standort-archiv-angebot')).toBeVisible();
    await messe('umzug-3-ergebnis');
  });
});
