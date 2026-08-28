import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SiteTopology, TopologyEntity } from './api';
import type { ConsumerRuntimeStatus } from './consumers/status';
import type { ChargePoint } from './ladepunkte';
import type { FlowMember } from './topology';
import {
  gruppeFuerTyp,
  kwText,
  verbrauchKomposition,
  type VerbrauchKomposition,
} from './verbrauchKomposition';

// ---------------------------------------------------------------------------
// Bausteine
// ---------------------------------------------------------------------------

function entity(over: Partial<TopologyEntity> & { id: string }): TopologyEntity {
  return {
    id: over.id,
    entityType: over.entityType ?? 'generic-load',
    typeLabel: over.typeLabel ?? 'Steuerbare Last',
    label: over.label ?? null,
    category: over.category ?? 'consumer',
    health: over.health ?? 'ok',
    capabilities: over.capabilities ?? [],
  };
}

function topo(members: FlowMember[], entities: TopologyEntity[]): SiteTopology {
  return {
    schemaVersion: '1.0',
    entities,
    topology: {
      schema_version: '1.0',
      nodes: [
        { role: 'consumer', flow_active: true, direction: 'out', members },
      ],
    },
  };
}

function charger(over: Partial<ChargePoint> & { chargePointId: string }): ChargePoint {
  return {
    deviceId: 'dev-1',
    chargePointId: over.chargePointId,
    label: over.label ?? null,
    priority: over.priority ?? false,
    connected: over.connected ?? true,
    ready: over.ready ?? true,
    lastSeen: over.lastSeen ?? '2026-08-28T08:50:00Z',
    entityId: over.entityId ?? null,
    reportedAt: over.reportedAt ?? '2026-08-28T09:41:00Z',
    connectors: over.connectors ?? [],
  };
}

/**
 * Die Anlage des Konzept-Mockups (§4.1): Wallbox 11,0 kW (über die Säule
 * gemessen) + Heizstab 1,9 kW + übriger Haushalt 1,2 kW = Haus 14,1 kW.
 *
 * ⚠ Das Mockup nennt als Haus-Summe 12,2 kW - seine eigenen Teile ergeben
 * aber 14,1 (der Balken dort zeigt 110/19/12). Hier steht die SELBST-
 * KONSISTENTE Zahl: dieses Modul RECHNET den Rest, es bekommt ihn nicht
 * gesagt, und ein Test auf einer Summe, die nicht aufgeht, prüfte nichts.
 */
const HAUS: FlowMember = { entity_id: 'haus', label: 'Hausverbrauch', primary: true, value_kw: 14.1 };
const HEIZSTAB: FlowMember = { entity_id: 'rod', label: 'Heizstab Warmwasser', primary: false, value_kw: 1.9 };
const ENTITIES = [
  entity({ id: 'haus', entityType: 'house-load', typeLabel: 'Hausverbrauch' }),
  entity({ id: 'rod', entityType: 'heating-rod', typeLabel: 'Heizstab' }),
];
const WALLBOX = charger({
  chargePointId: 'GARAGE-1',
  label: 'Wallbox Garage',
  connectors: [
    {
      connectorId: 1,
      status: 'Charging',
      charging: true,
      powerKw: 11.0,
      sessionSince: '2026-08-28T12:10:00Z',
    },
  ],
});

function k(over: Partial<Parameters<typeof verbrauchKomposition>[0]> = {}): VerbrauchKomposition {
  return verbrauchKomposition({
    topology: topo([HAUS, HEIZSTAB], ENTITIES),
    chargers: [WALLBOX],
    ...over,
  })!;
}

// ---------------------------------------------------------------------------

describe('verbrauchKomposition · das Haus bleibt die Summe', () => {
  it('schlüsselt die Anlage des Konzepts auf', () => {
    const c = k();
    expect(c.hausKw).toBe(14.1);
    expect(c.verbraucherCount).toBe(2);
    expect(c.gruppen.map((g) => g.id)).toEqual(['laden', 'waerme']);
    expect(c.gruppen[0].headline).toBe('1 von 1 lädt · 11,0 kW');
    expect(c.gruppen[1].kw).toBe(1.9);
    expect(c.rest.kw).toBeCloseTo(1.2, 9);
    expect(c.rest.note).toBeNull();
  });

  it('der Haus-Wert wird NICHT um die Teile verkleinert - er bleibt die Summe', () => {
    // Die Captain-Regel: Hausverbrauch = alles hinter dem Anschluss, inklusive
    // Wallbox. Wer das dreht, lässt Board-Zeile und Fluss zwei Zahlen sagen.
    const c = k();
    expect(c.hausKw).toBe(14.1);
    const gemessen = (c.rest.kw ?? 0) + 11.0 + 1.9;
    expect(gemessen).toBeCloseTo(c.hausKw!, 9);
  });

  it('nennt den Halbsatz der Board-Zeile nur, WÄHREND geladen wird', () => {
    expect(k().subLine).toBe('davon Laden 11,0 kW');
    // Steht das Auto nur da, wird nichts behauptet.
    const ruht = k({
      chargers: [charger({
        chargePointId: 'GARAGE-1',
        connectors: [{ connectorId: 1, status: 'SuspendedEVSE', charging: true, allocatedKw: 0 }],
      })],
    });
    expect(ruht.subLine).toBeNull();
    expect(ruht.ladenKw).toBeNull();
  });

  it('erklärt nichts, wo es nichts zu erklären gibt', () => {
    // Kein Verbraucher ausser dem Haus selbst ⇒ keine Aufschlüsselung, also
    // auch kein Chevron an der Zeile (die `pvComposition`-Disziplin).
    expect(verbrauchKomposition({ topology: topo([HAUS], ENTITIES) })).toBeNull();
    expect(verbrauchKomposition({ topology: null })).toBeNull();
  });
});

describe('verbrauchKomposition · der Rest ist eine Differenz, kein Gerät', () => {
  it('ein LADENDER Stecker ohne Messwert macht den Rest unbestimmbar', () => {
    // Die Rest-Regel: nie eine Zahl, die die Lücke des Nachbarn enthält.
    const c = k({
      chargers: [charger({
        chargePointId: 'GARAGE-1',
        label: 'Wallbox Garage',
        connectors: [{ connectorId: 1, status: 'Charging', charging: true, powerKw: null }],
      })],
    });
    expect(c.rest.kw).toBeNull();
    expect(c.rest.note).toBe('nicht bestimmbar (Wallbox Garage ohne Leistungsmessung)');
    // …und der Halbsatz behauptet auch keine kW.
    expect(c.subLine).toBeNull();
  });

  it('ein RUHENDER Verbraucher ohne Messwert blockiert den Rest NICHT', () => {
    // Was aus ist, zieht nichts - es fehlt also nichts in der Summe.
    const c = k({
      topology: topo([HAUS, HEIZSTAB, { entity_id: 'pumpe', label: 'Wasserpumpe', primary: false }], [
        ...ENTITIES,
        entity({ id: 'pumpe', entityType: 'pump', typeLabel: 'Pumpe' }),
      ]),
      consumerStatus: [{ entityId: 'pumpe', state: 'ready', reportedAt: '2026-08-28T09:41:00Z' }],
    });
    expect(c.rest.kw).toBeCloseTo(1.2, 9);
  });

  it('ein LAUFENDER Verbraucher ohne Messwert blockiert ihn sehr wohl', () => {
    const c = k({
      topology: topo([HAUS, HEIZSTAB, { entity_id: 'wp', label: 'Wärmepumpe', primary: false }], [
        ...ENTITIES,
        entity({ id: 'wp', entityType: 'heat-pump', typeLabel: 'Wärmepumpe' }),
      ]),
      consumerStatus: [
        { entityId: 'wp', state: 'running_optimized', reportedAt: '2026-08-28T09:41:00Z' },
      ],
    });
    expect(c.rest.kw).toBeNull();
    expect(c.rest.note).toBe('nicht bestimmbar (Wärmepumpe ohne Leistungsmessung)');
  });

  it('ein VERALTETER Messwert blockiert ihn ebenfalls, mit eigenem Grund', () => {
    const c = k({
      topology: topo([HAUS, HEIZSTAB], [
        ENTITIES[0],
        entity({ id: 'rod', entityType: 'heating-rod', typeLabel: 'Heizstab', health: 'stale' }),
      ]),
    });
    expect(c.rest.kw).toBeNull();
    expect(c.rest.note).toBe('nicht bestimmbar (Heizstab Warmwasser meldet sich gerade nicht)');
  });

  it('ohne Haus-Wert wird kein Rest erfunden', () => {
    const c = k({
      topology: topo([{ ...HAUS, value_kw: undefined }, HEIZSTAB], ENTITIES),
    });
    expect(c.hausKw).toBeNull();
    expect(c.rest.kw).toBeNull();
    expect(c.rest.note).toContain('nicht bestimmbar');
  });

  it('ein negativer Rest wird GESAGT, nie auf 0 geklemmt', () => {
    // Zwei Zähler widersprechen sich - eine 0 wäre eine erfundene Einigkeit.
    const c = k({ topology: topo([{ ...HAUS, value_kw: 5.0 }, HEIZSTAB], ENTITIES) });
    expect(c.rest.kw).toBeNull();
    expect(c.rest.konflikt).toBe(true);
    expect(c.rest.note).toBe('Messwerte passen nicht zusammen (-7,9 kW)');
  });

  it('eine Rundungs-Differenz unter der Schwelle ist KEIN Widerspruch', () => {
    const c = k({ topology: topo([{ ...HAUS, value_kw: 12.85 }, HEIZSTAB], ENTITIES) });
    expect(c.rest.konflikt).toBe(false);
    expect(c.rest.kw).toBe(0);
  });
});

describe('verbrauchKomposition · Gruppen, Sortierung, Kollaps (E4/E6)', () => {
  it('ordnet die drei Gruppen und kennt keinen geratenen Typ', () => {
    expect(gruppeFuerTyp('ev-charger')).toBe('laden');
    expect(gruppeFuerTyp('wallbox')).toBe('laden');
    expect(gruppeFuerTyp('heating-rod')).toBe('waerme');
    expect(gruppeFuerTyp('heat-pump')).toBe('waerme');
    expect(gruppeFuerTyp('pump')).toBe('sonstiges');
    // Ein Typ, den dieser Stand nicht kennt, wird nicht verschwiegen.
    expect(gruppeFuerTyp('was-auch-immer')).toBe('sonstiges');
    expect(gruppeFuerTyp(null)).toBe('sonstiges');
  });

  it('sortiert Aktive zuerst nach Leistung, Ruhende alphabetisch darunter', () => {
    const members: FlowMember[] = [
      HAUS,
      { entity_id: 'a', label: 'Zwei kW', primary: false, value_kw: 2 },
      { entity_id: 'b', label: 'Acht kW', primary: false, value_kw: 8 },
      { entity_id: 'c', label: 'Zoo aus', primary: false, value_kw: 0 },
      { entity_id: 'd', label: 'Alpha aus', primary: false, value_kw: 0 },
    ];
    const ents = [ENTITIES[0], ...['a', 'b', 'c', 'd'].map((id) => entity({ id, entityType: 'pump' }))];
    const c = verbrauchKomposition({ topology: topo(members, ents) })!;
    expect(c.gruppen[0].teile.map((t) => t.label)).toEqual([
      'Acht kW', 'Zwei kW', 'Alpha aus', 'Zoo aus',
    ]);
  });

  it('E4: die Laden-Gruppe kollabiert, sobald die Kachel sichtbar ist', () => {
    const offen = k({ ladenKachelSichtbar: false });
    expect(offen.gruppen[0].collapsed).toBe(false);
    expect(offen.gruppen[0].teile).toHaveLength(1);

    const zu = k({ ladenKachelSichtbar: true });
    expect(zu.gruppen[0].collapsed).toBe(true);
    expect(zu.gruppen[0].teile).toHaveLength(0);
    expect(zu.gruppen[0].collapsedText).toBe('1 Ladepunkt');
    // Die SUMME bleibt - kollabiert heisst zusammengefasst, nicht verschwunden.
    expect(zu.gruppen[0].kw).toBe(11.0);
    expect(zu.gruppen[0].headline).toBe('1 von 1 lädt · 11,0 kW');
    // …und der Rest rechnet unverändert mit ihr.
    expect(zu.rest.kw).toBeCloseTo(1.2, 9);
  });

  it('zählt bei mehreren Säulen richtig und nennt die Stecker beim Namen', () => {
    const c = verbrauchKomposition({
      topology: topo([HAUS], ENTITIES),
      chargers: [
        charger({
          chargePointId: 'P1',
          label: 'Stellplatz 1',
          connectors: [
            { connectorId: 1, status: 'Charging', charging: true, powerKw: 11 },
            { connectorId: 2, status: 'Available', charging: false },
          ],
        }),
        charger({
          chargePointId: 'P2',
          label: 'Stellplatz 2',
          connectors: [{ connectorId: 1, status: 'Charging', charging: true, powerKw: 11 }],
        }),
      ],
    })!;
    expect(c.gruppen[0].headline).toBe('2 von 3 laden · 22,0 kW');
    expect(c.ladenKw).toBe(22);
    expect(c.ladepunktCount).toBe(2);
    // Mehrere Stecker an EINER Säule tragen ihren Stecker-Namen, eine
    // einzelne Säule nicht - sonst stünde „Stecker A" ohne Alternative da.
    expect(c.gruppen[0].teile.map((t) => t.label)).toEqual([
      'Stellplatz 1 · Stecker A', 'Stellplatz 2', 'Stellplatz 1 · Stecker B',
    ]);
  });
});

describe('verbrauchKomposition · nicht messbar ist nie 0', () => {
  it('gibt einem Ladepunkt ohne Messwert ein WORT statt einer Zahl', () => {
    const c = k({
      chargers: [charger({
        chargePointId: 'G',
        label: 'Wallbox',
        connectors: [{ connectorId: 1, status: 'Charging', charging: true, powerKw: null }],
      })],
      ladenKachelSichtbar: false,
    });
    const teil = c.gruppen[0].teile[0];
    expect(teil.kw).toBeNull();
    expect(teil.word).toBe('Lädt — Leistung nicht messbar');
    expect(teil.aktiv).toBe(true);
  });

  it('reicht den Grund der Box durch, ohne ihn neu zu formulieren', () => {
    const c = k({
      chargers: [charger({
        chargePointId: 'G',
        connectors: [{
          connectorId: 1,
          status: 'SuspendedEVSE',
          charging: true,
          allocatedKw: 0,
          reasonText: 'kein Überschuss (Ihre Priorität: Nur Sonnenstrom)',
          sessionSince: '2026-08-28T12:10:00Z',
        }],
      })],
      ladenKachelSichtbar: false,
    });
    const teil = c.gruppen[0].teile[0];
    expect(teil.word).toBe('Eingesteckt · wartet');
    expect(teil.note).toContain('kein Überschuss (Ihre Priorität: Nur Sonnenstrom)');
    expect(teil.note).toContain('seit ');
  });

  it('sagt bei einem Gerät ohne Messung nur seinen Zustand', () => {
    const c = verbrauchKomposition({
      topology: topo([HAUS, { entity_id: 'wp', label: 'Wärmepumpe', primary: false }], [
        ENTITIES[0],
        entity({ id: 'wp', entityType: 'heat-pump', typeLabel: 'Wärmepumpe' }),
      ]),
      consumerStatus: [
        { entityId: 'wp', state: 'running_optimized', reportedAt: '2026-08-28T09:41:00Z' },
      ],
    })!;
    const teil = c.gruppen[0].teile[0];
    expect(teil.kw).toBeNull();
    expect(teil.word).toBe('Läuft · von VoltPilot geplant');
    expect(teil.note).toBe('ohne Leistungsmessung');
  });

  it('eine getrennte Säule zeigt NIE aktuelle Werte', () => {
    const c = verbrauchKomposition({
      topology: topo([HAUS], ENTITIES),
      chargers: [charger({
        chargePointId: 'G',
        label: 'Stellplatz 6',
        connected: false,
        lastSeen: '2026-08-28T06:50:00Z',
        connectors: [{ connectorId: 1, status: 'Charging', charging: true, powerKw: 11 }],
      })],
    })!;
    const teil = c.gruppen[0].teile[0];
    expect(teil.word).toBe('Säule getrennt');
    expect(teil.kw).toBeNull();
    expect(teil.health).toBe('stale');
    expect(c.ladenKw).toBeNull();
  });

  it('eine Säule ohne gemeldeten Stecker behauptet kein „kein Auto"', () => {
    const c = verbrauchKomposition({
      topology: topo([HAUS], ENTITIES),
      chargers: [charger({ chargePointId: 'NEU', connectors: [] })],
    })!;
    expect(c.gruppen[0].teile[0].word).toBe('Noch kein Stecker gemeldet');
    expect(c.gruppen[0].headline).toBe('noch kein Stecker gemeldet');
  });
});

describe('verbrauchKomposition · Heute-kWh und Bezugszeit', () => {
  it('rechnet den Rest des Tages nur, wenn JEDE Tagessumme vorliegt', () => {
    const voll = k({
      hausTodayKwh: 38.9,
      todayKwh: { 'cp:GARAGE-1#1': 12.4, 'e:rod': 4.3 },
    });
    expect(voll.rest.todayKwh).toBeCloseTo(22.2, 9);
    // Fehlt EINE, wird nichts behauptet.
    const halb = k({ hausTodayKwh: 38.9, todayKwh: { 'cp:GARAGE-1#1': 12.4 } });
    expect(halb.rest.todayKwh).toBeNull();
    // Ohne Haus-Tagessumme erst recht nicht.
    expect(k({ todayKwh: { 'cp:GARAGE-1#1': 12.4, 'e:rod': 4.3 } }).rest.todayKwh).toBeNull();
  });

  it('trägt den jüngsten Bezugszeitpunkt - und erfindet keinen', () => {
    expect(k().asOf).toBe('2026-08-28T09:41:00Z');
    expect(k({ chargers: [] }).asOf).toBeNull();
  });

  it('schreibt Leistungen in der Haus-Schreibweise', () => {
    expect(kwText(11)).toBe('11,0 kW');
    expect(kwText(0.05)).toBe('0,1 kW');
  });
});

describe('verbrauchKomposition · keine Zeile zweimal', () => {
  it('ein Ladepunkt, den die Topologie schon führt, wird nicht doppelt gezählt', () => {
    // Sonst stünde er als Komponente UND als Stecker in der Summe - und der
    // Rest wäre um seine Leistung zu klein.
    const c = verbrauchKomposition({
      topology: topo([{ ...HAUS, value_kw: 12.2 }, { entity_id: 'cp-e', label: 'Wallbox Garage', primary: false, value_kw: 11 }], [
        ENTITIES[0],
        entity({ id: 'cp-e', entityType: 'ev-charger', typeLabel: 'Ladepunkt' }),
      ]),
      chargers: [charger({
        chargePointId: 'GARAGE-1',
        label: 'Wallbox Garage',
        entityId: 'cp-e',
        connectors: [{ connectorId: 1, status: 'Charging', charging: true, powerKw: 11 }],
      })],
    })!;
    expect(c.verbraucherCount).toBe(1);
    expect(c.rest.kw).toBeCloseTo(1.2, 9);
  });
});

// ---------------------------------------------------------------------------
// Sim-Abgleich (Konzept `vp-verbraucher-cockpit-k1` §8 Schritt 8, Entscheid E7)
// ---------------------------------------------------------------------------

describe('Sim-Abgleich: die Zustandswörter UND der Rest-Wert an den Rig-Formen', () => {
  /**
   * Dieselben geteilten Vektoren, die `ladepunkte.test.ts` fährt und die das
   * Rig (`edge-app/test/e2e-ocpp.sh` L13) am ECHTEN Simulator erzeugt. Hier
   * geht es um die ZWEITE Hälfte der Abnahme: was die Aufschlüsselung aus
   * genau diesen Steckern macht - Wort je Zeile UND der Rest.
   */
  const V: {
    faelle: {
      name: string; portal: Record<string, unknown>;
      punkt?: { connected: boolean; lastSeen?: string }; wort: string;
    }[];
  } = JSON.parse(
    readFileSync(
      resolve(process.cwd(), '../../docs/contracts/ocpp-ladezustand-vectors.json'),
      'utf8',
    ),
  );
  const fall = (name: string) => V.faelle.find((f) => f.name === name)!;

  it('jede Ladepunkt-Zeile trägt das Wort der Vektoren', () => {
    // Eine Säule je Fall - so steht jedes Wort einmal in einer echten Zeile.
    const chargers = V.faelle.map((f, i) =>
      charger({
        chargePointId: `CP${i}`,
        connected: f.punkt?.connected ?? true,
        lastSeen: f.punkt?.lastSeen ?? '2026-08-28T09:41:00Z',
        connectors: [f.portal as never],
      }),
    );
    const k = verbrauchKomposition({
      topology: topo([HAUS], ENTITIES),
      chargers,
      consumerStatus: null,
      hausTodayKwh: null,
      links: {},
    })!;
    const woerter = k.gruppen.flatMap((g) => g.teile).map((t) => t.word);
    for (const f of V.faelle) expect(woerter).toContain(f.wort);
  });

  it('der REST ist Haus − Σ gemessene Teile', () => {
    // Haus 14,1 kW, gemessene Ladung 11,0 kW → übriger Haushalt 3,1 kW.
    const k = verbrauchKomposition({
      topology: topo([HAUS], ENTITIES),
      chargers: [charger({ chargePointId: 'CP-A', connectors: [fall('laedt').portal as never] })],
      consumerStatus: null,
      hausTodayKwh: null,
      links: {},
    })!;
    expect(k.rest.kw).toBeCloseTo(14.1 - 11, 6);
    expect(k.rest.konflikt).toBe(false);
    expect(k.rest.note).toBeNull();
  });

  it('⚠ ein LADENDER Stecker ohne Leistungsmessung macht den Rest unbestimmbar - und SAGT warum', () => {
    // Er gehört in die Summe und entzieht sich ihr: eine Rest-Zahl, die seine
    // Lücke enthielte, wäre schlimmer als keine. Genau die Rig-Form
    // `laedt_ohne_messung` prüft das an einer echten Simulator-Zeile.
    const k = verbrauchKomposition({
      topology: topo([HAUS], ENTITIES),
      chargers: [
        charger({ chargePointId: 'CP-A', connectors: [fall('laedt').portal as never] }),
        charger({ chargePointId: 'CP-B', connectors: [fall('laedt_ohne_messung').portal as never] }),
      ],
      consumerStatus: null,
      hausTodayKwh: null,
      links: {},
    })!;
    expect(k.rest.kw).toBeNull();
    expect(k.rest.note).toContain('ohne Leistungsmessung');
    expect(k.rest.konflikt).toBe(false);
  });

  it('⚠ eine GETRENNTE Säule zieht nichts vom Rest ab - über sie wissen wir nichts', () => {
    const getrennt = fall('getrennt');
    const k = verbrauchKomposition({
      topology: topo([HAUS], ENTITIES),
      chargers: [
        charger({ chargePointId: 'CP-A', connectors: [fall('laedt').portal as never] }),
        charger({
          chargePointId: 'CP-X',
          connected: false,
          lastSeen: getrennt.punkt!.lastSeen!,
          // ⚠ Ihr letzter gemeldeter Stecker sagte „Charging 11,0 kW" - und
          // trotzdem darf diese Leistung nicht mehr vom Haus abgezogen werden.
          connectors: [getrennt.portal as never],
        }),
      ],
      consumerStatus: null,
      hausTodayKwh: null,
      links: {},
    })!;
    expect(k.rest.kw).toBeCloseTo(14.1 - 11, 6);
  });
});

describe('Cockpit Phase 1 · eine veraltete Ladeleistung geht in keine Summe ein', () => {
  const JETZT = Date.parse('2026-08-28T12:30:00Z');

  const mitStempel = (meteredAt: string | null) =>
    k({
      chargers: [
        charger({
          chargePointId: 'GARAGE-1',
          label: 'Wallbox Garage',
          connectors: [
            {
              connectorId: 1,
              status: 'Charging',
              charging: true,
              powerKw: 11.0,
              meteredAt,
              sessionSince: '2026-08-28T12:10:00Z',
            } as never,
          ],
        }),
      ],
      nowMs: JETZT,
    });

  it('zieht eine FRISCHE Ladeleistung wie bisher in die Aufschlüsselung', () => {
    const c = mitStempel('2026-08-28T12:29:00Z');
    const teil = c.gruppen.flatMap((g) => g.teile).find((t) => t.key.startsWith('cp:'))!;
    expect(teil.kw).toBe(11);
    expect(teil.aktiv).toBe(true);
  });

  // ⚠ Der Kern der Regel: die Zeile bleibt AKTIV (der Rest wird dadurch
  // ehrlich unbestimmbar), aber die stehengebliebene Zahl geht NICHT in die
  // Summe - sonst zöge sie den „übrigen Haushalt" um Kilowatt herunter, die
  // seit einer halben Stunde nicht mehr fliessen.
  it('lässt eine VERALTETE Ladeleistung aus der Summe und benennt die Lücke', () => {
    const c = mitStempel('2026-08-28T11:40:00Z');
    const teil = c.gruppen.flatMap((g) => g.teile).find((t) => t.key.startsWith('cp:'))!;
    expect(teil.kw).toBeNull();
    expect(teil.aktiv).toBe(true);
    expect(teil.note ?? '').toContain('Leistung veraltet');
  });

  it('ist OHNE Stempel byte-identisch zum Vor-Phase-1-Verhalten', () => {
    const ohne = mitStempel(null);
    const teil = ohne.gruppen.flatMap((g) => g.teile).find((t) => t.key.startsWith('cp:'))!;
    expect(teil.kw).toBe(11);
    expect(teil.note ?? '').not.toContain('veraltet');
  });
});

describe('Cockpit Phase 1 · die Heute-kWh eines Ladepunkts dürfen aus der Entität kommen', () => {
  const MIT_ENTITAET = charger({
    chargePointId: 'GARAGE-1',
    label: 'Wallbox Garage',
    entityId: 'cp-ent',
    connectors: [
      { connectorId: 1, status: 'Charging', charging: true, powerKw: 11.0 } as never,
    ],
  });

  it('nimmt den Register-Zuwachs JE STECKER, wo es einen gibt', () => {
    const c = k({
      chargers: [MIT_ENTITAET],
      todayKwh: { 'cp:GARAGE-1#1': 12.5, 'e:cp-ent': 99 },
    });
    const teil = c.gruppen.flatMap((g) => g.teile).find((t) => t.key === 'cp:GARAGE-1#1')!;
    expect(teil.todayKwh).toBe(12.5);
  });

  it('fällt bei EINEM Stecker auf den Entitäts-Zähler der Säule zurück', () => {
    const c = k({ chargers: [MIT_ENTITAET], todayKwh: { 'e:cp-ent': 12.5 } });
    const teil = c.gruppen.flatMap((g) => g.teile).find((t) => t.key === 'cp:GARAGE-1#1')!;
    expect(teil.todayKwh).toBe(12.5);
  });

  // ⚠ Bei MEHREREN Steckern ist der Entitätswert die SUMME der Säule - ihn auf
  // einen Stecker zu schreiben wäre eine erfundene Aufteilung.
  it('schreibt die Säulen-Summe NIE auf einen von zwei Steckern', () => {
    const c = k({
      chargers: [
        {
          ...MIT_ENTITAET,
          connectors: [
            { connectorId: 1, status: 'Charging', charging: true, powerKw: 7 } as never,
            { connectorId: 2, status: 'Charging', charging: true, powerKw: 4 } as never,
          ],
        },
      ],
      todayKwh: { 'e:cp-ent': 12.5 },
    });
    for (const t of c.gruppen.flatMap((g) => g.teile).filter((x) => x.key.startsWith('cp:'))) {
      expect(t.todayKwh).toBeNull();
    }
  });
});
