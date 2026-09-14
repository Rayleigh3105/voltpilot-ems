import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { anlageSidebar } from './anlageNav';
import { healthBadge } from './health';
import { flussKnoten, ladenKachel } from './ladenKachel';
import { layoutFlow } from './adaptiveFlow';
import type { Topology } from './topology';
import { anlageDecision, cockpitStack, projectionActive } from './cockpit';
import { cockpitWidgets } from './cockpitWidgets';
import { hasTopology } from './adaptiveLive';
import { modeChips } from './portfolio';
import {
  ANWENDUNGEN,
  AUSSERHALB_REGAL,
  REGAL,
  betriebsmodellVorschlag,
  derivedAnwendungen,
  istCockpitGesteuert,
  presetSchaltplan,
  vorauswahl,
} from './anwendungen';
import { fleetKind, fleetTonalitaet, siteTonalitaet } from './fleet';
import { profileStatesFrom, type SiteProfile } from './profiles';
import { betriebsmodellKarten, betriebsmodellZone } from './betriebsmodelle';
import { profileRows } from './steuerungArea';
import { showTechnicalLayer } from './rollen';
import { JETZT_LEER, jetztZone } from './steuerungJetzt';
import { vorschlaege } from './vorschlaege';
import { regelFolgen } from './regeln/folgen';
import { VORRANG_FOLGEN, VORRANG_ZEILE } from './regeln/satz';
import {
  BAUSTEINE,
  CANONICAL_DESKTOP,
  CANONICAL_PHONE,
  anpassenDokument,
  eigeneAusSchichten,
  layoutResolve,
  mitEigenen,
  presetLayout,
} from './cockpitLayout';
import { MODE_RANK, anlageSurface, type AnlageSurfaceInput } from './surface';
import {
  CANONICAL_PORTFOLIO,
  PORTFOLIO_BAUSTEINE,
  anwendungenVonAnlage,
  portfolioDichte,
  portfolioKennzahlen,
  verfuegbareBausteine,
} from './portfolioCockpit';
import {
  canonicalShellRoute,
  isFleetShell,
  kopfPfad,
  orteAus,
  pfadWert,
  pfadZeile,
  redirectOverviewToAnlage,
  redirectToPortfolio,
  showOverviewNav,
  showPortfolioNav,
  startEbene,
  type Orte,
  type ShellInput,
} from './betriebsart';
import type { OverviewSite, Site } from './api';
import { anlagenOptionen } from './anlagenWahl';
import { anlageRoute, hashForRoute, pageRoute, standortRoute, type Route } from './nav';
import { AppShell } from './shell/AppShell';
import { ahrenbergUnternehmen, bestandEineAnlage, FIXTURE_IDS, halle1Entwurf } from './test/standorteFixtures';

// Die Schale braucht für den Byte-Vergleich (UEMS AP-01 IP-5) nur einen Namen
// am Avatar; alles andere aus `auth` bleibt echt (`rollen` liest `isPlatformAdmin`).
vi.mock('./auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./auth')>()),
  currentUser: () => ({ name: 'Jonas Wendlinger', email: 'jonas@example.test', roles: [] }),
}));

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

  it('die Schale trägt weder Badge noch einen Bereich, den die Anlage nicht hat', () => {
    for (const input of [NIE_MIGRIERT, NICHTS_GELADEN]) {
      const s = anlageSurface(input);
      const sidebar = anlageSidebar(s);
      // Ohne Speicher und ohne Ladepunkte fehlt der zweite Bereich ganz -
      // „ein Bereich ohne Inhalt existiert nicht" (E3).
      expect(sidebar.bereiche.map((b) => b.key)).toEqual([
        'cockpit',
        'verlauf',
        'steuerung',
        'anlage',
      ]);
      // Der Verlauf trägt genau seine EINE Basis-Welt; „Erlöse"/„Marktpreise"
      // sind modusgebunden und fehlen auf einer nie migrierten Anlage
      // folgerichtig - der Reiter-Streifen rendert damit gar nicht.
      expect(sidebar.bereiche.find((b) => b.key === 'verlauf')?.tabs.map((t) => t.key)).toEqual([
        'messwerte',
      ]);
      // Kein „0"-Badge, das die Anlage schlechter aussehen lässt, als sie ist.
      expect(sidebar.bereiche.every((b) => b.badge === null)).toBe(true);
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

describe('Verlauf-Sprache P1 · das Chrome der sechs Reiter', () => {
  /**
   * ⚠ **Der Wächter über Befund B1.** Vier der sechs Verlauf-Reiter trugen
   * einen SICHTBAREN Seitenkopf (`SUB_PAGES` in `AnlagenPage`), die anderen
   * zwei nie — die Bereichs-Reiter standen dadurch je nach Reiter bei 140 oder
   * 287/316 px und SPRANGEN bei jedem Wechsel. Ein neu eingetragener Kopf
   * bräche das still wieder: er sieht wie eine Verbesserung aus und ist die
   * teuerste Verletzung der stabilen Bühne (App-Kriterien A5/A8).
   *
   * Die Bereiche AUSSERHALB des Verlaufs behalten ihren Kopf — sie sind nicht
   * Teil von P1, und ein halb umgestelltes Portal wäre ein zweiter Sprung
   * statt keinem.
   */
  it('kein Verlauf-Reiter trägt einen sichtbaren Seitenkopf', () => {
    const code = ohneKommentare(readFileSync(join(SRC, 'pages/AnlagenPage.tsx'), 'utf8'));
    const block = code.slice(code.indexOf('const SUB_PAGES'));
    const gedeckelt = block.slice(0, block.indexOf('\n};'));
    for (const reiter of ['marktpreise', 'lastspitzen', 'prognose', 'wetter']) {
      expect(gedeckelt, reiter).not.toMatch(new RegExp(`\\n\\s*${reiter}\\s*:`));
    }
    // Nicht-vakuum: die Bereiche außerhalb des Verlaufs stehen weiterhin drin.
    expect(gedeckelt).toMatch(/\n\s*fahrplan\s*:/);
    expect(gedeckelt).toMatch(/\n\s*steuerung\s*:/);
  });

  /**
   * ⚠ Es gibt GENAU EINE Zeit-Leiste (V3). Vorher baute Marktpreise sie in
   * einem zweiten `vp-page-head` nach (Befund B2: drei Zeitraum-Bedienungen im
   * selben Bereich). Eine Kopie sieht im Browser gleich aus und driftet beim
   * ersten Feinschliff auseinander.
   */
  it('die Zeit-Leiste wird von den Reitern benutzt, nie nachgebaut', () => {
    for (const f of sourceFiles()) {
      if (/components\/HistorieWelt\.tsx$/.test(f)) continue;
      const code = ohneKommentare(readFileSync(f, 'utf8'));
      expect(code, f).not.toMatch(/className="vp-zeitleiste/);
    }
  });

  /**
   * ⚠ EINE Telefon-Grenze im Verlauf. `useIsPhone` fragt `(max-width: 720px)`;
   * eine zweite Grenze (700) ließ die Fläche zwischen 701 und 720 ihre
   * Telefon-Fassung in Schreibtisch-Maßen rendern.
   */
  it('kein Verlauf-Stylesheet trägt eine zweite Telefon-Grenze', () => {
    for (const f of sourceFiles()) {
      if (!/\.css$/.test(f)) continue;
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/@media\s*\((?:min|max)-width:\s*700px\)/);
    }
  });
});

describe('Abbau-Invarianten (M6)', () => {
  it('der Picker-Nullbestand gilt für jede Produktionsdatei, auch neue Geräteflächen', () => {
    for (const file of sourceFiles()) {
      const code = ohneKommentare(readFileSync(file, 'utf8'));
      expect(code, file).not.toMatch(/<select(?:\s|>)/i);
      expect(code, file).not.toMatch(/type\s*=\s*["'](?:date|time|datetime-local)["']/i);
      expect(code, file).not.toMatch(/<datalist(?:\s|>)/i);
    }
  });

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
    // Die gespeicherten Zeilen einer Bestandsanlage tragen die alten Schlüssel
    // - der Katalog hat keinen davon umbenannt (eine angewandte Migration ist
    // unveränderlich, und das Regal ist der An/Aus-Ort derselben Ids).
    for (const id of [
      'marktvermarktung',
      'lastspitzenkappung',
      'atypische-netznutzung',
    ]) {
      expect(REGAL.map((a) => a.id)).toContain(id);
    }
    // ⚠ `lastmanagement` behält seinen SCHLÜSSEL, hat aber seit dem
    // Verbrauchsmanagement v1 keinen Schalter mehr (Klasse `basis`); seine
    // Zeilen räumt die Migration V20260862000000 weg, damit ein gespeichertes
    // `aus` die Ladepunkt-Flächen nicht ohne Rückweg unterdrückt.
    expect(ANWENDUNGEN.find((a) => a.id === 'lastmanagement')?.klasse).toBe('basis');
    expect(REGAL.map((a) => a.id)).not.toContain('lastmanagement');
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
    // Der RESERVIERTE Eintrag steht im Katalog, aber nie im Regal.
    expect(ANWENDUNGEN.map((a) => a.id)).toContain('berichte');
    expect(REGAL.map((a) => a.id)).not.toContain('berichte');
    // Steuerung Stufe 8: die eigene Auswertung hat ihren SCHALTER verloren
    // (Klasse `cockpit`) - sie wird im Cockpit unter „Anpassen" gesteuert.
    // Abgeleitet wird sie weiterhin NIE (wie `ueberschuss`), und im Regal steht
    // sie seit Stufe 0 nicht: ausgeblendet, nicht gelöscht.
    expect(REGAL.map((a) => a.id)).not.toContain('eigene-auswertung');
    expect(AUSSERHALB_REGAL.map((a) => a.id)).toContain('eigene-auswertung');
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
    //  2. und der Assistent schlägt NICHTS vor, schaltet also auch nichts.
    expect(vorauswahl(null)).toEqual([]);
    const karten = [
      { id: 'marktvermarktung', label: 'Marktoptimierung', state: null, active: true, requirements: [] },
    ];
    expect(betriebsmodellVorschlag(null, karten)).toEqual({
      ticken: null,
      zurueckgestellt: null,
    });
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

  it('Steuerung Stufe 0: eine Bestandsanlage verliert NICHTS - nur das Regal wird kurz', () => {
    // Die Stufe blendet aus, sie löscht nicht. Der Beweis in vier Teilen:
    //  1. das Regal führt genau die Betriebsmodelle,
    expect(REGAL.map((a) => a.id)).toEqual([
      'marktvermarktung',
      'lastspitzenkappung',
      'atypische-netznutzung',
    ]);
    //  2. die anderen sind ausgeblendet, nicht weg,
    expect(AUSSERHALB_REGAL.map((a) => a.id)).toEqual([
      'monitoring',
      'speicher-fahrplan',
      'ueberschuss',
      'verbraucher',
      'lastmanagement',
      'eigene-auswertung',
    ]);
    //  3. das WILLENS-Overlay liest weiterhin JEDE Karte - ein gespeichertes
    //     `aus` einer Regel-Anwendung darf nicht verloren gehen, sonst würde
    //     ein abgeschalteter Modus stillschweigend wiederbelebt,
    expect(
      profileStatesFrom({
        profiles: [{ id: 'marktvermarktung', state: 'an' } as never],
        weitere: [{ id: 'ueberschuss', state: 'aus' } as never],
      }),
    ).toEqual({ marktvermarktung: 'an', ueberschuss: 'aus' });
    //     ... auch aus der Antwort eines ÄLTEREN Backends ohne `weitere`.
    expect(
      profileStatesFrom({ profiles: [{ id: 'ueberschuss', state: 'aus' } as never] }),
    ).toEqual({ ueberschuss: 'aus' });
    //  4. und die M0-Projektion ist unberührt: eine nie migrierte Anlage
    //     erzeugt weiterhin nichts.
    expect(anlageSurface(NIE_MIGRIERT).modes).toEqual([]);
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
      // Die Kachel „Laden" - am Rechner nach der Steuerungs-Zeile (E2).
      'laden',
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
      // Am Telefon direkt unter der Bühne (E2) - dort ist „lädt mein Auto?"
      // die erste Frage nach dem Fluss.
      'laden',
      'fahrplan',
      'steuerung',
      'strompreis',
      'kacheln',
      'komponenten',
      'zustand',
    ]);
  });

  it('Stufe 5: OHNE eigene Auswertungen ist alles Zeichen für Zeichen wie vorher', () => {
    // Die tragende Invariante der Stufe: `document.custom` ist für JEDE
    // Bestandsanlage leer (das Feld existierte nicht einmal). Ohne einen
    // einzigen Eintrag darf sich weder die kanonische Reihenfolge noch die
    // Auflösung noch das gespeicherte Dokument um ein Zeichen ändern.
    expect(mitEigenen(CANONICAL_DESKTOP, [])).toEqual(CANONICAL_DESKTOP);
    expect(mitEigenen(CANONICAL_PHONE, [])).toEqual(CANONICAL_PHONE);
    expect(eigeneAusSchichten({})).toEqual([]);
    expect(
      eigeneAusSchichten({
        eigen: { order: ['status'], hidden: [], shown: [], lead: null },
      }),
    ).toEqual([]);
    // Das gespeicherte Dokument trägt das Feld gar nicht erst - ein leeres
    // `custom: []` wäre eine Aussage, die es vorher nicht gab.
    const doc = anpassenDokument({
      arrangement: [...CANONICAL_DESKTOP],
      hidden: [],
      lead: null,
    });
    expect('custom' in doc).toBe(false);
    // Und die Auflösung bleibt der Katalog-Standard.
    const r = layoutResolve({ canonical: CANONICAL_DESKTOP, verfuegbar: ALLE });
    expect(r.order).toEqual(CANONICAL_DESKTOP);
    expect(r.quelle).toBe('katalog');
  });

  it('Stufe 5: eine eigene Auswertung landet an ihrer KANONISCHEN Stelle', () => {
    // Hinter den Kennzahlen (der Anker ihrer Vorlage), nicht hinten dran -
    // dieselbe Regel wie für jeden anderen frisch aufgetauchten Baustein.
    const def = {
      id: 'eigen:k1',
      titel: 'Wärmepumpe',
      darstellung: 'kachel' as const,
      entityId: 'e1',
      channel: 'power_kw',
      aggregat: 'jetzt' as const,
    };
    const canonical = mitEigenen(CANONICAL_DESKTOP, [def]);
    expect(canonical[canonical.indexOf('kacheln') + 1]).toBe('eigen:k1');
    expect(canonical.length).toBe(CANONICAL_DESKTOP.length + 1);
    // Sie ist erst verfügbar, wenn sie definiert ist - sonst würde die
    // Auflösung einen Schlüssel rendern, hinter dem nichts steht.
    expect(
      layoutResolve({ canonical, verfuegbar: [...ALLE, 'eigen:k1'] }).order,
    ).toContain('eigen:k1');
    expect(layoutResolve({ canonical, verfuegbar: ALLE }).order).not.toContain('eigen:k1');
  });

  it('Kachel „Laden": eine Anlage OHNE Ladepunkt sieht sie nie', () => {
    // Der Baustein steht in beiden kanonischen Listen, aber `verfuegbar` ist
    // der harte Filter davor: ohne Ladepunkt fällt er heraus, und das Cockpit
    // einer Bestandsanlage ist Zeichen für Zeichen das von vorher.
    const ohneLaden = ALLE.filter((id) => id !== 'laden');
    for (const canonical of [CANONICAL_DESKTOP, CANONICAL_PHONE]) {
      const r = layoutResolve({ canonical, verfuegbar: ohneLaden });
      expect(r.order).toEqual(canonical.filter((id) => id !== 'laden'));
      expect(r.order).not.toContain('laden');
      expect(r.quelle).toBe('katalog');
    }
    // Und die reine Ableitung sagt dasselbe: ohne Ladepunkt keine Kachel.
    expect(ladenKachel({ charging: { budget: null, chargers: [] } })).toBeNull();
    expect(ladenKachel({ charging: null })).toBeNull();
  });

  it('Knoten „Laden": ohne Ladepunkt ist der Energiefluss ZEICHENGLEICH zu vorher', () => {
    // Der fünfte Kreis (Konzept `vp-verbraucher-cockpit-k1` §6, E3) hängt an
    // GENAU einer Eingabe. Fehlt sie - und ohne Ladepunkt fehlt sie immer,
    // weil `flussKnoten` dann null liefert -, sind viewBox, Knotenmenge und
    // jede Koordinate dieselben wie vor dieser Runde.
    expect(flussKnoten(ladenKachel({ charging: null }))).toBeNull();
    expect(flussKnoten(ladenKachel({ charging: { budget: null, chargers: [] } }))).toBeNull();
    const ohne = layoutFlow(FLUSS_TOPO, []);
    for (const charging of [undefined, null]) {
      const l = layoutFlow(FLUSS_TOPO, [], { charging });
      expect([l.W, l.H, l.hubX, l.hubY]).toEqual([ohne.W, ohne.H, ohne.hubX, ohne.hubY]);
      expect(l.vertices.map((v) => [v.key, v.role, v.x, v.y, v.toX, v.toY])).toEqual(
        ohne.vertices.map((v) => [v.key, v.role, v.x, v.y, v.toX, v.toY]),
      );
    }
    // Nicht vakuum: MIT Knoten wächst die viewBox und es gibt einen Kreis mehr.
    const mit = layoutFlow(FLUSS_TOPO, [], {
      charging: { kw: 11, wort: 'lädt', aktiv: true, count: 1 },
    });
    expect(mit.H).toBeGreaterThan(ohne.H);
    expect(mit.vertices).toHaveLength(ohne.vertices.length + 1);
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

/**
 * Die Bestands-Anlage des Energiefluss-Wächters: vier Rollen, ein Haus - genau
 * die Form, an der ein fünfter Knoten sich zeigen WÜRDE.
 */
const FLUSS_TOPO: Topology = {
  schema_version: '1.0',
  nodes: [
    { role: 'pv', value_kw: 69.8, flow_active: true, direction: 'in', members: [{ entity_id: 'deye', label: null, primary: true, value_kw: 69.8 }] },
    { role: 'storage', value_kw: 8.2, soc_pct: 69, flow_active: true, direction: 'out', members: [{ entity_id: 'deye', label: 'B', primary: true, value_kw: 8.2 }] },
    { role: 'consumer', value_kw: 14.1, flow_active: true, direction: 'out', members: [{ entity_id: 'haus', label: 'H', primary: true, value_kw: 14.1 }] },
    { role: 'grid', value_kw: 33.3, flow_active: true, direction: 'out', members: [{ entity_id: 'deye', label: 'N', primary: true, value_kw: -33.3 }] },
  ],
};

describe('Anwendungs-Programm Stufe 4 — das Portfolio-Cockpit über Bestandsdaten', () => {
  /**
   * Die tragende Invariante der Stufe hat ZWEI Hälften, und nur die zweite
   * ändert sich sichtbar (E5, gewollt):
   *
   * 1. **Der EINZEL-Anlagen-Kunde ist zeichengleich unberührt** — er hat keine
   *    Flotten-Ebene, also weder Portfolio-Punkt noch Portfolio-Landung; seine
   *    Übersicht IST seine Anlagen-Seite wie seit je.
   * 2. **Der BETREIBER-Pfad behält Fläche und Dichte** — er bekam schon vor
   *    Stufe 4 das Portfolio mit der Operator-Tabelle, und genau das bekommt
   *    er weiter; NEU sind darin nur die Bausteine, die eine aktive Anwendung
   *    beisteuert.
   *
   * Was sich ändert, ist der Endkunde AB ZWEI Anlagen — die U0/U5-Änderung.
   * Sie steht hier ausdrücklich als Wächter, damit niemand sie versehentlich
   * zurücknimmt oder unbemerkt ausweitet.
   */
  const flotte = (siteCount: number, betriebsart: 'endkunde' | 'betreiber' | null) => ({
    isAdmin: false,
    loaded: true,
    tenantReady: true,
    betriebsart,
    siteCount,
  });

  it('EINE Anlage: kein Portfolio, keine Weiterleitung — byte-identisch zu vorher', () => {
    for (const betriebsart of ['endkunde', null] as const) {
      const i = flotte(1, betriebsart);
      expect(isFleetShell(betriebsart, 1)).toBe(false);
      expect(showPortfolioNav(i)).toBe(false);
      expect(redirectToPortfolio(i)).toBe(false);
      expect(showOverviewNav(i)).toBe(false);
      // Seine Übersicht ist die Anlagen-Seite - unverändert seit der IA.
      expect(redirectOverviewToAnlage(i)).toBe(true);
    }
  });

  it('der BETREIBER behält Fläche UND Dichte (auch mit einer Anlage)', () => {
    const i = flotte(1, 'betreiber');
    expect(showPortfolioNav(i)).toBe(true);
    expect(redirectToPortfolio(i)).toBe(true);
    expect(showOverviewNav(i)).toBe(false);
    // Die kompakte Zeile bleibt seine Dichte.
    expect(portfolioDichte('betreiber')).toBe('kompakt');
  });

  it('U0/U5: der Endkunde ab ZWEI Anlagen wechselt auf das Portfolio - in Karten-Dichte', () => {
    const i = flotte(3, 'endkunde');
    // Vor Stufe 4: showPortfolioNav false, showOverviewNav true
    // (die `FleetUebersicht`). Jetzt dieselbe Fläche wie der Betreiber ...
    expect(showPortfolioNav(i)).toBe(true);
    expect(showOverviewNav(i)).toBe(false);
    // ... aber in der RUHIGEN Dichte (Revision 2: dieselbe Tabelle, nur mit
    // mehr Luft und einer Satz-Unterzeile).
    expect(portfolioDichte('endkunde')).toBe('komfortabel');
    // Und sein altes Lesezeichen `#/uebersicht` gilt weiter.
    expect(redirectToPortfolio(i)).toBe(true);
  });

  it('ein Bestandskunde OHNE gesetzten Rahmen folgt derselben Heuristik + Komfort', () => {
    expect(showPortfolioNav(flotte(2, null))).toBe(true);
    expect(portfolioDichte(null)).toBe('komfortabel');
  });

  it('eine Flotten-Zeile eines ÄLTEREN Backends erfindet keine Anwendung', () => {
    // Ohne `anwendungen` (kein Stufe-4-Server) leitet das Portal aus der Zeile
    // ab, was es belegen kann - Monitoring plus, mit Speicher, den Fahrplan.
    const alt = {
      id: 'a',
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
    } as never;
    expect(anwendungenVonAnlage(alt)).toEqual(['monitoring']);
  });

  it('eine Flotte ohne Kennzahlen zeigt NUR die Pflicht-Bausteine, nie Zellen mit „—"', () => {
    const leer = portfolioKennzahlen(null, null, new Date());
    const ids = verfuegbareBausteine({
      anwendungen: ['monitoring', 'speicher-fahrplan'],
      kennzahlen: leer,
      anlagen: 3,
    });
    expect(ids).toEqual(['flotten-status', 'anlagen']);
  });

  it('die kanonische Portfolio-Reihenfolge ist der Wächter über den Standard', () => {
    // Wer sie ändert, ändert die Landung JEDES Mehr-Anlagen-Kunden, der keine
    // eigene Zeile in `cockpit_layout` hat - also fast aller.
    expect(CANONICAL_PORTFOLIO).toEqual([
      'flotten-status',
      // UEMS AP-01 IP-6: nur auf der Unternehmens-/Standort-Übersicht verfügbar,
      // jede andere Flotte behält ihre Anordnung (`verfuegbareBausteine`).
      'datenlage',
      'netzbezug-gesamt',
      'erloese',
      'speicher',
      'lastspitzen',
      'ladepunkte',
      'pv-jetzt',
      'erzeugung-heute',
      'verbrauch-heute',
      'netz-heute',
      'anlagen',
    ]);
    expect([...CANONICAL_PORTFOLIO].sort()).toEqual(PORTFOLIO_BAUSTEINE.map((b) => b.id).sort());
  });

  it('die frühere FleetUebersicht ist ERSATZLOS übergegangen, nicht dupliziert', () => {
    // Zwei Flotten-Bilder auf zwei Adressen waren der Zustand, den E5 beendet.
    const code = ohneKommentare(readFileSync(join(SRC, 'pages/UebersichtPage.tsx'), 'utf8'));
    expect(code).not.toContain('function FleetUebersicht');
    expect(code).toContain('PortfolioCockpit');
  });
});

// ---------------------------------------------------------------------------
// Portfolio Revision 2 — was ERSATZLOS entfallen ist
// ---------------------------------------------------------------------------

describe('Portfolio Revision 2 — Abbau-Invarianten', () => {
  it('der Geld-HELD ist weg: kein Marken-Verlauf mehr im Betriebs-Portal', () => {
    // Captain 25.08.2026: der Verlauf gehört Login und Marketing. Kehrt
    // `EarningsHero` zurück, kehrt mit ihm die Fläche zurück, gegen die
    // Revision 2 gebaut ist.
    for (const f of sourceFiles()) {
      expect(ohneKommentare(readFileSync(f, 'utf8')), f).not.toMatch(
        /\bEarningsHero\b|\bFleetStatusCard\b/,
      );
    }
  });

  it('die Kennzahlen-Leiste hat das 235-px-Kachelgitter abgelöst', () => {
    // `.vp-portfolio-kpis` war das `auto-fit`-Gitter, dessen letzte Kachel bei
    // fast jeder Breite als Waise in einer eigenen Reihe stand (Befund P1).
    for (const f of sourceFiles()) {
      expect(ohneKommentare(readFileSync(f, 'utf8')), f).not.toContain('vp-portfolio-kpis');
    }
  });

  it('es gibt nur EINE Anlagen-Fläche: die Tabelle - Karten erst am Telefon', () => {
    const code = ohneKommentare(readFileSync(join(SRC, 'components/PortfolioCockpit.tsx'), 'utf8'));
    expect(code).toContain('AnlagenTabelle');
    // Die Flotten-Karte lebt weiter - aber als Karte der Anlagen-LISTE
    // (`#/anlagen`), nicht als zweite Flotten-Fassung des Portfolios.
    expect(code).not.toContain('FleetSiteCard');
  });

  it('der Layout-Speicher bleibt SERVER-seitig, auch für die neuen Flächen', () => {
    // Der Admin gestaltet für den Kunden - eine Browser-Ablage wäre pro Gerät
    // und damit keine Vorgabe.
    for (const name of [
      'components/PortfolioCockpit.tsx',
      'components/AnlagenTabelle.tsx',
      'components/KennzahlLeiste.tsx',
      'portfolioCockpit.ts',
      'portfolioVorschau.ts',
    ]) {
      const code = ohneKommentare(readFileSync(join(SRC, name), 'utf8'));
      expect(code, name).not.toMatch(/localStorage|sessionStorage/);
    }
  });
});

describe('Steuerung Stufen 1+2: eine Anlage OHNE Daten bleibt ehrlich leer', () => {
  it('die Jetzt-Zone erfindet ohne Steuerbares keine Zeile', () => {
    const v = jetztZone({ now: new Date('2026-08-25T12:00:00Z') });
    expect(v.zeilen).toEqual([]);
    expect(v.banner).toBeNull();
    // Statt einer Zeile mit „—" steht dort der WEG.
    expect(v.leer).toBe(JETZT_LEER);
  });

  it('die Jetzt-Zone behauptet ohne Rücklesen keinen Speicher-Zustand', () => {
    const v = jetztZone({
      speicher: {
        control: null, expectControl: false,
        plantKind: 'eigenverbrauch', now: new Date('2026-08-25T12:00:00Z'),
      },
      now: new Date('2026-08-25T12:00:00Z'),
    });
    expect(v.zeilen).toEqual([]);
  });

  it('die Folgen-Karte trägt ohne Fahrplan-Zahl NIE einen erfundenen Betrag', () => {
    const k = regelFolgen({ name: 'R', satz: null, art: 'geraet' });
    const alles = k.bloecke.flatMap((b) => b.zeilen).join(' ');
    expect(alles).not.toMatch(/\d+[,.]\d+\s*(€|kWh)/);
    expect(alles).toContain('Nicht abschätzbar');
  });

  it('der Vorrang-Hinweis sagt seit Stufe 3 auf BEIDEN Zweigen „Ihre Regel geht vor"', () => {
    // ⚠ Der Umschaltpunkt WAR Stufe 3 (A3-A5): seit die Box für eine
    // beanspruchte Komponente keinen Fahrplan-Sollwert mehr einspeist und der
    // Optimierer sie als gehalten plant, hält die Anlage die Zusage - vorher
    // wäre sie eine gewesen, die sie nicht hält.
    expect(VORRANG_FOLGEN.speicher).toContain('Ihre Regel geht vor');
    expect(VORRANG_FOLGEN.geraet).toContain('Ihre Regel geht vor');
    for (const zeile of Object.values(VORRANG_ZEILE)) {
      expect(zeile).toContain('Regel vor Fahrplan');
      expect(zeile).not.toContain('Fahrplan vor Regel');
    }
    // ... aber KEINE Zahl: „was das kostet" ist Stufe 7, bis dahin wäre sie
    // erfunden (die Echtheits-Regel des Hauses).
    for (const text of [...Object.values(VORRANG_FOLGEN), ...Object.values(VORRANG_ZEILE)]) {
      expect(text).not.toMatch(/\d+[,.]\d+\s*(€|kWh)/);
    }
  });

  it('eine SPEICHER-Regel nennt die Folge für ein laufendes Betriebsmodell (A5b)', () => {
    // Der Server legt das konkurrierende Betriebsmodell bei der Aktivierung
    // stillt statt die Regel mit V-5 abzulehnen - die Folgen-Karte sagt das
    // VOR dem Klick, sonst wäre es eine Überraschung.
    expect(VORRANG_FOLGEN.speicher).toContain('Betriebsmodell');
    expect(VORRANG_FOLGEN.speicher).toContain('pausiert');
    // Bei einem GERÄT gibt es kein Betriebsmodell, das pausieren könnte.
    expect(VORRANG_FOLGEN.geraet).not.toContain('Betriebsmodell');
  });

  it('die Jetzt-Zone speichert nichts im Browser', () => {
    for (const name of ['steuerungJetzt.ts', 'components/JetztZone.tsx', 'regeln/folgen.ts']) {
      const code = ohneKommentare(readFileSync(join(SRC, name), 'utf8'));
      expect(code, name).not.toMatch(/localStorage|sessionStorage/);
    }
  });
});

// ---------------------------------------------------------------------------
// Steuerung Stufe 5 — Bestandsanlagen und der Abbau
// ---------------------------------------------------------------------------

describe('Steuerung Stufe 5: eine Anlage OHNE aktives Betriebsmodell ist unberührt', () => {
  const NOW = new Date('2026-08-25T12:00:00');

  function profil(over: Partial<SiteProfile> & { id: string }): SiteProfile {
    return {
      label: over.id,
      state: null,
      derivedActive: false,
      active: false,
      unlocks: { views: [], widgets: [], moneyStream: null },
      requirements: [],
      blockedReason: null,
      origin: null,
      flowRef: null,
      gatedNodeTypes: [],
      gatedNodesEnabled: true,
      ...over,
    };
  }

  it('⚠ ohne aktives Modell steht der GRUNDMODUS - kein Altbestand, kein „seit"', () => {
    // Der Zustand jeder Anlage, die nie ein Betriebsmodell eingeschaltet hat.
    const zone = betriebsmodellZone(
      [profil({ id: 'lastspitzenkappung' }), profil({ id: 'marktvermarktung' })],
      [], null, NOW,
    );
    expect(zone.aktiv).toBeNull();
    expect(zone.altbestand).toEqual([]);
    expect(zone.radio.every((k) => k.seit === null && k.beleg === null)).toBe(true);
  });

  it('ohne Server-Antwort (älteres Backend) behauptet die Zone GAR NICHTS', () => {
    expect(betriebsmodellZone(null, [], null, NOW)).toEqual({
      radio: [], eigene: [], nichtMoeglich: [], aktiv: null, altbestand: [],
    });
    expect(betriebsmodellZone(undefined, [], null, NOW).radio).toEqual([]);
  });

  it('⚠ ein ÄLTERER Server ohne `exklusivGruppe` fällt auf den KATALOG zurück', () => {
    // Die Gruppe ist eine Server-Angabe; kennt der Server sie nicht, entscheidet
    // die byte-gleiche Katalog-Kopie - und die kennt sie.
    const karten = betriebsmodellKarten(
      [profil({ id: 'marktvermarktung' }), profil({ id: 'lastmanagement' })],
      [], null, NOW,
    );
    expect(karten.map((k) => k.id)).toEqual(['marktvermarktung']);
    expect(karten[0].gruppe).toBe('speicher');
    // ⚠ Und der Katalog filtert die Karte, die kein Betriebsmodell mehr ist:
    // ein ÄLTERER Server, der `lastmanagement` noch im Regal schickt, bringt
    // sie NICHT zurück (Verbrauchsmanagement v1).
    expect(karten.map((k) => k.id)).not.toContain('lastmanagement');
  });

  it('die Zone speichert nichts im Browser', () => {
    for (const name of ['betriebsmodelle.ts', 'components/Betriebsmodelle.tsx']) {
      const code = ohneKommentare(readFileSync(join(SRC, name), 'utf8'));
      expect(code, name).not.toMatch(/localStorage|sessionStorage/);
    }
  });
});

describe('Steuerung Stufe 5 — Abbau-Invarianten', () => {
  /**
   * ⚠ Der Ko-Optimierungs-Streifen und der SoC-Reservierungs-Stack sind
   * ERSATZLOS entfallen: es läuft immer nur EIN Betriebsmodell, ein Streifen
   * über die gemeinsame Optimierung zweier erklärte also einen Zustand, den die
   * Fläche gerade abschafft — und auf einem Altbestand argumentierte er GEGEN
   * die Wahl, um die die Zone bittet.
   */
  it('coOptimization / socReservationStack / CoOptimizationStrip existieren nicht mehr', () => {
    const dateien = [
      'steuerungArea.ts',
      'components/SteuerungParts.tsx',
      'pages/SteuerungSection.tsx',
    ];
    for (const name of dateien) {
      const code = ohneKommentare(readFileSync(join(SRC, name), 'utf8'));
      expect(code, name).not.toMatch(/\bcoOptimization\b/);
      expect(code, name).not.toMatch(/\bsocReservationStack\b/);
      expect(code, name).not.toMatch(/\bCoOptimizationStrip\b/);
      expect(code, name).not.toMatch(/\bbatteryModes\b/);
    }
  });

  it('die Kunden-Steuerung ruft KEINE Admin-Route mehr auf', () => {
    // Der Streifen war der einzige Verbraucher der admin-only
    // `optimizerApi.configViaSwitcher` auf einer Kundenfläche.
    const code = ohneKommentare(readFileSync(join(SRC, 'pages/SteuerungSection.tsx'), 'utf8'));
    expect(code).not.toMatch(/optimizerApi/);
  });

  it('die alte Profil-ZEILE (ProfileRowView) ist durch die Karten ersetzt', () => {
    const code = ohneKommentare(readFileSync(join(SRC, 'pages/SteuerungSection.tsx'), 'utf8'));
    expect(code).not.toMatch(/ProfileRowView/);
    expect(code).toMatch(/Betriebsmodelle/);
  });
});

// ---------------------------------------------------------------------------
// Steuerung Stufe 6 — eine Anlage OHNE Vorschlags-Zutaten ist unberührt
// ---------------------------------------------------------------------------

describe('Steuerung Stufe 6: ohne Zutaten gibt es keine Vorschlags-Karte', () => {
  const NOW = new Date('2026-08-25T08:00:00Z');

  it('ohne Fahrplan UND ohne steuerbare Komponente entsteht nichts', () => {
    expect(vorschlaege({ slots: null, consumers: [], now: NOW })).toEqual([]);
    expect(vorschlaege({ slots: [], consumers: [], now: NOW })).toEqual([]);
  });

  it('ein Vorschlag erzeugt NIE selbst eine Regel — er füllt nur den Baukasten', () => {
    // Der Beleg ist strukturell: die reine Schicht kennt keinen einzigen
    // Schreibpfad, und die Fläche reicht `prefill` in den BESTEHENDEN
    // Baukasten. Eine Vorlagen-Mechanik wäre genau das, was der Captain
    // ausgeschlossen hat („nur freier Builder").
    const code = ohneKommentare(readFileSync(join(SRC, 'vorschlaege.ts'), 'utf8'));
    expect(code).not.toMatch(/\bapi\./);
    expect(code).not.toMatch(/fetch\(/);
    expect(code).not.toMatch(/localStorage|sessionStorage/);
  });

  it('die Vorschlags-Fläche speichert nichts im Browser', () => {
    // Die Ablehnung ist server-seitig (§7 `localStorage`-Verbot) - sonst
    // überlebte sie den Gerätewechsel nicht und wäre keine Entscheidung.
    for (const name of ['vorschlaege.ts', 'components/VorschlagsKarten.tsx']) {
      const code = ohneKommentare(readFileSync(join(SRC, name), 'utf8'));
      expect(code, name).not.toMatch(/localStorage|sessionStorage/);
    }
  });
});

// ---------------------------------------------------------------------------
// Steuerung Stufen 8+9 „Umzüge + Datenbereinigung"
// ---------------------------------------------------------------------------

describe('Steuerung Stufen 8+9: Umzüge und Datenbereinigung', () => {
  it('„Eigene Auswertung" hat KEINEN Schalter mehr — sie wohnt im Cockpit', () => {
    // Stufe 8: die Klasse wechselt von `regel` auf `cockpit`. Der Unterschied
    // zu `basis` ist NICHT „läuft immer", sondern „wird AN EINEM ANDEREN ORT
    // gesteuert" — deshalb ein eigenes Wort und ein eigener Ablehnungs-Satz.
    const eigen = ANWENDUNGEN.find((a) => a.id === 'eigene-auswertung');
    expect(eigen?.klasse).toBe('cockpit');
    expect(eigen?.abschaltbar).toBe(false);
    expect(istCockpitGesteuert('eigene-auswertung')).toBe(true);
    // Sie steht in KEINEM Preset auf „an": ein Preset kann sie nicht wählen.
    expect(eigen?.preset.privat).toBe('abgeleitet');
    expect(eigen?.preset.gewerbe).toBe('abgeleitet');
    expect(vorauswahl('privat')).not.toContain('eigene-auswertung');
    expect(vorauswahl('gewerbe')).not.toContain('eigene-auswertung');
    // Und der Schaltplan legt für sie NIE einen Schalter um.
    for (const profil of ['privat', 'gewerbe'] as const) {
      const plan = presetSchaltplan(profil, [], []);
      expect(plan.map((p) => p.id)).not.toContain('eigene-auswertung');
    }
  });

  it('istCockpitGesteuert urteilt über eine UNBEKANNTE Id nie „ja"', () => {
    expect(istCockpitGesteuert('marktvermarktung')).toBe(false);
    expect(istCockpitGesteuert('monitoring')).toBe(false);
    // Ein neuerer Server mit einer Anwendung, die diese Kopie nicht kennt.
    expect(istCockpitGesteuert('brandneu')).toBe(false);
    expect(istCockpitGesteuert(null)).toBe(false);
    expect(istCockpitGesteuert(undefined)).toBe(false);
  });

  it('Stufe 9: die Klassen, deren Zeilen die Migration löscht, sind GENAU zwei', () => {
    // Die Migration V20260847000000 löscht `site_profile_state`-Zeilen der
    // Klassen `basis` und `regel` — die Ids stehen dort AUSGESCHRIEBEN (eine
    // angewandte Migration darf ihre Wirkung nicht von einer Ressource
    // abhängig machen, die sich morgen ändert). Dieser Wächter hält fest,
    // WELCHE Ids das heute sind: wer eine Anwendung in eine dieser Klassen
    // schiebt, muss die Migrations-Liste bewusst mitziehen.
    //
    // ⚠ `lastmanagement` ist mit dem Verbrauchsmanagement v1 in die Klasse
    // `basis` gewechselt (es ist SCHUTZ, kein Betriebsmodell) - und genau
    // deshalb trägt es eine EIGENE Migration (V20260862000000), die seine
    // Zeilen wegräumt. Wer eine weitere Anwendung hierher schiebt, zieht seine
    // Migrations-Liste bewusst mit.
    const geloescht = ANWENDUNGEN
      .filter((a) => a.klasse === 'basis' || a.klasse === 'regel')
      .map((a) => a.id)
      .sort();
    expect(geloescht).toEqual(
      ['monitoring', 'speicher-fahrplan', 'ueberschuss', 'verbraucher', 'lastmanagement'].sort(),
    );
    // Was BLEIBT: die vier Betriebsmodelle und die cockpit-Anwendung. Ihre
    // Zeilen tragen eine Entscheidung, die der Kunde wirklich getroffen hat.
    const bleibt = ANWENDUNGEN
      .filter((a) => a.klasse === 'geschaeft' || a.klasse === 'cockpit')
      .map((a) => a.id)
      .sort();
    expect(bleibt).toEqual(
      [
        'marktvermarktung',
        'lastspitzenkappung',
        'atypische-netznutzung',
        'eigene-auswertung',
      ].sort(),
    );
  });

  it('das Kundenwort „Anwendung" kommt in keinem Katalog-Text mehr vor', () => {
    // Stufe 8 Wortprüfung: „Betriebsmodell" ist das Kundenwort; „Anwendung"
    // bleibt das INTERNE Modell (jede Code-Id, jeder Feldname). Der volle
    // Wächter über alle Kundenflächen steht in `copy.test.ts`.
    for (const a of ANWENDUNGEN) {
      for (const [feld, text] of Object.entries({
        label: a.label,
        nutzen: a.nutzen,
        leer_zustand: a.leer_zustand ?? '',
      })) {
        expect(text, `${a.id}.${feld}`).not.toMatch(/\bAnwendung(en)?\b/);
      }
    }
  });

  it('„Komponenten & Regeln" existiert nirgends mehr — die Seite heisst „Komponenten"', () => {
    for (const a of ANWENDUNGEN) {
      expect(a.leer_zustand ?? '', a.id).not.toContain('Komponenten & Regeln');
    }
  });
});

describe('UEMS AP-01 IP-5 — die Startansicht-Weiche lässt den Einzel-Anlagen-Kunden stehen', () => {
  /**
   * Die härteste Anforderung des Pakets: ein Kunde mit genau einer Anlage merkt
   * NICHTS — gleich, in welcher Form die Standorte ankommen (gar nicht, ohne
   * Standort, mit dem Standort der Bestandsübernahme, mit einem Standort ohne
   * Zuordnung). Verglichen wird gegen die Schale OHNE Ebene — genau die
   * Eingabe, die `canonicalShellRoute` vor IP-5 bekam — und die gerenderte
   * Schale Zeichen für Zeichen gegen die von vorher (Aufruf ohne `pfad`).
   */
  const halle1 = FIXTURE_IDS.an1;
  const ids = [halle1];
  const heute: ShellInput = { isAdmin: false, loaded: true, tenantReady: true, betriebsart: 'endkunde', siteCount: 1 };
  const formen: [string, Orte | null][] = [
    ['nicht geladen / älteres Backend', null],
    [
      'Unternehmen ohne Standort',
      orteAus(
        {
          stichtag: '2026-09-20',
          standorte: [],
          nichtGezeigt: [],
          nochNichtZugeordnet: { anlagenZahl: 1, anlagen: [{ id: halle1, name: 'Werk Ahrenberg – Halle 1' }] },
        },
        ahrenbergUnternehmen({ standortZahl: 0, anlagenZahl: 1, nochNichtZugeordnetZahl: 1, sitz: null }),
      ),
    ],
    [
      'Standort aus der Bestandsübernahme (AP-02 A5)',
      orteAus(bestandEineAnlage(), ahrenbergUnternehmen({ standortZahl: 1, anlagenZahl: 1, sitz: null })),
    ],
    [
      'Standort, die Anlage noch nicht zugeordnet',
      orteAus(
        { ...bestandEineAnlage(), standorte: [{ ...halle1Entwurf(), anlagen: [], anlagenZahl: 0 }] },
        ahrenbergUnternehmen({ standortZahl: 1, anlagenZahl: 1, nochNichtZugeordnetZahl: 1, sitz: null }),
      ),
    ],
  ];
  const mitEbene = (orte: Orte | null): ShellInput => ({
    ...heute,
    ebene: startEbene({ isAdmin: false, betriebsart: 'endkunde', siteIds: ids, orte }),
  });
  const routen: Route[] = [
    pageRoute('uebersicht'),
    pageRoute('anlagen'),
    anlageRoute(halle1),
    anlageRoute(halle1, 'fahrplan'),
    anlageRoute('unbekannt', 'messwerte'),
    { page: 'anlagen', siteId: halle1, sub: 'geraet', geraet: { ref: 'VP-DEMO-0001', geraetId: 'inverter' } },
    pageRoute('portfolio'),
    pageRoute('portfolio-messwerte'),
    pageRoute('portfolio-standorte'),
    pageRoute('hilfe'),
    standortRoute(FIXTURE_IDS.st1),
  ];

  it('Einzel-Anlagen-Kunde byte-identisch', () => {
    for (const [form, orte] of formen) {
      const shell = mitEbene(orte);
      for (const route of routen) {
        const fall = `${form} · ${hashForRoute(route)}`;
        expect(JSON.stringify(canonicalShellRoute({ shell, route, siteIds: ids })), fall)
          .toBe(JSON.stringify(canonicalShellRoute({ shell: heute, route, siteIds: ids })));
        expect(JSON.stringify(kopfPfad({ shell, route, anlageId: halle1, fleetLabel: 'Meine Anlagen' })), fall)
          .toBe(JSON.stringify(kopfPfad({ shell: heute, route, anlageId: halle1, fleetLabel: 'Meine Anlagen' })));
      }
      expect([showPortfolioNav(shell), showOverviewNav(shell), redirectOverviewToAnlage(shell)], form)
        .toEqual([showPortfolioNav(heute), showOverviewNav(heute), redirectOverviewToAnlage(heute)]);
    }

    // Die Schale, wie `App.tsx` sie baut — vorher ohne Pfad, nachher mit dem Pfad der Weiche.
    const sites = [{ id: halle1, name: 'Werk Ahrenberg – Halle 1' }] as Site[];
    const devices = { devices: [], fetchedAt: null };
    const surface = anlageSurface({
      entities: [],
      config: { plantKind: 'eigenverbrauch', tarifArt: 'dynamisch' },
    } as unknown as AnlageSurfaceInput);
    const schaleHtml = (anlage: Parameters<typeof AppShell>[0]['anlage']) => {
      const { container } = render(
        createElement(AppShell, {
          page: 'anlagen',
          onNavigate: () => {},
          isAdmin: false,
          showOverview: false,
          showPortfolio: false,
          fleetLabel: 'Meine Anlagen',
          showAddAnlage: true,
          onAddAnlage: () => {},
          counts: { sites: 1, devices: 1 },
          tenants: [],
          tenantOverride: null,
          onTenantChange: () => {},
          anlage,
          children: createElement('p', null, 'Cockpit'),
        }),
      );
      const html = container.innerHTML;
      cleanup();
      return html;
    };
    const gemeinsam = {
      siteId: halle1,
      siteName: 'Werk Ahrenberg – Halle 1',
      sites,
      onSelectSite: () => {},
      sidebar: anlageSidebar(surface, 0),
      activeKey: 'cockpit',
      onOpenSub: () => {},
      onOpenPage: () => {},
      onOpenFleet: null,
      health: null,
    };
    const vorher = schaleHtml({
      ...gemeinsam,
      siteOptions: anlagenOptionen({ sites, devices, mitFlotte: false, flottenLabel: 'Meine Anlagen' }),
    });
    expect(vorher).toContain('Werk Ahrenberg – Halle 1');
    // Der Vergleich beisst: ein einziges Glied davor wäre ein anderes Bild.
    expect(
      schaleHtml({
        ...gemeinsam,
        pfad: [{ wert: '__standort__', label: 'Werk Ahrenberg – Halle 1', onOpen: () => {} }],
      }),
    ).not.toBe(vorher);
    for (const [form, orte] of formen) {
      const p = kopfPfad({ shell: mitEbene(orte), route: anlageRoute(halle1), anlageId: halle1, fleetLabel: 'Meine Anlagen' });
      const rueckwege = p.vor.some((g) => g.ebene !== 'flotte') ? p.vor.map(pfadZeile) : undefined;
      const nachher = schaleHtml({
        ...gemeinsam,
        siteOptions: anlagenOptionen({ sites, devices, mitFlotte: false, flottenLabel: 'Meine Anlagen', rueckwege }),
        pfad: p.vor.map((g) => ({ wert: pfadWert(g), label: g.label, onOpen: () => {} })),
      });
      expect(nachher, form).toBe(vorher);
    }
  });
});
