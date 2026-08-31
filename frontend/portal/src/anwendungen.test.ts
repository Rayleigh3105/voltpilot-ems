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
  exklusivGeschwister,
  exklusivGruppe,
  AUSSERHALB_REGAL,
  PRESETS,
  PROFIL_UNGESETZT,
  REGAL,
  anwendung,
  anwendungLabel,
  anwendungenSatz,
  betriebsmodellVorschlag,
  imRegal,
  istProfil,
  preset,
  presetSchaltplan,
  presetWert,
  profilAenderungsFolgen,
  profilLabel,
  tonalitaetVon,
  vorauswahl,
  type RegalKarte,
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
      expect(['basis', 'regel', 'cockpit', 'geschaeft', 'reserviert']).toContain(a.klasse);
      expect(['basis', 'steuerung', 'geschaeft', 'auswertung']).toContain(a.kategorie);
      expect(['an', 'angeboten', 'verborgen', 'abgeleitet']).toContain(a.preset.privat);
      expect(['an', 'angeboten', 'verborgen', 'abgeleitet']).toContain(a.preset.gewerbe);
      expect(a.nutzen.length).toBeGreaterThan(20);
    }
  });

  it('eine Basis-Anwendung ist nicht abschaltbar, eine reservierte nicht sichtbar', () => {
    for (const a of ANWENDUNGEN) {
      // ⚠ Zwei Klassen ohne Schalter, aus VERSCHIEDENEN Gründen: `basis`
      // läuft immer, `cockpit` wird an einem ANDEREN Ort gesteuert (im
      // Cockpit unter „Anpassen", Steuerung Stufe 8).
      if (a.klasse === 'basis' || a.klasse === 'cockpit') {
        expect(a.abschaltbar, a.id).toBe(false);
      } else expect(a.abschaltbar, a.id).toBe(true);
      if (a.klasse === 'reserviert') expect(a.sichtbar, a.id).toBe(false);
      else expect(a.sichtbar, a.id).toBe(true);
    }
  });

  it('das Regal führt seit Stufe 0 GENAU die Betriebsmodelle, kanonisch sortiert', () => {
    // ⚠ Verbrauchsmanagement v1: das Ladepark-Lastmanagement ist KEIN
    // Betriebsmodell mehr, sondern SCHUTZ - Klasse `basis`, kein Schalter,
    // nicht im Regal. Seinen Platz nimmt der Ladepark-Rahmen als Kopf des
    // Ladepunkt-Abschnitts in der Verbraucher-Zone ein.
    expect(REGAL.map((a) => a.id)).toEqual([
      'marktvermarktung',
      'lastspitzenkappung',
      'atypische-netznutzung',
    ]);
    const raenge = ANWENDUNGEN.map((a) => a.rang);
    expect(new Set(raenge).size).toBe(raenge.length);
  });

  it('Stufe 0: `regal` folgt der KLASSE - Betriebsmodell ja, sonst nein', () => {
    for (const a of ANWENDUNGEN) {
      expect(a.regal, a.id).toBe(a.klasse === 'geschaeft');
    }
  });

  it('Stufe 0 blendet aus, sie LÖSCHT nicht: Regal ∪ Rest ist alles Sichtbare', () => {
    // Der tragende Satz dieser Stufe. Die ausgeblendeten Anwendungen existieren
    // unverändert - ihre Zustände reisen in `SiteProfiles.weitere` weiter, weil
    // das Cockpit-Tor „Eigene Auswertung" und das Willens-Overlay sie lesen.
    expect(AUSSERHALB_REGAL.map((a) => a.id)).toEqual([
      'monitoring',
      'speicher-fahrplan',
      'ueberschuss',
      'verbraucher',
      'lastmanagement',
      'eigene-auswertung',
    ]);
    expect([...REGAL, ...AUSSERHALB_REGAL].map((a) => a.id).sort()).toEqual(
      ANWENDUNGEN.filter((a) => a.sichtbar).map((a) => a.id).sort(),
    );
    // `sichtbar` bleibt daneben die andere Frage: GIBT es die Anwendung schon?
    expect(REGAL.every((a) => a.sichtbar)).toBe(true);
    expect(AUSSERHALB_REGAL.every((a) => a.sichtbar)).toBe(true);
  });

  it('imRegal urteilt über eine UNBEKANNTE Id nie „ja"', () => {
    expect(imRegal('marktvermarktung')).toBe(true);
    expect(imRegal('ueberschuss')).toBe(false);
    // Ein neuerer Server mit einer Anwendung, die diese Kopie nicht kennt:
    // lieber auslassen als eine Zeile ohne Nutzen-Satz rendern.
    expect(imRegal('brandneu')).toBe(false);
    expect(imRegal(null)).toBe(false);
  });

  it('keine Anwendung nennt mehr die Phantom-Seite „Komponenten & Regeln"', () => {
    // Sie existiert nicht: die Navigation kennt „Anlagen-Modell" und
    // „Steuerung"; die Regel-Liste wohnt auf derselben Seite eine Kapsel
    // tiefer. Der Satz schickte den Kunden in eine Sackgasse.
    for (const a of ANWENDUNGEN) {
      expect(a.leer_zustand ?? '', a.id).not.toContain('Komponenten & Regeln');
    }
    expect(anwendung('ueberschuss')?.leer_zustand).toContain('„Regeln“ auf dieser Seite');
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
      // ⚠ Seit Steuerung Stufe 8 ist „Eigene Auswertung" KEINE Regel-Anwendung
      // mehr (Klasse `cockpit`) - ihr Leer-Zustand bleibt aus derselben
      // Ehrlichkeitsregel NULL: der SERVER kann die Leere nicht belegen (sein
      // `hasCustomerRule` zählt aktive Flows, nicht Kacheln), der Hinweis lebt
      // im Cockpit (`eigeneAuswertung.LEER_SATZ`).
      if (a.klasse === 'cockpit') {
        expect(a.leer_zustand, a.id).toBeNull();
        expect(a.abschaltbar, a.id).toBe(false);
        // Ein Preset kann sie nicht wählen - sie hat keinen Schalter.
        expect(a.preset.privat, a.id).toBe('abgeleitet');
        expect(a.preset.gewerbe, a.id).toBe('abgeleitet');
        continue;
      }
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

// ---------------------------------------------------------------------------
// Die PRESETS (Stufe 2)
// ---------------------------------------------------------------------------

/** Eine Regal-Karte, wie der Server sie liefert. */
function karte(id: string, over: Partial<RegalKarte> = {}): RegalKarte {
  return { id, label: anwendungLabel(id), state: null, active: false, requirements: [], ...over };
}

describe('Presets: Vokabular und Datenlage', () => {
  it('kennt GENAU die zwei Profile des Konzepts, jedes mit Satz und Tonalität', () => {
    expect(PRESETS.map((p) => p.id)).toEqual(['privat', 'gewerbe']);
    for (const p of PRESETS) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.satz.length).toBeGreaterThan(20);
      expect(['sparen', 'verdienen']).toContain(p.tonalitaet);
    }
  });

  it('erkennt nur bekannte Profile - ein unbekanntes Wort gilt NIE', () => {
    expect(istProfil('privat')).toBe(true);
    expect(istProfil('gewerbe')).toBe(true);
    expect(istProfil('betreiber')).toBe(false);
    expect(istProfil(null)).toBe(false);
    expect(istProfil(42)).toBe(false);
    expect(preset('quatsch')).toBeNull();
  });

  it('die Tonalität ist null, solange kein Profil gewählt ist (der Rückfall)', () => {
    // Genau dieses `null` ist die Migrations-Zusage: ohne Profil gilt weiter
    // die plant_kind-Regel, byte-identisch zu vor Stufe 2.
    expect(tonalitaetVon(null)).toBeNull();
    expect(tonalitaetVon('quatsch')).toBeNull();
    expect(tonalitaetVon('privat')).toBe('sparen');
    expect(tonalitaetVon('gewerbe')).toBe('verdienen');
  });

  it('jede sichtbare Anwendung trägt für BEIDE Profile einen Preset-Wert', () => {
    for (const a of ANWENDUNGEN) {
      expect(presetWert(a.id, 'privat')).not.toBeNull();
      expect(presetWert(a.id, 'gewerbe')).not.toBeNull();
    }
    expect(presetWert('marktvermarktung', null)).toBeNull();
  });
});

describe('vorauswahl: was ein Profil vorschlägt', () => {
  it('Stufe 0: HÖCHSTENS EIN Betriebsmodell je Profil - Privat keins', () => {
    // Konzept §3.9: der Assistent schlägt genau eines vor, nie zwei. Dass es
    // höchstens eines gibt, ist eine Eigenschaft der DATEN.
    expect(vorauswahl('privat')).toEqual([]);
    expect(vorauswahl('gewerbe')).toEqual(['lastspitzenkappung']);
    expect(vorauswahl(null)).toEqual([]);
    for (const profil of ['privat', 'gewerbe'] as const) {
      expect(vorauswahl(profil).length, profil).toBeLessThanOrEqual(1);
    }
  });

  it('nennt weder Basis- noch Regel-Anwendungen - sie gehören nicht ins Regal', () => {
    for (const profil of ['privat', 'gewerbe'] as const) {
      for (const id of vorauswahl(profil)) {
        expect(istBasis(id)).toBe(false);
        expect(istAbschaltbar(id)).toBe(true);
        expect(imRegal(id)).toBe(true);
      }
    }
    // Die Basis-Anwendungen stehen im Katalog auf `an` - und trotzdem nicht in
    // der Vorauswahl: sie laufen ohnehin und haben gar keinen Schalter. Die
    // Regel-Anwendungen ebenso: Regeln entstehen später in der Steuerung.
    expect(presetWert('monitoring', 'privat')).toBe('an');
    expect(presetWert('ueberschuss', 'privat')).toBe('an');
    expect(vorauswahl('privat')).toEqual([]);
  });
});

describe('betriebsmodellVorschlag: GENAU EINES, oder ehrlich keins', () => {
  const markt = (met: boolean) =>
    karte('marktvermarktung', { requirements: [{ label: 'Marktzugang', met }] });
  const spitze = (met: boolean) =>
    karte('lastspitzenkappung', {
      requirements: [{ label: 'Leistungspreis hinterlegt', met }],
    });

  it('Gewerbe mit Leistungspreis: die Lastspitzenkappung, nie zwei', () => {
    // Beide könnten - vorgeschlagen wird das Startmodell des Profils (`an`).
    const { ticken, zurueckgestellt } = betriebsmodellVorschlag('gewerbe', [
      markt(true),
      spitze(true),
    ]);
    expect(ticken).toBe('lastspitzenkappung');
    expect(zurueckgestellt).toBeNull();
  });

  it('Gewerbe OHNE Leistungspreis, aber mit Marktzugang: die Marktoptimierung', () => {
    // Konzept §3.9 wörtlich: „sonst Marktoptimierung, wenn Marktzugang".
    const { ticken } = betriebsmodellVorschlag('gewerbe', [markt(true), spitze(false)]);
    expect(ticken).toBe('marktvermarktung');
  });

  it('kann keins laufen, wird das GEMEINTE genannt statt still angehakt', () => {
    const { ticken, zurueckgestellt } = betriebsmodellVorschlag('gewerbe', [
      markt(false),
      spitze(false),
    ]);
    expect(ticken).toBeNull();
    expect(zurueckgestellt).toEqual({
      id: 'lastspitzenkappung',
      label: 'Lastspitzenkappung',
      fehlend: ['Leistungspreis hinterlegt'],
    });
  });

  it('Privat schlägt NICHTS vor - auch wenn ein Rückfall laufen könnte', () => {
    // Der Eigenverbrauchs-Fahrplan ist Grundverhalten, kein Modus: ohne
    // Startwahl des Profils gibt es keine Empfehlung, die jemand getroffen hat.
    expect(betriebsmodellVorschlag('privat', [markt(true), spitze(true)])).toEqual({
      ticken: null,
      zurueckgestellt: null,
    });
  });

  it('ohne Profil GAR nichts', () => {
    expect(betriebsmodellVorschlag(null, [markt(true)])).toEqual({
      ticken: null,
      zurueckgestellt: null,
    });
  });

  it('ein Modell ohne gebaute Ökonomie ist nie Kandidat', () => {
    // Die atypische Netznutzung ist für Gewerbe `angeboten`, trägt aber einen
    // IMMER geltenden Sperrgrund - sie darf nie einspringen.
    expect(anwendung('atypische-netznutzung')?.blocked_reason_immer).not.toBeNull();
    const { ticken } = betriebsmodellVorschlag('gewerbe', [
      spitze(false),
      markt(false),
      karte('atypische-netznutzung', { requirements: [] }),
    ]);
    expect(ticken).toBeNull();
  });

  it('ein Kandidat ohne Karte DIESES Servers wird übersprungen', () => {
    // Ein Vorschlag, den der Server nicht kennt, liesse sich nicht einschalten.
    const { ticken, zurueckgestellt } = betriebsmodellVorschlag('gewerbe', [markt(true)]);
    expect(ticken).toBe('marktvermarktung');
    expect(zurueckgestellt).toBeNull();
  });
});

describe('presetSchaltplan: nur der Wille wird geschrieben', () => {
  it('schreibt `an` auch für eine SCHON abgeleitet aktive Anwendung', () => {
    // Der tragende Fall: eine Direktvermarktungs-Anlage hat die
    // Marktoptimierung abgeleitet an, aber ohne gespeichertes `an` öffnet der
    // Server nie das Tor und sät nie den Starter.
    const karten = [karte('marktvermarktung', { active: true })];
    expect(presetSchaltplan(['marktvermarktung'], ['marktvermarktung'], karten)).toEqual([
      { id: 'marktvermarktung', state: 'an' },
    ]);
  });

  it('schreibt NICHTS, wenn der Kunde nichts wollte (durchgeklickt)', () => {
    const karten = [karte('lastmanagement', { active: true })];
    expect(presetSchaltplan([], ['lastmanagement'], karten)).toEqual([]);
  });

  it('schreibt kein zweites `an` auf eine schon gespeicherte Absicht', () => {
    const karten = [karte('marktvermarktung', { state: 'an', active: true })];
    expect(presetSchaltplan(['marktvermarktung'], ['marktvermarktung'], karten)).toEqual([]);
  });

  it('schaltet nur AB, was wirklich an ist', () => {
    const an = [karte('marktvermarktung', { active: true })];
    expect(presetSchaltplan([], [], an)).toEqual([{ id: 'marktvermarktung', state: 'aus' }]);
    const stumm = [karte('marktvermarktung')];
    expect(presetSchaltplan([], [], stumm)).toEqual([]);
  });

  it('lässt eine BASIS-Anwendung nie in den Plan (der Server lehnt sie ab)', () => {
    const karten = [karte('monitoring', { active: true }), karte('speicher-fahrplan', { active: true })];
    expect(presetSchaltplan(['monitoring'], [], karten)).toEqual([]);
    expect(presetSchaltplan([], [], karten)).toEqual([]);
  });

  it('ordnet den Plan kanonisch (die Wirkung bleibt reproduzierbar)', () => {
    const karten = [
      karte('lastspitzenkappung'),
      karte('ueberschuss'),
      karte('marktvermarktung'),
    ];
    const ids = ['lastspitzenkappung', 'ueberschuss', 'marktvermarktung'];
    expect(presetSchaltplan(ids, ids, karten).map((p) => p.id)).toEqual([
      'ueberschuss',
      'marktvermarktung',
      'lastspitzenkappung',
    ]);
  });
});

describe('Copy der Abschluss- und Einstellungs-Fläche', () => {
  it('nennt die eingeschalteten Anwendungen - und behauptet ohne sie nichts', () => {
    expect(anwendungenSatz(['ueberschuss', 'verbraucher'])).toBe(
      'Eingeschaltet: Überschuss nutzen, Verbraucher steuern.',
    );
    expect(anwendungenSatz([])).toBeNull();
    expect(anwendungenSatz(['gibt-es-nicht'])).toBeNull();
  });

  it('profilLabel sagt ehrlich, wenn keins gewählt ist', () => {
    expect(profilLabel('privat')).toBe('Privat');
    expect(profilLabel(null)).toBe(PROFIL_UNGESETZT);
    expect(profilLabel('quatsch')).toBe(PROFIL_UNGESETZT);
  });

  it('die Folgenliste sagt AUCH, was gleich bleibt - und verspricht keinen Schaltvorgang', () => {
    for (const neu of ['privat', 'gewerbe', null] as const) {
      const folgen = profilAenderungsFolgen(neu);
      expect(folgen.some((f) => /bleiben unverändert/.test(f))).toBe(true);
      expect(folgen.some((f) => /jederzeit wieder ändern/.test(f))).toBe(true);
      expect(folgen.join(' ')).not.toMatch(/schalten wir (ein|ab)/);
    }
    expect(profilAenderungsFolgen('gewerbe').join(' ')).toMatch(/verdient/);
    expect(profilAenderungsFolgen('privat').join(' ')).toMatch(/gespart/);
  });
});

// ---------------------------------------------------------------------------
// Steuerung Stufe 5 · Exklusivität + die zwei Voraussetzungs-Felder
// ---------------------------------------------------------------------------

describe('Exklusivitäts-Gruppen (Steuerung Stufe 5)', () => {
  it('⚠ die Gruppe `speicher` sind GENAU die drei Modelle mit Strategie-Knoten', () => {
    // Die argumentierte Abweichung vom Konzept-Wortlaut („alle vier"): das
    // Ladepark-Lastmanagement ist SCHUTZ, hat keinen Strategie-Knoten, läuft
    // auf der Box weiter und ist abgeleitet aktiv, sobald eine Säule da ist.
    const gruppe = ANWENDUNGEN.filter((a) => a.exklusiv_gruppe === 'speicher').map((a) => a.id);
    expect(gruppe.sort()).toEqual(
      ['atypische-netznutzung', 'lastspitzenkappung', 'marktvermarktung'],
    );
    expect(exklusivGruppe('lastmanagement')).toBeNull();
  });

  it('nur REGAL-Einträge tragen überhaupt eine Gruppe', () => {
    for (const a of ANWENDUNGEN) {
      if (a.exklusiv_gruppe != null) expect(a.regal, a.id).toBe(true);
    }
  });

  it('die Geschwister sind gegenseitig - und ein Modell ist nie sein eigener Geschwister', () => {
    const markt = exklusivGeschwister('marktvermarktung');
    expect(markt).not.toContain('marktvermarktung');
    expect(markt.sort()).toEqual(['atypische-netznutzung', 'lastspitzenkappung']);
    for (const id of markt) expect(exklusivGeschwister(id)).toContain('marktvermarktung');
  });

  it('ein Modell ohne Gruppe hat keine Geschwister - es konkurriert mit niemandem', () => {
    expect(exklusivGeschwister('lastmanagement')).toEqual([]);
    expect(exklusivGeschwister('gibt-es-nicht')).toEqual([]);
  });

  it('⚠ ein Preset schlägt höchstens EIN Modell derselben Gruppe vor', () => {
    // Sonst stünden nach dem Assistenten zwei Häkchen, und der Server machte
    // daraus stillschweigend eines.
    for (const p of ['privat', 'gewerbe'] as const) {
      const proGruppe = new Map<string, number>();
      for (const a of vorauswahl(p)) {
        const g = anwendung(a)?.exklusiv_gruppe;
        if (!g) continue;
        proGruppe.set(g, (proGruppe.get(g) ?? 0) + 1);
      }
      for (const [g, n] of proGruppe) expect(n, `${p}/${g}`).toBe(1);
    }
  });
});

describe('Voraussetzungen: art + behebung (Steuerung Stufe 5)', () => {
  it('jede Voraussetzung trägt eine ART aus dem geschlossenen Vokabular', () => {
    for (const a of ANWENDUNGEN) {
      for (const v of a.voraussetzungen) {
        expect(['hardware', 'einstellung'], `${a.id}/${v.id}`).toContain(v.art);
      }
    }
  });

  it('⚠ ein HARDWARE-Fakt hat keinen Weg - ein Klick löst ihn nicht', () => {
    for (const a of ANWENDUNGEN) {
      for (const v of a.voraussetzungen) {
        if (v.art !== 'hardware') continue;
        // Die eine Ausnahme: eine Komponente kann man ANLEGEN.
        if (v.behebung) expect(v.behebung.ziel, `${a.id}/${v.id}`).toBe('modell');
      }
    }
  });

  it('das Behebungs-Ziel kommt aus dem geschlossenen Vokabular', () => {
    const ziele = ['einstellungen', 'modell', 'ladepark', 'voltpilot'];
    for (const a of ANWENDUNGEN) {
      for (const v of a.voraussetzungen) {
        if (!v.behebung) continue;
        expect(ziele, `${a.id}/${v.id}`).toContain(v.behebung.ziel);
        // ⚠ `voltpilot` hat KEIN Klickziel - dort steht ein Satz, kein Knopf.
        if (v.behebung.ziel === 'voltpilot') expect(v.behebung.label).toBeNull();
        else expect(v.behebung.label, `${a.id}/${v.id}`).toBeTruthy();
      }
    }
  });
});
