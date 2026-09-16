import type { Page } from '@playwright/test';
import { FAELLE, STAND, type Fall } from './summenwert-abnahme-faelle';

/** Zustand der API-Antworten. Die echte Rechnung/Transaktion wird separat im API-Test geprüft. */
export async function cloud(page: Page, fallName: Fall, vorhanden = false) {
  const f = FAELLE[fallName];
  const state = { angelegt: vorhanden, rolle: null as string | null, reads: 0, writes: [] as string[], body: null as any };
  const wert = { wert: f.wert, einheit: 'kW', stand: STAND, unvollstaendig: false, fehlende: [] };
  const messstelle = () => ({ id: 'summe', kennzeichen: 'MS-0042', name: f.name, art: 'berechnet', medium: 'Strom', lebenszyklus: 'aktiv', fehlt: [],
    hauptgroesse: { groesse: 'Wirkleistung', wertart: 'Momentanwert', einheit: 'kW', richtung: f.rolle === 'pv' ? 'Erzeugung' : f.rolle === 'consumer' ? 'Bezug' : 'richtungslos' } });
  const zugeordnet = () => ({ art: 'gesamtwert', quell_messstelle_id: 'summe', capability: null, name: f.name });
  const ids = [...new Set(f.register.map((r) => r.entityId))];
  await page.route('**/api/v1/**', async (route) => {
    const u = new URL(route.request().url()), p = u.pathname, method = route.request().method();
    if (method !== 'GET') state.writes.push(`${method} ${p}`);
    if (p.endsWith('/summenwerte')) return route.fulfill({ json: state.angelegt ? [{ messstelle: messstelle(), rolle: state.rolle, wert }] : [] });
    if (p.endsWith('/summenwert-quellen')) return route.fulfill({ json: ids.filter(id => !u.searchParams.has('geraetId') || fallName !== 'ahrenberg' || id === ids[0]).map((id) => ({ entityId: id, deviceId: 'box', name: f.register.find((r) => r.entityId === id)!.name, grund: null })) });
    if (p.endsWith('/measurement-selection/catalog')) {
      const points = f.register.filter((r) => r.entityId === u.searchParams.get('entityId')).map((r) => ({
        family: 'abnahme', pointKey: r.punkt, labelDe: r.label, group: 'Leistung', quantity: 'active_power', direction: r.direction,
        aggregationKind: 'gauge', unit: 'kW', selected: r.selected, available: true, defaultCadenceS: 5,
        decodedValue: r.selected ? String(r.wert) : null, lastReadAt: r.selected ? STAND : null,
        estimatedDataPerYearBytes: 400_000_000,
      }));
      return route.fulfill({ json: { points, total: points.length, offset: 0, limit: 250 } });
    }
    if (p.endsWith('/measurement-selection/lesen')) {
      state.reads++; return route.fulfill({ json: { wert: 2, einheit: 'kW', gelesen_am: STAND, grund: null } });
    }
    if (p.includes('/measurement-selection')) return route.fulfill({ json: { desiredRevision: 1 } });
    if (p.endsWith('/messstellen/berechnet') && method === 'POST') {
      state.body = route.request().postDataJSON(); state.angelegt = true; state.rolle = state.body.rolle?.role ?? null;
      return route.fulfill({ status: 201, json: messstelle() });
    }
    if (p.endsWith('/wert')) return route.fulfill({ json: wert });
    if (/\/rollen\/[^/]+$/.test(p)) {
      const role = p.split('/').pop()!;
      if (method === 'DELETE') { state.rolle = null; return route.fulfill({ json: { zugeordnet: null, abgeloest: zugeordnet() } }); }
      if (method === 'PUT') { state.rolle = role; return route.fulfill({ json: { geraete: ids.map((id) => ({ entity_id: id, role, zugeordnet: zugeordnet() })) } }); }
      if (p.includes('/komponenten/')) return route.fulfill({ json: { entity_id: ids[0], role, zugeordnet: state.rolle === role ? zugeordnet() : null } });
      return route.fulfill({ json: { role, wert: state.rolle === role ? f.wert : null, einheit: 'kW', stand: state.rolle === role ? STAND : null,
        zuordnung_vorhanden: state.rolle === role, unvollstaendig: false,
        geraete: state.rolle === role ? ids.map((entity_id) => ({ entity_id, name: f.register.find((r) => r.entityId === entity_id)!.name, art: 'gesamtwert', wert: f.wert, liefernd: true, grund: null })) : [] } });
    }
    if (p.endsWith('/aenderungen')) return route.fulfill({ json: { eintraege: [], zeitraum: {} } });
    return route.fulfill({ status: 404, json: { message: `Nicht gestellter Weg: ${p}` } });
  });
  return state;
}
