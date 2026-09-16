/**
 * Die Ableitung der Steuerungs-Fläche — rein, ohne React/Netzwerk (der
 * `surface.ts`/`fleet.ts`-Präzedenzfall).
 *
 * **Portal v3 · M4** (`docs/portal.md`): die Steuerung
 * beantwortet EINE Frage — „Was darf VoltPilot, und was habe ich selbst
 * geregelt?" — mit ZWEI Kapseln plus einer schmalen Schutz-Zeile:
 *
 *  1. **Anwendungen** (`profileRows`) — kompakte, ANTIPPBARE Zeilen:
 *     Statuspunkt, EIN Satz mit echten Zahlen, Schalter. Antippen öffnet den
 *     Modus-Container (v3.1-M2), in dem Nutzen, Einstellungen, Voraussetzungen
 *     und Ansichten des Modus leben. Der Ko-Optimierungs-Streifen +
 *     `socReservationStack` bilden die Fußzeile dieser Kapsel.
 *  2. **Regeln** (`automationRows`) — je Regel eine Zeile mit ihrem lebenden
 *     Zustand und EINEM „＋ Neue Regel"-Knopf.
 *
 * Die alte Werkzeugkiste („＋ Modus hinzufügen") ist ERSETZT: Angebote leben
 * ausschließlich in M3s Regal, die zweite Tür in den Editor gibt es nicht mehr.
 *
 * Zwei Regeln bleiben Gesetz:
 *  - **Nie eine erfundene Zahl.** Fehlt die Zuordnung (Automationen, E15) oder
 *    die Erlös-Antwort, steht dort „—", nie eine 0.
 *  - **Stammdaten-Ehrlichkeit** (report §1.2): ein nur über Stammdaten aktiver
 *    Modus sagt „Von VoltPilot eingerichtet" und bekommt KEINE
 *    „Flow öffnen"-Affordanz — nie einen editierbaren Flow versprechen, den es
 *    nicht gibt.
 */

import type { EarningsSite, EntityStrategy, FunktionTeilnahme } from './api';
import { eurAmount, fmtNum } from './format';
import { speicherAussage } from './speicherAussage';
import {
  type SteuerungFormelInput,
} from './erloesKomposition';
import { lifecycleLabel, type EditorEntity } from './flows/model';
import { AUTOMATIC_MODULES } from './moduleSurface';
import { imRegal } from './anwendungen';
import {
  benefitLine,
  blockedReason,
  requirementChips,
  type SiteProfile,
} from './profiles';
import {
  VOLTPILOT_MANAGED,
  type ActiveMode,
  type ModeKind,
  type MoneyStreamId,
  type StreamPeriod,
} from './surface';

// ---------------------------------------------------------------------------
// 1 · Der Beitrag eines Modus (echte Zahlen, sonst "—")
// ---------------------------------------------------------------------------

/**
 * Aus WELCHEM Feld der Erlös-Antwort ein Geld-Strom seinen Wert liest. Labels,
 * Reihenfolge und Periode kommen aus dem M0-Manifest (`surface.ts`), damit
 * Steuerung und Erlös-Komposition (M4) dieselbe Sprache sprechen; hier steht
 * nur die Auflösung auf ein konkretes Feld. `null` = es GIBT keine Zuordnung
 * (Automationen, E15 nicht gebaut) — die Zeile zeigt "—".
 */
const STREAM_FIELD: Record<MoneyStreamId, ((e: EarningsSite) => number | null) | null> = {
  eigenverbrauchswert: (e) => e.eigenverbrauchsWertEur,
  einspeisung: (e) => e.einspeiseErloesEur,
  // ⚠ Der Steuerungs-Beitrag, nie `savedEur` (Captain 04.09.2026 — jenes misst
  //   gegen eine Anlage OHNE Speicher und ist eine ADMIN-Zahl).
  handel: (e) => e.savedSteuerungEur ?? null,
  lastspitzen: (e) => e.peakShaving?.avoidedEur ?? null,
  automation: null,
};

export interface ContributionRow {
  id: MoneyStreamId;
  label: string;
  /** Formatierter Betrag; null = keine Zahl (zeigt "—"). */
  value: string | null;
  period: StreamPeriod;
  /** Kurzer Zusatz (Periode/Kleingedrucktes); null = keiner. */
  note: string | null;
  /**
   * Die Eingabe fuer den Aufklapper „Wie wird das berechnet?" — nur an der
   * Zeile, die die Steuerungs-Zurechnung traegt (Captain 01.09.2026). Null an
   * jeder anderen: dort gibt es keine Zahl, deren Rechnung zu erklaeren waere.
   */
  formel: SteuerungFormelInput | null;
}

/** Periodenlabel — quer über Perioden wird NIE stillschweigend summiert (§1.4). */
export function periodLabel(period: StreamPeriod): string {
  return period === 'billing-period' ? 'laufende Abrechnungsperiode' : 'im gewählten Zeitraum';
}

/**
 * Der Beitrag eines Modus — eine Zeile je Geld-Strom seines M0-Manifests.
 * Fehlt die Erlös-Antwort oder das Feld, steht dort ehrlich "—", nie eine 0.
 */
export function contributionRows(
  mode: ActiveMode,
  earnings: EarningsSite | null | undefined,
  now: Date = new Date(),
): ContributionRow[] {
  // Die SPEICHER-AUSSAGE in Kurzform (Erlöse-Konzept §3.5/§3.6, P5): dieselbe
  // Ableitung wie auf der Erlöse-Karte und im Cockpit. Vorher stand hier
  // `savedEur` unter dem Wort „Steuerung"; derselbe Wert misst aber den GANZEN
  // Speicher (§2.2), und die Steuerung ist erst `savedSteuerungEur`.
  const speicher = earnings ? speicherAussage(earnings, { now }) : null;
  return mode.manifest.moneyStreams.map((stream) => {
    const read = stream.unattributed ? null : STREAM_FIELD[stream.id];
    const raw = read && earnings ? read(earnings) : null;
    const zurechnung =
      stream.attribution === 'steering' && speicher?.hatAussage ? speicher.kurz : null;
    return {
      id: stream.id,
      label: stream.label,
      value: raw == null ? null : eurAmount(raw),
      period: stream.period,
      // Der Aufklapper haengt am CHIP, nicht an der Zeile: ohne Zurechnung
      // gibt es keine Zahl, deren Rechnung erklaert werden koennte.
      formel:
        zurechnung == null || !earnings
          ? null
          : {
              tarifArt: earnings.tarifArt,
              tarifParamCtKwh: earnings.tarifParamCtKwh,
              tarifPriced: earnings.tarifPriced ?? null,
              exportVerguetungPriced: earnings.exportVerguetungPriced ?? null,
              plantKind: earnings.plantKind,
              anzulegenderWertCtKwh: earnings.anzulegenderWertCtKwh,
              marketValueSolarCtKwh: earnings.marketValueSolarCtKwh,
              savedSteuerungEur: earnings.savedSteuerungEur ?? null,
            },
      note: stream.unattributed
        ? 'Pro Regel noch nicht zugeordnet.'
        : [
            periodLabel(stream.period),
            // MIG §5: dieselbe EINE Zurechnungs-Wahrheit wie im Geld-Stapel —
            // der Steuerungs-Beitrag steht UNTER dem Erlös, nie daneben.
            zurechnung,
          ]
            .filter(Boolean)
            .join(' · '),
    };
  });
}

/**
 * Der zusätzliche Nachweis-Satz eines Lastspitzen-Modus ("X kW vermieden").
 * Null, solange in der laufenden Periode nichts gemessen ist.
 */
export function peakContributionNote(earnings: EarningsSite | null | undefined): string | null {
  const peak = earnings?.peakShaving;
  if (!peak || peak.avoidedKw == null) return null;
  return `Vermiedene Spitze: ${fmtNum(peak.avoidedKw, 'kW')}`;
}

// ---------------------------------------------------------------------------
// 1 · Geräte-Chips (welche Geräte der Modus beansprucht)
// ---------------------------------------------------------------------------

export interface EntityChip {
  id: string;
  label: string;
}

/** Speicher-Entitäten der Anlage (die Einheit, die jede Batterie-Strategie steuert). */
export function storageEntities(entities: EditorEntity[]): EditorEntity[] {
  return entities.filter((e) => e.entityType === 'battery-hybrid');
}

/**
 * Die Geräte, die dieser Modus beansprucht:
 *  - Flow-getragen → die **echten Claims** aus `api.entityStrategies` (welcher
 *    aktive Flow welche Entität anfasst) — kein Raten.
 *  - Stammdaten-getragen (kein Flow) → die Speicher-Einheit, die die
 *    VoltPilot-Ko-Optimierung fährt; ein Modus ohne Speicherbezug bekommt
 *    KEINE Chips (lieber nichts als eine Behauptung).
 */
export function entityChips(
  mode: ActiveMode,
  strategies: Record<string, EntityStrategy[]> | null | undefined,
  entities: EditorEntity[],
): EntityChip[] {
  const byId = new Map(entities.map((e) => [e.id, e] as const));
  const flowId = mode.flowRef?.flowId ?? null;
  if (flowId && strategies) {
    const chips: EntityChip[] = [];
    for (const [entityId, rows] of Object.entries(strategies)) {
      if (!(rows ?? []).some((r) => r.flowId === flowId)) continue;
      chips.push({ id: entityId, label: byId.get(entityId)?.label ?? entityId });
    }
    return chips.sort((a, b) => a.label.localeCompare(b.label, 'de'));
  }
  if (!flowId && isBatteryMode(mode.kind)) {
    return storageEntities(entities).map((e) => ({ id: e.id, label: e.label }));
  }
  return [];
}

// ---------------------------------------------------------------------------
// 1 · Aktionen einer Modus-Karte
// ---------------------------------------------------------------------------

export interface ModeActions {
  /** "Details/Öffnen" — nur mit WIRKLICH auflösbarem Flow (report §1.2). */
  canOpen: boolean;
  /** "Pausieren" = den Flow stilllegen; nie bei Stammdaten-Modi. */
  canPause: boolean;
  /** Die Ehrlichkeits-Zeile eines Stammdaten-Modus; null sonst. */
  managedNote: string | null;
}

export function modeActions(mode: ActiveMode): ModeActions {
  const open = mode.manifest.steuerungCard.action === 'open-flow' && mode.flowRef != null;
  return {
    canOpen: open,
    canPause: open,
    managedNote: mode.manifest.steuerungCard.managed ? VOLTPILOT_MANAGED : null,
  };
}

// ---------------------------------------------------------------------------
// 2 · Speicher-Modi
// ---------------------------------------------------------------------------

/** Welche Modi um DENSELBEN Speicher konkurrieren. */
const BATTERY_MODE_KINDS: ModeKind[] = ['lastspitzenkappung', 'marktvermarktung'];

export function isBatteryMode(kind: ModeKind): boolean {
  return BATTERY_MODE_KINDS.includes(kind);
}

/*
 * ⚠ ERSATZLOS ENTFALLEN (Steuerung Stufe 5, Konzept §3.4): der
 * **Ko-Optimierungs-Streifen** (`coOptimization`, `batteryModes`) und der
 * **SoC-Reservierungs-Stack** (`socReservationStack`) samt ihrer Render-Hälfte
 * `SteuerungParts.CoOptimizationStrip`.
 *
 * Der Streifen sagte „N Anwendungen, ein Speicher — VoltPilot optimiert sie
 * gemeinsam" und erschien ab ZWEI aktiven Speicher-Modi. Seit Stufe 5 gibt es
 * diesen Zustand als gewollten nicht mehr: **es läuft immer nur EINES**, der
 * Schalter ist ein Radio. Ein Streifen, der eine gleichzeitige Ko-Optimierung
 * erklärt, wäre damit die Erklärung eines Zustands, den die Fläche gerade
 * abschafft — und auf einer ALTBESTANDS-Anlage mit zwei aktiven Modellen die
 * beruhigende Gegenrede zu der Wahl, um die die Zone dort ausdrücklich bittet.
 *
 * Der SoC-Stack hing an ihm (er war seine Fußzeile) und beschreibt die
 * Aufteilung EINES Speichers zwischen mehreren Anwendungen — dieselbe Frage,
 * dieselbe Antwort: sie stellt sich nicht mehr. Die einzelnen Reservierungen
 * (Notstrom, Lastspitze) bleiben unverändert Einstellungen ihres Modus.
 *
 * Sie kommen zurück, wenn Multi-Use als eigenes Konzept gebaut wird — dann
 * aber mit der Exklusivitäts-Gruppe als Eingabe, nicht mit einer Modus-Zählung.
 */

// ---------------------------------------------------------------------------
// M4 · Kapsel 1 — die Anwendungs-Zeilen
// ---------------------------------------------------------------------------

/**
 * Eine Zeile des Regals — seit Steuerung Stufe 0 „Entwirrung" die eines
 * BETRIEBSMODELLS: Statuspunkt, Name, **Nutzen-Satz**, **Voraussetzungs-Chips**
 * und der Schalter. Das Detail (Einstellungen, Ansichten) lebt weiter im
 * Modus-Container, den ein Tipp auf die Zeile öffnet.
 *
 * ⚠ Der Nutzen-Satz und die Chips sind der Kern dieser Stufe: davor stand in
 * der Zeile der BEITRAG — und der ist nur bei einem aktiven Modus eine Zahl,
 * sonst „—". Auf einer Privat-Anlage las die Kapsel damit neun Mal „—" und
 * beantwortete keine der vier Kundenfragen („Was bringt mir das? Was brauche
 * ich?"). Der Beitrag bleibt, aber nur, wenn es ihn WIRKLICH gibt: `null`
 * statt eines Gedankenstrichs.
 */
export interface ProfileRow {
  id: string;
  label: string;
  /** Der effektive Zustand (M3-Overlay) — der Schalter zeigt genau ihn. */
  on: boolean;
  /** Der Statuspunkt: läuft / läuft-noch-nicht / aus. */
  tone: 'on' | 'blocked' | 'off';
  /** EIN Satz aus dem Katalog: was dieses Betriebsmodell dem Kunden tut. */
  benefit: string;
  /** Die ✓/fehlt-Chips des Servers — die Antwort auf „Was brauche ich?". */
  requirements: { label: string; met: boolean; text: string }[];
  /**
   * „Wert des Eigenverbrauchs: 88,25 € · im gewählten Zeitraum", oder `null`,
   * wenn es keine echte Zahl gibt (nie „—").
   */
  contribution: string | null;
  /** M3s ehrlicher Satz, wenn ein EINGESCHALTETES Profil nicht voll läuft. */
  blockedReason: string | null;
}

/**
 * Der Beitrag eines Modus als EINE Zeile — `null`, wenn es keinen gibt.
 *
 * Seit Stufe 5 exportiert, weil die Betriebsmodell-Karte denselben LIVE-BELEG
 * trägt wie die Regal-Zeile: zwei Ableitungen desselben Satzes wären zwei
 * Wahrheiten über dasselbe Geld.
 */
export function contributionLine(
  mode: ActiveMode | null,
  earnings: EarningsSite | null | undefined,
): string | null {
  if (!mode) return null;
  const rows = contributionRows(mode, earnings).filter((r) => r.value != null);
  if (rows.length === 0) return null;
  const period = periodLabel(rows[0].period);
  const sameperiod = rows.every((r) => r.period === rows[0].period);
  const parts = rows.map((r) => (sameperiod
    ? `${r.label}: ${r.value}`
    : `${r.label}: ${r.value} (${periodLabel(r.period)})`));
  return sameperiod ? `${parts.join(' · ')} · ${period}` : parts.join(' · ');
}

/**
 * Die Kapsel „Betriebsmodelle": eine Zeile je Betriebsmodell, mit dem Beitrag
 * des zugehörigen AKTIVEN Modus. Profil-Ids und `ModeKind` teilen sich dasselbe
 * Vokabular (M0/M3), deshalb wird hier nichts geraten — ein Modell ohne
 * laufenden Modus bekommt schlicht keine Zahl.
 *
 * ⚠ **Der zweite Filter** (Steuerung Stufe 0): der Server liefert im Feld
 * `profiles` bereits nur noch das Regal; `imRegal` prüft dieselbe Regel ein
 * zweites Mal aus der byte-gleichen Katalog-Kopie. Ein ÄLTERER Server, der
 * weiterhin alle neun Zeilen schickt, bekommt damit trotzdem die aufgeräumte
 * Kapsel — und eine dem Katalog unbekannte Id (neuerer Server) wird
 * ausgelassen statt ohne Nutzen-Satz gerendert.
 */
export function profileRows(
  profiles: SiteProfile[] | null | undefined,
  modes: ActiveMode[],
  earnings: EarningsSite | null | undefined,
): ProfileRow[] {
  const byKind = new Map(modes.map((m) => [String(m.kind), m] as const));
  return (profiles ?? [])
    .filter((p) => imRegal(p.id))
    .map((p) => {
      const mode = byKind.get(p.id) ?? null;
      const reason = blockedReason(p);
      return {
        id: p.id,
        label: p.label,
        on: p.active,
        tone: (p.active ? (reason ? 'blocked' : 'on') : 'off') as ProfileRow['tone'],
        benefit: benefitLine(p),
        requirements: requirementChips(p),
        contribution: p.active ? contributionLine(mode, earnings) : null,
        blockedReason: reason,
      };
    });
}

/**
 * ⚠ Das Kundenwort ist seit dem Captain-Entscheid vom 25.08.2026
 * **„Betriebsmodell"**; „Anwendung" bleibt das interne Modell und ist kein
 * Kundenwort mehr.
 */
export const PROFILE_CAPSULE_TITLE = 'Betriebsmodelle';

export const PROFILE_CAPSULE_INTRO =
  'Die Betriebsweise Ihres Speichers. Ohne Betriebsmodell fährt er den '
  + 'Eigenverbrauchs-Fahrplan: möglichst viel eigener Strom im Haus.';

export const PROFILE_CAPSULE_EMPTY =
  'Für diese Anlage gibt es noch kein Betriebsmodell — Ihr Speicher fährt den '
  + 'Eigenverbrauchs-Fahrplan.';

// ---------------------------------------------------------------------------
// M4 · Kapsel 2 — die Automations-Zeilen
// ---------------------------------------------------------------------------

/**
 * Was ein Gerät über eine Regel gemeldet hat. Optional und ADDITIV: der
 * Knoten-Status kommt erst mit M5 vom Edge — ohne ihn steht in der Zeile
 * schlicht „Läuft", nie eine erfundene Zahl.
 */
export interface AutomationActivity {
  flowId: string;
  /** Wie oft die Regel heute geschaltet hat; null/undefined = unbekannt. */
  switchedToday?: number | null;
  /** Zeitpunkt der letzten Schaltung (ISO); null/undefined = unbekannt. */
  lastSwitchedAt?: string | null;
}

export interface AutomationRow {
  flowId: string;
  name: string;
  active: boolean;
  version: number;
  /** „Läuft · heute 3× geschaltet · zuletzt 14:02" bzw. „Läuft" / „Entwurf". */
  state: string;
  /** Punkt-Tönung: grün wenn ausgerollt, sonst ruhig. */
  tone: 'on' | 'off';
  /**
   * D7 (Inkrement 4): die aus einer VERBRAUCHERREGEL generierte Automation —
   * sie trägt das Abzeichen „Aus Verbraucherregel" und öffnet den
   * Regelbaukasten ihres Verbrauchers statt des Flow-Editors. Abgeleitet aus
   * dem server-gestempelten `origin` des Dokuments, nie geraten.
   */
  fromConsumerRule: { entityId: string } | null;
}

/** Das Herkunfts-Abzeichen der generierten Verbraucherregel-Automation. */
export const AUS_VERBRAUCHERREGEL = 'Aus Verbraucherregel';

function timeOfDay(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Eine Zeile je Automation mit ihrem LEBENDEN Zustand. Ohne Knoten-Status
 * (heute immer, bis M5 den Edge-Block liefert) bleibt es bei „Läuft" —
 * ein Schaltzähler wird niemals geschätzt.
 */
export function automationRows(
  flows: {
    flowId: string;
    name: string;
    activeVersion: number | null;
    latestVersion: number;
    latestLifecycle: string;
    latestDocument?: { origin?: { kind?: string; entity_id?: string } } | null;
  }[],
  activity?: AutomationActivity[] | null,
): AutomationRow[] {
  const byFlow = new Map((activity ?? []).map((a) => [a.flowId, a] as const));
  return (flows ?? []).map((f) => {
    const active = f.activeVersion != null;
    const origin = f.latestDocument?.origin;
    const fromConsumerRule = origin?.kind === 'consumer-policy' && origin.entity_id
      ? { entityId: origin.entity_id } : null;
    const a = byFlow.get(f.flowId);
    const parts: string[] = [active ? 'Läuft' : lifecycleLabel(f.latestLifecycle)];
    if (active && a) {
      if (a.switchedToday != null && Number.isFinite(a.switchedToday)) {
        parts.push(`heute ${a.switchedToday}× geschaltet`);
      }
      const at = a.lastSwitchedAt ? timeOfDay(a.lastSwitchedAt) : null;
      if (at) parts.push(`zuletzt ${at}`);
    }
    return {
      flowId: f.flowId,
      name: f.name,
      active,
      version: active ? (f.activeVersion as number) : f.latestVersion,
      state: parts.join(' · '),
      tone: active ? 'on' : 'off',
      fromConsumerRule,
    };
  });
}

/**
 * Naming Set A (Einheitsmodell, Captain-Entscheid E1): die Kapsel heißt
 * **„Regeln"**, der Knopf **„＋ Neue Regel"**. „Automation" war das technischere
 * Wort für dieselbe Sache und ist aus der Kundensicht verschwunden — der
 * Copy-Wächter (`copy.test.ts`) hält das fest.
 */
export const REGEL_CAPSULE_TITLE = 'Regeln';

export const REGEL_CAPSULE_INTRO =
  'Was Ihre Anlage von selbst erledigt — geprüft, simuliert und erst dann aktiv.';

export const NEUE_REGEL_LABEL = '＋ Neue Regel';

// ---------------------------------------------------------------------------
// M4 · Die schmale Schutz-Zeile (läuft immer, ohne Profil)
// ---------------------------------------------------------------------------

export interface ProtectionItem {
  key: string;
  label: string;
  tip: string;
}

/**
 * Die immer laufenden Schutzfunktionen als schmale Zeile. „Nur Solarladen"
 * erscheint NUR, wenn das Netzladen für die Anlage tatsächlich gesperrt ist —
 * sonst wäre die Zeile eine Behauptung.
 */
export function protectionItems(site: { netzladenErlaubt?: boolean | null }): ProtectionItem[] {
  const items: ProtectionItem[] = AUTOMATIC_MODULES.map((m) => ({
    key: m.title,
    label: m.title,
    tip: m.tip,
  }));
  if (site?.netzladenErlaubt === false) {
    items.push({
      key: 'eeg',
      label: 'EEG: nur Solarladen',
      tip:
        'Ihr Speicher wird ausschließlich mit eigenem Solarstrom geladen — so bleibt Ihre '
        + 'EEG-Vergütung unangetastet. Ihr Gerät hält das auch dann ein, wenn die Verbindung abreißt.',
    });
  }
  return items;
}

export const PROTECTION_INTRO = 'Läuft immer mit, ganz ohne Betriebsmodell:';

export interface SteuerungFunktionsAnzeige {
  kopf: string | null;
  wirktNicht: string | null;
}

/** A4/A5-Kopf und Wirkhinweis aus dem gespeicherten Funktionszustand. */
export function steuerungFunktionsAnzeige(
  teilnahme: FunktionTeilnahme | null,
  zeitzone = 'Europe/Berlin',
): SteuerungFunktionsAnzeige {
  if (!teilnahme || (teilnahme.zustand !== 'eingerichtet' && teilnahme.zustand !== 'angehalten')) {
    return { kopf: null, wirktNicht: null };
  }
  if (!teilnahme.seit) {
    return teilnahme.zustand === 'angehalten'
      ? { kopf: 'Angehalten', wirktNicht: 'wirkt nicht — angehalten' }
      : { kopf: 'Eingerichtet — Steuerung noch nicht gestartet', wirktNicht: null };
  }
  const zeit = new Date(teilnahme.seit);
  const datum = new Intl.DateTimeFormat('de-DE', {
    timeZone: zeitzone, day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(zeit);
  if (teilnahme.zustand === 'eingerichtet') {
    return { kopf: `Eingerichtet am ${datum} — Steuerung noch nicht gestartet`, wirktNicht: null };
  }
  const uhr = new Intl.DateTimeFormat('de-DE', {
    timeZone: zeitzone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(zeit);
  return {
    kopf: `Angehalten seit ${datum} ${uhr}`,
    wirktNicht: `wirkt nicht — angehalten seit ${datum} ${uhr}`,
  };
}
