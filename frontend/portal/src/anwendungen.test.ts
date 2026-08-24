/**
 * Der EINE Anwendungs-Katalog, Portal-Seite (Zielbild
 * `data/vp-portal-zielbild-anwendungen/report.md` §2.2/§3.2, Stufe 1).
 *
 * Drei Dinge werden hier festgenagelt:
 *  1. **Die Vektoren fahren die Ableitung WIRKLICH** — `derivedAnwendungen`
 *     UND, für die vier Geschäfts-Anwendungen, der DRITTE Zwilling
 *     `surface.ts activeModes`. Beide bekommen dieselbe Eingabe und müssen
 *     dasselbe sagen; der Java-Zwilling (`AnwendungDerivationTest`) liest
 *     dieselbe Datei. Kein Vakuum-Test.
 *  2. **Kein Katalog-Eintrag ohne Manifest** — was der Katalog als Baustein
 *     einer Modus-Art nennt, muss `surface.ts manifestFor` auch beisteuern
 *     (Cockpit-Block, Tiefen-Ansichten, Geld-Strom, Einstellungen), und jede
 *     Baustein-Id muss ein bekanntes Vokabular treffen.
 *  3. **Die Regeln des Katalogs selbst** — Klassen/Kategorien/Preset-Werte aus
 *     dem geschlossenen Vokabular, Basis nicht abschaltbar, reserviert nicht
 *     sichtbar, Ränge eindeutig.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ANWENDUNGEN,
  REGAL,
  anwendung,
  anwendungLabel,
  anwendungenFuerEinstellung,
  derivedActive,
  derivedAnwendungen,
  einstellungenVon,
  istAbschaltbar,
  istBasis,
  istRegel,
  requirementMet,
  type AnwendungSignals,
} from './anwendungen';
import {
  MODE_LABELS,
  activeModes,
  modeDeepViews,
  moneyStreams,
  type AnlageSurfaceInput,
  type ModeKind,
  type SurfaceEntity,
} from './surface';
import { EV_CHARGER } from './ladepunkte';
import { SETTING_DEFS } from './modeSettings';

const VECTORS = resolve(process.cwd(), '../../docs/contracts/v2/anwendung-vectors.json');

interface VectorInput {
  has_storage: boolean;
  has_pv: boolean;
  has_controllable_consumer: boolean;
  has_charge_point: boolean;
  has_measurement: boolean;
  has_leistungspreis: boolean;
  has_grid_limit: boolean;
  active_node_types: string[];
  has_customer_rule: boolean;
  plant_kind: string;
  tarif_art: string;
  netzladen_erlaubt: boolean;
}

interface Vector {
  name: string;
  input: VectorInput;
  expected_derived_active: string[];
  expected_requirements: Record<string, boolean>;
}

const vectors = JSON.parse(readFileSync(VECTORS, 'utf8')) as {
  anwendungen: string[];
  requirement_ids: string[];
  mode_kinds: string[];
  derivation: Vector[];
};

function signalsOf(v: VectorInput): AnwendungSignals {
  return {
    hasStorage: v.has_storage,
    hasPv: v.has_pv,
    hasControllableConsumer: v.has_controllable_consumer,
    hasChargePoint: v.has_charge_point,
    hasMeasurement: v.has_measurement,
    hasLeistungspreis: v.has_leistungspreis,
    hasGridLimit: v.has_grid_limit,
    activeNodeTypes: v.active_node_types,
    hasCustomerRule: v.has_customer_rule,
    plantKind: v.plant_kind,
    tarifArt: v.tarif_art,
    netzladenErlaubt: v.netzladen_erlaubt,
  };
}

/**
 * Dieselbe Eingabe, als M0-Projektions-Eingabe. Die Strategie-Knoten reisen als
 * `signals.activeStrategyNodeTypes` (die Server-Wahrheit), der Ladepunkt als
 * Entität (`activeModes` keyt darauf), und der Leistungspreis als SIGNAL — nicht
 * als Betrag, denn `has_leistungspreis` ist im Vektor bewusst ein Boolean
 * (siehe den `_comment` der Vektor-Datei).
 */
function surfaceInputOf(v: VectorInput): AnlageSurfaceInput {
  const entities: SurfaceEntity[] = [];
  if (v.has_charge_point) entities.push({ id: 'cp-1', entityType: EV_CHARGER });
  return {
    signals: {
      hasStorage: v.has_storage,
      hasPv: v.has_pv,
      hasControllableConsumer: v.has_controllable_consumer,
      activeStrategyNodeTypes: v.active_node_types,
      plantKind: v.plant_kind,
      hasLeistungspreis: v.has_leistungspreis,
    },
    config: {
      plantKind: v.plant_kind,
      tarifArt: v.tarif_art,
      netzladenErlaubt: v.netzladen_erlaubt,
    },
    entities,
    flows: [],
  };
}

describe('anwendung-vectors: die zwei Zwillinge fahren dieselben Fälle', () => {
  it('die Vektor-Datei deckt jeden Katalog-Eintrag und jede Voraussetzungs-Id ab', () => {
    expect(vectors.anwendungen).toEqual(ANWENDUNGEN.map((a) => a.id));
    const reqIds = new Set(ANWENDUNGEN.flatMap((a) => a.voraussetzungen.map((v) => v.id)));
    for (const id of reqIds) expect(vectors.requirement_ids).toContain(id);
    expect(vectors.derivation.length).toBeGreaterThan(5);
  });

  for (const v of vectors.derivation) {
    it(`derivedAnwendungen · ${v.name}`, () => {
      expect(derivedAnwendungen(signalsOf(v.input))).toEqual(v.expected_derived_active);
    });

    it(`requirementMet · ${v.name}`, () => {
      const signals = signalsOf(v.input);
      for (const [id, met] of Object.entries(v.expected_requirements)) {
        expect(requirementMet(id, signals), `${v.name} · ${id}`).toBe(met);
      }
      // Ein UNBEKANNTER Name gilt als NICHT erfüllt - eine Voraussetzung, die
      // niemand prüfen kann, darf nie als Häkchen erscheinen.
      expect(requirementMet('gibt-es-nicht', signals)).toBe(false);
    });

    it(`activeModes stimmt mit derivedAnwendungen überein · ${v.name}`, () => {
      const ausProjektion = activeModes(surfaceInputOf(v.input))
        .map((m) => String(m.kind))
        .filter((k) => vectors.mode_kinds.includes(k))
        .sort();
      const ausKatalog = v.expected_derived_active
        .filter((id) => vectors.mode_kinds.includes(id))
        .sort();
      expect(ausProjektion).toEqual(ausKatalog);
    });
  }
});

describe('Katalog ⟷ Manifest: kein Eintrag ohne Fläche', () => {
  const modeKinds = vectors.mode_kinds as Exclude<ModeKind, 'automation'>[];

  it('jede Modus-Art hat einen Katalog-Eintrag und umgekehrt', () => {
    for (const kind of modeKinds) expect(anwendung(kind), kind).not.toBeNull();
    for (const a of ANWENDUNGEN) {
      if (modeKinds.includes(a.id as never)) continue;
      // Die übrigen Einträge tragen keine Modus-Art - sie erscheinen im Regal,
      // aber nicht in der M0-Projektion (Stufe 1 ändert die Fläche nicht).
      expect(modeKinds).not.toContain(a.id);
    }
  });

  it('MODE_LABELS kommt aus dem Katalog', () => {
    for (const kind of modeKinds) {
      expect(MODE_LABELS[kind]).toBe(anwendungLabel(kind));
    }
  });

  for (const kind of vectors.mode_kinds as Exclude<ModeKind, 'automation'>[]) {
    it(`bausteine == manifestFor · ${kind}`, () => {
      const a = anwendung(kind)!;
      // Tiefen-Ansichten
      expect(modeDeepViews(kind)).toEqual(a.bausteine.ansichten);
      // Einstellungs-Ansprüche
      expect(einstellungenVon(kind)).toEqual(a.einstellungen);
      // Cockpit-Block + primärer Geld-Strom über einen echten aktiven Modus
      const modes = activeModes(surfaceInputOf(erzeugeFuer(kind)));
      const mode = modes.find((m) => m.kind === kind)!;
      expect(mode, `${kind} muss aktivierbar sein`).toBeTruthy();
      const block = mode.manifest.cockpitBlock;
      expect(block ? [block.id] : []).toEqual(a.bausteine.cockpit);
      const primaer = moneyStreams([mode])[0]?.id ?? null;
      expect(primaer).toBe(a.bausteine.geldstrom);
    });
  }

  it('jede Baustein-Id trifft ein bekanntes Vokabular', () => {
    const blocks = new Set([
      'status',
      'lade-budget',
      'peak-band',
      'erloes-komposition',
      'energiefluss',
      'handel',
      'eigenverbrauch',
      'geraete-automatik',
      'toolbox-pointer',
    ]);
    const views = new Set([
      'ladevorgaenge',
      'live',
      'geraete',
      'telemetrie-historie',
      'wetter',
      'erloes-historie',
      'fahrplan',
      'marktpreise',
      'prognosequalitaet',
      'lastspitzen',
      'flow-editor',
    ]);
    const streams = new Set([
      'eigenverbrauchswert',
      'einspeisung',
      'handel',
      'lastspitzen',
      'automation',
    ]);
    for (const a of ANWENDUNGEN) {
      for (const b of a.bausteine.cockpit) expect(blocks, `${a.id}/${b}`).toContain(b);
      for (const v of a.bausteine.ansichten) expect(views, `${a.id}/${v}`).toContain(v);
      if (a.bausteine.geldstrom) expect(streams, a.id).toContain(a.bausteine.geldstrom);
      for (const s of a.einstellungen) expect(Object.keys(SETTING_DEFS), a.id).toContain(s);
    }
  });

  it('`claimedBy` ist die Umkehrung der Katalog-Einstellungen', () => {
    for (const [id, def] of Object.entries(SETTING_DEFS)) {
      expect(def.claimedBy).toEqual(anwendungenFuerEinstellung(id));
    }
  });

  it('einstellungen_verweis passt zur Heimat der Einstellungen', () => {
    for (const a of ANWENDUNGEN) {
      if (a.einstellungen.length === 0) continue;
      const homes = new Set(a.einstellungen.map((s) => SETTING_DEFS[s as never].home));
      expect(homes.size, `${a.id}: alle Einstellungen teilen eine Heimat`).toBe(1);
      expect(a.einstellungen_verweis).toBe([...homes][0]);
    }
  });
});

describe('Katalog-Regeln', () => {
  it('Klassen, Kategorien und Preset-Werte kommen aus dem geschlossenen Vokabular', () => {
    for (const a of ANWENDUNGEN) {
      expect(['basis', 'regel', 'geschaeft', 'reserviert']).toContain(a.klasse);
      expect(['basis', 'steuerung', 'geschaeft', 'auswertung']).toContain(a.kategorie);
      expect(['an', 'angeboten', 'verborgen', 'abgeleitet']).toContain(a.preset.privat);
      expect(['an', 'angeboten', 'verborgen', 'abgeleitet']).toContain(a.preset.gewerbe);
      expect(a.nutzen.length).toBeGreaterThan(20);
    }
  });

  it('eine Basis-Anwendung ist nicht abschaltbar, eine reservierte nicht sichtbar', () => {
    for (const a of ANWENDUNGEN) {
      if (a.klasse === 'basis') expect(a.abschaltbar, a.id).toBe(false);
      else expect(a.abschaltbar, a.id).toBe(true);
      if (a.klasse === 'reserviert') expect(a.sichtbar, a.id).toBe(false);
      else expect(a.sichtbar, a.id).toBe(true);
    }
  });

  it('das Regal führt genau die sichtbaren Einträge, kanonisch sortiert', () => {
    expect(REGAL.map((a) => a.id)).toEqual([
      'monitoring',
      'speicher-fahrplan',
      'ueberschuss',
      'verbraucher',
      'marktvermarktung',
      'lastspitzenkappung',
      'atypische-netznutzung',
      'lastmanagement',
    ]);
    const raenge = ANWENDUNGEN.map((a) => a.rang);
    expect(new Set(raenge).size).toBe(raenge.length);
  });

  it('nur eine Geschäfts-Anwendung trägt Strategie-Knoten oder Starter', () => {
    for (const a of ANWENDUNGEN) {
      if (a.klasse === 'geschaeft') continue;
      expect(a.strategie_knoten, a.id).toBeNull();
      expect(a.starter, a.id).toBeNull();
    }
  });

  it('die Regel-Anwendungen tragen ihren ehrlichen Leer-Zustand', () => {
    for (const a of ANWENDUNGEN) {
      if (a.klasse !== 'regel') continue;
      expect(a.leer_zustand, a.id).toBeTruthy();
      expect(a.leer_zustand, a.id).toContain('Regeln');
    }
  });

  it('die Helfer beantworten eine unbekannte Id ehrlich', () => {
    expect(anwendung('gibt-es-nicht')).toBeNull();
    expect(anwendung(null)).toBeNull();
    // Der Server ist die Wahrheit: eine unbekannte Anwendung gilt als schaltbar
    // (er lehnt sonst ehrlich ab), aber weder Basis noch Regel.
    expect(istAbschaltbar('gibt-es-nicht')).toBe(true);
    expect(istBasis('gibt-es-nicht')).toBe(false);
    expect(istRegel('gibt-es-nicht')).toBe(false);
    expect(anwendungLabel('gibt-es-nicht')).toBe('gibt-es-nicht');
    expect(einstellungenVon('gibt-es-nicht')).toEqual([]);
    expect(derivedActive('gibt-es-nicht', signalsOf(vectors.derivation[0].input))).toBe(false);
  });
});

/** Eine minimale Eingabe, die GENAU diese Modus-Art aktiviert. */
function erzeugeFuer(kind: Exclude<ModeKind, 'automation'>): VectorInput {
  const base: VectorInput = {
    has_storage: true,
    has_pv: true,
    has_controllable_consumer: false,
    has_charge_point: false,
    has_measurement: true,
    has_leistungspreis: false,
    has_grid_limit: false,
    active_node_types: [],
    has_customer_rule: false,
    plant_kind: 'eigenverbrauch',
    tarif_art: 'dynamisch',
    netzladen_erlaubt: false,
  };
  switch (kind) {
    case 'marktvermarktung':
      return { ...base, plant_kind: 'direktvermarktung' };
    case 'lastspitzenkappung':
      return { ...base, has_leistungspreis: true };
    case 'atypische-netznutzung':
      return { ...base, active_node_types: ['vp.strategy.atypical-grid'] };
    case 'lastmanagement':
      return { ...base, has_charge_point: true };
  }
}
