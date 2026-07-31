import { describe, expect, it } from 'vitest';
import type { FlowDocument } from './flows/model';
import {
  activeModes,
  type ActiveMode,
  type AnlageSurfaceInput,
  type ModeKind,
  type SurfaceEntity,
  type SurfaceFlow,
} from './surface';
import {
  ALL_SETTINGS,
  orphanedSettings,
  settingDef,
  settingsForMode,
  settingsPageSettings,
  SETTING_DEFS,
} from './modeSettings';

// ---------------------------------------------------------------------------
// Fixtures — genau die Modi, deren Container Einstellungen tragen
// ---------------------------------------------------------------------------

function entity(id: string, entityType: string, channels: string[]): SurfaceEntity {
  return { id, entityType, label: null, capabilities: { measure: channels.map((channel) => ({ channel })) } };
}
const BATTERY = entity('e-batt', 'battery-hybrid', ['soc_pct', 'battery_power_kw']);
const PRODUCER = entity('e-pv', 'producer', ['pv_power_kw']);
const GRID = entity('e-grid', 'grid-meter', ['power_kw']);
const ENTITIES = [BATTERY, PRODUCER, GRID];

function doc(nodes: Array<{ id: string; type: string }>): FlowDocument {
  return {
    schema_version: '1.0',
    name: 'flow',
    runtime: 'edge',
    nodes: nodes.map((n) => ({ ...n, type_version: '1.0.0' })),
    edges: [],
    triggers: [],
  };
}
function flow(flowId: string, name: string, nodes: Array<{ id: string; type: string }>): SurfaceFlow {
  return { flowId, name, activeVersion: 1, latestLifecycle: 'active', latestDocument: doc(nodes) };
}

/** Nur Lastspitzenkappung (Leistungspreis gesetzt, sonst nichts). */
const PEAK_ONLY: AnlageSurfaceInput = {
  signals: { hasStorage: false, hasPv: false, activeStrategyNodeTypes: [], plantKind: 'eigenverbrauch', hasLeistungspreis: true },
  config: { plantKind: 'eigenverbrauch', tarifArt: 'ohne', netzladenErlaubt: false, leistungspreisEurKw: 120 },
  flows: [],
  entities: ENTITIES,
};

/** Nur Eigenverbrauch (Speicher ∧ PV, kein Markt, kein Leistungspreis). */
const EV_ONLY: AnlageSurfaceInput = {
  signals: { hasStorage: true, hasPv: true, activeStrategyNodeTypes: [], plantKind: 'eigenverbrauch', hasLeistungspreis: false },
  config: { plantKind: 'eigenverbrauch', tarifArt: 'fest', netzladenErlaubt: false, leistungspreisEurKw: null },
  flows: [],
  entities: ENTITIES,
};

/** Nur Marktvermarktung (Direktvermarktung + Netzladen; EV auf DV unterdrückt). */
const MARKT_ONLY: AnlageSurfaceInput = {
  signals: { hasStorage: true, hasPv: true, activeStrategyNodeTypes: [], plantKind: 'direktvermarktung', hasLeistungspreis: false },
  config: { plantKind: 'direktvermarktung', tarifArt: 'dynamisch', netzladenErlaubt: true, leistungspreisEurKw: null },
  flows: [],
  entities: ENTITIES,
};

/** Markt UND Eigenverbrauch gleichzeitig aktiv (EEG-Haus mit Netzladen + dyn. Tarif). */
const MARKT_AND_EV: AnlageSurfaceInput = {
  signals: { hasStorage: true, hasPv: true, activeStrategyNodeTypes: [], plantKind: 'eigenverbrauch', hasLeistungspreis: false },
  config: { plantKind: 'eigenverbrauch', tarifArt: 'dynamisch', netzladenErlaubt: true, leistungspreisEurKw: null },
  flows: [],
  entities: ENTITIES,
};

/** Nur atypische Netznutzung (Strategie-Knoten, Karten-Modus). */
const ATYP_ONLY: AnlageSurfaceInput = {
  signals: { hasStorage: false, hasPv: false, activeStrategyNodeTypes: ['vp.strategy.atypical-grid'] },
  entities: ENTITIES,
};

/** Nur eine Automation (aktiver Flow ohne Strategie-Knoten). */
const AUTOMATION_ONLY: AnlageSurfaceInput = {
  signals: { hasStorage: false, hasPv: false, activeStrategyNodeTypes: [], plantKind: 'eigenverbrauch', hasLeistungspreis: false },
  config: { plantKind: 'eigenverbrauch', tarifArt: 'ohne', netzladenErlaubt: false, leistungspreisEurKw: null },
  flows: [flow('f-wb', 'Wallbox nur bei PV-Überschuss', [
    { id: 'n1', type: 'vp.entity.read' },
    { id: 'n2', type: 'vp.entity.control' },
  ])],
  entities: ENTITIES,
};

/** Alle vier Settings-tragenden Modus-Arten (Peak + Markt + EV + Automation). */
const FULL: AnlageSurfaceInput = {
  signals: { hasStorage: true, hasPv: true, activeStrategyNodeTypes: ['vp.strategy.market'], plantKind: 'eigenverbrauch', hasLeistungspreis: true },
  config: { plantKind: 'eigenverbrauch', tarifArt: 'dynamisch', netzladenErlaubt: true, leistungspreisEurKw: 95 },
  flows: [
    flow('f-markt', 'Marktoptimierung', [{ id: 'n1', type: 'vp.price.dayahead' }, { id: 'n2', type: 'vp.strategy.market' }]),
    flow('f-wb', 'Wallbox nur bei PV-Überschuss', [{ id: 'n1', type: 'vp.entity.read' }, { id: 'n2', type: 'vp.entity.control' }]),
  ],
  entities: ENTITIES,
};

const modeOf = (input: AnlageSurfaceInput, kind: ModeKind): ActiveMode => {
  const m = activeModes(input).find((x) => x.kind === kind);
  if (!m) throw new Error(`Fixture liefert keinen Modus ${kind}`);
  return m;
};
const ids = (defs: { id: string }[]) => defs.map((d) => d.id);

// ---------------------------------------------------------------------------
// 1 · Die Registry / der §2-Split
// ---------------------------------------------------------------------------

describe('SETTING_DEFS — der §2-Audit als Registry', () => {
  it('trägt genau die sieben Einstellungen, jede unter ihrer eigenen Id', () => {
    expect(ALL_SETTINGS.map((s) => s.id)).toEqual([
      'speicherschonung',
      'netzladen',
      'anzulegender-wert',
      'stromtarif',
      'leistungspreis',
      'abrechnung-leistung',
      'lastspitzen-reserve',
    ]);
    for (const def of ALL_SETTINGS) {
      expect(SETTING_DEFS[def.id]).toBe(def);
      expect(settingDef(def.id)).toBe(def);
    }
  });

  it('beansprucht die Batterie aus dem Markt-Modus (Eigenverbrauch ist kein Modus mehr)', () => {
    expect(SETTING_DEFS.speicherschonung.claimedBy).toEqual(['marktvermarktung']);
  });

  it('ordnet Netzladen + anzulegenden Wert + Tarif dem Markt-Modus zu', () => {
    expect(SETTING_DEFS.netzladen.claimedBy).toEqual(['marktvermarktung']);
    expect(SETTING_DEFS['anzulegender-wert'].claimedBy).toEqual(['marktvermarktung']);
    expect(SETTING_DEFS.stromtarif.claimedBy).toEqual(['marktvermarktung']);
  });

  it('macht die drei Lastspitzen-Einstellungen read-only (von VoltPilot)', () => {
    for (const id of ['leistungspreis', 'abrechnung-leistung', 'lastspitzen-reserve'] as const) {
      expect(SETTING_DEFS[id].claimedBy).toEqual(['lastspitzenkappung']);
      expect(SETTING_DEFS[id].editability).toBe('voltpilot');
      expect(SETTING_DEFS[id].editForm).toBeNull();
    }
  });

  it('gibt den Kunden-Einstellungen ein Bearbeiten-Formular', () => {
    for (const id of ['speicherschonung', 'netzladen', 'anzulegender-wert', 'stromtarif'] as const) {
      expect(SETTING_DEFS[id].editability).toBe('customer');
      expect(SETTING_DEFS[id].editForm).toBe(id);
      expect(SETTING_DEFS[id].readView).toBe(id);
    }
  });

  it('manifest.settings ↔ claimedBy: die beiden Dateien bleiben im Gleichschritt', () => {
    const modeByKind: Record<ModeKind, ActiveMode> = {
      lastspitzenkappung: modeOf(FULL, 'lastspitzenkappung'),
      marktvermarktung: modeOf(FULL, 'marktvermarktung'),
      automation: modeOf(FULL, 'automation'),
      'atypische-netznutzung': modeOf(ATYP_ONLY, 'atypische-netznutzung'),
    };
    for (const kind of Object.keys(modeByKind) as ModeKind[]) {
      const claimed = ALL_SETTINGS.filter((d) => d.claimedBy.includes(kind)).map((d) => d.id);
      // Menge (Reihenfolge im Manifest ist Anzeige-Sache, nicht Anspruch).
      expect(new Set(modeByKind[kind].manifest.settings)).toEqual(new Set(claimed));
      for (const id of modeByKind[kind].manifest.settings) {
        expect(SETTING_DEFS[id].claimedBy).toContain(kind);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2 · settingsForMode — erst-aktiver-gewinnt-Dedupe (MODE_RANK)
// ---------------------------------------------------------------------------

describe('settingsForMode — Anzeige je aktivem Modus', () => {
  it('zeigt dem Markt-Container alle vier Ansprüche in Manifest-Reihenfolge', () => {
    const modes = activeModes(MARKT_ONLY);
    expect(ids(settingsForMode(modeOf(MARKT_ONLY, 'marktvermarktung'), modes))).toEqual([
      'speicherschonung',
      'netzladen',
      'anzulegender-wert',
      'stromtarif',
    ]);
  });

  it('eine reine PV+Speicher-Anlage ohne Markt/Peak trägt gar keinen Modus (kein Container)', () => {
    // Eigenverbrauch ist Grundverhalten (report §3.3): EV_ONLY aktiviert keinen
    // Modus, also lebt keine Einstellung in einem Container - alle ruhen.
    expect(activeModes(EV_ONLY)).toEqual([]);
  });

  it('zeigt dem Lastspitzen-Container die drei Read-only-Einstellungen', () => {
    const modes = activeModes(PEAK_ONLY);
    expect(ids(settingsForMode(modeOf(PEAK_ONLY, 'lastspitzenkappung'), modes))).toEqual([
      'leistungspreis',
      'abrechnung-leistung',
      'lastspitzen-reserve',
    ]);
  });

  it('gibt einem Karten-Modus / einer Automation gar keine Einstellung', () => {
    const atyp = activeModes(ATYP_ONLY);
    expect(settingsForMode(modeOf(ATYP_ONLY, 'atypische-netznutzung'), atyp)).toEqual([]);
    const auto = activeModes(AUTOMATION_ONLY);
    expect(settingsForMode(modeOf(AUTOMATION_ONLY, 'automation'), auto)).toEqual([]);
  });

  it('ist die Batterie-Einstellung im Markt-Container erreichbar', () => {
    // Nur Markt aktiv -> die Batterie lebt in seinem Container.
    const marktModes = activeModes(MARKT_ONLY);
    expect(ids(settingsForMode(modeOf(MARKT_ONLY, 'marktvermarktung'), marktModes))).toContain('speicherschonung');
  });

  it('zeigt den anzulegenden Wert nur einer DIREKTVERMARKTUNGS-Anlage', () => {
    // Nach einer Umstellung DV → Eigenverbrauch kann der Markt-Modus über
    // Netzladen + dynamischen Tarif weiterlaufen. Der anzulegende Wert ist aber
    // der Vertragsfakt der EEG-Marktprämie und wird nur für eine DV-Anlage
    // verrechnet - er darf danach nicht als wirkungslose Eingabe stehenbleiben.
    const dv = modeOf(MARKT_ONLY, 'marktvermarktung');
    expect(ids(settingsForMode(dv, activeModes(MARKT_ONLY), { plantKind: 'direktvermarktung' })))
      .toContain('anzulegender-wert');

    const ev = modeOf(MARKT_AND_EV, 'marktvermarktung');
    const evIds = ids(settingsForMode(ev, activeModes(MARKT_AND_EV), { plantKind: 'eigenverbrauch' }));
    expect(evIds).not.toContain('anzulegender-wert');
    // Alles andere des Markt-Containers bleibt erreichbar.
    expect(evIds).toEqual(['speicherschonung', 'netzladen', 'stromtarif']);

    // Ohne Kontext (Aufrufer ohne Anlagen-Daten) wird NICHTS gefiltert.
    expect(ids(settingsForMode(ev, activeModes(MARKT_AND_EV)))).toContain('anzulegender-wert');
  });

  it('ein NICHT aktiver Modus zeigt keine Einstellungen (Owner: aus ⇒ nichts)', () => {
    const markt = modeOf(MARKT_ONLY, 'marktvermarktung');
    // Markt ist nicht in der aktiven Menge -> leer, auch wenn er Ansprüche trägt.
    expect(settingsForMode(markt, [])).toEqual([]);
    expect(settingsForMode(markt, activeModes(EV_ONLY))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3 · Die HEIMAT (E1): settingsPageSettings + die geschrumpfte Waisen-Regel
// ---------------------------------------------------------------------------

describe('settingsPageSettings — die Heimat der Kunden-Einstellungen (E1)', () => {
  it('die Einstellungs-Seite besitzt genau die vier kunden-gestellten Werte', () => {
    // Die „fünf" des Auftrags sind vier IDs: die Bezugspreis-Komponenten sind
    // Teil des Stromtarif-Formulars (`SupplyPriceFields` in `TariffFields`).
    expect(ids(settingsPageSettings())).toEqual([
      'speicherschonung',
      'netzladen',
      'anzulegender-wert',
      'stromtarif',
    ]);
    // Und genau diese vier tragen `home: 'einstellungen'`.
    for (const def of ALL_SETTINGS) {
      expect(def.home).toBe(def.editability === 'customer' ? 'einstellungen' : 'modus');
    }
  });

  it('DAS E1-Ergebnis: eine reine PV+Speicher-Anlage ERREICHT sie alle — ohne Modus', () => {
    const modes = activeModes(EV_ONLY);
    // Der Ausgangsbefund: diese Anlage aktiviert KEINEN Modus (Eigenverbrauch
    // ist Grundverhalten, report §3.3) …
    expect(modes).toEqual([]);
    // … und genau deshalb ruhten früher ALLE Einstellungen. Jetzt hat jede
    // kunden-gestellte Einstellung eine modus-unabhängige Heimat.
    expect(ids(settingsPageSettings({ plantKind: 'eigenverbrauch' }))).toEqual([
      'speicherschonung',
      'netzladen',
      'stromtarif',
    ]);
    // Nichts davon ist noch verwaist — die §3-Sackgasse ist geschlossen.
    for (const id of ['speicherschonung', 'netzladen', 'stromtarif', 'anzulegender-wert']) {
      expect(ids(orphanedSettings(modes))).not.toContain(id);
    }
  });

  it('die Sichtbarkeitsregel bleibt: der anzulegende Wert ist ein DV-Fakt', () => {
    // Auf einer Direktvermarktungs-Anlage steht er, auf einer Eigenverbrauchs-
    // Anlage wäre er eine wirkungslose Eingabe — unverändert zu vorher.
    expect(ids(settingsPageSettings({ plantKind: 'direktvermarktung' }))).toContain(
      'anzulegender-wert',
    );
    expect(ids(settingsPageSettings({ plantKind: 'eigenverbrauch' }))).not.toContain(
      'anzulegender-wert',
    );
    // Ohne Kontext (ein Aufrufer ohne Anlagen-Daten) wird NICHTS gefiltert.
    expect(ids(settingsPageSettings())).toContain('anzulegender-wert');
  });

  it('ist von jedem Modus unabhängig — dieselbe Liste, egal was läuft', () => {
    const baseline = ids(settingsPageSettings({ plantKind: 'eigenverbrauch' }));
    for (const input of [PEAK_ONLY, EV_ONLY, MARKT_AND_EV, ATYP_ONLY, AUTOMATION_ONLY, FULL, {}]) {
      // Das Argument ist bewusst kein Modus: die Heimat hängt nicht daran.
      void activeModes(input as AnlageSurfaceInput);
      expect(ids(settingsPageSettings({ plantKind: 'eigenverbrauch' }))).toEqual(baseline);
    }
  });
});

describe('orphanedSettings — was WIRKLICH keine Heimat hat (E1)', () => {
  it('eine Einstellung mit Heimat kann nie verwaisen', () => {
    for (const modes of [[], activeModes(EV_ONLY), activeModes(PEAK_ONLY), activeModes(FULL)]) {
      for (const def of orphanedSettings(modes)) expect(def.home).toBe('modus');
    }
  });

  it('ohne aktiven Modus ruhen nur noch die drei von-VoltPilot-Werte', () => {
    const rest = ['leistungspreis', 'abrechnung-leistung', 'lastspitzen-reserve'];
    expect(ids(orphanedSettings([]))).toEqual(rest);
    expect(ids(orphanedSettings(null))).toEqual(rest);
    expect(ids(orphanedSettings(undefined))).toEqual(rest);
    // Auch auf der Anlage, die früher der Beweis der Sackgasse war.
    expect(ids(orphanedSettings(activeModes(EV_ONLY)))).toEqual(rest);
  });

  it('mit aktiver Lastspitzenkappung ruht gar nichts mehr', () => {
    expect(orphanedSettings(activeModes(PEAK_ONLY))).toEqual([]);
    expect(orphanedSettings(activeModes(FULL))).toEqual([]);
  });

  it('Partition: jede Einstellung ist ERREICHBAR oder verwaist, nie beides', () => {
    for (const input of [PEAK_ONLY, EV_ONLY, MARKT_ONLY, MARKT_AND_EV, ATYP_ONLY, AUTOMATION_ONLY, FULL, {}]) {
      const modes = activeModes(input as AnlageSurfaceInput);
      // Der Container zeigt weiterhin duplikatfrei (jetzt als Spiegel) …
      const shown = modes.flatMap((m) => ids(settingsForMode(m, modes)));
      expect(new Set(shown).size).toBe(shown.length);
      // … und die Einstellungs-Seite ist die zweite Fläche. Erreichbar heißt:
      // auf mindestens einer von beiden.
      const reachable = new Set([...ids(settingsPageSettings()), ...shown]);
      const orphan = ids(orphanedSettings(modes));
      for (const id of orphan) expect(reachable.has(id)).toBe(false);
      expect(new Set([...reachable, ...orphan])).toEqual(new Set(ids(ALL_SETTINGS)));
    }
  });
});
