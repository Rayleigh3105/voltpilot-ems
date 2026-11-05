import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * Das Erstbild der Landung hängt nicht an `/overview` (Scout `vp-anlagen-cockpit-perf`, Rang 4a).
 *
 * Eine Kundin mit EINER Anlage (Komponenten vorhanden) landet nach der Anmeldung im Cockpit. `/overview` ist der
 * teuerste Aufruf der Landung (300-1.000 ms nach vier Monaten Datenbestand) und hielt bis hierher den Boot-Vorhang
 * UND den Stapel zurück. Hier hält der Fall `/overview` an und prüft, dass Vorhang und Stapel mit den Stammdaten
 * fallen, und dass das Eintreffen der Übersichts-Zeile die Seite nicht rückt.
 *
 *   - `LANDUNG_BILDER=<Ordner>`: legt je Zustand ein Bild ab.
 *   - `LANDUNG_MESSUNG=<ms>`: misst statt zu prüfen. `/overview` antwortet nach <ms>, der Lauf schreibt die Zeiten
 *     (Vorhang weg, Stapel sichtbar, Übersichts-Teile sichtbar) als JSON an die Konsole und prüft nichts. Dasselbe
 *     Skript läuft so gegen den Stand VOR und NACH der Änderung.
 */

const BILDER = process.env.LANDUNG_BILDER;
const MESSUNG = process.env.LANDUNG_MESSUNG ? Number(process.env.LANDUNG_MESSUNG) : null;

const ANLAGE = {
  id: '10000000-0000-4000-8000-0000000000a1',
  name: 'Hof Lindenberg',
  biddingZone: 'DE-LU',
  latitude: 49.1159,
  longitude: 10.7155,
  plantKind: 'eigenverbrauch',
  anzulegenderWertCtKwh: null,
  tarifArt: 'dynamisch',
  tarifParamCtKwh: 18,
  netzladenErlaubt: true,
  maxFeedInKw: null,
};
const BOX = { id: '20000000-0000-4000-8000-0000000000a1', siteId: ANLAGE.id, name: 'Box', lastSeenAt: new Date().toISOString() };

const json = (r: Route, body: unknown, status = 200) =>
  r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const sichtbar = (eintraege: unknown[]) => ({ eintraege, teilansicht: { sichtbar: eintraege.length, gesamt: eintraege.length } });

function entitaet(id: string, entityType: string, role: string, channels: string[]) {
  return {
    id, entityType, typeLabel: entityType, role, label: null, control: false, deviceId: BOX.id,
    capabilities: { measure: channels.map((channel) => ({ channel })) }, guards: null, syncStatus: 'synced',
    observed: null, edgeSourceId: null,
  };
}

const TOPOLOGIE = {
  schemaVersion: '1.0',
  entities: [
    { id: 'e-pv', entityType: 'producer', typeLabel: 'PV', label: null, category: 'producer', health: 'ok',
      capabilities: [{ channel: 'pv_power_kw', unit: 'kW', role: 'pv', primary: true, value: 4.2 }] },
    { id: 'e-batt', entityType: 'battery-hybrid', typeLabel: 'Speicher', label: null, category: 'storage', health: 'ok',
      capabilities: [{ channel: 'soc_pct', unit: '%', role: 'storage', primary: true, value: 60 }] },
    { id: 'e-grid', entityType: 'grid-meter', typeLabel: 'Netzanschluss', label: null, category: 'meter', health: 'ok',
      capabilities: [{ channel: 'power_kw', unit: 'kW', role: 'grid', primary: true, value: -2.1 }] },
  ],
  topology: {
    schema_version: '1.0',
    nodes: [
      { role: 'pv', value_kw: 4.2, flow_active: true, direction: 'out', members: [{ entity_id: 'e-pv', label: 'PV', primary: true, value_kw: 4.2 }] },
      { role: 'storage', value_kw: 1.2, soc_pct: 60, flow_active: true, direction: 'in', members: [{ entity_id: 'e-batt', label: 'Speicher', primary: true, value_kw: 1.2 }] },
      { role: 'grid', value_kw: 2.1, flow_active: true, direction: 'out', members: [{ entity_id: 'e-grid', label: 'Netz', primary: true, value_kw: -2.1 }] },
    ],
  },
};

const PROFIL = {
  usageProfile: 'private', derivedProfile: 'private', override: null,
  emphasis: { money: 'normal', peak: 'hidden', flow: 'prominent', devices: 'normal' },
  signals: { hasStorage: true, hasPv: true, hasControllableConsumer: false, activeStrategyNodeTypes: [], plantKind: 'eigenverbrauch', hasLeistungspreis: false },
};

const ZEILE = {
  id: ANLAGE.id, name: ANLAGE.name, plantKind: 'eigenverbrauch', netzladenErlaubt: true, batteryWithoutDevice: false,
  deviceCount: 1, onlineCount: 1, waitingCount: 0, worstStatus: 'online', lastSeenAt: new Date().toISOString(),
  live: { ts: new Date().toISOString(), pvKw: 4.2, loadKw: 1.1, gridKw: -2.1, socPct: 60 },
  plannedSavingsTodayEur: null,
};

/** Verdrahtet die Cloud; `/overview` antwortet erst, wenn der Fall `frei()` ruft (oder nach `MESSUNG` ms). */
async function verdrahte(page: Page) {
  let frei = () => {};
  const tor = new Promise<void>((r) => { frei = r; });
  await page.route((url) => url.hostname !== '127.0.0.1' && url.hostname !== 'localhost', (r) => r.abort());
  await page.route('**/api/v1/**', (r) => {
    const leer = /\/(sites|devices|components|entities|candidates|runs|releases|assets)(\?|$)/.test(r.request().url());
    if (!leer && r.request().method() === 'GET') return json(r, { message: 'Not found' }, 404);
    return r.fulfill({ status: 200, contentType: 'application/json', body: leer ? '[]' : '{}' });
  });
  await page.route('**/api/v1/me', (r) => json(r, {
    kennung: 'e2e', name: 'Alex Beispiel', konto: 'benutzer', zustand: 'aktiv', kundenbereich: { id: 't-1', name: 'Demo' },
    zugang: 'konto', rollen: ['kundenadministrator'], unternehmensweit: true, standorte: [], unternehmen_rechte: ['anlage.verwalten'],
    kuenftig: [], text: null, teilansicht: null, unterstuetzungen: { eigene: [], gewaehrte: [] }, kundenadministratoren: [],
  }));
  await page.route('**/api/v1/tenant-context', (r) => json(r, { tenantId: 't-1', name: 'Demo', segment: 'B2C', betriebsart: 'endkunde' }));
  await page.route('**/api/v1/funktionen', (r) => json(r, {
    unternehmen: { messen: { laeuft_an: 0, standorte: 0, text: null }, steuern: { laeuft_an: 0, standorte: 0, text: null } }, standorte: [],
  }));
  await page.route('**/api/v1/standorte', (r) => json(r, { message: 'nicht da' }, 404));
  await page.route('**/api/v1/unternehmen', (r) => json(r, { message: 'nicht da' }, 404));
  await page.route('**/api/v1/sites', (r) => json(r, sichtbar([ANLAGE])));
  await page.route('**/api/v1/devices', (r) => json(r, sichtbar([BOX])));
  const s = `**/api/v1/sites/${ANLAGE.id}`;
  await page.route(`${s}/entities`, (r) => json(r, {
    registry: null, localSetup: [], staleOnDevice: [],
    entities: [
      entitaet('e-pv', 'producer', 'pv', ['pv_power_kw']),
      entitaet('e-batt', 'battery-hybrid', 'storage', ['soc_pct']),
      entitaet('e-grid', 'grid-meter', 'grid', ['power_kw']),
    ],
  }));
  await page.route(`${s}/topology`, (r) => json(r, TOPOLOGIE));
  await page.route(`${s}/profile`, (r) => json(r, PROFIL));
  await page.route(`${s}/profiles`, (r) => json(r, { profiles: [] }));
  await page.route(`${s}/schedule`, (r) => json(r, {
    planId: null, deviceId: null, generatedAt: null, slotMinutes: 15, savingsEur: null, bankedValueEur: null,
    socStartPct: null, socEndPct: null, peakTargetKw: null, slots: [],
  }));
  await page.route('**/api/v1/overview', async (r) => {
    if (MESSUNG != null) await new Promise((res) => setTimeout(res, MESSUNG));
    else await tor;
    await json(r, {
      sites: [{ ...ZEILE, lastSeenAt: new Date().toISOString(), live: { ...ZEILE.live, ts: new Date().toISOString() } }],
      totals: { sites: 1, devices: 1, online: 1, plannedSavingsTodayEur: null, liveSitesCovered: 1 },
      dailySavings: [],
    });
  });
  return frei;
}

/** Schreibt Zeitmarken und Layout-Verschiebungen der Seite mit (ab dem ersten Dokument). */
async function messe(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __m: { marken: Record<string, number>; shifts: { t: number; v: number; q: string[] }[] } };
    w.__m = { marken: {}, shifts: [] };
    const marke = (name: string) => { if (w.__m.marken[name] == null) w.__m.marken[name] = performance.now(); };
    const abgleich = () => {
      if (document.querySelector('.vp-cockpit-stack')) marke('stapel');
      if (document.querySelector('.vp-hero-flow')) marke('uebersichtsteile');
      if (document.querySelector('.vp-loader-screen')) marke('vorhangDa');
      else if (w.__m.marken.vorhangDa != null) marke('vorhangWeg');
    };
    new MutationObserver(abgleich).observe(document, { childList: true, subtree: true, attributes: true });
    new PerformanceObserver((liste) => {
      for (const e of liste.getEntries() as unknown as {
        value: number; hadRecentInput: boolean; startTime: number;
        sources?: { node?: Element; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[];
      }[]) {
        if (e.hadRecentInput) continue;
        const q = (e.sources ?? []).map((x) => `${(x.node as HTMLElement | undefined)?.className?.toString().split(' ').slice(0, 2).join('.') ?? x.node?.nodeName}:${Math.round(x.previousRect.y)}->${Math.round(x.currentRect.y)}/${Math.round(x.previousRect.height)}->${Math.round(x.currentRect.height)}`);
        w.__m.shifts.push({ t: e.startTime, v: e.value, q });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
}

const lies = (page: Page) =>
  page.evaluate(() => (window as unknown as { __m: { marken: Record<string, number>; shifts: { t: number; v: number; q: string[] }[] } }).__m);

async function bild(page: Page, name: string, breite: number) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  await page.screenshot({ path: join(BILDER, `${name}-${breite}.png`) });
}

for (const breite of [390, 1440]) {
  test(`Landung · ${breite} px: Vorhang und Stapel fallen vor /overview, das Eintreffen rückt nichts`, async ({ page }) => {
    await page.setViewportSize({ width: breite, height: breite < 720 ? 844 : 900 });
    const frei = await verdrahte(page);
    await messe(page);
    await page.goto('/e2e/boot-flow.html');

    if (MESSUNG != null) {
      await expect(page.locator('.vp-hero-flow')).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(800);
      const m = await lies(page);
      console.log(`LANDUNG_MESSUNG ${JSON.stringify({ breite, overviewMs: MESSUNG, ...m.marken, shiftSumme: m.shifts.reduce((a, s) => a + s.v, 0) })}`);
      return;
    }

    // Die Übersicht ist angehalten: Vorhang und Stapel stehen trotzdem.
    await expect(page.locator('.vp-cockpit-stack')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.vp-loader-screen')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('.vp-hero-flow')).toHaveCount(0);
    // Die Teile der Zeile halten ihren Platz, behaupten aber nichts.
    await expect(page.locator('.vp-cockpit-stack .vp-skeleton').first()).toBeVisible();
    await expect(page.locator('.vp-anlage-sentence')).toHaveCount(0);
    await expect(page.locator('.vp-anlage-pending')).toHaveCount(0);
    await expect(page.getByText(/Noch keine Anlage|nicht zugeordnet/)).toHaveCount(0);
    await page.waitForTimeout(400);
    await bild(page, 'uebersicht-haengt', breite);
    const vorher = await lies(page);
    const hoehen = () => page.evaluate(() => {
      const h = (sel: string) => Math.round(document.querySelector(sel)?.getBoundingClientRect().height ?? -1);
      return {
        buehne: h('.vp-cockpit-stack > .vp-skeleton, .vp-cockpit-stack > .vp-cockpit-hero'),
        zustand: h('.vp-cockpit-health'),
        stapel: h('.vp-cockpit-stack'),
        kinder: [...(document.querySelector('.vp-cockpit-stack')?.children ?? [])].map(
          (el) => `${(el.className || el.tagName).toString().split(' ')[0]}:${Math.round(el.getBoundingClientRect().height)}`,
        ),
      };
    });
    const hoeheVorher = await hoehen();

    frei();
    await expect(page.locator('.vp-hero-flow')).toBeVisible();
    await expect(page.locator('.vp-cockpit-stack .vp-skeleton')).toHaveCount(0, { timeout: 5_000 });
    await page.waitForTimeout(600);
    await bild(page, 'uebersicht-da', breite);
    const nachher = await lies(page);

    // Das Eintreffen der Zeile verschiebt wenig: Summe der Verschiebungen NACH dem Stapelbild. Am Telefon steht sie
    // bei 0; am Rechner bleibt ein Rest (~0,02), weil die Bühne beim Nachladen ihrer Stücke kurz niedriger steht
    // (Fallback der Unter-Stücke). Die Schwelle liegt unter der Hälfte der „guten“ Marke (0,1) von Core Web Vitals.
    const stapelT = nachher.marken.stapel ?? 0;
    const danach = nachher.shifts.filter((x) => x.t > Math.max(stapelT, vorher.shifts.at(-1)?.t ?? 0)).reduce((a, x) => a + x.v, 0);
    console.log(`LANDUNG_HOEHEN ${JSON.stringify({ breite, vorher: hoeheVorher, nachher: await hoehen() })}`);
    console.log(`LANDUNG_SHIFT ${JSON.stringify({ breite, danach, alle: nachher.shifts })}`);
    expect(danach, 'Layout-Verschiebung beim Eintreffen der Übersichts-Zeile').toBeLessThan(0.05);
  });
}
