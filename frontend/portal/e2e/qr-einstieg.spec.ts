import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * Der Weg nach dem Scan des Gehäuse-QR (Konzept vp-qr-einstieg, entschieden 04.11.2026: QE-1 A, QE-2 A,
 * QE-3 B, QE-4 A, QE-5 A), bei 375 und 1440 px, mit einer fiktiven Kennung und einer per `page.route`
 * verdrahteten Cloud:
 *   - ohne Sitzung: Empfangsseite (M1) → „Konto erstellen“ mit Box-Band (M3); ein unlesbarer Code (M2);
 *     die Empfangsseite fragt keinen Server,
 *   - angemeldet ohne Anlage: Assistent mit Band (M5), Schritt „Box“ mit der Kennung aus dem QR-Code (M6),
 *     „Box verbinden“ → „wartet auf das erste Lebenszeichen“ (M8) → von selbst „Ihre Box ist online“ (M9),
 *   - die Box gehört einem anderen Konto (M11), sie gehört schon zu diesem (M10).
 *
 * Mit `QR_EINSTIEG_BILDER=<Ordner>` legt der Lauf je Seite ein Bild ab.
 */

const BILDER = process.env.QR_EINSTIEG_BILDER;
const BREITEN = [375, 1440] as const;
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

interface Cloud {
  sites: unknown[];
  devices: Record<string, unknown>[];
  standorte: unknown[];
  /** Was das Verbinden antwortet: 201 oder 409 (Box gehört einem anderen Konto). */
  claim: 201 | 409;
  claims: string[];
}

const box = (lastSeenAt: string | null) => ({
  id: '20000000-0000-4000-8000-0000000000a1', siteId: ANLAGE.id, externalRef: REF, kind: 'edge', name: null, status: 'claimed',
  lastSeenAt, createdAt: new Date().toISOString(),
});

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
    cloud.devices = [box(null)];
    return json(r, box(null), 201);
  });
  await page.route(`**/api/v1/sites/${ANLAGE.id}/entities`, (r) => json(r, { registry: null, entities: [], localSetup: [], staleOnDevice: [] }));
  // Der Aufbau braucht die Komponenten-Antwort in ihrer Form (leer, keine Sperre).
  await page.route(`**/api/v1/sites/${ANLAGE.id}/components`, (r) => json(r, { components: [], heldReason: null }));
  await page.route(`**/api/v1/sites/${ANLAGE.id}/topology`, (r) =>
    json(r, { schemaVersion: '1.0', entities: [], topology: { schema_version: '1.0', nodes: [] } }),
  );
}

async function ohneQuerlauf(page: Page, breite: number, seite: string) {
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity),
  );
  const m = await page.evaluate((b) => ({
    dokument: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    draussen: [...document.querySelectorAll('.vp-koppel-seite *, .vp-koppel-band *, .vp-auth-body *, .vp-onboarding *')]
      .filter((el) => !el.closest('.vp-map'))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.right > b + 0.5 || r.left < -0.5);
      })
      .map((el) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`),
  }), breite);
  expect(m.dokument, `${seite} ${breite}: Dokument`).toBe(0);
  expect(m.draussen, `${seite} ${breite}: Elemente`).toEqual([]);
  if (BILDER) {
    mkdirSync(BILDER, { recursive: true });
    await page.screenshot({ path: join(BILDER, `${seite}-${breite}.png`), fullPage: true });
  }
}

const konsolenfehler = (page: Page) => {
  const fehler: string[] = [];
  page.on('pageerror', (e) => fehler.push(String(e)));
  return fehler;
};

test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'desktop-chromium', 'Die Breiten 375 und 1440 px stellt der Test selbst ein.');
});

for (const breite of BREITEN) {
  const hoehe = breite < 720 ? 844 : 900;

  test(`Empfang ohne Sitzung · ${breite} px: Box ist da → Konto erstellen mit Band; kein Server vor der Anmeldung (QE-1 A)`, async ({ page }) => {
    const fehler = konsolenfehler(page);
    const api: string[] = [];
    await page.route((url) => url.hostname !== '127.0.0.1', (r) => r.abort());
    await page.route('**/api/**', (r) => {
      api.push(r.request().url());
      return r.abort();
    });
    await page.setViewportSize({ width: breite, height: hoehe });
    await page.goto(`/e2e/koppel-empfang.html#/k/${REF}`);

    await expect(page.getByRole('heading', { name: 'Ihre VoltPilot-Box ist da' })).toBeVisible();
    await expect(page.getByText('EDGE-K7M2XQ3', { exact: true })).toBeVisible();
    // Der Link ist aus der Adresse, die Kennung im Speicher (Tab und 24 Stunden im Browser, QE-3 B).
    expect(new URL(page.url()).hash).toBe('#/');
    expect(await page.evaluate(() => sessionStorage.getItem('vp.koppel.ref'))).toBe(REF);
    expect(JSON.parse((await page.evaluate(() => localStorage.getItem('vp.koppel.vormerk')))!)).toMatchObject({ ref: REF });
    await ohneQuerlauf(page, breite, 'qr-1-empfang');

    // Neu laden: die Empfangsseite bleibt (vorgemerkt), statt zur Anmeldung zu springen.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Ihre VoltPilot-Box ist da' })).toBeVisible();

    await page.getByRole('button', { name: 'Ich habe schon ein Konto' }).click();
    expect(await page.evaluate(() => (window as unknown as { __anmeldungen: number }).__anmeldungen)).toBe(1);

    await page.getByRole('button', { name: 'Konto erstellen' }).click();
    await expect(page.getByRole('heading', { name: 'Konto erstellen' })).toBeVisible();
    await expect(page.getByText('Box EDGE-K7M2XQ3 ist vorgemerkt. Nach dem Konto fragen wir die Adresse Ihrer Anlage, dann verbinden Sie die Box.')).toBeVisible();
    await ohneQuerlauf(page, breite, 'qr-2-konto-erstellen');
    expect(api).toEqual([]);
    expect(fehler).toEqual([]);
  });

  test(`Code nicht lesbar · ${breite} px: Kennung vom Aufdruck eintippen (M2)`, async ({ page }) => {
    await page.route((url) => url.hostname !== '127.0.0.1', (r) => r.abort());
    await page.setViewportSize({ width: breite, height: hoehe });
    await page.goto('/e2e/koppel-empfang.html#/k/edge-k7m2xq1');
    await expect(page.getByRole('heading', { name: 'Dieser Code ist nicht vollständig lesbar' })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem('vp.koppel.ref'))).toBeNull();
    await ohneQuerlauf(page, breite, 'qr-3-unlesbar');
    await page.getByLabel('Kennung').fill('EDGE-K7M2XQ3');
    await page.getByRole('button', { name: 'Weiter', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Ihre VoltPilot-Box ist da' })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem('vp.koppel.ref'))).toBe(REF);
  });

  test(`Angemeldet ohne Anlage · ${breite} px: Band, Kennung aus dem QR-Code, ehrliches Ergebnis bis „online“ (QE-2 A, QE-4 A)`, async ({ page }) => {
    const fehler = konsolenfehler(page);
    const cloud: Cloud = { sites: [], devices: [], standorte: [], claim: 201, claims: [] };
    await verdrahte(page, cloud);
    await page.clock.install();
    await page.addInitScript((ref) => sessionStorage.setItem('vp.koppel.ref', ref), REF);
    await page.setViewportSize({ width: breite, height: hoehe });
    await page.goto('/e2e/boot-flow.html');

    await expect(page.getByRole('heading', { name: 'Willkommen bei VoltPilot' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Box EDGE-K7M2XQ3 aus dem QR-Code ist vorgemerkt. Sie verbinden sie im nächsten Schritt.')).toBeVisible();
    await ohneQuerlauf(page, breite, 'qr-4-assistent-adresse');
    await page.getByLabel('Adresse').fill('Hauptstr 12 gun');
    await page.getByRole('option', { name: HAUS.text }).click();
    await page.getByRole('button', { name: 'Weiter', exact: true }).click();

    // Schritt „Box“: die Kennung steht im Feld, die Weiche springt nach Schritt 1 nicht mehr um (Befund §7).
    await expect(page.getByRole('heading', { name: 'Ihre VoltPilot-Box' })).toBeVisible();
    await expect(page.getByText(/Die Kennung ist schon eingetragen, aus dem QR-Code/)).toBeVisible();
    await expect(page.getByLabel('Kennung')).toHaveValue(REF);
    await expect(page.getByText('Kennung stimmt · aus dem QR-Code')).toBeVisible();
    expect(new URL(page.url()).hash).not.toContain('neu=box');
    expect(await page.evaluate(() => sessionStorage.getItem('vp.koppel.ref'))).toBe(REF);
    expect(cloud.claims).toEqual([]);
    await ohneQuerlauf(page, breite, 'qr-5-assistent-box');
    await page.getByRole('button', { name: 'Box verbinden', exact: true }).click();

    // M8: verbunden, aber noch kein Lebenszeichen - kein „meldet sich“.
    await expect(page.getByRole('heading', { name: 'Box verbunden – sie hat sich noch nicht gemeldet' })).toBeVisible();
    expect(cloud.claims).toEqual([REF]);
    expect(await page.evaluate(() => [sessionStorage.getItem('vp.koppel.ref'), localStorage.getItem('vp.koppel.vormerk')])).toEqual([null, null]);
    await ohneQuerlauf(page, breite, 'qr-6-wartet');

    // Die Box meldet sich: die Seite geht von selbst über (M9).
    cloud.devices = [box(new Date(await page.evaluate(() => Date.now())).toISOString())];
    await page.clock.runFor(11_000);
    await expect(page.getByRole('heading', { name: 'Ihre Box ist online' })).toBeVisible();
    await ohneQuerlauf(page, breite, 'qr-7-online');
    await page.getByRole('button', { name: 'Weiter: Geräte übernehmen' }).click();
    await expect(page.getByRole('heading', { name: /^Ihre Box meldet gerade ihre Geräte/ })).toBeVisible();
    expect(fehler).toEqual([]);
  });

  test(`Box eines anderen Kontos · ${breite} px: eigene Seite ohne fremdes Konto (QE-5 A)`, async ({ page }) => {
    const cloud: Cloud = { sites: [ANLAGE], devices: [], standorte: [STANDORT], claim: 409, claims: [] };
    await verdrahte(page, cloud);
    await page.addInitScript((ref) => sessionStorage.setItem('vp.koppel.ref', ref), REF);
    await page.setViewportSize({ width: breite, height: hoehe });
    await page.goto('/e2e/boot-flow.html');
    // Eine Anlage: der Aufbau öffnet „VoltPilot-Box hinzufügen“ mit dem QR-Band.
    const blatt = page.getByRole('dialog');
    await expect(blatt.getByText('Aus dem QR-Code: EDGE-K7M2XQ3')).toBeVisible({ timeout: 20_000 });
    await ohneQuerlauf(page, breite, 'qr-8-blatt');
    await blatt.getByRole('button', { name: 'VoltPilot-Box hinzufügen' }).click();
    await expect(blatt.getByRole('heading', { name: 'Diese Box ist schon mit einem anderen Konto verbunden' })).toBeVisible();
    await expect(blatt.getByText('Mit welchem, zeigen wir aus Datenschutzgründen nicht.')).toBeVisible();
    await ohneQuerlauf(page, breite, 'qr-9-anderes-konto');
  });

  test(`Box gehört schon zu Ihnen · ${breite} px: eigene Seite, kein zweites Verbinden (F-2)`, async ({ page }) => {
    const cloud: Cloud = { sites: [ANLAGE], devices: [box(new Date().toISOString())], standorte: [STANDORT], claim: 201, claims: [] };
    await verdrahte(page, cloud);
    await page.addInitScript((ref) => sessionStorage.setItem('vp.koppel.ref', ref), REF);
    await page.setViewportSize({ width: breite, height: hoehe });
    await page.goto('/e2e/boot-flow.html');
    await expect(page.getByRole('heading', { name: 'Diese Box gehört schon zu Ihnen' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('EDGE-K7M2XQ3 ist mit Ihrer Anlage „Zuhause“ verbunden. Es ist nichts mehr zu tun.')).toBeVisible();
    await ohneQuerlauf(page, breite, 'qr-10-schon-deins');
    expect(cloud.claims).toEqual([]);
  });
}
