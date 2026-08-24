import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { anlageSidebar, moreSheetItems } from './anlageNav';
import { healthBadge } from './health';
import { anlageDecision, cockpitStack, projectionActive } from './cockpit';
import { cockpitWidgets } from './cockpitWidgets';
import { hasTopology } from './adaptiveLive';
import { modeChips } from './portfolio';
import {
  ANWENDUNGEN,
  REGAL,
  derivedAnwendungen,
  presetSchaltplan,
  presetVorschlag,
  regalFuerProfil,
  vorauswahl,
} from './anwendungen';
import { fleetKind, fleetTonalitaet, siteTonalitaet } from './fleet';
import { profileStatesFrom } from './profiles';
import { profileRows } from './steuerungArea';
import { showTechnicalLayer } from './rollen';
import {
  BAUSTEINE,
  CANONICAL_DESKTOP,
  CANONICAL_PHONE,
  layoutResolve,
  presetLayout,
} from './cockpitLayout';
import { MODE_RANK, anlageSurface, type AnlageSurfaceInput } from './surface';
import type { OverviewSite } from './api';

/**
 * M6 (#534) — die Migrations-Invarianten der „Projektion" an EINER Stelle
 * (report `data/vp-anlagen-face-k9/report.md` §6), erweitert um die
 * Captain-Nachtrag-Invarianten vom 06.08.2026 (`fm/vp-erst-alt-layout-r5`):
 * der v1-Zonen-Dashboard-Renderpfad ist ERSATZLOS entfallen.
 *
 * Die Cockpit-Hälfte des v1-Beweises steht in `pages/AnlagenPage.test.tsx`
 * (M3: zwei DOMs, zeichengleich) und `pages/AnlagenPage.v1.test.tsx` (der
 * Beweis über die ECHTEN Weichen inkl. Lade-/Fehler-/Nicht-zugeordnet-Zustand).
 * Hier wird die Invariante über ALLE Projektions-Oberflächen konsolidiert —
 * Shell (M1), Cockpit-Weiche (M3) und Portfolio-Spalte (M6) — plus die
 * Abbau-Invarianten (FACES weg, `usage_profile_override` nur noch als
 * Template-Wähler, und seit dem Nachtrag: KEIN v1-Renderpfad kehrt zurück).
 *
 * Alles hier ist pur: eine nie migrierte Anlage darf NIRGENDWO etwas Neues
 * erzeugen, und das lässt sich ohne DOM festnageln.
 */

/** Das Portal-Quellverzeichnis (vitest läuft im `frontend/portal`-Root). */
const SRC = join(process.cwd(), 'src') + '/';

/**
 * Kommentare weg (das `copy.test.ts`-Muster): ein Abbau-Wächter prüft, was der
 * Code TUT, nicht was eine Grabstein-Notiz über einen entfernten Namen sagt.
 * Über-Strippen kann höchstens einen Verstoß verstecken, nie einen erfinden.
 */
function ohneKommentare(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Alle Portal-Quelldateien (ohne Tests) — für die Abbau-Invarianten. */
function sourceFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** Wie `sourceFiles`, aber inklusive `.css` — für den CSS-Teardown-Wächter. */
function allSourceFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...allSourceFiles(full));
    } else if (/\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Die nie migrierte Anlage: keine v2-Entitäten, keine Strategie-Knoten, keine
 * Geld-/Vertrags-Stammdaten, keine Flows. Genau der Zustand jeder heutigen
 * Bestandsanlage vor der Umstellung.
 */
const NIE_MIGRIERT: AnlageSurfaceInput = {
  signals: {
    hasStorage: false,
    hasPv: false,
    hasControllableConsumer: false,
    activeStrategyNodeTypes: [],
    plantKind: 'eigenverbrauch',
    hasLeistungspreis: false,
  },
  config: { plantKind: 'eigenverbrauch', tarifArt: 'ohne', netzladenErlaubt: false },
  flows: [],
  entities: [],
};

/** Ein älteres Backend / ein Ladefehler: gar nichts geladen. */
const NICHTS_GELADEN: AnlageSurfaceInput = {};

function overviewSite(over: Partial<OverviewSite> = {}): OverviewSite {
  return {
    id: 's-alt',
    name: 'Bestandsanlage',
    plantKind: 'eigenverbrauch',
    netzladenErlaubt: false,
    batteryWithoutDevice: false,
    deviceCount: 1,
    onlineCount: 1,
    waitingCount: 0,
    worstStatus: 'online',
    lastSeenAt: null,
    live: null,
    plannedSavingsTodayEur: null,
    ...over,
  };
}

describe('v1 bleibt v1 — eine nie migrierte Anlage erzeugt nirgendwo Neues', () => {
  it('die Projektion ist leer (kein Modus, kein Block, keine Tiefe)', () => {
    for (const input of [NIE_MIGRIERT, NICHTS_GELADEN]) {
      const s = anlageSurface(input);
      expect(s.base.hasEntities).toBe(false);
      expect(s.modes).toEqual([]);
      expect(s.cockpitBlocks).toEqual([]);
      expect(s.moneyStreams).toEqual([]);
      expect(s.deepViews).toEqual([]);
      // Auch der Renderer bekommt nichts zu stapeln.
      expect(cockpitStack(s.cockpitBlocks, null)).toEqual([]);
      // Portal v3 M2: und das Live-Cockpit bekommt keine einzige Kachel -
      // selbst mit vollständigen Tages- und Wetterdaten.
      expect(
        cockpitWidgets({
          blocks: s.cockpitBlocks,
          modes: s.modes,
          lead: null,
          dayTotals: {
            consumptionKwh: 10,
            pvGenerationKwh: 20,
            gridImportKwh: 1,
            gridExportKwh: 2,
            gridCostEur: 0.5,
            tarifArt: 'ohne',
            batterySavingsPlannedEur: 0.4,
            autarkiePct: 70,
            eigenverbrauchPct: 60,
          },
          streams: s.moneyStreams,
          range: 'month',
          now: new Date('2026-07-22T12:00:00+02:00'),
          weather: { nextHourTempC: 21, why: 'Sonnig bis 18 Uhr.' },
        }),
      ).toEqual([]);
    }
  });

  it('die Cockpit-Weiche bleibt zu — BEIDE Tore müssen offen sein', () => {
    const s = anlageSurface(NIE_MIGRIERT);
    expect(projectionActive({ hasEntities: s.base.hasEntities, adaptive: true })).toBe(false);
    // Selbst MIT Entitäten: die bestehende Topologie-Weiche bleibt Gesetz.
    expect(projectionActive({ hasEntities: true, adaptive: false })).toBe(false);
    // Unbekannt (älteres Backend / Ladefehler, NACH dem Laden) ⇒ kein Stapel.
    expect(projectionActive({ hasEntities: null, adaptive: null })).toBe(false);
    expect(projectionActive({ hasEntities: undefined, adaptive: undefined })).toBe(false);
    expect(projectionActive({ hasEntities: true, adaptive: true })).toBe(true);
  });

  it('anlageDecision: eine nie migrierte, aber FERTIG geladene Anlage ist "unassigned", nie "stack"', () => {
    // Captain-Nachtrag 06.08.2026: es gibt keinen v1-Rückfall mehr - eine
    // Anlage ohne Entitäten ist entweder der M5-Einrichtungspfad (siehe
    // `setupPath.ts`, außerhalb dieses Moduls) oder der ehrliche
    // "nicht zugeordnet"-Endzustand. `anlageDecision` selbst kennt den
    // Einrichtungspfad nicht - das entscheidet der Aufrufer zusätzlich.
    const s = anlageSurface(NIE_MIGRIERT);
    expect(
      anlageDecision({
        loading: false,
        failed: false,
        timedOut: false,
        hasEntities: s.base.hasEntities,
        adaptive: true,
      }),
    ).toBe('unassigned');
    // Und solange die Entscheidungs-Eingaben noch laufen, wird GAR NICHTS
    // entschieden - das ist der eigentliche Fix des "erst die alte Ansicht"-
    // Defekts.
    expect(
      anlageDecision({
        loading: true,
        failed: false,
        timedOut: false,
        hasEntities: s.base.hasEntities,
        adaptive: true,
      }),
    ).toBe('pending');
  });

  it('die Live-Weiche (hasTopology) bleibt unverändert Gesetz', () => {
    expect(hasTopology(null)).toBe(false);
    expect(hasTopology(undefined)).toBe(false);
    expect(hasTopology({ entities: [], topology: { nodes: [], flows: [] } } as never)).toBe(false);
    expect(
      hasTopology({ entities: [{}], topology: { nodes: [], flows: [] } } as never),
    ).toBe(false);
  });

  it('die M1-Shell trägt weder Badge noch Modus-Gruppe', () => {
    for (const input of [NIE_MIGRIERT, NICHTS_GELADEN]) {
      const s = anlageSurface(input);
      const sidebar = anlageSidebar(s);
      // Nur die Basis-Gruppe - keine einzige Modus-Gruppe.
      expect(sidebar.groups).toHaveLength(1);
      expect(sidebar.groups[0].label).toBe('Anlage');
      expect(sidebar.groups[0].items.map((i) => i.key)).toEqual([
        'cockpit',
        // Die Basis-Welt der Historie; „Erlöse" ist modusgebunden und fehlt
        // auf einer nie migrierten Anlage folgerichtig.
        'messwerte',
        'steuerung',
        'anlagen-modell',
      ]);
      // Kein „0"-Badge, das die Anlage schlechter aussehen lässt, als sie ist.
      expect(sidebar.groups[0].items.every((i) => i.badge === null)).toBe(true);
      // Und im Mehr-Blatt taucht ebenfalls keine Modus-Gruppe auf.
      expect(moreSheetItems(sidebar).every((g) => g.tone === null)).toBe(true);
    }
  });

  it('das Gesundheits-Abzeichen erfindet nichts (kein v2-Drift, keine Fakten)', () => {
    // Ohne geladene Fakten: grün, aber OHNE erfundenen Befund.
    expect(healthBadge({})).toEqual({ state: 'ok', label: 'Alles in Ordnung', detail: null, findings: [] });
    // Eine Bestandsanlage hat keine v2-Entitäten - Soll/Ist-Drift ist damit
    // strukturell unmöglich und darf nie einen Hinweis erzeugen.
    expect(healthBadge({ entityDrift: false }).detail).toBeNull();
    expect(healthBadge({ entityDrift: null }).state).toBe('ok');
    // Ein stilles Gerät bleibt aber auch auf einer v1-Anlage sichtbar.
    expect(
      healthBadge({ devices: { deviceCount: 1, onlineCount: 0, waitingCount: 0 } }).state,
    ).toBe('warnung');
  });

  it('die Portfolio-Zeile zeigt keine Modus-Chips (die Zelle liest „—")', () => {
    expect(modeChips(overviewSite(), null)).toEqual([]);
    // Auch dann nicht, wenn ein älteres Backend roleCounts/usageProfile weglässt
    // und der SiteDto keine Tarif-/Leistungspreis-Angabe trägt.
    expect(
      modeChips(overviewSite({ roleCounts: undefined, usageProfile: undefined }), {
        tarifArt: 'ohne',
        leistungspreisEurKw: null,
      }),
    ).toEqual([]);
  });
});

describe('Abbau-Invarianten (M6)', () => {
  it('FACES ist vollständig weg — kein adaptiveNav-Modul, keine FACES-Konstante', () => {
    const files = sourceFiles();
    expect(files.some((f) => /adaptiveNav\.tsx?$/.test(f))).toBe(false);
    for (const f of files) {
      const code = readFileSync(f, 'utf8');
      // Der Doc-Kommentar in anlageNav.ts erklärt die LÖSCHUNG - erlaubt ist
      // nur die Erwähnung in einem Kommentar, nie eine echte Verwendung.
      expect(code).not.toMatch(/\bconst\s+FACES\b|\bFACES\s*[:=]|from\s+'.*adaptiveNav'/);
    }
  });

  /**
   * Das Anlagen-Modell komponiert der SERVER (Captain-Order 10.08.2026): der
   * Assistent rief `entitiesApi.bootstrap` hinter einem `if (admin)` auf, und
   * genau deshalb bekam ein KUNDE nie eine Komposition. Der Aufruf ist
   * ersatzlos entfallen; bliebe er „als Sofort-Refresh für Admins" stehen,
   * gäbe es wieder zwei Wege zu derselben Wirkung - und der Kunden-Weg wäre
   * erneut der stille.
   */
  it('kein Kunden-Assistent stösst die v2-Komposition an - das tut der Server', () => {
    for (const f of sourceFiles()) {
      // Die Admin-Konsole darf den Bootstrap-Endpunkt weiter besitzen; jede
      // ANDERE Fläche (allen voran der Anlege-Assistent) nicht.
      if (f.includes('/pages/admin/') || f.endsWith('entitiesApi.ts')) continue;
      expect(readFileSync(f, 'utf8')).not.toMatch(/entitiesApi\.bootstrap|v2-entities\/bootstrap/);
    }
  });

  it('das „Mehr ▾"-Popover ist vollständig weg (v3 M1)', () => {
    const files = sourceFiles();
    expect(files.some((f) => /AnlageMoreMenu\.tsx?$/.test(f))).toBe(false);
    for (const f of files) {
      const code = readFileSync(f, 'utf8');
      expect(code).not.toMatch(/AnlageMoreMenu|DEEP_VIEW_ITEMS|vp-more-btn/);
    }
  });

  it('V2: das Widget-Detail-Modal ist vollständig weg (Teardown-Wächter)', () => {
    // Die Modal-Dateien sind gelöscht (`AnlageMoreMenu`-Präzedenzfall) …
    const files = sourceFiles();
    expect(files.some((f) => /components\/WidgetModal\.tsx?$/.test(f))).toBe(false);
    expect(files.some((f) => /components\/WidgetHistoryChart\.tsx?$/.test(f))).toBe(false);
    expect(files.some((f) => /widgetHistory\.tsx?$/.test(f))).toBe(false);
    // … kein `widgetHistory`-Import mehr irgendwo …
    for (const f of files) {
      expect(readFileSync(f, 'utf8')).not.toMatch(/from\s+'.*widgetHistory'|WidgetModal|WidgetHistoryChart/);
    }
    // … und keine `vp-wmodal`/`vp-chart-modal`-Klasse mehr, auch nicht im CSS.
    for (const f of allSourceFiles()) {
      expect(readFileSync(f, 'utf8')).not.toMatch(/vp-wmodal|vp-chart-modal/);
    }
  });

  it('Cockpit+Live-Merge: die Live-Daten-Seite ist vollständig weg (Teardown-Wächter)', () => {
    // Option A: die frühere Live-Daten-Seite und ihre beiden Hero-Komponenten
    // sind gelöscht (das Cockpit hostet Board + Verlauf selbst). Der Wächter
    // liest die Quellen (AnlageMoreMenu-Präzedenzfall): keine Datei, kein
    // Import, keine Verwendung mehr — auch nicht in einem Kommentar.
    const files = sourceFiles();
    expect(files.some((f) => /pages\/LiveSection\.tsx?$/.test(f))).toBe(false);
    expect(files.some((f) => /components\/AdaptiveLiveView\.tsx?$/.test(f))).toBe(false);
    expect(files.some((f) => /components\/LiveHero\.tsx?$/.test(f))).toBe(false);
    for (const f of files) {
      const code = readFileSync(f, 'utf8');
      expect(code).not.toMatch(/LiveSection|AdaptiveLiveView|\bLiveHero\b/);
    }
  });

  it('Captain-Nachtrag 06.08.2026: der v1-Zonen-Dashboard-Renderpfad kehrt NIE zurück', () => {
    // `fm/vp-erst-alt-layout-r5`: der frühere v1-Rückfall der Anlagen-Seite ist
    // ERSATZLOS entfallen (nicht nur "während des Ladens vermieden") - die
    // Seite kennt seither drei Zustände (pending/error/entschieden), nie mehr
    // ein Ersatz-Layout. Der Wächter liest die Quellen (AnlageMoreMenu-
    // Präzedenzfall): keine Datei, kein Import, keine Verwendung mehr.
    const files = sourceFiles();
    const goneFiles = [
      /planAccuracy\.tsx?$/,
      /moneyEmphasis\.tsx?$/,
      /components\/ErtragChart\.tsx?$/,
      /components\/HealthChecklist\.tsx?$/,
      /components\/PeakBand\.tsx?$/,
    ];
    for (const pattern of goneFiles) {
      expect(files.some((f) => pattern.test(f))).toBe(false);
    }
    for (const f of files) {
      const code = readFileSync(f, 'utf8');
      // Die v1-only Komponenten/Helfer - AnlagenPage.tsx darf keine davon mehr
      // definieren, importieren oder tatsächlich AUFRUFEN; kein anderer Ort
      // darf sie neu erfinden. Gematcht wird ECHTE Verwendung (JSX-Tag,
      // Funktionsaufruf, Import) - nicht die bloße Erwähnung in einem
      // erklärenden Kommentar (der FACES-Präzedenzfall oben).
      expect(code).not.toMatch(
        /<AnlageHero\b|<EnergyStatsRow\b|<MonthRail\b|<MoneyGlanceCard\b|<PlanTrafCard\b|<DetailCard\b|\bplanTrafZu\(|:\s*PlanTrafZu\b|\bleadArtifact\(|\bmoneyLayout\(|from\s+'\.\.?\/planAccuracy'|from\s+'\.\.?\/moneyEmphasis'/,
      );
      // Und keine v1-Zonen-Dashboard-Klasse mehr, auch nicht im CSS.
      expect(code).not.toMatch(
        /vp-anlage-dash|vp-zone-money|vp-zone-live|vp-zone-rail|vp-dash-hero|vp-dash-ertrag|vp-dash-energy|vp-dash-plantraf|vp-dash-rail|vp-detail-grid|vp-detail-card|vp-money-glance|vp-plantraf\b|vp-mstrip-mobile|vp-lead-peakband|vp-money-nachweis\b|vp-money-min\b/,
      );
    }
  });

  it('M3: eine Anlage ohne Profil-Zeilen erzeugt NICHTS Neues', () => {
    // Ein Backend ohne `GET /sites/{id}/profiles` (oder eine Anlage, auf der
    // noch nie ein Profil geschaltet wurde) liefert KEINE Zustände - die
    // Projektion muss dann zeichengleich zu vorher sein.
    const ohne = anlageSurface(NIE_MIGRIERT);
    expect(anlageSurface({ ...NIE_MIGRIERT, profileStates: null })).toEqual(ohne);
    expect(anlageSurface({ ...NIE_MIGRIERT, profileStates: {} })).toEqual(ohne);
    expect(profileStatesFrom(null)).toBeNull();
    // Und die Projektion selbst bleibt leer: keine Modi, keine Blöcke.
    expect(ohne.modes).toEqual([]);
    expect(ohne.cockpitBlocks).toEqual([]);
    // Das Regal einer Anlage ohne Server-Antwort ist leer, nie erfunden.
    expect(profileRows(null, ohne.modes, null)).toEqual([]);
    expect(profileRows([], ohne.modes, null)).toEqual([]);
  });

  it('Anwendungs-Katalog Stufe 1: eine Bestandsanlage rendert exakt wie vorher', () => {
    // Der EINE Anwendungs-Katalog bringt VIER neue Regal-Einträge mit
    // (monitoring · speicher-fahrplan · ueberschuss · verbraucher). KEINER von
    // ihnen ist eine M0-Modus-Art - die PROJEKTION (Cockpit-Blöcke, Nav-Gruppen,
    // Manifeste) bleibt damit unberührt, und eine nie migrierte Anlage sieht
    // zeichengleich aus wie vor der Stufe.
    const ohne = anlageSurface(NIE_MIGRIERT);
    expect(ohne.modes).toEqual([]);
    expect(ohne.cockpitBlocks).toEqual([]);
    expect(ohne.deepViews).toEqual([]);
    expect(ohne.moneyStreams).toEqual([]);
    // Die Projektions-Rangfolge ist NICHT katalog-gespeist (der Katalog-`rang`
    // ordnet das REGAL, `MODE_RANK` die aktiven Modi) - sie steht unverändert.
    expect(MODE_RANK).toEqual({
      lastmanagement: 5,
      lastspitzenkappung: 10,
      'atypische-netznutzung': 20,
      marktvermarktung: 30,
      automation: 50,
    });
    // Es gibt genau die vier bekannten Modus-Arten; ein neuer Katalog-Eintrag
    // darf sich NICHT in die Projektion schleichen.
    expect(Object.keys(MODE_RANK).sort()).toEqual([
      'atypische-netznutzung',
      'automation',
      'lastmanagement',
      'lastspitzenkappung',
      'marktvermarktung',
    ]);
  });

  it('Anwendungs-Katalog Stufe 1: `site_profile_state` behält Schlüssel und Semantik', () => {
    // Die gespeicherten Zeilen einer Bestandsanlage tragen die VIER alten
    // Schlüssel - der Katalog hat keinen davon umbenannt (eine angewandte
    // Migration ist unveränderlich, und das Regal ist der An/Aus-Ort derselben
    // Ids).
    for (const id of [
      'marktvermarktung',
      'lastspitzenkappung',
      'atypische-netznutzung',
      'lastmanagement',
    ]) {
      expect(REGAL.map((a) => a.id)).toContain(id);
    }
    // `aus` unterdrückt weiterhin einen abgeleiteten Modus, `an` erfindet keinen.
    const dv: AnlageSurfaceInput = {
      ...NIE_MIGRIERT,
      config: { plantKind: 'direktvermarktung' },
    };
    expect(anlageSurface(dv).modes.map((m) => m.kind)).toEqual(['marktvermarktung']);
    expect(
      anlageSurface({ ...dv, profileStates: { marktvermarktung: 'aus' } }).modes,
    ).toEqual([]);
    expect(anlageSurface({ ...NIE_MIGRIERT, profileStates: { marktvermarktung: 'an' } }).modes)
      .toEqual([]);
  });

  it('Anwendungs-Katalog Stufe 1: eine Anlage OHNE Fähigkeiten aktiviert nur Monitoring', () => {
    // Der Server erfindet nichts: ohne Speicher, ohne Ladepunkt, ohne Flow und
    // ohne Leistungspreis ist genau EINE Anwendung abgeleitet aktiv - die
    // Beobachtung selbst; die zwei Regel-Anwendungen bleiben aus.
    expect(
      derivedAnwendungen({
        hasStorage: false,
        hasPv: false,
        hasControllableConsumer: false,
        hasChargePoint: false,
        hasMeasurement: false,
        hasLeistungspreis: false,
        hasGridLimit: false,
        activeNodeTypes: [],
        hasCustomerRule: false,
        plantKind: 'eigenverbrauch',
        tarifArt: 'ohne',
        netzladenErlaubt: false,
      }),
    ).toEqual(['monitoring']);
    // Die zwei RESERVIERTEN Einträge stehen im Katalog, aber nie im Regal.
    expect(ANWENDUNGEN.map((a) => a.id)).toContain('berichte');
    expect(REGAL.map((a) => a.id)).not.toContain('berichte');
    expect(REGAL.map((a) => a.id)).not.toContain('eigene-auswertung');
  });

  it('Anwendungs-Preset Stufe 2: eine Anlage OHNE Profil rendert exakt wie vorher', () => {
    // `site.profil` ist bei JEDER Bestandsanlage null (die Migration setzt
    // keinen Default). Daraus folgen drei Byte-Identitäten:
    //  1. die Tonalität fällt auf die bisherige plant_kind-Regel zurück,
    expect(siteTonalitaet({ plantKind: 'eigenverbrauch' })).toBe('eigenverbrauch');
    expect(siteTonalitaet({ profil: null, plantKind: 'direktvermarktung' })).toBe(
      'direktvermarktung',
    );
    expect(
      fleetTonalitaet([
        { plantKind: 'direktvermarktung' },
        { plantKind: 'eigenverbrauch' },
      ]),
    ).toBe(fleetKind(['direktvermarktung', 'eigenverbrauch']));
    //  2. das Regal wird nicht umsortiert und nichts eingeklappt,
    const regal = regalFuerProfil(null);
    expect(regal.vorne).toEqual(REGAL);
    expect(regal.weitere).toEqual([]);
    //  3. und der Assistent schlägt NICHTS vor, schaltet also auch nichts.
    expect(vorauswahl(null)).toEqual([]);
    const karten = [
      { id: 'marktvermarktung', label: 'Marktoptimierung', state: null, active: true, requirements: [] },
    ];
    expect(presetVorschlag(null, karten)).toEqual({ ticken: [], zurueckgestellt: [] });
    expect(presetSchaltplan([], ['marktvermarktung'], karten)).toEqual([]);
  });

  it('Anwendungs-Preset Stufe 2: das Profil ist NIE ein Signal der Ableitung', () => {
    // Captain-Entscheid E3. Die Ableitung kennt das Feld gar nicht - ihre
    // Eingabe (`AnwendungSignals`) hat keinen Platz dafür, und genau das ist
    // der Beweis: was auf einer Anlage läuft, bleibt Anwendungen x Fähigkeiten.
    const signals = {
      hasStorage: false,
      hasPv: false,
      hasControllableConsumer: false,
      hasChargePoint: false,
      hasMeasurement: false,
      hasLeistungspreis: false,
      hasGridLimit: false,
      activeNodeTypes: [],
      hasCustomerRule: false,
      plantKind: 'eigenverbrauch',
      tarifArt: 'ohne',
      netzladenErlaubt: false,
    };
    expect(Object.keys(signals)).not.toContain('profil');
    expect(derivedAnwendungen(signals)).toEqual(['monitoring']);
  });

  it('M7: die technische Schicht ist standardmäßig zu (ohne Admin-Token)', () => {
    // Ohne Plattform-Admin-Token (der Kundenfall UND ein älteres Backend / ein
    // Ladefehler) bleibt die Installateur-Ansicht geschlossen - eine Bestands-
    // oder Kundenanlage bekommt nie Entitätstypen, Kanäle oder Guard-Bänder zu
    // sehen. Genau EIN Helfer entscheidet das (rollen.showTechnicalLayer).
    expect(showTechnicalLayer()).toBe(false);
  });

  it('`usage_profile_override` wird NIRGENDS mehr geschrieben (Anwendungs-Programm Stufe 2)', () => {
    // Stufe 2 hat den letzten Schreibpfad entfernt (der Wizard-Vorwahl-Block).
    // Die DB-SPALTE bleibt lesbar und das Backend ist unangetastet - das
    // Portal schreibt sie nur nicht mehr. Geprüft wird auf dem KOMMENTAR-freien
    // Text: die Grabstein-Notizen in `adaptiveOnboarding.ts`/`AnlageFlow.tsx`
    // nennen die entfernten Namen absichtlich, und ein Wächter, der daran
    // scheitert, verböte seine eigene Dokumentation.
    const schreiber = sourceFiles().filter((f) =>
      /setUsageProfileOverride|overrideForChoice/.test(ohneKommentare(readFileSync(f, 'utf8'))),
    );
    expect(schreiber.map((f) => f.slice(SRC.length))).toEqual([]);
  });

  it('Stufe 2: das PRESET wird über die schmale Route geschrieben, nie über updateSite', () => {
    // Der EINE Schreibpfad ist `api.setAnwendungsPreset` (die schmale Route);
    // ein voll-repräsentatives `updateSite` aus dem Assistenten heraus wäre ein
    // Überschreib-Risiko für die Tarif-/Vergütungsfelder, die der Schritt nie
    // geladen hat.
    const schreiber = sourceFiles().filter((f) =>
      /setAnwendungsPreset/.test(ohneKommentare(readFileSync(f, 'utf8'))),
    );
    // api.ts = die Route selbst, AnlageFlow.tsx = der Assistent,
    // AnlageTechnik.tsx = „Profil ändern" in den Einstellungen.
    expect(schreiber.map((f) => f.slice(SRC.length)).sort()).toEqual([
      'api.ts',
      'components/AnlageFlow.tsx',
      'pages/AnlageTechnik.tsx',
    ]);
  });
});

describe('Anwendungs-Programm Stufe 3 — das Cockpit-Layout einer Bestandsanlage', () => {
  /**
   * Die tragende Invariante der Stufe: `cockpit_layout` ist für JEDE
   * Bestandsanlage leer, und `site.profil` ist NULL. Ohne beides muss die
   * Auflösung Zeichen für Zeichen die kanonische Reihenfolge liefern — die
   * DOM-Hälfte des Beweises steht in `pages/AnlagenPage.test.tsx` („rendert
   * OHNE gespeicherte Zeile Zeichen für Zeichen dasselbe wie ohne die Route").
   */
  const ALLE = [...CANONICAL_DESKTOP];

  it('ohne Zeile und ohne Profil ist die Auflösung der Katalog-Standard', () => {
    for (const canonical of [CANONICAL_DESKTOP, CANONICAL_PHONE]) {
      const r = layoutResolve({ canonical, verfuegbar: ALLE });
      expect(r.order).toEqual(canonical);
      expect(r.hidden).toEqual([]);
      expect(r.quelle).toBe('katalog');
    }
  });

  it('eine Anlage ohne Profil bekommt keine Preset-Schicht', () => {
    expect(presetLayout(null)).toBeNull();
    expect(presetLayout(undefined)).toBeNull();
  });

  it('die kanonischen Listen führen dieselben Bausteine wie der Katalog', () => {
    const katalog = BAUSTEINE.map((b) => b.id).sort();
    expect([...CANONICAL_DESKTOP].sort()).toEqual(katalog);
    expect([...CANONICAL_PHONE].sort()).toEqual(katalog);
  });

  it('die Rechner-Reihenfolge ist die frühere hart codierte Folge des Stapels', () => {
    // Vor Stufe 3 stand sie als JSX-Folge in `pages/AnlagenPage.tsx`: Bühne
    // (mit Geld-Leiste und Steuerungs-Fuß in ihr) → Kacheln → Börsenpreis →
    // Fahrplan → Komponenten → Zustand. Wer sie ändert, ändert das Cockpit
    // JEDER Bestandsanlage — deshalb steht sie hier als Wächter.
    expect(CANONICAL_DESKTOP).toEqual([
      'status',
      'energiefluss',
      'geld',
      'steuerung',
      'kacheln',
      'strompreis',
      'fahrplan',
      'komponenten',
      'zustand',
    ]);
    // Am Telefon führen die zwei täglichen Fragen als Zeilen (Mobil-Umbau).
    expect(CANONICAL_PHONE).toEqual([
      'status',
      'energiefluss',
      'geld',
      'fahrplan',
      'steuerung',
      'strompreis',
      'kacheln',
      'komponenten',
      'zustand',
    ]);
  });

  it('das Layout ist server-seitig — im Portal gibt es dafür KEIN localStorage', () => {
    // Hausregel (§2.4): Layout-Präferenzen liegen nie im Browser; der Admin
    // gestaltet für den Kunden, also muss der Speicher RLS-gefenced sein.
    const layoutCode = readFileSync(join(SRC, 'cockpitLayout.ts'), 'utf8');
    const hookCode = readFileSync(join(SRC, 'useCockpitLayout.ts'), 'utf8');
    for (const code of [layoutCode, hookCode]) {
      expect(ohneKommentare(code)).not.toContain('localStorage');
      expect(ohneKommentare(code)).not.toContain('sessionStorage');
    }
  });
});
