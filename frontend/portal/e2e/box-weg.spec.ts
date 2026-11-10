import { expect, test, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Der Weg (vp-box-verbinden-konzept, E1 = B, entschieden 10.11.2026): fünf
 * Stationen nach dem Verbinden - Eingesteckt · Box startet · Anmeldung ·
 * Datenverbindung · Ihre Anlage - bei 390 und 1440 px, mit einer fiktiven
 * Kennung und einer per `page.route` verdrahteten Cloud. `page.clock` fährt
 * jeden Umschaltpunkt aus Bericht Abschnitt 4.3 an, ohne wirklich zu warten.
 */

const REF = 'edge-k7m2xq3';
const ANLAGE = {
  id: '10000000-0000-4000-8000-0000000000a1', name: 'Zuhause', biddingZone: 'DE-LU', latitude: 49.1159, longitude: 10.7155,
  plantKind: 'eigenverbrauch', anzulegenderWertCtKwh: null, tarifArt: 'ohne', tarifParamCtKwh: null, netzladenErlaubt: false, maxFeedInKw: null,
};
const STANDORT = {
  id: '5a1d0000-0000-4000-8000-0000000000a1', unternehmenId: 'u-1', name: 'Zuhause', kurzzeichen: 'ST-1',
  adresse: { strasse: 'Hauptstraße 12', plz: '91710', ort: 'Gunzenhausen', land: 'DE' }, zeitzone: 'Europe/Berlin', zustand: 'aktiv',
  esFehlt: [], bestand: 'vorhanden', bestandText: null, anlagen: [] as unknown[], anlagenZahl: 0, gebaeudeZahl: 0, nutzung: null, notiz: null,
  lage: { breitengrad: 49.1159, laengengrad: 10.7155 },
};
const HAUS = {
  text: 'Hauptstraße 12, 91710 Gunzenhausen', strasse: 'Hauptstraße', hausnummer: '12', plz: '91710', ort: 'Gunzenhausen', land: 'DE',
  breitengrad: 49.1159, laengengrad: 10.7155, genau: 'haus',
};

interface Anmeldung {
  zuletztAngefragtAm: string | null;
  schluesselAbgeholtAm: string | null;
}

interface Cloud {
  sites: unknown[];
  devices: Record<string, unknown>[];
  standorte: unknown[];
  claim: 201 | 409;
  claims: string[];
  createdAt: string | null;
  anmeldung: Anmeldung | null;
  lastSeenAt: string | null;
}

function box(cloud: Cloud) {
  return {
    id: '20000000-0000-4000-8000-0000000000a1', siteId: ANLAGE.id, externalRef: REF, kind: 'edge', name: null, status: 'claimed',
    lastSeenAt: cloud.lastSeenAt, createdAt: cloud.createdAt, anmeldung: cloud.anmeldung,
  };
}

async function verdrahte(page: Page, cloud: Cloud) {
  await page.route((url) => url.hostname !== '127.0.0.1' && url.hostname !== 'localhost', (r) => r.abort());
  await page.route('**/api/v1/**', (r) => {
    const url = r.request().url();
    const leer = /\/(sites|devices|components|entities|candidates|runs|releases|assets)(\?|$)/.test(url);
    if (!leer && r.request().method() === 'GET') return r.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"Not found"}' });
    return r.fulfill({ status: 200, contentType: 'application/json', body: leer ? '[]' : '{}' });
  });
  const json = (r: Route, body: unknown, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const sichtbar = (e: unknown[]) => ({ eintraege: e, teilansicht: { sichtbar: e.length, gesamt: e.length } });
  await page.route('**/api/v1/me', (r) =>
    json(r, {
      kennung: 'erika', name: 'Erika Kaiser', konto: 'benutzer', zustand: 'aktiv', kundenbereich: { id: 'kb-erika', name: 'Erika Kaiser' },
      zugang: 'konto', rollen: ['kundenadministrator'], unternehmensweit: true, standorte: [],
      unternehmen_rechte: ['anlage.verwalten', 'geraet.einrichten', 'standort.verwalten'], kuenftig: [], text: null, teilansicht: null,
      unterstuetzungen: { eigene: [], gewaehrte: [] }, kundenadministratoren: [],
    }),
  );
  await page.route('**/api/v1/tenant-context', (r) => json(r, { tenantId: 'kb-erika', name: 'Erika Kaiser', segment: 'B2C', betriebsart: 'endkunde' }));
  await page.route('**/api/v1/funktionen', (r) =>
    json(r, { unternehmen: { messen: { laeuft_an: 0, standorte: 0, text: null }, steuern: { laeuft_an: 0, standorte: 0, text: null } }, standorte: [] }),
  );
  await page.route('**/api/v1/unternehmen', (r) => json(r, { id: 'u-1', name: 'Erika Kaiser', zeitzone: 'Europe/Berlin', sitz: null }));
  await page.route('**/api/v1/orte/suche**', (r) => {
    const q = new URL(r.request().url()).searchParams.get('q') ?? '';
    return json(r, { treffer: q.length >= 3 ? [HAUS] : [], quelle: '© OpenStreetMap-Mitwirkende' });
  });
  await page.route('**/api/v1/standorte', (r) => {
    if (r.request().method() === 'POST') {
      cloud.standorte = [STANDORT];
      return json(r, STANDORT, 201);
    }
    return json(r, { stichtag: '2026-11-04', standorte: cloud.standorte, nichtGezeigt: [], nochNichtZugeordnet: null });
  });
  await page.route('**/api/v1/sites', (r) => {
    if (r.request().method() === 'POST') {
      cloud.sites = [ANLAGE];
      return json(r, ANLAGE, 201);
    }
    return json(r, sichtbar(cloud.sites));
  });
  await page.route('**/api/v1/devices', (r) => json(r, sichtbar(cloud.devices)));
  await page.route('**/api/v1/devices/claim', (r) => {
    const body = r.request().postDataJSON() as { externalRef: string };
    cloud.claims.push(body.externalRef);
    if (cloud.claim === 409) return json(r, { message: 'taken' }, 409);
    cloud.createdAt = new Date().toISOString();
    cloud.devices = [box(cloud)];
    return json(r, box(cloud), 201);
  });
  await page.route(`**/api/v1/sites/${ANLAGE.id}/entities`, (r) => json(r, { registry: null, entities: [], localSetup: [], staleOnDevice: [] }));
  await page.route(`**/api/v1/sites/${ANLAGE.id}/components`, (r) => json(r, { components: [], heldReason: null }));
  await page.route(`**/api/v1/sites/${ANLAGE.id}/topology`, (r) =>
    json(r, { schemaVersion: '1.0', entities: [], topology: { schema_version: '1.0', nodes: [] } }),
  );
  await page.route('**/api/v1/sites/*/assets', (r) => json(r, []));
}

/** Kein horizontaler Überlauf, weder am Dokument noch an einem Element der Seite. */
async function ohneQuerlauf(page: Page, breite: number, seite: string) {
  const m = await page.evaluate((b) => ({
    dokument: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    draussen: [...document.querySelectorAll('.vp-koppel-seite *, .vp-onboarding *')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.right > b + 0.5 || r.left < -0.5);
      })
      .map((el) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`),
  }), breite);
  expect(m.dokument, `${seite} ${breite}: Dokument`).toBe(0);
  expect(m.draussen, `${seite} ${breite}: Elemente`).toEqual([]);
}

async function bisZurBox(page: Page) {
  await page.addInitScript((ref) => sessionStorage.setItem('vp.koppel.ref', ref), REF);
  await page.goto('/e2e/boot-flow.html');
  await expect(page.getByRole('heading', { name: 'Willkommen bei VoltPilot' })).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('Adresse').fill('Hauptstr 12 gun');
  await page.getByRole('option', { name: HAUS.text }).click();
  await page.getByRole('button', { name: 'Weiter', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ihre VoltPilot-Box' })).toBeVisible();
}

test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'desktop-chromium', 'Die Breiten 390 und 1440 px stellt der Test selbst ein.');
});

for (const breite of [390, 1440] as const) {
  const hoehe = breite < 720 ? 844 : 900;

  test(`Der Weg: alle Phasen und Umschaltpunkte - ${breite}px`, async ({ page }) => {
    const cloud: Cloud = { sites: [], devices: [], standorte: [], claim: 201, claims: [], createdAt: null, anmeldung: null, lastSeenAt: null };
    await verdrahte(page, cloud);
    await page.clock.install();
    await page.setViewportSize({ width: breite, height: hoehe });
    await bisZurBox(page);
    await ohneQuerlauf(page, breite, 'box-kennung');

    await page.getByRole('button', { name: 'Box verbinden', exact: true }).click();

    // 0:00 - startet.
    await expect(page.getByRole('heading', { name: 'Ihre Box startet' })).toBeVisible();
    await expect(page.getByText('Meist ist sie 2½ Minuten nach dem Einstecken online.')).toBeVisible();
    await ohneQuerlauf(page, breite, 'weg-startet');

    // 3:00 - länger als meist, noch kein Problem.
    await page.clock.runFor(3 * 60_000 + 1000);
    await expect(page.getByRole('heading', { name: 'Heute dauert es länger als meist' })).toBeVisible();

    // 5:00 - Prüf-Hilfe mit den drei Fragen und der Zeichnung der Box.
    await page.clock.runFor(2 * 60_000);
    await expect(page.getByRole('heading', { name: 'Wir hören noch nichts von Ihrer Box' })).toBeVisible();
    await expect(page.getByText('Das Netzteil steckt in der Buchse „5V“ und in der Steckdose.')).toBeVisible();
    await expect(page.getByText('Steht unten auf Ihrer Box dieselbe Kennung?')).toBeVisible();
    await expect(page.locator('svg.vpb')).toBeVisible();
    await ohneQuerlauf(page, breite, 'weg-pruefen');

    // 15:00 - Weg zum Support.
    await page.clock.runFor(10 * 60_000);
    await expect(page.getByRole('heading', { name: 'Wir hören noch nichts von Ihrer Box' })).toBeVisible();
    await expect(page.getByText(/Seit 15 Minuten kein Lebenszeichen von der Box/)).toBeVisible();
    await expect(page.getByRole('link', { name: /Support kontaktieren/ })).toBeVisible();
    await ohneQuerlauf(page, breite, 'weg-support');

    // Anmeldung da (S2): „Ihre Box ist im Internet“, die Station „Anmeldung“ ist erledigt.
    cloud.anmeldung = { zuletztAngefragtAm: new Date(await page.evaluate(() => Date.now())).toISOString(), schluesselAbgeholtAm: null };
    cloud.devices = [box(cloud)];
    await page.clock.runFor(6000);
    await expect(page.getByRole('heading', { name: 'Ihre Box ist im Internet' })).toBeVisible();

    // 75 s ohne Herzschlag nach der Anmeldung: Datenverbindung gesperrt.
    await page.clock.runFor(76_000);
    await expect(page.getByRole('heading', { name: 'Die Datenverbindung kommt nicht durch' })).toBeVisible();
    await ohneQuerlauf(page, breite, 'weg-datensperre');

    // Erster Herzschlag: online, „Weiter: Ihre Anlage“ führt in Schritt 3.
    cloud.lastSeenAt = new Date(await page.evaluate(() => Date.now())).toISOString();
    cloud.devices = [box(cloud)];
    await page.clock.runFor(6000);
    await expect(page.getByRole('heading', { name: 'Ihre Box ist online' })).toBeVisible();
    await ohneQuerlauf(page, breite, 'weg-online');

    await page.getByRole('button', { name: 'Weiter: Ihre Anlage' }).click();
    await expect(page.getByRole('heading', { name: 'So geht es weiter' })).toBeVisible();
    await expect(page.getByText('Box online')).toBeVisible();
    await ohneQuerlauf(page, breite, 'schritt3-ueberblick');
  });

  test(`Der Weg: Prüf-Hilfe ohne laufende Animation bei reduzierter Bewegung - ${breite}px`, async ({ page }) => {
    const cloud: Cloud = { sites: [], devices: [], standorte: [], claim: 201, claims: [], createdAt: null, anmeldung: null, lastSeenAt: null };
    await verdrahte(page, cloud);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.clock.install();
    await page.setViewportSize({ width: breite, height: hoehe });
    await bisZurBox(page);
    await page.getByRole('button', { name: 'Box verbinden', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Ihre Box startet' })).toBeVisible();
    await page.waitForTimeout(300);
    const laufend = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length);
    expect(laufend, 'keine laufende Animation unter prefers-reduced-motion').toBe(0);
  });
}

test('Der Weg: axe-core ohne neue Funde (online und Prüf-Hilfe, 1440px)', async ({ page }) => {
  const cloud: Cloud = { sites: [], devices: [], standorte: [], claim: 201, claims: [], createdAt: null, anmeldung: null, lastSeenAt: null };
  await verdrahte(page, cloud);
  await page.clock.install();
  await page.setViewportSize({ width: 1440, height: 900 });
  await bisZurBox(page);
  await page.getByRole('button', { name: 'Box verbinden', exact: true }).click();
  await page.clock.runFor(5 * 60_000 + 1000);
  await expect(page.getByRole('heading', { name: 'Wir hören noch nichts von Ihrer Box' })).toBeVisible();
  // Nur der neue Weg selbst (`.vp-onboarding-step`), nicht der Kopf der Seite - dessen
  // bekannter Fund (`.vp-healthbadge`) steht schon in `e2e/a11y-scan.spec.ts` OFFEN.
  const pruefen = await new AxeBuilder({ page }).include('.vp-onboarding-step').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(pruefen.violations, JSON.stringify(pruefen.violations, null, 2)).toEqual([]);

  cloud.lastSeenAt = new Date(await page.evaluate(() => Date.now())).toISOString();
  cloud.devices = [box(cloud)];
  await page.clock.runFor(6000);
  await expect(page.getByRole('heading', { name: 'Ihre Box ist online' })).toBeVisible();
  const online = await new AxeBuilder({ page }).include('.vp-onboarding-step').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(online.violations, JSON.stringify(online.violations, null, 2)).toEqual([]);
});
