import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { anlageTrio, modeNavGroup } from './anlageNav';
import { cockpitStack, projectionActive } from './cockpit';
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
    const s = anlageSurface(NIE_MIGRIERT);
    const trio = anlageTrio(s.modes.length);
    expect(trio.map((a) => a.key)).toEqual(['uebersicht', 'steuerung', 'geraete']);
    // Kein „0"-Badge, das die Anlage schlechter aussehen lässt, als sie ist.
    expect(trio.every((a) => a.badge === null)).toBe(true);
    expect(modeNavGroup(s.deepViews)).toBeNull();
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
