import { describe, expect, it } from 'vitest';
import type { SiteTopology, TopologyCapability, TopologyEntity } from './api';
import { verlaufRangeForCockpit, widgetTarget } from './verlaufTarget';

/**
 * V2 — „Eine Kachel ist ein Absprung" (`data/vp-portal-livedata-design/report.md`
 * §1 + §4). Der Kachel→Ziel-Mapper wird hier erschöpfend festgenagelt: die
 * Fluss-Kacheln über DIESELBE Rollen-Auflösung wie die Topologie (maßgeblich
 * zuerst, sonst erste ihrer Rolle), die Geld-/Modus-Kacheln per Tabelle, plus
 * der ehrliche Fallback ohne Read-Model und die Zeitraum-Übernahme.
 */

function cap(
  channel: string,
  role: string,
  value: number | null,
  primary = false,
): TopologyCapability {
  return { channel, unit: null, role, primary, value };
}

function ent(id: string, entityType: string, category: string, caps: TopologyCapability[]): TopologyEntity {
  return { id, entityType, typeLabel: entityType, label: null, category, health: 'ok', capabilities: caps };
}

function topo(entities: TopologyEntity[]): SiteTopology {
  return { schemaVersion: '1.0', entities, topology: { schema_version: '1.0', nodes: [] } };
}

/** Die Pilot-Anlage: ein Hybrid (Speicher + PV + Haus komponiert) + Netzzähler. */
const PILOT = topo([
  ent('e-batt', 'battery-hybrid', 'storage', [
    cap('soc_pct', 'storage', 76, true),
    cap('battery_power_kw', 'storage', 1.4),
    cap('pv_power_kw', 'pv', 5.4, true),
  ]),
  ent('e-grid', 'grid-meter', 'meter', [cap('power_kw', 'grid', -2.1, true)]),
  ent('e-haus', 'house-load', 'consumer', [cap('power_kw', 'consumer', 1.9)]),
]);

describe('widgetTarget — Fluss-Kacheln lösen über die Topologie auf', () => {
  it('bildet jede Fluss-Kachel auf ihren maßgeblichen Messwert ab', () => {
    expect(widgetTarget('erzeugung', PILOT)).toEqual({
      kind: 'verlauf',
      entityId: 'e-batt',
      channel: 'pv_power_kw',
    });
    expect(widgetTarget('speicher', PILOT)).toEqual({
      kind: 'verlauf',
      entityId: 'e-batt',
      channel: 'soc_pct',
    });
    expect(widgetTarget('haus', PILOT)).toEqual({
      kind: 'verlauf',
      entityId: 'e-haus',
      channel: 'power_kw',
    });
    expect(widgetTarget('netz', PILOT)).toEqual({
      kind: 'verlauf',
      entityId: 'e-grid',
      channel: 'power_kw',
    });
  });

  it('Multi-Erzeuger: die Erzeugung-Kachel nimmt die MASSGEBLICHE PV-Komponente', () => {
    // Ein separater Erzeuger PLUS der Hybrid; der Hybrid trägt die maßgebliche
    // (summierende) PV-Messung → die Kachel springt genau dorthin. Die übrigen
    // erreicht der Kunde über die Explorer-Rail.
    const multi = topo([
      ent('e-pv2', 'producer', 'producer', [cap('pv_power_kw', 'pv', 9, false)]),
      ent('e-batt', 'battery-hybrid', 'storage', [
        cap('soc_pct', 'storage', 50, true),
        cap('pv_power_kw', 'pv', 5, true),
      ]),
    ]);
    expect(widgetTarget('erzeugung', multi)).toEqual({
      kind: 'verlauf',
      entityId: 'e-batt',
      channel: 'pv_power_kw',
    });
  });

  it('ohne maßgeblich-Markierung nimmt sie die ERSTE ihrer Rolle', () => {
    const noPrimary = topo([
      ent('e-a', 'producer', 'producer', [cap('pv_power_kw', 'pv', 3, false)]),
      ent('e-b', 'producer', 'producer', [cap('pv_power_kw', 'pv', 4, false)]),
    ]);
    expect(widgetTarget('erzeugung', noPrimary)).toEqual({
      kind: 'verlauf',
      entityId: 'e-a',
      channel: 'pv_power_kw',
    });
  });

  it('Netz nimmt den maßgeblichen Zähler, nicht den erstbesten', () => {
    const twoMeters = topo([
      ent('e-sub', 'grid-meter', 'meter', [cap('power_kw', 'grid', 1, false)]),
      ent('e-pcc', 'grid-meter', 'meter', [cap('power_kw', 'grid', 2, true)]),
    ]);
    expect(widgetTarget('netz', twoMeters)).toEqual({
      kind: 'verlauf',
      entityId: 'e-pcc',
      channel: 'power_kw',
    });
  });

  it('unterscheidet Haus (house-load) von einem Verbraucher (Wallbox) am Typ', () => {
    const withWallbox = topo([
      ent('e-wb', 'wallbox', 'consumer', [cap('power_kw', 'consumer', 7)]),
      ent('e-haus', 'house-load', 'consumer', [cap('power_kw', 'consumer', 1.9)]),
    ]);
    // „Haus" meint die Hauslast, nie die Wallbox — obwohl beide Rolle consumer sind.
    expect(widgetTarget('haus', withWallbox)).toEqual({
      kind: 'verlauf',
      entityId: 'e-haus',
      channel: 'power_kw',
    });
  });
});

describe('widgetTarget — Geld-/Modus-Kacheln bilden auf ihre Seite ab', () => {
  it('folgt der Abbildungstabelle (report §1)', () => {
    expect(widgetTarget('eigenverbrauch', PILOT)).toEqual({ kind: 'sub', sub: 'historie' });
    expect(widgetTarget('erloes', PILOT)).toEqual({ kind: 'sub', sub: 'historie' });
    expect(widgetTarget('handel', PILOT)).toEqual({ kind: 'sub', sub: 'fahrplan' });
    expect(widgetTarget('lastspitze', PILOT)).toEqual({ kind: 'sub', sub: 'lastspitzen' });
    expect(widgetTarget('automatik', PILOT)).toEqual({ kind: 'sub', sub: 'steuerung' });
    expect(widgetTarget('wetter', PILOT)).toEqual({ kind: 'sub', sub: 'wetter' });
  });
});

describe('widgetTarget — ehrlicher Fallback', () => {
  it('ohne Topologie springt eine Fluss-Kachel auf die Live-Daten-Seite', () => {
    for (const id of ['erzeugung', 'speicher', 'haus', 'netz'] as const) {
      expect(widgetTarget(id, null)).toEqual({ kind: 'sub', sub: 'live' });
    }
  });

  it('fehlt der Kanal in der Topologie, springt sie ebenfalls auf Live-Daten', () => {
    // Eine Topologie ohne PV-Messung: „Erzeugung" kann nicht auflösen.
    const noPv = topo([ent('e-grid', 'grid-meter', 'meter', [cap('power_kw', 'grid', 1, true)])]);
    expect(widgetTarget('erzeugung', noPv)).toEqual({ kind: 'sub', sub: 'live' });
    // Netz löst hier weiterhin auf.
    expect(widgetTarget('netz', noPv)).toEqual({
      kind: 'verlauf',
      entityId: 'e-grid',
      channel: 'power_kw',
    });
  });
});

describe('verlaufRangeForCockpit — Zeitraum-Übernahme', () => {
  it('Heute→Tag, Monat→Monat, Jahr→Jahr, Gesamt→Jahr', () => {
    expect(verlaufRangeForCockpit('day')).toBe('day');
    expect(verlaufRangeForCockpit('month')).toBe('month');
    expect(verlaufRangeForCockpit('year')).toBe('year');
    // Der Explorer hat keinen All-Zeit-Bereich → Gesamt landet auf Jahr.
    expect(verlaufRangeForCockpit('all')).toBe('year');
  });
});
