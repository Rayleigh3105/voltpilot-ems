import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { anlageSidebar, moreSheetItems } from './anlageNav';
import { healthBadge } from './health';
import { cockpitStack, projectionActive } from './cockpit';
import { cockpitWidgets } from './cockpitWidgets';
import { hasTopology } from './adaptiveLive';
import { modeChips } from './portfolio';
import { anlageSurface, type AnlageSurfaceInput } from './surface';
import type { OverviewSite } from './api';

/**
 * M6 (#534) — die Migrations-Invarianten der „Projektion" an EINER Stelle
 * (report `data/vp-anlagen-face-k9/report.md` §6).
 *
 * Die Cockpit-Hälfte des v1-Beweises steht in `pages/AnlagenPage.test.tsx`
 * (M3: zwei DOMs, zeichengleich). Hier wird die Invariante über ALLE
 * Projektions-Oberflächen konsolidiert — Shell (M1), Cockpit-Weiche (M3) und
 * Portfolio-Spalte (M6) — plus die beiden Abbau-Invarianten (FACES weg,
 * `usage_profile_override` nur noch als Template-Wähler).
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
      // selbst mit vollständigen Live-, Tages- und Wetterdaten.
      expect(
        cockpitWidgets({
          blocks: s.cockpitBlocks,
          modes: s.modes,
          lead: null,
          channels: s.base.telemetryChannels,
          snapshot: { pvKw: 4, loadKw: 2, gridKw: 1, battKw: 1, socPct: 55, socAt: null },
          dayTotals: {
            consumptionKwh: 10,
            pvGenerationKwh: 20,
            gridImportKwh: 1,
            gridExportKwh: 2,
            gridCostEur: 0.5,
            batterySavingsEur: 0.4,
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
    // Unbekannt (älteres Backend / Ladefehler) fällt still auf v1 zurück.
    expect(projectionActive({ hasEntities: null, adaptive: null })).toBe(false);
    expect(projectionActive({ hasEntities: undefined, adaptive: undefined })).toBe(false);
    expect(projectionActive({ hasEntities: true, adaptive: true })).toBe(true);
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
        'live',
        'historie',
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
    expect(healthBadge({})).toEqual({ state: 'ok', label: 'Alles in Ordnung', detail: null });
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

  it('das „Mehr ▾"-Popover ist vollständig weg (v3 M1)', () => {
    const files = sourceFiles();
    expect(files.some((f) => /AnlageMoreMenu\.tsx?$/.test(f))).toBe(false);
    for (const f of files) {
      const code = readFileSync(f, 'utf8');
      expect(code).not.toMatch(/AnlageMoreMenu|DEEP_VIEW_ITEMS|vp-more-btn/);
    }
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
