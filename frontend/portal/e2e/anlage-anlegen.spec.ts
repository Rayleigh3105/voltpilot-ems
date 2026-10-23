import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Funktionen, StandortAmStichtag, StandorteAmStichtag, Unternehmen } from '../src/api';
import { ahrenbergFunktionen, funktionWerkAhrenberg, funktionWerkLindach } from '../src/test/funktionenFixtures';
import { ahrenbergHeute, ahrenbergUnternehmen, FIXTURE_IDS, werkAhrenberg, werkLindach } from '../src/test/standorteFixtures';

/**
 * Der Modus „nur messen" im Anlege-Fluss (Steuern-Regel, Captain 15.09.2026) auf der
 * Bühne `anlage-anlegen.html` bei 375 und 1440 px: ein Kunde, der nur misst (Werk
 * Lindach), und ein Kunde mit Steuern (Werk Ahrenberg) gehen denselben Drawer „Anlage
 * anlegen" durch. Im Modus „nur messen" steht auf der ganzen Seite kein Wort der
 * Wortliste (`STEUER_GELD_WOERTER`, im Browser gegen das echte Modul geprüft), und
 * das Ende führt ohne Umweg zu den Messstellen; der Kunde mit Steuern sieht die
 * Veräußerungsform und endet im Cockpit seiner neuen Anlage. Ohne Querlauf — GEMESSEN am
 * Dokument, am Rumpf und an jedem Element des Dialogs.
 *
 * Seit Anlage-Flow a1 (Paket 0+1): die Ortswahl ist eine ausdrückliche Frage („Wo steht die neue
 * Anlage?“, D8), ein Privatkunde trägt die Adresse EINMAL ein (Standort und Anlage aus einem Formular,
 * Vorschläge über `GET /api/v1/orte/suche`), die Box wird mit ihrer Kennung verbunden, und Escape mit
 * Eingaben fragt nach (F8). Seit Paket 2 hat die Leiste in jeder Art dieselben drei Schritte
 * Adresse · Box · Anlage (R4, D6) und endet ohne Zusammenfassung (D7).
 *
 * Mit `ANLAGE_ANLEGEN_BILDER=<Ordner>` legt der Lauf je Fall Bild, ganzes Bild und Messung ab.
 */

const BILDER = process.env.ANLAGE_ANLEGEN_BILDER;
const BREITEN = [375, 1440] as const;
const NEU = 's-neu';
const MESSSTELLEN_LINDACH = `#/standort/${FIXTURE_IDS.st2}/messstellen`;

interface Cloud {
  standorte: StandorteAmStichtag;
  funktionen: Funktionen;
  unternehmen?: Unternehmen;
  /** Die Antwort der Registrierung (D2); ohne sie wie ein Bestandskunde. */
  betriebsart?: 'endkunde' | 'betreiber' | null;
  /** Jeder Körper von `POST /api/v1/sites`. */
  angelegt: Record<string, unknown>[];
  /** Jeder Körper von `POST /api/v1/standorte`. */
  standorteAngelegt?: Record<string, unknown>[];
  /** Der Kopf `Idempotency-Key` jeder Anlege-Anfrage (B3). */
  kennungen?: string[];
}

/** Ein Adressvorschlag wie `GET /api/v1/orte/suche` ihn liefert (OpenStreetMap-Adressen). */
const HAUS = {
  text: 'Hauptstraße 12, 91710 Gunzenhausen',
  strasse: 'Hauptstraße',
  hausnummer: '12',
  plz: '91710',
  ort: 'Gunzenhausen',
  land: 'DE',
  breitengrad: 49.1159,
  laengengrad: 10.7155,
  genau: 'haus',
};

const neuerPrivatkunde = (): Cloud => ({
  standorte: { ...ahrenbergHeute(), standorte: [], nichtGezeigt: [], nochNichtZugeordnet: null },
  funktionen: ahrenbergFunktionen({ standorte: [] }),
  betriebsart: 'endkunde',
  angelegt: [],
  standorteAngelegt: [],
  kennungen: [],
});

const messkunde = (): Cloud => ({
  standorte: { ...ahrenbergHeute(), standorte: [werkLindach()] },
  funktionen: ahrenbergFunktionen({ standorte: [funktionWerkLindach()] }),
  angelegt: [],
});

const kundeMitSteuern = (): Cloud => ({
  standorte: { ...ahrenbergHeute(), standorte: [werkAhrenberg()] },
  funktionen: ahrenbergFunktionen({ standorte: [funktionWerkAhrenberg()] }),
  angelegt: [],
});

const neuerMesskunde = (): Cloud => ({
  standorte: { ...ahrenbergHeute(), standorte: [], nichtGezeigt: [], nochNichtZugeordnet: null },
  funktionen: ahrenbergFunktionen({ standorte: [] }),
  unternehmen: ahrenbergUnternehmen({ standortZahl: 0, anlagenZahl: 0, nochNichtZugeordnetZahl: 0 }),
  angelegt: [],
});

const bestandskundeOhneStandort = (): Cloud => ({
  standorte: { ...ahrenbergHeute(), standorte: [], nichtGezeigt: [], nochNichtZugeordnet: null },
  funktionen: ahrenbergFunktionen({ standorte: [] }),
  angelegt: [],
});

async function verdrahte(page: Page, cloud: Cloud) {
  // Keine Kartenkacheln aus dem Netz — die Karte ist hier nicht Gegenstand.
  await page.route((url) => url.hostname !== '127.0.0.1' && url.hostname !== 'localhost', (r) => r.abort());
  await page.route('**/api/v1/**', async (r) => {
    const url = new URL(r.request().url());
    const pfad = url.pathname.slice(url.pathname.indexOf('/api/v1'));
    const methode = r.request().method();
    const json = (body: unknown, status = 200) =>
      r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (pfad === '/api/v1/standorte' && methode === 'GET') return json(cloud.standorte);
    if (pfad === '/api/v1/tenant-context') {
      return json({ tenantId: 'kb', name: 'Kundin', segment: 'CI', betriebsart: cloud.betriebsart ?? null });
    }
    if (pfad === '/api/v1/orte/suche') {
      const q = url.searchParams.get('q') ?? '';
      return json({ treffer: q.length >= 3 ? [HAUS] : [], quelle: '© OpenStreetMap-Mitwirkende' });
    }
    if (pfad === '/api/v1/unternehmen') return json(cloud.unternehmen ?? ahrenbergUnternehmen());
    if (pfad === '/api/v1/standorte/kurzzeichen-vorschlag') return json({ kurzzeichen: 'ST-2' });
    if (pfad === '/api/v1/standorte' && methode === 'POST') {
      const body = r.request().postDataJSON() as {
        name: string;
        adresse: { strasse: string; plz: string | null; ort: string; land: 'DE' | 'AT' | 'CH' };
        zeitzone: string;
        lage?: { breitengrad: number; laengengrad: number } | null;
      };
      cloud.standorteAngelegt?.push(body);
      cloud.kennungen?.push(r.request().headers()['idempotency-key'] ?? '');
      const standort: StandortAmStichtag = werkLindach({
        name: body.name,
        adresse: body.adresse,
        zeitzone: body.zeitzone,
        lage: body.lage ?? null,
        anlagen: [],
        anlagenZahl: 0,
      });
      cloud.standorte = { ...cloud.standorte, standorte: [standort] };
      cloud.funktionen = ahrenbergFunktionen({ standorte: [funktionWerkLindach()] });
      return json(standort, 201);
    }
    if (pfad === '/api/v1/funktionen') return json(cloud.funktionen);
    if (pfad === '/api/v1/sites' && methode === 'POST') {
      const body = r.request().postDataJSON() as Record<string, unknown>;
      cloud.angelegt.push(body);
      cloud.kennungen?.push(r.request().headers()['idempotency-key'] ?? '');
      return json({
        id: NEU,
        name: body.name,
        biddingZone: 'DE-LU',
        latitude: null,
        longitude: null,
        plantKind: body.plantKind,
        anzulegenderWertCtKwh: null,
        tarifArt: body.tarifArt,
        tarifParamCtKwh: null,
        netzladenErlaubt: body.netzladenErlaubt,
        maxFeedInKw: body.maxFeedInKw,
      });
    }
    if (pfad === '/api/v1/devices/claim') {
      return json({
        id: 'd-neu',
        siteId: NEU,
        externalRef: 'edge-k7m2xq3',
        kind: 'inverter',
        name: null,
        status: 'active',
        lastSeenAt: null,
        createdAt: '2026-10-20T08:15:30Z',
      });
    }
    if (pfad === `/api/v1/sites/${NEU}/assets`) return json([]);
    if (pfad === `/api/v1/sites/${NEU}/entities`) return json({ registry: null, entities: [], localSetup: [], staleOnDevice: [] });
    if (pfad === '/api/v1/devices') return json({ eintraege: [], teilansicht: null });
    return json({ code: 'nicht_gefunden', message: 'Nicht gefunden.' }, 404);
  });
}

async function oeffne(page: Page, breite: number, suche = '', titel = 'Wo steht die neue Anlage?') {
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/anlage-anlegen.html${suche}`);
  await expect(page.getByRole('heading', { name: titel })).toBeVisible();
}

const woerter = (page: Page) =>
  page.evaluate(() => (window as unknown as { steuerGeldWoerterDerSeite: () => string[] }).steuerGeldWoerterDerSeite());

async function schweigt(page: Page, stelle: string) {
  expect(await woerter(page), stelle).toEqual([]);
}

/** Querlauf in px: Dokument, Rumpf des Dialogs und jedes Element über den Rand (die Karte zeichnet ihre Kacheln bewusst darüber hinaus). */
async function ueberlauf(page: Page, breite: number) {
  return page.evaluate((b) => {
    const draussen = [...document.querySelectorAll('.vp-modal *, .vp-onboarding *')]
      .filter((el) => !el.closest('.vp-map'))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.right > b + 0.5 || r.left < -0.5))
      .map(({ el }) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`);
    const rumpf = [...document.querySelectorAll('.vp-modal .dbody')] as HTMLElement[];
    const gekuerzt = [...document.querySelectorAll('.vp-anlage-flow button')]
      .filter((el) => el.scrollWidth > el.clientWidth + 0.5)
      .map((el) => el.textContent);
    return {
      dokument: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      rumpf: rumpf.length ? Math.max(...rumpf.map((k) => k.scrollWidth - k.clientWidth)) : 0,
      draussen,
      gekuerzt,
    };
  }, breite);
}

async function messeUndFotografiere(page: Page, breite: number, name: string) {
  if (await page.locator('.vp-modal').count()) {
    await expect(page.locator('.vp-modal').last()).toHaveCSS('opacity', '1');
  }
  // Endlos-Loops (der Laufpunkt „wird gesucht“) laufen immer - gewartet wird nur auf die endlichen.
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity),
  );
  const m = await ueberlauf(page, breite);
  expect(m.dokument, `${name} ${breite}: Dokument`).toBe(0);
  expect(m.rumpf, `${name} ${breite}: Rumpf`).toBe(0);
  expect(m.draussen, `${name} ${breite}: Elemente`).toEqual([]);
  expect(m.gekuerzt, `${name} ${breite}: gekürzt`).toEqual([]);
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  writeFileSync(join(BILDER, `messung-${name}-${breite}.json`), JSON.stringify(m));
  await page.screenshot({ path: join(BILDER, `${name}-${breite}.png`) });
  // Das ganze Bild: der Rumpf des Dialogs bzw. die ganze Seite des Assistenten.
  const hoehe = await page.evaluate(() => {
    const modal = document.querySelector('.vp-modal') as HTMLElement | null;
    const rumpf = modal?.querySelector('.dbody') as HTMLElement | null;
    if (modal && rumpf) return modal.offsetHeight - rumpf.clientHeight + rumpf.scrollHeight + 48;
    return document.documentElement.scrollHeight;
  });
  const vorher = page.viewportSize()!;
  if (hoehe > vorher.height) {
    await page.setViewportSize({ width: breite, height: hoehe });
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
    await page.screenshot({ path: join(BILDER, `${name}-${breite}-ganz.png`) });
    await page.setViewportSize(vorher);
  }
}

for (const breite of BREITEN) {
  test(`neuer Messkunde ohne Standort · ${breite} px: zuerst Standort, danach Anlage nur messen`, async ({ page }) => {
    const cloud = neuerMesskunde();
    await verdrahte(page, cloud);
    await oeffne(page, breite, '', 'Zuerst den Standort');
    await expect(page.locator('.vp-step-label')).toHaveText(['Standort', 'Adresse', 'Box', 'Anlage']);
    await expect(page.getByText('Jede Anlage gehört zu einem Standort.')).toBeVisible();
    await schweigt(page, 'Zuerst den Standort');
    await messeUndFotografiere(page, breite, 'neu-0-standort-zuerst');

    await page.getByRole('button', { name: 'Standort anlegen', exact: true }).click();
    const standort = page.getByRole('dialog', { name: 'Standort anlegen' });
    await standort.getByLabel('Name *').fill('Werk Lindach');
    await standort.getByLabel('Straße und Hausnummer *').fill('Am Bahndamm 12');
    await standort.getByLabel('Ort *').fill('Lindach');
    await standort.getByRole('button', { name: 'Standort anlegen' }).click();

    await expect(page.getByRole('heading', { name: 'Wo steht die neue Anlage?' })).toBeVisible();
    const anlage = page.getByRole('dialog', { name: 'Anlage anlegen' });
    await expect(anlage.getByRole('radio', { name: /Am selben Ort wie „Werk Lindach“/ })).toBeChecked();
    // F7: der erledigte Standort bleibt in der Leiste - abgehakt, nicht verschwunden.
    await expect(anlage.locator('.vp-step-label')).toHaveText(['Standort', 'Adresse', 'Box', 'Anlage']);
    await expect(anlage.locator('.vp-step-done .vp-step-label')).toHaveText(['Standort']);
    await schweigt(page, 'Anlage nach dem Standort');
    await messeUndFotografiere(page, breite, 'neu-1-anlage');

    await anlage.getByLabel('Name der neuen Anlage').fill('Messung Halle 1');
    await anlage.getByRole('button', { name: 'Weiter', exact: true }).click();
    await expect(anlage.getByRole('heading', { name: 'Ihre VoltPilot-Box' })).toBeVisible();
    expect(cloud.angelegt).toEqual([
      expect.objectContaining({ standortId: FIXTURE_IDS.st2, plantKind: 'eigenverbrauch', tarifArt: 'ohne' }),
    ]);
  });

  test(`Ein-Anlagen-Bestandskunde ohne Standort · ${breite} px: Zeichenweg bleibt wie heute`, async ({ page }) => {
    await verdrahte(page, bestandskundeOhneStandort());
    await oeffne(page, breite, '?wirt=bestand-ohne-standort');
    const dialog = page.getByRole('dialog', { name: 'Anlage anlegen' });
    await expect(dialog.locator('.vp-step-label')).toHaveText(['Adresse', 'Box', 'Anlage']);
    await expect(dialog.getByRole('combobox', { name: 'Veräußerungsform' })).toBeVisible();
    await expect(dialog.getByText(/Feineinstellungen/)).toBeVisible();
    await expect(dialog.getByText('Zuerst den Standort')).toHaveCount(0);
    await messeUndFotografiere(page, breite, 'bestand-eine-anlage');
  });

  test(`Leerzustand · ${breite} px: Messkunde ohne Fahrplan und Erlöse, Gegenprobe wie heute`, async ({ page }) => {
    await verdrahte(page, messkunde());
    await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
    await page.goto('/e2e/anlage-anlegen.html?wirt=leer');
    await expect(page.getByRole('heading', { name: 'Noch keine Anlage' })).toBeVisible();
    await expect(page.locator('.vp-main')).toContainText('ihre Messwerte');
    await expect(page.locator('.vp-main')).not.toContainText('Fahrplan');
    await expect(page.locator('.vp-main')).not.toContainText('Erlöse');
    await messeUndFotografiere(page, breite, 'leer-messkunde-nachher');
  });

  test(`Leerzustand-Gegenprobe · ${breite} px: Standort mit Steuern behält heutigen Text`, async ({ page }) => {
    await verdrahte(page, kundeMitSteuern());
    await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
    await page.goto('/e2e/anlage-anlegen.html?wirt=leer');
    await expect(page.getByRole('heading', { name: 'Noch keine Anlage' })).toBeVisible();
    await expect(page.locator('.vp-main')).toContainText('Fahrplan');
    await expect(page.locator('.vp-main')).toContainText('Erlöse');
    await messeUndFotografiere(page, breite, 'leer-wie-heute-vorher');
  });

  test(`nur messen · ${breite} px: Werk Lindach — drei Schritte, kein Wort der Wortliste, ab zu den Messstellen`, async ({ page }) => {
    const cloud = messkunde();
    await verdrahte(page, cloud);
    await oeffne(page, breite);
    const dialog = page.getByRole('dialog', { name: 'Anlage anlegen' });
    await expect(dialog.getByRole('radio', { name: /Am selben Ort wie „Werk Lindach“/ })).toBeChecked();
    await expect(dialog.locator('.vp-step-label')).toHaveText(['Adresse', 'Box', 'Anlage']);
    await expect(dialog.getByText(/Feineinstellungen/)).toHaveCount(0);
    await schweigt(page, 'Schritt 1 · Adresse');
    await messeUndFotografiere(page, breite, 'messen-1-anlage');

    await dialog.getByLabel('Name der neuen Anlage').fill('Halle 3');
    await dialog.getByRole('button', { name: 'Weiter', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: 'Ihre VoltPilot-Box' })).toBeVisible();
    await schweigt(page, 'Schritt 2 · Box');
    await messeUndFotografiere(page, breite, 'messen-2-box');

    await dialog.getByLabel('Kennung').fill('k7m2xq3');
    await expect(dialog.getByText('Kennung stimmt: edge-k7m2xq3')).toBeVisible();
    await dialog.getByRole('button', { name: 'Box verbinden', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: /^Ihre Box meldet gerade ihre Geräte/ })).toBeVisible();
    await schweigt(page, 'Schritt 3 · Anlage');
    await messeUndFotografiere(page, breite, 'messen-3-anlage');
    expect(cloud.angelegt).toEqual([
      expect.objectContaining({
        standortId: FIXTURE_IDS.st2,
        plantKind: 'eigenverbrauch',
        tarifArt: 'ohne',
        netzladenErlaubt: false,
        maxFeedInKw: null,
      }),
    ]);

    // Kein Fertig-Bildschirm (D7): „Stimmt so“ führt ohne Umweg zu den Messstellen.
    await dialog.getByRole('button', { name: 'Stimmt so', exact: true }).click();
    await expect(page.getByTestId('gemeldet')).toHaveText(`${NEU} → ${MESSSTELLEN_LINDACH}`);
    expect(new URL(page.url()).hash).toBe(MESSSTELLEN_LINDACH);
  });

  test(`Kunde mit Steuern · ${breite} px: Werk Ahrenberg — mit Veräußerungsform, Ende im Cockpit der neuen Anlage`, async ({ page }) => {
    const cloud = kundeMitSteuern();
    await verdrahte(page, cloud);
    await oeffne(page, breite);
    const dialog = page.getByRole('dialog', { name: 'Anlage anlegen' });
    await expect(dialog.getByRole('radio', { name: /Am selben Ort wie „Werk Ahrenberg“/ })).toBeChecked();
    await expect(dialog.locator('.vp-step-label')).toHaveText(['Adresse', 'Box', 'Anlage']);
    await expect(dialog.getByRole('combobox', { name: 'Veräußerungsform' })).toBeVisible();
    // Gegenprobe im Browser: derselbe Abtaster findet die Wörter.
    expect(await woerter(page)).toEqual(expect.arrayContaining(['veräußerung', 'vergüt', 'netzladen']));
    await messeUndFotografiere(page, breite, 'steuern-1-anlage');

    await dialog.getByLabel('Name der neuen Anlage').fill('Halle 3');
    await dialog.getByRole('button', { name: 'Weiter', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: 'Ihre VoltPilot-Box' })).toBeVisible();
    await messeUndFotografiere(page, breite, 'steuern-2-box');

    // Ohne Box: „Was haben Sie?“ - Solar und Speicher als Zahlen (Paket 2).
    await dialog.getByRole('button', { name: 'Box ist noch nicht da - später verbinden' }).click();
    await expect(dialog.getByRole('heading', { name: 'Was haben Sie?' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Speicher' }).click();
    await messeUndFotografiere(page, breite, 'steuern-3-anlage');
    await dialog.getByRole('button', { name: 'Speicher' }).click();
    // Kein Fertig-Bildschirm (D7): ins Cockpit der neuen Anlage.
    await dialog.getByRole('button', { name: 'Später ergänzen' }).click();
    await expect(page.getByTestId('gemeldet')).toHaveText(`${NEU} → #/anlage/${NEU}`);
  });

  test(`Einrichtungs-Assistent · ${breite} px: „In drei Schritten" beim Messkunden`, async ({ page }) => {
    await verdrahte(page, messkunde());
    await oeffne(page, breite, '?wirt=assistent');
    await expect(page.getByText('In drei Schritten ist Ihre Anlage startklar.')).toBeVisible();
    await schweigt(page, 'Willkommen');
    await messeUndFotografiere(page, breite, 'assistent-messen');
  });

  test(`Privatkunde · ${breite} px: die Adresse einmal - Standort und Anlage aus einem Formular`, async ({ page }) => {
    const cloud = neuerPrivatkunde();
    await verdrahte(page, cloud);
    await oeffne(page, breite, '?wirt=assistent', 'Wo steht Ihre Anlage?');
    // Drei feste Schritte und kein Standort-Dialog vorab.
    await expect(page.locator('.vp-step-label')).toHaveText(['Adresse', 'Box', 'Anlage']);
    await expect(page.getByText('Zuerst den Standort')).toHaveCount(0);
    await messeUndFotografiere(page, breite, 'privat-1-adresse');

    await page.getByLabel('Adresse').fill('Hauptstr 12 gun');
    const vorschlag = page.getByRole('option', { name: 'Hauptstraße 12, 91710 Gunzenhausen' });
    await expect(vorschlag).toBeVisible();
    await expect(page.getByText('Adressen: © OpenStreetMap-Mitwirkende')).toBeVisible();
    await messeUndFotografiere(page, breite, 'privat-2-vorschlaege');
    await vorschlag.click();
    await expect(page.getByText(/Adresse gefunden/)).toBeVisible();
    await messeUndFotografiere(page, breite, 'privat-3-gewaehlt');

    await page.getByRole('button', { name: 'Weiter', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Ihre VoltPilot-Box' })).toBeVisible();
    expect(cloud.standorteAngelegt).toEqual([
      {
        name: 'Zuhause',
        adresse: { strasse: 'Hauptstraße 12', plz: '91710', ort: 'Gunzenhausen', land: 'DE' },
        zeitzone: 'Europe/Berlin',
        lage: { breitengrad: 49.1159, laengengrad: 10.7155 },
      },
    ]);
    expect(cloud.angelegt).toEqual([expect.objectContaining({ name: 'Zuhause', standortId: FIXTURE_IDS.st2 })]);
    expect(cloud.angelegt[0]).not.toHaveProperty('latitude');
    // B3: beide Anfragen tragen die Kennung desselben Formulars.
    expect(cloud.kennungen).toEqual([expect.stringMatching(/:standort0$/), expect.stringMatching(/:anlage$/)]);
  });

  test(`Verwerfen-Frage · ${breite} px: Escape mit Eingaben fragt nach (F8)`, async ({ page }) => {
    await verdrahte(page, kundeMitSteuern());
    await oeffne(page, breite);
    const dialog = page.getByRole('dialog', { name: 'Anlage anlegen' });
    await dialog.getByLabel('Name der neuen Anlage').fill('Garage');
    await page.keyboard.press('Escape');
    const frage = page.getByRole('dialog', { name: 'Eingaben verwerfen?' });
    await expect(frage).toBeVisible();
    await messeUndFotografiere(page, breite, 'verwerfen-frage');
    // Escape heißt „weiter ausfüllen“ - die Eingabe bleibt.
    await page.keyboard.press('Escape');
    await expect(frage).toHaveCount(0);
    await expect(dialog.getByLabel('Name der neuen Anlage')).toHaveValue('Garage');
    await page.keyboard.press('Escape');
    await frage.getByRole('button', { name: 'Verwerfen' }).click();
    await expect(page.getByTestId('gemeldet')).toHaveText('geschlossen');
  });

  test(`Einrichtungs-Assistent · ${breite} px: „In drei Schritten" auch mit Steuern`, async ({ page }) => {
    await verdrahte(page, kundeMitSteuern());
    await oeffne(page, breite, '?wirt=assistent');
    await expect(page.getByText('In drei Schritten ist Ihre Anlage startklar.')).toBeVisible();
    await messeUndFotografiere(page, breite, 'assistent-steuern');
  });
}
