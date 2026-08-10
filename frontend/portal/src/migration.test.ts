import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { anlageSidebar, moreSheetItems } from './anlageNav';
import { healthBadge } from './health';
import { anlageDecision, cockpitStack, projectionActive } from './cockpit';
import { cockpitWidgets } from './cockpitWidgets';
import { hasTopology } from './adaptiveLive';
import { modeChips } from './portfolio';
import { profileShelf, profileStatesFrom } from './profiles';
import { showTechnicalLayer } from './rollen';
import { anlageSurface, type AnlageSurfaceInput } from './surface';
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
    expect(profileShelf(null)).toEqual({ cards: [], weitere: [] });
  });

  it('M7: die technische Schicht ist standardmäßig zu (ohne Admin-Token)', () => {
    // Ohne Plattform-Admin-Token (der Kundenfall UND ein älteres Backend / ein
    // Ladefehler) bleibt die Installateur-Ansicht geschlossen - eine Bestands-
    // oder Kundenanlage bekommt nie Entitätstypen, Kanäle oder Guard-Bänder zu
    // sehen. Genau EIN Helfer entscheidet das (rollen.showTechnicalLayer).
    expect(showTechnicalLayer()).toBe(false);
  });

  it('`usage_profile_override` lebt nur noch als Auto-Start-Template-Wähler', () => {
    const users = sourceFiles().filter((f) =>
      /setUsageProfileOverride|overrideForChoice/.test(readFileSync(f, 'utf8')),
    );
    const names = users.map((f) => f.slice(SRC.length));
    // api.ts = der Endpunkt selbst (die DB-Spalte bleibt, das Backend ist
    // unangetastet), adaptiveOnboarding.ts = die reine Wahl-Logik,
    // AnlageFlow.tsx = der EINE Schreibpfad (der Wizard-Template-Wähler).
    expect(names.sort()).toEqual([
      'adaptiveOnboarding.ts',
      'api.ts',
      'components/AnlageFlow.tsx',
    ]);
  });
});
