import { describe, expect, it } from 'vitest';
import type { RollenKanonischerWert, SiteTopology } from './api';
import { pvRolleView, teilSummeText, rollenView, rollenStand, cockpitRollenTopologie } from './pvRolle';

/**
 * vp-agg §2.4/B — die reine Ableitung der Cockpit-PV-Rolle. Sie entscheidet, ob das Cockpit ein
 * „berechnet"-Merkmal + Aufschlüsselung zeigt (Zuordnung vorhanden) oder stumm beim Rückfall
 * bleibt, und formt die ehrliche Teil-Summe „aus N von M Geräten" (ein stummes Gerät trägt keinen
 * Wert, nie eine 0).
 */

function wert(over: Partial<RollenKanonischerWert>): RollenKanonischerWert {
  return {
    role: 'pv',
    zuordnung_vorhanden: true,
    wert: null,
    einheit: 'kW',
    unvollstaendig: false,
    geraete: [],
    stand: null,
    ...over,
  };
}

describe('pvRolleView: Rückfall vs. kanonische Rolle', () => {
  it('gibt null ohne Wert (Rückfall telemetry.pv_power_kw, kein Merkmal)', () => {
    expect(pvRolleView(null)).toBeNull();
    expect(pvRolleView(undefined)).toBeNull();
  });

  it('gibt null, wenn keine Zuordnung existiert', () => {
    expect(pvRolleView(wert({ zuordnung_vorhanden: false }))).toBeNull();
  });

  it('führt jedes Gerät auf und summiert nur die liefernden', () => {
    const v = pvRolleView(
      wert({
        wert: 12.4,
        unvollstaendig: false,
        geraete: [
          { entity_id: 'a', name: '„PV gesamt"', art: 'gesamtwert', wert: 12.4, liefernd: true, grund: null },
        ],
      }),
    );
    expect(v).not.toBeNull();
    expect(v!.summe).toBe(12.4);
    expect(v!.beitragend).toBe(1);
    expect(v!.gesamt).toBe(1);
    expect(v!.unvollstaendig).toBe(false);
    expect(v!.zeilen[0]).toMatchObject({ name: '„PV gesamt"', kw: 12.4, liefernd: true });
  });

  it('benennt ein stummes Gerät und lässt seinen Wert null (nie 0)', () => {
    const v = pvRolleView(
      wert({
        wert: 15.5,
        unvollstaendig: true,
        geraete: [
          { entity_id: 'a', name: 'WR 1', art: 'messkanal', wert: 15.5, liefernd: true, grund: null },
          { entity_id: 'b', name: 'Mikrowechselrichter', art: 'messkanal', wert: null, liefernd: false, grund: 'veraltet' },
        ],
      }),
    );
    expect(v!.summe).toBe(15.5);
    expect(v!.beitragend).toBe(1);
    expect(v!.gesamt).toBe(2);
    expect(v!.unvollstaendig).toBe(true);
    const stumm = v!.zeilen.find((z) => !z.liefernd)!;
    expect(stumm.name).toBe('Mikrowechselrichter');
    expect(stumm.kw).toBeNull();
  });

  it('ersetzt einen leeren Gerätenamen durch „Gerät"', () => {
    const v = pvRolleView(
      wert({ geraete: [{ entity_id: 'a', name: '', art: 'messkanal', wert: 1, liefernd: true, grund: null }] }),
    );
    expect(v!.zeilen[0].name).toBe('Gerät');
  });
});

describe('teilSummeText: „aus N von M Geräten", nur wenn informativ', () => {
  it('nennt die Teil-Summe bei mehreren Geräten', () => {
    const v = pvRolleView(
      wert({
        unvollstaendig: true,
        geraete: [
          { entity_id: 'a', name: 'WR 1', art: 'messkanal', wert: 15.5, liefernd: true, grund: null },
          { entity_id: 'b', name: 'WR 2', art: 'messkanal', wert: 12, liefernd: true, grund: null },
          { entity_id: 'c', name: 'WR 3', art: 'messkanal', wert: null, liefernd: false, grund: 'kein_wert' },
        ],
      }),
    )!;
    expect(teilSummeText(v)).toBe('aus 2 von 3 Geräten');
  });

  it('schweigt bei einem einzelnen, liefernden Gerät', () => {
    const v = pvRolleView(
      wert({ wert: 8, geraete: [{ entity_id: 'a', name: 'WR', art: 'messkanal', wert: 8, liefernd: true, grund: null }] }),
    )!;
    expect(teilSummeText(v)).toBeNull();
  });

  it('nennt die Teil-Summe auch bei einem einzelnen, stummen Gerät', () => {
    const v = pvRolleView(
      wert({
        unvollstaendig: true,
        geraete: [{ entity_id: 'a', name: 'WR', art: 'messkanal', wert: null, liefernd: false, grund: 'veraltet' }],
      }),
    )!;
    expect(teilSummeText(v)).toBe('aus 0 von 1 Geräten');
  });
});

describe('H-3: alle drei Rollen bleiben Serverzahlen', () => {
  it.each(['pv', 'consumer', 'grid'])('%s: Rückfall, null, Stand und ein mehrfach zugeordneter Summenwert', (role) => {
    expect(rollenView(wert({ role, zuordnung_vorhanden: false }))).toBeNull();
    expect(rollenView(wert({ role, wert: null }))?.summe).toBeNull();
    const eingang = wert({ role, wert: -3.5, stand: '2026-09-16T10:15:00+02:00', geraete: ['a', 'b'].map(entity_id => ({
      entity_id, name: entity_id, art: 'gesamtwert', wert: -3.5, liefernd: true, grund: null,
    })) });
    const view = rollenView(eingang)!;
    expect(view.summe).toBe(-3.5); // niemals zwei Gerätebeiträge erneut addieren
    expect(view.zeilen).toHaveLength(2);
    expect(rollenStand(view.stand)).toBe('Stand 10:15 Uhr');
  });

  it('übernimmt nur zugeordnete Rollen in eine Kopie der Cockpit-Topologie', () => {
    const raw: SiteTopology = { schemaVersion: '1.0', entities: [], topology: { schema_version: '1.0', nodes: [
      { role: 'grid', value_kw: 99, flow_active: true, direction: 'in', members: [] },
      { role: 'storage', soc_pct: 63, flow_active: false, members: [] },
    ] } };
    expect(cockpitRollenTopologie(raw, [null, wert({ zuordnung_vorhanden: false })])).toBe(raw);
    const grid = wert({ role: 'grid', wert: -3.5, geraete: [{ entity_id: 'a', name: 'Netz', art: 'gesamtwert', wert: -3.5, liefernd: true, grund: null }] });
    const neu = cockpitRollenTopologie(raw, [grid])!;
    expect(neu.topology.nodes[0]).toMatchObject({ value_kw: 3.5, direction: 'out', flow_active: true });
    expect(neu.topology.nodes[1]).toBe(raw.topology.nodes[1]);
    expect(raw.topology.nodes[0].value_kw).toBe(99);
    const stumm = cockpitRollenTopologie(raw, [{ ...grid, wert: null }])!.topology.nodes[0];
    expect(stumm.value_kw).toBeUndefined();
    expect(stumm.direction).toBeUndefined();
    expect(stumm.flow_active).toBe(false);
  });

  it('erfindet keinen Stand', () => {
    expect(rollenStand(null)).toBe('Stand unbekannt');
    expect(rollenStand('kaputt')).toBe('Stand unbekannt');
  });
});
