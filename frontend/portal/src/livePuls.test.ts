import { describe, expect, it } from 'vitest';
import type { SiteTopology, TelemetryPoint, TopologyEntity } from './api';
import type { FlowNode } from './topology';
import {
  BOARD_HINT,
  componentRows,
  istHausZeile,
  v1FallbackRows,
  withVerbrauch,
  type LivePulsRow,
} from './livePuls';
import { NO_DATA } from './nodata';

/**
 * Das Komponenten-Board seit der EINEN Zeilen-Grammatik (vp-cockpit-unten-
 * ux-n3 PR 2): Werte/Zustandswörter kommen unverändert aus `deriveTiles`
 * bzw. den `live.ts`-Zuständen (keine Re-Derivation), NEU ist die Sortierung
 * der Nebentexte — Bestands-Notizen an den Namen, Detail-Zeilen an den
 * JETZT-Wert, die redundante Netz-Richtungs-Unterzeile entfällt — und dass
 * jede Zeile mit `today: null` startet (die Heute-Spalte füllt
 * `liveDetail.withDayTotals` aus BERICHTETEN Summen). Die Sparklines sind
 * ersatzlos entfallen (D4).
 */

/** fmtNum puts a non-breaking space before the unit. */
const NBSP = ' ';

// --- fixtures ----------------------------------------------------------------

function ent(
  id: string,
  entityType: string,
  channels: string[],
  health = 'ok',
): TopologyEntity {
  return {
    id,
    entityType,
    typeLabel: entityType,
    label: entityType,
    category: '',
    health,
    capabilities: channels.map((channel) => ({
      channel,
      unit: null,
      role: null,
      primary: false,
      value: null,
    })),
  };
}

const NODES: FlowNode[] = [
  {
    role: 'pv',
    value_kw: 6.4,
    flow_active: true,
    direction: 'in',
    members: [{ entity_id: 'pv', label: 'Fronius', primary: true, value_kw: 6.4 }],
  },
  {
    role: 'storage',
    value_kw: 2,
    soc_pct: 87,
    flow_active: true,
    direction: 'out',
    members: [{ entity_id: 'batt', label: 'Deye', primary: true, value_kw: 2 }],
  },
  {
    role: 'consumer',
    value_kw: 3.3,
    flow_active: true,
    direction: 'out',
    members: [{ entity_id: 'wb', label: 'Wallbox', primary: true, value_kw: 3.3 }],
  },
  {
    role: 'grid',
    value_kw: 1.2,
    flow_active: true,
    direction: 'in',
    members: [{ entity_id: 'grid', label: 'Netz', primary: true, value_kw: 1.2 }],
  },
];

const TOPO: SiteTopology = {
  schemaVersion: '1.0',
  entities: [
    ent('pv', 'producer', ['pv_power_kw']),
    ent('batt', 'battery-hybrid', ['soc_pct', 'battery_power_kw', 'pv_power_kw']),
    ent('wb', 'wallbox', ['power_kw'], 'stale'),
    ent('grid', 'grid-meter', ['power_kw']),
  ],
  topology: { schema_version: '1.0', nodes: NODES },
};

// --- componentRows -----------------------------------------------------------

describe('componentRows (v2, reusing the tile derivations)', () => {
  const rows = componentRows(TOPO);

  it('emits one row per component in role order: PV, Speicher, Verbraucher, Netz', () => {
    expect(rows.map((r) => r.role)).toEqual(['pv', 'storage', 'consumer', 'grid']);
  });

  it('carries the value + state word straight from deriveTiles (no re-derivation)', () => {
    const [pv, storage, wb, grid] = rows;
    expect(pv.value).toBe(`6,4${NBSP}kW`);
    expect(pv.stateLabel).toBe('erzeugt');
    expect(storage.value).toBe(`87${NBSP}%`);
    expect(storage.stateLabel).toBe('Lädt');
    expect(wb.value).toBe(`3,3${NBSP}kW`);
    expect(wb.stateLabel).toBe('lädt');
    expect(grid.stateLabel).toBe('Netzbezug');
  });

  it('resolves the „Verlauf"-Sprungziel to the representative channel', () => {
    expect(rows[0].target).toEqual({ entityId: 'pv', channel: 'pv_power_kw' });
    expect(rows[1].target).toEqual({ entityId: 'batt', channel: 'soc_pct' });
    expect(rows[2].target).toEqual({ entityId: 'wb', channel: 'power_kw' });
    expect(rows[3].target).toEqual({ entityId: 'grid', channel: 'power_kw' });
  });

  it('takes the component health (a stale entity → an amber dot)', () => {
    expect(rows[2].health).toBe('stale');
    expect(rows[0].health).toBe('ok');
  });

  it('jede Zeile startet ohne Heute-Spalte — die füllt erst withDayTotals', () => {
    expect(rows.every((r) => r.today === null)).toBe(true);
  });

  it('die Grammatik sortiert die Nebentexte: Detail bleibt an der JETZT-Zeile', () => {
    const [, storage, , grid] = rows;
    // Speicher-Detail („Ladeleistung X") bleibt subLine der Wert-Zeile.
    expect(storage.subLine).toMatch(/^Ladeleistung/);
    expect(storage.titleNote).toBeUndefined();
    // Die Netz-Richtungs-Unterzeile („aus dem Netz") entfällt — das
    // Zustandswort („Netzbezug") sagt es bereits.
    expect(grid.subLine).toBeUndefined();
  });

  it('collapses a multi-producer PV role to ONE row with the count as titleNote', () => {
    const topo: SiteTopology = {
      ...TOPO,
      entities: [
        ...TOPO.entities,
        ent('pv2', 'producer', ['pv_power_kw']),
      ],
      topology: {
        schema_version: '1.0',
        nodes: [
          {
            role: 'pv',
            value_kw: 9.1,
            flow_active: true,
            direction: 'in',
            members: [
              { entity_id: 'pv', label: 'Fronius', primary: true, value_kw: 5.85 },
              { entity_id: 'pv2', label: 'Deye', primary: false, value_kw: 3.25 },
            ],
          },
          ...NODES.slice(1),
        ],
      },
    };
    const [pvRow] = componentRows(topo);
    // Der Bestand steht NEBEN dem Namen, nie als Zustands-Unterzeile.
    expect(pvRow.titleNote).toBe('2 Erzeuger');
    expect(pvRow.subLine).toBeUndefined();
    // The primary member is the representative jump.
    expect(pvRow.target).toEqual({ entityId: 'pv', channel: 'pv_power_kw' });
  });

  it('resolves to an existing channel when the preferred one is absent', () => {
    // A grid meter that only measures grid_power_kw (not power_kw) still resolves.
    const topo: SiteTopology = {
      ...TOPO,
      entities: [ent('grid', 'grid-meter', ['grid_power_kw'])],
      topology: {
        schema_version: '1.0',
        nodes: [
          {
            role: 'grid',
            value_kw: 1,
            flow_active: true,
            direction: 'in',
            members: [{ entity_id: 'grid', label: 'Netz', primary: true, value_kw: 1 }],
          },
        ],
      },
    };
    expect(componentRows(topo)[0].target).toEqual({ entityId: 'grid', channel: 'grid_power_kw' });
  });
});

// --- v1 fallback rows --------------------------------------------------------

const pt = (over: Partial<TelemetryPoint>): TelemetryPoint => ({
  ts: '2026-07-06T10:00:00Z',
  powerKw: null,
  socPct: null,
  pvPowerKw: null,
  loadKw: null,
  gridLimitKw: null,
  ...over,
});

/**
 * P5d: die Speicher-Zeile des Cockpits trägt die HERKUNFT des Ladestands
 * durch - dieselbe Wahrheit wie Geräteseite und Fahrplan, aus demselben Kanal.
 */
describe('componentRows — die Herkunft des Ladestands (P5d)', () => {
  function mitHerkunft(code: number | null): SiteTopology {
    const batt = ent('batt', 'user-defined-battery', []);
    batt.capabilities = [
      { channel: 'soc_pct', unit: '%', role: 'storage', primary: true, value: 87 },
      { channel: 'soc_source_code', unit: '', role: null, primary: false, value: code },
    ];
    return {
      ...TOPO,
      entities: TOPO.entities.map((e) => (e.id === 'batt' ? batt : e)),
    };
  }

  it('reicht das Herkunfts-Wort an die Zeile durch', () => {
    const zeile = componentRows(mitHerkunft(2)).find((r) => r.role === 'storage')!;
    expect(zeile.herkunft).toBe('berechnet: Kennlinie');
    // Es ERSETZT nichts: Wert, Zustand und Detail bleiben, wie sie waren.
    expect(zeile.value).toBe(`87${NBSP}%`);
    expect(zeile.stateLabel).toBe('Lädt');
  });

  it('behauptet ohne den Kanal keine Herkunft', () => {
    expect(componentRows(TOPO).find((r) => r.role === 'storage')!.herkunft).toBeUndefined();
    expect(
      componentRows(mitHerkunft(null)).find((r) => r.role === 'storage')!.herkunft,
    ).toBeUndefined();
  });
});

describe('v1FallbackRows (site-level, reusing live.ts states)', () => {
  const rows = v1FallbackRows([pt({ pvPowerKw: 4.7, loadKw: 1.1, powerKw: -2.4, socPct: 76 })]);

  it('emits the four site-level rows deep-linking into the v1 explorer tree', () => {
    expect(rows.map((r) => r.target)).toEqual([
      { entityId: 'anlage', channel: 'pv' },
      { entityId: 'anlage', channel: 'soc' },
      { entityId: 'anlage', channel: 'haus' },
      { entityId: 'anlage', channel: 'netz' },
    ]);
  });

  it('speaks direction words + carries derived charge power, never signs', () => {
    const [pv, storage, haus, netz] = rows;
    expect(pv.stateLabel).toBe('erzeugt');
    expect(storage.stateLabel).toBe('Lädt');
    expect(storage.subLine).toMatch(/^Ladeleistung/);
    expect(storage.socPct).toBe(76);
    expect(haus.stateLabel).toBe('aktueller Bedarf');
    // grid -2.4 → export → Einspeisung, value shown as a positive magnitude.
    expect(netz.stateLabel).toBe('Einspeisung');
    expect(netz.value).not.toMatch(/-/);
    // Auch v1: die Heute-Spalte startet leer und wird nur BERICHTET gefüllt.
    expect(rows.every((r) => r.today === null)).toBe(true);
  });

  it('keeps an absent value as „—", never a fabricated 0 — and never „keine Batterie"', () => {
    const [, storage] = v1FallbackRows([pt({ pvPowerKw: 0 })]);
    // X1: EIN Zeichen für „kein Wert" auf allen Cockpit-/Board-Flächen.
    expect(storage.value).toBe(NO_DATA);
    // V1 (Audit): ein fehlender Ladestand ist „noch keine Daten" - die Anlage
    // HAT eine Batterie, sie meldet nur gerade nichts.
    expect(storage.stateLabel).toBe('noch keine Daten');
    // H2: und der Punkt behauptet dann kein „liefert Daten".
    expect(storage.health).toBe('unknown');
  });
});

// --- V6 (Audit), fortgeschrieben: der Sprung bleibt im Rollen-Kanal ----------

describe('componentRows — V6: a role row jumps to ITS channel only', () => {
  /** A hybrid whose capabilities carry real roles (as the API returns them). */
  function roledEnt(id: string, type: string, caps: [string, string][]): TopologyEntity {
    return {
      id,
      entityType: type,
      typeLabel: type,
      label: type,
      category: '',
      health: 'ok',
      capabilities: caps.map(([channel, role]) => ({
        channel,
        unit: null,
        role,
        primary: role === 'storage' ? channel === 'soc_pct' : true,
        value: null,
      })) as never,
    };
  }
  const hybrid = roledEnt('hy', 'battery-hybrid', [
    ['soc_pct', 'storage'],
    ['battery_power_kw', 'storage'],
    ['pv_power_kw', 'pv'],
  ]);
  const member = { entity_id: 'hy', label: 'Batteriespeicher', primary: true, value_kw: 5.9 };
  const topo: SiteTopology = {
    schemaVersion: '1.0',
    entities: [hybrid],
    topology: {
      schema_version: '1.0',
      nodes: [
        { role: 'pv', value_kw: 5.9, flow_active: true, direction: 'in', members: [member] },
        {
          role: 'storage',
          value_kw: 1.2,
          soc_pct: 87,
          flow_active: true,
          direction: 'out',
          members: [member],
        },
      ],
    },
  };

  it('die Erzeuger-Zeile springt in die PV-Leistung — nie in den Ladestand des Hybriden', () => {
    const [pv, storage] = componentRows(topo);
    expect(pv.target?.channel).toBe('pv_power_kw');
    // ... while the Speicher row keeps its own representative.
    expect(storage.target?.channel).toBe('soc_pct');
  });
});

// --- Kopfhinweis -------------------------------------------------------------

describe('BOARD_HINT — beide Zeitbezüge benannt, kein bedingtes Versprechen', () => {
  it('nennt „jetzt" und „heute" und die eine Interaktion', () => {
    expect(BOARD_HINT).toBe('Jetzt und heute · eine Zeile öffnet den Verlauf');
    // Das alte „letzte 60 Min"-Versprechen ist mit den Sparklines entfallen.
    expect(BOARD_HINT).not.toContain('60');
  });
});

// ---------------------------------------------------------------------------
// Die HAUS-Zeile und ihre Aufschlüsselung (`vp-verbraucher-cockpit-k1`)
// ---------------------------------------------------------------------------

describe('withVerbrauch · die Signale der Haus-Zeile ohne Klick', () => {
  const zeilen = (): LivePulsRow[] => [
    {
      key: 'pv', role: 'pv', icon: 'sun', title: 'PV-Erzeugung', value: '14,1 kW',
      stateLabel: 'liefert', stateTone: 'accent', health: 'ok', target: null, today: null,
    },
    {
      key: 'consumer-haus-0', role: 'consumer', icon: 'home', title: 'Hausverbrauch',
      value: '14,1 kW', stateLabel: 'verbraucht', stateTone: 'accent', health: 'ok',
      target: null, today: null,
    },
    {
      key: 'consumer-wb-1', role: 'consumer', icon: 'zap', title: 'Wallbox',
      value: '11,0 kW', stateLabel: 'lädt', stateTone: 'accent', health: 'ok',
      target: null, today: null,
    },
  ];

  it('setzt Bestands-Notiz und Halbsatz - und NUR an der Haus-Zeile', () => {
    const out = withVerbrauch(zeilen(), { verbraucherCount: 4, subLine: 'davon Laden 11,0 kW' });
    const haus = out.find((r) => r.title === 'Hausverbrauch')!;
    expect(haus.titleNote).toBe('4 Verbraucher');
    expect(haus.subLine).toBe('davon Laden 11,0 kW');
    // ⚠ Eine Wallbox darf die Zusammensetzung des Hauses NICHT erben.
    expect(out.find((r) => r.title === 'Wallbox')!.titleNote).toBeUndefined();
    expect(out.find((r) => r.role === 'pv')!.titleNote).toBeUndefined();
  });

  it('behauptet ohne ladenden Stecker keinen Halbsatz', () => {
    const out = withVerbrauch(zeilen(), { verbraucherCount: 2, subLine: null });
    const haus = out.find((r) => r.title === 'Hausverbrauch')!;
    expect(haus.titleNote).toBe('2 Verbraucher');
    expect(haus.subLine).toBeUndefined();
  });

  it('ohne Aufschlüsselung ist die Liste Zeichen für Zeichen dieselbe', () => {
    const vorher = zeilen();
    expect(withVerbrauch(vorher, null)).toEqual(vorher);
    expect(withVerbrauch(vorher, { verbraucherCount: 0, subLine: null })).toEqual(vorher);
  });

  it('istHausZeile meint auf BEIDEN Pfaden dieselbe Zeile', () => {
    // Ein Leser (die Heute-Spalte) und der andere (die Aufschlüsselung) dürfen
    // nie zwei verschiedene Zeilen für „das Haus" halten.
    expect(istHausZeile(zeilen()[1])).toBe(true);
    expect(istHausZeile(zeilen()[2])).toBe(false);
    expect(istHausZeile(zeilen()[0])).toBe(false);
    expect(
      istHausZeile({ ...zeilen()[1], key: 'v1-haus', title: 'Haus' }),
    ).toBe(true);
  });
});
