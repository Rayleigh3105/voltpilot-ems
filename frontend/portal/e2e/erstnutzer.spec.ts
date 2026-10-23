import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Der Erstnutzer-Fluss nach Konzept a1 (Paket 0-3), bei 390 und 1440 px, gegen eine per `page.route`
 * verdrahtete Cloud: Registrierung mit der einen Frage (D2) → „Wo steht Ihre Anlage?“ (die Adresse
 * einmal, Vorschläge über `GET /api/v1/orte/suche`) → Box mit Kennung (B4) → „Das hat Ihre Box gefunden“
 * (bestätigen, F17) → Cockpit, wie es ist, mit der einmaligen Karte „Ihre Anlage ist live.“ (D7).
 *
 * B1: 30 s nach „Ihre Anlage ist verbunden“ stand „Noch keine Anlage“ - die Geräte-Abfrage fand die
 * verbundene Box und hängte den Assistenten aus. Hier läuft die Uhr der Seite 35 s weiter, während die
 * Abfrage die Box schon kennt: der Assistent bleibt, bis der Kunde ihn beendet.
 * F9: ein Neuladen mitten in Schritt 3 führt an denselben Schritt zurück, mit denselben Eingaben.
 *
 * Mit `ERSTNUTZER_BILDER=<Ordner>` legt der Lauf je Schritt ein Bild ab.
 */

const BILDER = process.env.ERSTNUTZER_BILDER;
const BREITEN = [390, 1440] as const;

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

const ANLAGE = {
  id: '10000000-0000-4000-8000-0000000000a1',
  name: 'Zuhause',
  biddingZone: 'DE-LU',
  latitude: 49.1159,
  longitude: 10.7155,
  plantKind: 'eigenverbrauch',
  anzulegenderWertCtKwh: null,
  tarifArt: 'ohne',
  tarifParamCtKwh: null,
  netzladenErlaubt: false,
  maxFeedInKw: null,
};

const STANDORT = {
  id: '5a1d0000-0000-4000-8000-0000000000a1',
  unternehmenId: 'u-1',
  name: 'Zuhause',
  kurzzeichen: 'ST-1',
  adresse: { strasse: 'Hauptstraße 12', plz: '91710', ort: 'Gunzenhausen', land: 'DE' },
  zeitzone: 'Europe/Berlin',
  zustand: 'aktiv',
  esFehlt: [],
  bestand: 'vorhanden',
  bestandText: null,
  anlagen: [] as unknown[],
  anlagenZahl: 0,
  gebaeudeZahl: 0,
  nutzung: null,
  notiz: null,
  lage: { breitengrad: 49.1159, laengengrad: 10.7155 },
};

function sichtbar(eintraege: unknown[]) {
  return { eintraege, teilansicht: { sichtbar: eintraege.length, gesamt: eintraege.length } };
}

/** Die Selbstauskunft der neuen Kundin: Kundenadministratorin ihres Unternehmens (E12). */
function kundin() {
  return {
    kennung: 'erika', name: 'Erika Kaiser', konto: 'benutzer', zustand: 'aktiv',
    kundenbereich: { id: 'kb-erika', name: 'Erika Kaiser' }, zugang: 'konto', rollen: ['kundenadministrator'],
    unternehmensweit: true, standorte: [], unternehmen_rechte: ['anlage.verwalten', 'geraet.einrichten', 'standort.verwalten'],
    kuenftig: [], text: null, teilansicht: null, unterstuetzungen: { eigene: [], gewaehrte: [] }, kundenadministratoren: [],
  };
}

interface Cloud {
  sites: unknown[];
  devices: unknown[];
  standorte: unknown[];
  telemetrie: boolean;
  /** Was die Box meldet (`/entities` → `localSetup`) - sie meldet sich im Hintergrund. */
  gemeldet: unknown[];
  posts: { pfad: string; body: unknown; kennung: string | null }[];
}

const FRONIUS = {
  id: 'pv-1', kind: 'source', role: 'pv-generation', brand: 'Fronius', model: 'Symo 10.0', label: null,
  reportedAt: '2026-10-23T10:00:00Z', adoptedEntityId: null,
};

async function verdrahte(page: Page, cloud: Cloud) {
  // Keine Kartenkacheln aus dem Netz - die Karte ist hier nicht Gegenstand.
  await page.route((url) => url.hostname !== '127.0.0.1' && url.hostname !== 'localhost', (r) => r.abort());
  // Auffang zuerst (in Playwright gewinnt der zuletzt registrierte Handler): was der Fluss nicht braucht, ist leer -
  // Listen leer, alles andere wie bei einer neuen Anlage ohne Daten (404; die Flächen bleiben fail-soft).
  await page.route('**/api/v1/**', (r) => {
    const url = r.request().url();
    const leer = /\/(sites|devices|components|entities|candidates|runs|releases|assets)(\?|$)/.test(url);
    if (!leer && r.request().method() === 'GET') {
      return r.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"Not found"}' });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: leer ? '[]' : '{}' });
  });
  const json = (r: Parameters<Parameters<Page['route']>[1]>[0], body: unknown, status = 200) =>
    r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/v1/me', (r) => json(r, kundin()));
  await page.route('**/api/v1/tenant-context', (r) =>
    json(r, { tenantId: 'kb-erika', name: 'Erika Kaiser', segment: 'B2C', betriebsart: 'endkunde' }),
  );
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
      cloud.posts.push({ pfad: 'standorte', body: r.request().postDataJSON(), kennung: r.request().headers()['idempotency-key'] ?? null });
      cloud.standorte = [STANDORT];
      return json(r, STANDORT, 201);
    }
    return json(r, { stichtag: '2026-10-23', standorte: cloud.standorte, nichtGezeigt: [], nochNichtZugeordnet: null });
  });
  await page.route('**/api/v1/sites', (r) => {
    if (r.request().method() === 'POST') {
      cloud.posts.push({ pfad: 'sites', body: r.request().postDataJSON(), kennung: r.request().headers()['idempotency-key'] ?? null });
      cloud.sites = [ANLAGE];
      return json(r, ANLAGE, 201);
    }
    return json(r, sichtbar(cloud.sites));
  });
  await page.route('**/api/v1/devices', (r) => json(r, sichtbar(cloud.devices)));
  await page.route('**/api/v1/devices/claim', (r) => {
    const body = r.request().postDataJSON() as { externalRef: string };
    cloud.posts.push({ pfad: 'claim', body, kennung: r.request().headers()['idempotency-key'] ?? null });
    const box = {
      id: '20000000-0000-4000-8000-0000000000a1', siteId: ANLAGE.id, externalRef: body.externalRef, kind: 'edge',
      name: null, status: 'claimed', lastSeenAt: null, createdAt: new Date().toISOString(),
    };
    cloud.devices = [box];
    return json(r, box, 201);
  });
  await page.route(`**/api/v1/sites/${ANLAGE.id}/telemetry**`, (r) =>
    json(r, cloud.telemetrie ? [{ ts: new Date().toISOString(), deviceId: 'box', metric: 'pv_power_kw', value: 3.2 }] : []),
  );
  await page.route(`**/api/v1/sites/${ANLAGE.id}/entities`, (r) =>
    json(r, { registry: null, entities: [], localSetup: cloud.gemeldet, staleOnDevice: [] }),
  );
  await page.route(`**/api/v1/sites/${ANLAGE.id}/v2-entities/adopt`, (r) => {
    cloud.posts.push({ pfad: 'adopt', body: r.request().postDataJSON(), kennung: null });
    return json(r, { id: 'e-1', entityType: 'producer', role: 'pv', label: null, deviceId: null });
  });
  // Ohne Anlagensteuerung antwortet der Server 404 (F15, eigenes Arbeitspaket) - das Cockpit bleibt fail-soft.
  await page.route(`**/api/v1/sites/${ANLAGE.id}/erzeuger/**`, (r) => json(r, { message: 'Not found' }, 404));
  // Das Cockpit einer neuen Anlage: noch kein Modell, keine Komponenten (wie eine frisch verbundene Box).
  await page.route(`**/api/v1/sites/${ANLAGE.id}/topology`, (r) =>
    json(r, { schemaVersion: '1.0', entities: [], topology: { schema_version: '1.0', nodes: [] } }),
  );
  await page.route('**/api/v1/overview', (r) =>
    json(r, {
      sites: cloud.sites.map(() => ({
        id: ANLAGE.id, name: ANLAGE.name, plantKind: 'eigenverbrauch', netzladenErlaubt: false, batteryWithoutDevice: false,
        deviceCount: cloud.devices.length, onlineCount: cloud.telemetrie ? 1 : 0, waitingCount: cloud.telemetrie ? 0 : 1,
        worstStatus: cloud.telemetrie ? 'online' : 'waiting', lastSeenAt: cloud.telemetrie ? new Date().toISOString() : null,
        live: cloud.telemetrie ? { ts: new Date().toISOString(), pvKw: 3.2, loadKw: 2.1, gridKw: -1.1, socPct: null } : null,
        plannedSavingsTodayEur: null, standort: { id: STANDORT.id, name: 'Zuhause', kurzzeichen: 'ST-1', gueltigAb: '2026-10-23', adresseFehlt: false },
      })),
      totals: {
        sites: cloud.sites.length, devices: cloud.devices.length, online: cloud.telemetrie ? 1 : 0,
        plannedSavingsTodayEur: null, liveSitesCovered: cloud.telemetrie ? 1 : 0,
      },
      dailySavings: [],
    }),
  );
}

async function ohneQuerlauf(page: Page, breite: number, schritt: string) {
  // Endlos-Animationen (der Lader der Anmeldeseite) laufen immer - gewartet wird nur auf die endlichen.
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity),
  );
  const m = await page.evaluate((b) => ({
    dokument: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    draussen: [...document.querySelectorAll('.vp-onboarding *, .vp-auth-body *, .vp-anlage-hinweise *')]
      .filter((el) => !el.closest('.vp-map'))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.right > b + 0.5 || r.left < -0.5);
      })
      .map((el) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`),
  }), breite);
  expect(m.dokument, `${schritt} ${breite}: Dokument`).toBe(0);
  expect(m.draussen, `${schritt} ${breite}: Elemente`).toEqual([]);
  if (BILDER) {
    mkdirSync(BILDER, { recursive: true });
    await page.screenshot({ path: join(BILDER, `${schritt}-${breite}.png`), fullPage: true });
  }
}

for (const breite of BREITEN) {
  test(`Registrierung · ${breite} px: die eine Frage „Für mein Zuhause / Für ein Unternehmen“ (D2)`, async ({ page }) => {
    await page.setViewportSize({ width: breite, height: breite < 720 ? 844 : 900 });
    let gesendet: Record<string, unknown> | null = null;
    // Die Anmeldung danach (Direct Grant an Keycloak) ist hier nicht Gegenstand: ohne sie steht „Ihr Konto ist bereit“.
    // Zuerst - in Playwright gewinnt der zuletzt registrierte Handler, die API kann auf einem anderen Host liegen.
    await page.route((url) => url.hostname !== '127.0.0.1', (r) => r.abort());
    await page.route('**/api/v1/registration', (r) => {
      gesendet = r.request().postDataJSON() as Record<string, unknown>;
      return r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ tenantId: 'kb-erika', tenantName: 'Erika Kaiser', username: 'erika@beispiel.test' }) });
    });
    await page.goto('/e2e/mobile-ui.html?register');
    await expect(page.getByRole('heading', { name: 'Konto erstellen' })).toBeVisible();
    await expect(page.getByRole('radio', { name: /Für mein Zuhause/ })).toBeVisible();
    await ohneQuerlauf(page, breite, 'erst-0-registrierung');

    await page.getByRole('radio', { name: /Für mein Zuhause/ }).check();
    await page.getByLabel('Ihr Name', { exact: true }).fill('Erika Kaiser');
    await page.getByLabel('E-Mail-Adresse').fill('erika@beispiel.test');
    await page.getByLabel('Passwort', { exact: true }).fill('ein-langes-passwort');
    await ohneQuerlauf(page, breite, 'erst-1-registrierung-ausgefuellt');
    await page.getByRole('button', { name: 'Konto erstellen', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Ihr Konto ist bereit' })).toBeVisible();
    expect(gesendet).toEqual({ name: 'Erika Kaiser', email: 'erika@beispiel.test', password: 'ein-langes-passwort', zweck: 'zuhause' });
  });

  test(`Erstnutzer · ${breite} px: Adresse → Box → Anlage → Cockpit, der Assistent bleibt nach 35 s (B1)`, async ({ page }) => {
    const cloud: Cloud = { sites: [], devices: [], standorte: [], telemetrie: false, gemeldet: [], posts: [] };
    await verdrahte(page, cloud);
    await page.clock.install();
    await page.setViewportSize({ width: breite, height: breite < 720 ? 844 : 900 });
    await page.goto('/e2e/boot-flow.html');

    // 1 · Adresse - kein Standort-Dialog vorab, der Name ist „Zuhause“, die Leiste hat drei Schritte.
    await expect(page.getByRole('heading', { name: 'Willkommen bei VoltPilot' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'Wo steht Ihre Anlage?' })).toBeVisible();
    await expect(page.getByText('In drei Schritten ist Ihre Anlage startklar.')).toBeVisible();
    await expect(page.locator('.vp-step-label')).toHaveText(['Adresse', 'Box', 'Anlage']);
    await expect(page.getByText('Zuerst den Standort')).toHaveCount(0);
    await ohneQuerlauf(page, breite, 'erst-2-adresse');
    await page.getByLabel('Adresse').fill('Hauptstr 12 gun');
    await page.getByRole('option', { name: HAUS.text }).click();
    await ohneQuerlauf(page, breite, 'erst-3-adresse-gewaehlt');
    await page.getByRole('button', { name: 'Weiter', exact: true }).click();

    // 2 · Box - die Anlage steht schon in der Liste (B1: `onSiteCreated` lädt neu); kein Register-Schritt mehr (R4).
    await expect(page.getByRole('heading', { name: 'Ihre VoltPilot-Box' })).toBeVisible();
    expect(cloud.posts.map((p) => p.pfad)).toEqual(['standorte', 'sites']);
    expect(cloud.posts[1].body).toMatchObject({ name: 'Zuhause', standortId: STANDORT.id });
    expect(cloud.posts[0].kennung).toMatch(/:standort0$/);
    expect(cloud.posts[1].kennung).toMatch(/:anlage$/);
    // Die Kennung ohne „edge-“: das Feld ergänzt ihn und prüft das Prüfzeichen.
    await page.getByLabel('Kennung').fill('edge-k7m2xq1');
    await expect(page.getByText('Diese Kennung stimmt nicht. Eine Kennung enthält kein 0, 1, i, l oder o.')).toBeVisible();
    await ohneQuerlauf(page, breite, 'erst-4-box-tippfehler');
    await page.getByLabel('Kennung').fill('K7M2XQ3');
    await expect(page.getByText('Kennung stimmt: edge-k7m2xq3')).toBeVisible();
    await ohneQuerlauf(page, breite, 'erst-5-box');
    await page.getByRole('button', { name: 'Box verbinden', exact: true }).click();

    // 3 · Anlage - kein Warte-Bildschirm (D7): die Box meldet ihre Geräte im Hintergrund.
    await expect(page.getByRole('heading', { name: /^Ihre Box meldet gerade ihre Geräte/ })).toBeVisible();
    expect(cloud.posts.at(-1)).toMatchObject({ pfad: 'claim', body: { externalRef: 'edge-k7m2xq3' } });
    expect(cloud.posts.at(-1)?.kennung).toMatch(/:box:edge-k7m2xq3$/);
    await ohneQuerlauf(page, breite, 'erst-6-box-sucht');
    cloud.gemeldet = [FRONIUS];
    // B1: die Geräte-Abfrage (alle 30 s) kennt die Box schon - 35 s später steht der Assistent noch.
    await page.clock.runFor(35_000);
    await expect(page.getByRole('heading', { name: 'Das hat Ihre Box gefunden' })).toBeVisible();
    await expect(page.getByText('Noch keine Anlage')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Willkommen bei VoltPilot' })).toBeVisible();
    await expect(page.getByText('Fronius Symo 10.0')).toBeVisible();
    await page.getByLabel('Leistung der Solarmodule (kWp)').fill('9,8');
    await ohneQuerlauf(page, breite, 'erst-7-gefunden');

    // F9: Neuladen mitten im Schritt - zurück am selben Schritt, mit derselben Zahl.
    await page.reload();
    await expect(page.getByText('Ihre Eingaben sind wiederhergestellt.')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'Das hat Ihre Box gefunden' })).toBeVisible();
    await expect(page.getByLabel('Leistung der Solarmodule (kWp)')).toHaveValue('9,8');
    await ohneQuerlauf(page, breite, 'erst-8-wiederhergestellt');
    await page.getByRole('button', { name: 'Stimmt so', exact: true }).click();
    // Annahme: die Übernahme bucht die kWp EINMAL, am gemeldeten Erzeuger.
    await expect.poll(() => cloud.posts.at(-1)?.pfad).toBe('adopt');
    expect(cloud.posts.at(-1)?.body).toMatchObject({ sourceId: 'pv-1', entityType: 'producer', capacityKwp: 9.8 });

    // 4 · Ende im Cockpit, wie es ist - kein Vollbild-Assistent mehr; mit den ersten Werten die Karte darüber.
    await expect(page.getByRole('heading', { name: 'Willkommen bei VoltPilot' })).toHaveCount(0);
    await expect(page.getByText('Noch keine Anlage')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Ihre Anlage ist live.' })).toHaveCount(0);
    cloud.telemetrie = true;
    await page.clock.runFor(35_000);
    await expect(page.getByRole('heading', { name: 'Ihre Anlage ist live.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Strompreis angeben' })).toBeVisible();
    await ohneQuerlauf(page, breite, 'erst-9-live');
    await page.getByRole('button', { name: 'Hinweis schließen' }).click();
    await expect(page.getByRole('heading', { name: 'Ihre Anlage ist live.' })).toHaveCount(0);
    await page.reload();
    await expect(page.getByText('Zuhause').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'Ihre Anlage ist live.' })).toHaveCount(0);
  });
}
