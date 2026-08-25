import { describe, expect, it } from 'vitest';
import type { Consumer } from '../consumers/types';
import type { ConsumerRuntimeStatus } from '../consumers/status';
import { buildGuidedFlow, type GuidedRule } from '../flows/guidedBuilder';
import { applyDerivedClaims, type EditorEntity, type FlowDocument } from '../flows/model';
import {
  flowKarte,
  flowZustand,
  istGenerierteVerbraucherregel,
  RANK_AKTIV,
  RANK_ENTWURF,
  RANK_FEHLER,
  RANK_GREIFT,
  RANK_PAUSIERT,
  RANK_WARTET,
  regelKarten,
  rezeptKarte,
  rezeptZustand,
  sofortBanner,
  VERLAUF_NOCH_NICHT,
  type FlowRegelInput,
  type RezeptRegelInput,
} from './zustand';

const ENTITIES: EditorEntity[] = [
  { id: 'e-grid', entityType: 'grid-meter', label: 'Netzanschluss', measure: ['power_kw'], actuate: [] },
  { id: 'e-batt', entityType: 'battery-hybrid', label: 'Speicher', measure: ['soc_pct'], actuate: ['setpoint_kw'] },
  { id: 'e-wb', entityType: 'wallbox', label: 'Wallbox Garage', measure: ['power_kw'], actuate: ['on_off'] },
];

const REGEL: GuidedRule = {
  conditions: [
    { kind: 'entity', entityId: 'e-grid', channel: 'power_kw', direction: 'below', threshold: -3.5 },
  ],
  combinator: 'and',
  action: { kind: 'onoff', entityId: 'e-wb', ttlS: 300 },
};

function doc(): FlowDocument {
  return buildGuidedFlow(REGEL, 'Wallbox nur bei PV-Überschuss', 's-1');
}

function flow(over: Partial<FlowRegelInput> = {}): FlowRegelInput {
  return {
    flowId: 'f-1',
    name: 'Wallbox nur bei PV-Überschuss',
    activeVersion: 2,
    latestVersion: 2,
    latestLifecycle: 'active',
    latestDocument: doc(),
    ...over,
  };
}

function consumer(over: Partial<Consumer> = {}): Consumer {
  return {
    id: 'c-rod',
    type: 'heating-rod',
    typeLabel: 'Heizstab',
    name: 'Heizstab Keller',
    controlKind: 'on_off',
    ratedPowerKw: 4,
    minPowerKw: null,
    levelsKw: null,
    resolutionKw: null,
    powerRangesKw: null,
    storageRelation: 'consumer_first',
    defaultGridEnergyPolicy: 'allow',
    allowStorageDischarge: false,
    failsafe: 'off',
    enabled: true,
    version: 1,
    connection: 'connected',
    edgeSourceId: 'src-1',
    controlActivation: 'active',
    hasDraftPolicy: true,
    draftPolicyVersion: 1,
    ...over,
  };
}

function status(over: Partial<ConsumerRuntimeStatus> = {}): ConsumerRuntimeStatus {
  return {
    entityId: 'c-rod',
    state: 'running_optimized',
    reasonCode: null,
    actualKw: 4,
    confirmed: true,
    reportedAt: '2026-08-11T12:00:00Z',
    ...over,
  };
}

function rezept(over: Partial<RezeptRegelInput> = {}): RezeptRegelInput {
  return { consumer: consumer(), anyStatusReported: true, status: status(), ...over };
}

describe('Zustands-Vokabular einer Flow-Regel (5b.1)', () => {
  it('nennt Lebenszyklus UND Gerätestand, sobald etwas ausgerollt ist', () => {
    const z = flowZustand(flow({ ack: { flowId: 'f-1', flowVersion: 2, contentHash: null, state: 'active', detail: null, reportedAt: null } }));
    expect(z.lebenszyklus).toBe('Aktiv');
    expect(z.geraet?.label).toBe('Läuft auf dem Gerät · v2');
    expect(z.zeile).toBe('Aktiv · Läuft auf dem Gerät · v2');
    expect(z.rang).toBe(RANK_AKTIV);
  });

  it('behauptet OHNE Bestätigung nie „läuft" — sondern sagt, dass sie fehlt', () => {
    const z = flowZustand(flow({ ack: null }));
    expect(z.geraet?.label).toBe('Ausgerollt · v2');
    expect(z.geraet?.detail).toBe('Das Gerät hat den Empfang noch nicht bestätigt.');
  });

  it('ein meldendes Gerät mit Problem ist BERNSTEIN und trägt seinen Grund', () => {
    const z = flowZustand(flow({
      ack: {
        flowId: 'f-1', flowVersion: 2, contentHash: null,
        state: 'error', detail: 'Baustein 3 antwortet nicht.', reportedAt: null,
      },
    }));
    expect(z.ton).toBe('warn');
    expect(z.problem).toContain('Gerät meldet ein Problem');
    expect(z.problem).toContain('Baustein 3 antwortet nicht.');
    expect(z.rang).toBe(RANK_WARTET);
  });

  it('ein Entwurf trägt gar keinen Gerätestand', () => {
    const z = flowZustand(flow({ activeVersion: null, latestLifecycle: 'draft' }));
    expect(z.lebenszyklus).toBe('Entwurf');
    expect(z.geraet).toBeNull();
    expect(z.rang).toBe(RANK_ENTWURF);
  });

  it('eine stillgelegte Regel liest sich als „Pausiert" und sortiert nach hinten', () => {
    const z = flowZustand(flow({ activeVersion: null, latestLifecycle: 'retired' }));
    expect(z.lebenszyklus).toBe('Pausiert');
    expect(z.rang).toBe(RANK_PAUSIERT);
  });
});

describe('Komponenten-Chips + Fehler-Ehrlichkeit', () => {
  it('nennt die beanspruchten Komponenten beim Namen', () => {
    const karte = flowKarte(flow(), ENTITIES);
    expect(karte.chips.map((c) => c.label)).toEqual(['Wallbox Garage']);
  });

  it('eine Regel, deren Komponente entfernt wurde, bleibt SICHTBAR und rot', () => {
    const karte = flowKarte(flow(), [ENTITIES[0], ENTITIES[1]]);
    // Der Chip benennt die Lücke mit seinem EIGENEN Wort - die Zustands-Zeile
    // trägt das Urteil, zweimal dieselbe Zeichenkette wäre Rauschen.
    expect(karte.chips[0].label).toBe('Entfernte Komponente');
    expect(karte.zustand.ton).toBe('error');
    expect(karte.zustand.problem).toBe('Komponente wurde entfernt');
    expect(karte.zustand.rang).toBe(RANK_FEHLER);
  });

  it('der Vorrang-Einzeiler ist nach der beanspruchten Sache getrennt (Stufe 2)', () => {
    const speicherRegel: GuidedRule = {
      conditions: REGEL.conditions,
      combinator: 'and',
      action: { kind: 'setpoint', entityId: 'e-batt', value: 5, ttlS: 300 },
    };
    const mit = flowKarte(
      flow({ latestDocument: buildGuidedFlow(speicherRegel, 'Speicher', 's-1') }),
      ENTITIES,
    );
    // Speicher: heute gewinnt der Fahrplan — das sagt die Zeile auch.
    expect(mit.hinweis).toContain('Fahrplan vor Regel');
    // Gerät: die Regel geht wirklich vor.
    const geraet = flowKarte(flow(), ENTITIES).hinweis;
    expect(geraet).toContain('Regel vor Fahrplan');
    expect(geraet).not.toContain('Fahrplan vor Regel');
  });

  it('unterscheidet Baukasten- von Editor-Regel und behauptet bei letzterer nichts', () => {
    expect(flowKarte(flow(), ENTITIES).art).toBe('baukasten');
    const reicher = applyDerivedClaims({
      ...doc(),
      nodes: [...doc().nodes, { id: 'extra', type: 'vp.logic.and', type_version: '1.0.0' }],
    });
    const editor = flowKarte(flow({ latestDocument: reicher }), ENTITIES);
    expect(editor.art).toBe('editor');
    expect(editor.satz).toBeNull();
    expect(editor.ersatz).toContain('Bausteine');
  });
});

describe('Zustands-Vokabular einer Rezept-Regel', () => {
  it('spricht Lebenszyklus und Betrieb in EINER Zeile aus', () => {
    const z = rezeptZustand(rezept());
    expect(z.zeile).toBe('Aktiv · Läuft · von VoltPilot geplant');
    expect(z.rang).toBe(RANK_GREIFT);
    expect(z.ton).toBe('ok');
  });

  it('OHNE Beleg behauptet sie NICHTS über den Betrieb', () => {
    const z = rezeptZustand(rezept({ anyStatusReported: false, status: null }));
    expect(z.betrieb).toBeNull();
    expect(z.problem).toBeNull();
    expect(z.zeile).toBe('Aktiv');
  });

  it('„wartet" trägt IMMER seinen Grund und steht vor der ruhig aktiven Regel', () => {
    const z = rezeptZustand(rezept({
      status: status({ state: 'waiting', reasonCode: 'guard_min_off' }),
    }));
    expect(z.zeile).toContain('Wartet auf passenden Zeitpunkt');
    expect(z.rang).toBe(RANK_WARTET);
  });

  it('eine Begrenzung ist eine SCHUTZ-Aussage: bernstein, nie rot', () => {
    const z = rezeptZustand(rezept({
      status: status({ state: 'clamped', reasonCode: 'guard_grid_limit' }),
    }));
    expect(z.ton).toBe('warn');
    expect(z.problem).toContain('Durch Netzvorgabe begrenzt');
  });

  it('eine laufende Sofortaktion hat Vorrang — und die Regel sagt das', () => {
    const spaeter = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const z = rezeptZustand(rezept({
      override: { entityId: 'c-rod', kind: 'start', targetCommand: 'on_off', endsAt: spaeter },
    }));
    expect(z.problem).toBe('wartet — Sofortaktion hat Vorrang');
    expect(z.rang).toBe(RANK_WARTET);
  });

  it('„Pausiert" sagt WÖRTLICH dazu, dass das Gerät seinem Failsafe folgt', () => {
    const z = rezeptZustand(rezept({ consumer: consumer({ controlActivation: 'paused' }) }));
    expect(z.zeile).toContain('das Gerät folgt seinem Failsafe');
    expect(z.rang).toBe(RANK_PAUSIERT);
  });

  it('eine NICHT aktive Regel spricht keinen Betrieb aus — der gehört dem Gerät', () => {
    // Dieselbe laufende Meldung, einmal aktiv, einmal pausiert: nur die aktive
    // Regel darf „greift gerade" behaupten.
    expect(rezeptZustand(rezept()).betrieb).not.toBeNull();
    const pausiert = rezeptZustand(rezept({
      consumer: consumer({ controlActivation: 'paused' }),
    }));
    expect(pausiert.betrieb).toBeNull();
    expect(pausiert.rang).toBe(RANK_PAUSIERT);
    const entwurf = rezeptZustand(rezept({
      consumer: consumer({ controlActivation: 'not_activated' }),
    }));
    expect(entwurf.betrieb).toBeNull();
    expect(entwurf.rang).toBe(RANK_ENTWURF);
  });

  it('ein unbekanntes Zustandswort wird nicht geraten', () => {
    const z = rezeptZustand(rezept({ status: status({ state: 'was_neues' }) }));
    expect(z.betrieb).toBeNull();
    expect(z.zeile).toBe('Aktiv');
  });

  it('ein Grund, der den Zustand nur wiederholt, wird NICHT zweimal gesagt', () => {
    const z = rezeptZustand(rezept({
      status: status({ state: 'offline', reasonCode: 'device_offline' }),
    }));
    expect(z.zeile).toBe('Aktiv · Gerät meldet sich nicht');
  });

  it('der Nachweis-Chip erscheint nur mit Aufgaben und tönt ehrlich', () => {
    const ohne = rezeptKarte(rezept());
    expect(ohne.chips).toHaveLength(1);
    const mit = rezeptKarte(rezept({
      fulfilment: {
        tasks: [{
          requirementId: 'r-1', periodStart: 'a', deadline: 'b',
          state: 'missed', atRisk: false,
        }],
      },
    }));
    expect(mit.chips[1].label).toBe('Heute: 1 Aufgabe nicht erreicht');
    expect(mit.chips[1].ton).toBe('warn');

    // Grün heisst ERFÜLLT: eine laufende Aufgabe bekommt den ruhigen Chip.
    const laeuft = rezeptKarte(rezept({
      fulfilment: { tasks: [
        { requirementId: 'a', periodStart: '', deadline: '', state: 'running', atRisk: false },
        { requirementId: 'b', periodStart: '', deadline: '', state: 'fulfilled', atRisk: false },
      ] },
    }));
    expect(laeuft.chips[1].ton).toBe('plain');
    const fertig = rezeptKarte(rezept({
      fulfilment: { tasks: [
        { requirementId: 'a', periodStart: '', deadline: '', state: 'fulfilled', atRisk: false },
      ] },
    }));
    expect(fertig.chips[1].ton).toBe('ok');
  });
});

describe('Die Liste: Aufmerksamkeit zuerst (5b.2)', () => {
  it('sortiert Fehler → wartet → greift → ruhig aktiv → Entwurf → pausiert', () => {
    const karten = regelKarten({
      entities: ENTITIES,
      flows: [
        flow({ flowId: 'f-ruhig', name: 'D Ruhig', ack: { flowId: 'f-ruhig', flowVersion: 2, contentHash: null, state: 'active', detail: null, reportedAt: null } }),
        flow({ flowId: 'f-entwurf', name: 'E Entwurf', activeVersion: null, latestLifecycle: 'draft' }),
        flow({ flowId: 'f-fehler', name: 'A Fehler', latestDocument: buildGuidedFlow({ ...REGEL, action: { kind: 'onoff', entityId: 'weg', ttlS: 300 } }, 'x', 's-1') }),
      ],
      rezepte: [
        rezept({ consumer: consumer({ id: 'c-p', name: 'F Pausiert', controlActivation: 'paused' }), status: null }),
        rezept({ consumer: consumer({ id: 'c-w', name: 'B Wartet' }), status: status({ entityId: 'c-w', state: 'waiting', reasonCode: 'guard_min_off' }) }),
        rezept({ consumer: consumer({ id: 'c-g', name: 'C Greift' }), status: status({ entityId: 'c-g' }) }),
      ],
    });
    expect(karten.map((k) => k.name)).toEqual([
      'A Fehler', 'B Wartet', 'C Greift', 'D Ruhig', 'E Entwurf', 'F Pausiert',
    ]);
  });

  it('sortiert innerhalb desselben Rangs alphabetisch statt eine Reihenfolge zu erfinden', () => {
    const karten = regelKarten({
      entities: ENTITIES,
      flows: [flow({ flowId: 'f-b', name: 'Zebra' }), flow({ flowId: 'f-a', name: 'Ampel' })],
      rezepte: [],
    });
    expect(karten.map((k) => k.name)).toEqual(['Ampel', 'Zebra']);
  });
});

describe('Ehrlichkeit der Fläche', () => {
  it('der Verlauf wird in dieser Stufe NICHT behauptet — und sagt das', () => {
    expect(VERLAUF_NOCH_NICHT).toMatch(/noch nicht aufgezeichnet/);
    expect(VERLAUF_NOCH_NICHT).not.toMatch(/\d/);
  });

  it('keine Karte trägt einen erfundenen Schaltzähler', () => {
    const k = flowKarte(flow(), ENTITIES);
    const text = JSON.stringify(k);
    expect(text).not.toMatch(/× geschaltet/);
    expect(text).not.toMatch(/zuletzt \d\d:/);
  });

  it('erkennt die generierte Verbraucherregel am Server-Stempel, nie geraten', () => {
    expect(istGenerierteVerbraucherregel({
      ...doc(),
      origin: { kind: 'consumer-policy', policy_id: 'p', policy_version: 1, entity_id: 'c-rod' },
    })).toBe(true);
    expect(istGenerierteVerbraucherregel(doc())).toBe(false);
    expect(istGenerierteVerbraucherregel(null)).toBe(false);
  });

  it('der Sofortaktions-Banner nennt das Gerät und endet mit dem Eingriff', () => {
    const spaeter = new Date(Date.now() + 90 * 60 * 1000).toISOString();
    const b = sofortBanner(
      [{ entityId: 'c-rod', kind: 'start', targetCommand: 'on_off', endsAt: spaeter }],
      { 'c-rod': 'Heizstab Keller' },
    );
    expect(b?.text).toContain('Heizstab Keller');
    expect(b?.hinweis).toContain('endet von selbst');
    // Ein abgelaufener Eingriff ist kein Eingriff mehr.
    expect(sofortBanner(
      [{ entityId: 'c-rod', kind: 'start', targetCommand: 'on_off', endsAt: '2020-01-01T00:00:00Z' }],
      {},
    )).toBeNull();
    expect(sofortBanner([], {})).toBeNull();
  });
});

describe('Stufe 5b · das Regel-Protokoll an der Karte', () => {
  const WALLBOX_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

  function protokollFuer(rules: Array<{
    ruleKind: 'rezept' | 'flow'; ruleRef: string;
    switchedToday: number | null; lastSwitchedAt: string | null;
  }>) {
    return {
      recordingSince: '2026-08-10T08:00:00Z',
      accuracySeconds: 15,
      countsToday: true,
      rules,
      events: [],
    };
  }

  it('traegt die Zaehler-Zeile an die Karte, die der Server belegt hat', () => {
    const karten = regelKarten({
      flows: [flow({ flowId: 'f1', name: 'Wallbox nur bei PV' })],
      rezepte: [],
      entities: [],
      protokoll: protokollFuer([{
        ruleKind: 'flow', ruleRef: 'f1', switchedToday: 3,
        lastSwitchedAt: new Date(2026, 7, 11, 14, 2).toISOString(),
      }]),
    });
    expect(karten[0].aktivitaet).toBe('heute 3\u00d7 geschaltet \u00b7 zuletzt 14:02');
  });

  it('OHNE Protokoll bleibt die Karte zeichengleich zu Stufe 5a', () => {
    const karten = regelKarten({
      flows: [flow({ flowId: 'f1', name: 'Regel' })],
      rezepte: [],
      entities: [],
    });
    expect(karten[0].aktivitaet).toBeNull();
  });

  it('eine Regel ohne Ereignis nennt die BELEGTE 0, wenn der Tag zaehlbar ist', () => {
    const karten = regelKarten({
      flows: [flow({ flowId: 'f1', name: 'Regel' })],
      rezepte: [],
      entities: [],
      // Der Server hat fuer eine ANDERE Regel gezaehlt, fuer diese nicht.
      protokoll: protokollFuer([{
        ruleKind: 'flow', ruleRef: 'andere', switchedToday: 5, lastSwitchedAt: null,
      }]),
    });
    // Der Server sagt: der heutige Tag ist zaehlbar. Dann ist die 0 belegt.
    expect(karten[0].aktivitaet).toBe('heute noch nicht geschaltet');
  });

  it('ist der Tag NICHT zaehlbar, nennt sie den Beginn statt einer 0', () => {
    const karten = regelKarten({
      flows: [flow({ flowId: 'f1', name: 'Regel' })],
      rezepte: [],
      entities: [],
      protokoll: {
        recordingSince: new Date(2026, 7, 11, 10, 0).toISOString(),
        accuracySeconds: 15,
        countsToday: false,
        rules: [],
        events: [],
      },
    });
    expect(karten[0].aktivitaet).toBe('seit 10:00 aufgezeichnet');
    expect(karten[0].aktivitaet).not.toContain('geschaltet');
  });

  it('sortiert innerhalb desselben Rangs den ZULETZT geschalteten zuerst', () => {
    const alt = new Date(2026, 7, 11, 9, 0).toISOString();
    const neu = new Date(2026, 7, 11, 14, 0).toISOString();
    const karten = regelKarten({
      flows: [
        flow({ flowId: 'f-a', name: 'Anton' }),
        flow({ flowId: 'f-z', name: 'Zacharias' }),
      ],
      rezepte: [],
      entities: [],
      protokoll: protokollFuer([
        { ruleKind: 'flow', ruleRef: 'f-a', switchedToday: 1, lastSwitchedAt: alt },
        { ruleKind: 'flow', ruleRef: 'f-z', switchedToday: 1, lastSwitchedAt: neu },
      ]),
    });
    // Alphabetisch waere Anton zuerst - der Beleg dreht es um.
    expect(karten.map((k) => k.name)).toEqual(['Zacharias', 'Anton']);
  });

  it('ohne Beleg auf BEIDEN Seiten bleibt es alphabetisch', () => {
    const karten = regelKarten({
      flows: [
        flow({ flowId: 'f-z', name: 'Zacharias' }),
        flow({ flowId: 'f-a', name: 'Anton' }),
      ],
      rezepte: [],
      entities: [],
      protokoll: protokollFuer([
        { ruleKind: 'flow', ruleRef: 'f-a', switchedToday: 1, lastSwitchedAt: null },
      ]),
    });
    expect(karten.map((k) => k.name)).toEqual(['Anton', 'Zacharias']);
  });
});
