/**
 * Woraus sich der HAUSVERBRAUCH zusammensetzt — die reine Schicht hinter der
 * Board-Zeile „Hausverbrauch" (Konzept `vp-verbraucher-cockpit-k1`, Captain-
 * Entscheide E1/E3/E4/E6 vom 28.08.2026).
 *
 * Das Spiegelbild von {@link ./pvComposition}: dort ist der Knoten die SUMME
 * seiner Teile, hier ist er eine EIGENE Messung (der Haus-Standard der Box,
 * `pv + grid − battery`), und die Teile werden davon ABGEZOGEN. Daraus folgt
 * die ganze Ehrlichkeits-Arithmetik dieses Moduls.
 *
 * ⚠ DIE RECHENREGEL DES CAPTAINS, als Vertrag (Konzept §2.1):
 *
 *     hausverbrauch_kw  = pv + grid − battery            (alles hinter dem Anschluss)
 *     gemessene_teile   = Σ kW der Verbraucher MIT frischem eigenen Messwert
 *     uebriger_haushalt = hausverbrauch_kw − gemessene_teile
 *
 * Der Haus-Wert bleibt die Summe INKLUSIVE Wallbox — die Aufschlüsselung sagt,
 * wie viel davon wohin geht, sie verkleinert das Haus nicht. Wer das dreht,
 * lässt Board-Zeile und Flussdiagramm zwei verschiedene Zahlen sagen.
 *
 * SECHS Ehrlichkeitsregeln (alle aus bestehenden Hausregeln, hier nur
 * zusammengeführt):
 *
 *  1. **Nicht messbar ist nie 0.** Ein Teil ohne eigenen Messwert bekommt
 *     `kw: null` und ein WORT; eine Nennleistung wird NICHT als Schätzung
 *     eingesetzt (Captain: keine Nennwert-Schätzung).
 *  2. **Der Rest ist eine Differenz, kein Gerät.** „übriger Haushalt" trägt
 *     keinen Punkt, keinen Sprung und keinen Zustand.
 *  3. **Der Rest wird NICHT gerechnet, wenn ein Teil, der hineingehört, sich
 *     der Zählung entzieht** — ein laufender Verbraucher ohne Messwert, oder
 *     ein gemessener mit veraltetem Wert. Dann steht dort der GRUND, nie eine
 *     Zahl, die die Lücke des Nachbarn enthält.
 *  4. **Ein negativer Rest wird gesagt, nie geklemmt.** Liegen die Teile über
 *     dem Haus (Messversatz zweier Zähler), sagt die Zeile das — eine 0 wäre
 *     eine erfundene Übereinstimmung.
 *  5. **Ein eigener Anschluss ist eine eigene Gruppe** und steht NEBEN dem
 *     Haus, nie darin. In Phase 0 gibt es das Flag noch nicht (Edge/Cloud,
 *     Phase 1 C1/E2), die Gruppe ist deshalb vorbereitet und immer leer.
 *  6. **Ein Wort, das wir nicht kennen, wird kein Satz** — das Zustands-
 *     Vokabular ist geschlossen ({@link ladeZustand} · {@link consumerStatusLine}).
 *
 * Rein + rahmenfrei (getestet in `verbrauchKomposition.test.ts`).
 */
import type { SiteTopology, TopologyEntity } from './api';
import type { ConsumerRuntimeStatus } from './consumers/status';
import { consumerStatusLine } from './consumers/status';
import { newestTs } from './datenAlter';
import { deviceName } from './entityLabel';
import { fmtNum } from './format';
import {
  chargerName,
  connectorName,
  ladeZustand,
  type ChargePoint,
  type LadeZustandKind,
} from './ladepunkte';
import type { FlowMember } from './topology';

const CONSUMER_ROLE = 'consumer';

/** Der komponierte Haus-Knoten selbst - er IST die Summe, nie ein Teil davon. */
const HOUSE_LOAD = 'house-load';

/**
 * ⚠ WORAUF DIESES MODUL SCHLÜSSELT: das MASCHINEN-Wort {@link LadeZustandKind}
 * von {@link ladeZustand}, nie der deutsche Satz. Die Haus-Regel des
 * `target_verdict` - eine Fläche, die deutsche Sätze nach Stichworten
 * durchsucht, bricht beim ersten Umformulieren.
 */
const LAEDT: ReadonlySet<LadeZustandKind> = new Set<LadeZustandKind>([
  'laedt',
  'laedt_ohne_messung',
]);

/** Unter dieser Schwelle gilt ein Verbraucher als aus (die `live.ts`-Konvention). */
export const VERBRAUCH_DEADBAND_KW = 0.05;

/**
 * Ab diesem Betrag heißt ein negativer Rest „die Messwerte passen nicht
 * zusammen". Darunter ist es Rundung zweier Zähler, kein Widerspruch.
 */
const KONFLIKT_DEADBAND_KW = 0.2;

/** Die Gruppen der Aufschlüsselung (Konzept §3). */
export type VerbrauchGruppeId = 'laden' | 'waerme' | 'sonstiges' | 'laden_eigen';

export const GRUPPE_LABEL: Record<VerbrauchGruppeId, string> = {
  laden: 'Laden',
  waerme: 'Wärme',
  sonstiges: 'Sonstiges',
  laden_eigen: 'Laden (eigener Anschluss)',
};

/** Frische einer Zeile - dieselben drei Töne wie die PV-Aufschlüsselung. */
export type VerbrauchHealth = 'ok' | 'stale' | 'never';

/** Eine Zeile der Aufschlüsselung. */
export interface VerbrauchTeil {
  key: string;
  /** Der Name wie auf der Geräteseite (`chargerName` bzw. `deviceName`). */
  label: string;
  /** Gemessene Leistung, oder `null` wenn nicht gemessen (nie eine erfundene 0). */
  kw: number | null;
  /** Das Zustandswort - immer gesetzt, immer aus einem geschlossenen Vokabular. */
  word: string;
  /**
   * Die Unterzeile: der Grund der Box, „seit HH:MM", „ohne Leistungsmessung".
   * `null`, wo es nichts zu sagen gibt.
   */
  note: string | null;
  health: VerbrauchHealth;
  /**
   * Zieht dieser Teil GERADE Leistung? Trägt zwei Dinge: die Sortierung
   * (Aktive zuerst) und die Rest-Regel (ein aktiver Teil OHNE Messwert macht
   * den Rest unbestimmbar).
   */
  aktiv: boolean;
  /** Heute-kWh; `null` = noch nicht bekannt bzw. nicht belegbar („—"). */
  todayKwh: number | null;
  /** Sprung auf die Geräteseite bzw. die Komponente; `null` = kein Ziel. */
  href: string | null;
  /** Die Komponente hinter der Zeile, wo es eine gibt. */
  entityId: string | null;
  /** Der technische Name als `title` (die R2-Regel der PV-Zeilen). */
  title: string | null;
}

/** Eine Gruppe der Aufschlüsselung. */
export interface VerbrauchGruppe {
  id: VerbrauchGruppeId;
  label: string;
  /** Σ kW der gemessenen Teile; `null`, wenn kein Teil misst. */
  kw: number | null;
  /** Der Kopf-Satz: „1 von 1 lädt · 11,0 kW" bzw. „1,9 kW". */
  headline: string;
  teile: VerbrauchTeil[];
  /**
   * E4: die Gruppe ist auf EINE Summenzeile kollabiert, weil ihre Zeilen
   * anderswo vollständig stehen (die Kachel „Laden"). Eine Zahl hat einen
   * Wohnort.
   */
  collapsed: boolean;
  /** Der Satz der kollabierten Zeile („1 Ladepunkt"). */
  collapsedText: string | null;
}

/** Die letzte, leise Zeile: was vom Haus übrig bleibt. */
export interface VerbrauchRest {
  /** Haus − Σ gemessene Teile; `null`, wenn nicht bestimmbar. */
  kw: number | null;
  /** Der Grund, wenn `kw` null ist - oder der Widerspruchs-Satz. */
  note: string | null;
  /** Die Teile liegen ÜBER dem Haus: zwei Zähler widersprechen sich. */
  konflikt: boolean;
  todayKwh: number | null;
}

export interface VerbrauchKomposition {
  /** Der Haus-Wert der Box - unverändert, inklusive Wallbox. */
  hausKw: number | null;
  gruppen: VerbrauchGruppe[];
  rest: VerbrauchRest;
  /** Zahl der aufgeschlüsselten Verbraucher (die `titleNote` der Board-Zeile). */
  verbraucherCount: number;
  /**
   * Der Halbsatz der Board-Zeile („davon Laden 11,0 kW") - nur, während
   * wirklich geladen wird und die Leistung gemessen ist.
   */
  subLine: string | null;
  /** Σ kW der ladenden Stecker HINTER dem Hausanschluss (der Laden-Knoten). */
  ladenKw: number | null;
  /** Zahl der Ladepunkte (Säulen), egal ob sie gerade laden. */
  ladepunktCount: number;
  /** Der jüngste Bezugszeitpunkt der Teile - die Grundlage von „Stand: HH:MM". */
  asOf: string | null;
}

// ---------------------------------------------------------------------------
// Gruppen-Zuordnung
// ---------------------------------------------------------------------------

/**
 * Welcher Gruppe gehört ein Verbraucher-Typ? Ein unbekannter Typ landet in
 * „Sonstiges" - er wird nicht verschwiegen und nicht geraten.
 */
export function gruppeFuerTyp(entityType: string | null | undefined): VerbrauchGruppeId {
  switch ((entityType ?? '').trim()) {
    case 'ev-charger':
    case 'wallbox':
      return 'laden';
    case 'heating-rod':
    case 'heat-pump':
      return 'waerme';
    default:
      return 'sonstiges';
  }
}

// ---------------------------------------------------------------------------
// Eingabe
// ---------------------------------------------------------------------------

export interface VerbrauchInput {
  topology: SiteTopology | null | undefined;
  /** Die Ladesäulen aus `GET /sites/{id}/chargers`. */
  chargers?: ChargePoint[] | null;
  /** Der gemeldete Laufzeit-Zustand steuerbarer Verbraucher (ohne Messung). */
  consumerStatus?: ConsumerRuntimeStatus[] | null;
  /** Heute-kWh je Komponente (lazy nachgeliefert) bzw. je Stecker-Schlüssel. */
  todayKwh?: Record<string, number | null> | null;
  /** Heute-kWh des Hauses (aus `/history`) - die Grundlage der Rest-Zeile. */
  hausTodayKwh?: number | null;
  /** E4: die Kachel „Laden" ist im Layout sichtbar ⇒ die Gruppe kollabiert. */
  ladenKachelSichtbar?: boolean;
  /** Sprung-Adressen; ohne sie trägt eine Zeile keinen Chevron. */
  links?: {
    charger?: (chargePointId: string) => string | null;
    komponente?: (entityId: string) => string | null;
  } | null;
}

/** Eine endliche Zahl, sonst null - nie eine erfundene 0. */
function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function healthOf(e: TopologyEntity | undefined): VerbrauchHealth {
  switch (e?.health) {
    case 'ok':
      return 'ok';
    case 'stale':
      return 'stale';
    default:
      return 'never';
  }
}

/** Der Verbraucher-Knoten der Topologie, oder null. */
function consumerNode(topology: SiteTopology | null | undefined) {
  return topology?.topology.nodes.find((n) => n.role === CONSUMER_ROLE) ?? null;
}

/**
 * Der Haus-Wert: das Mitglied vom Typ `house-load`. NICHT der Knoten-Wert - der
 * summiert seit je house-load PLUS jeden gemessenen Verbraucher und zählt die
 * Wallbox damit doppelt (Konzept §1.2; die Rolle `charging` räumt das in
 * Phase 1 auf). Die Aufschlüsselung darf nicht auf einer Zahl fußen, von der
 * sie ihre eigenen Teile abziehen will.
 */
function hausMitglied(
  topology: SiteTopology,
): { member: FlowMember; entity: TopologyEntity | undefined } | null {
  const node = consumerNode(topology);
  if (!node) return null;
  const byId = new Map(topology.entities.map((e) => [e.id, e] as const));
  for (const m of node.members) {
    const e = byId.get(m.entity_id);
    if (e?.entityType === HOUSE_LOAD) return { member: m, entity: e };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Die Ableitung
// ---------------------------------------------------------------------------

/**
 * Die Zusammensetzung des Hausverbrauchs, oder `null`, wenn es nichts zu
 * erklären gibt (keine Topologie, kein Haus-Knoten, kein einziger Verbraucher).
 * Eine Anlage ohne jeden Verbraucher bekommt damit KEINE Aufklapp-Möglichkeit -
 * genau wie die PV-Zusammensetzung bei einem einzigen Wechselrichter.
 */
export function verbrauchKomposition(input: VerbrauchInput): VerbrauchKomposition | null {
  const { topology } = input;
  if (!topology) return null;
  const node = consumerNode(topology);
  if (!node) return null;

  const byId = new Map(topology.entities.map((e) => [e.id, e] as const));
  const haus = hausMitglied(topology);
  const hausKw = haus?.member.value_kw == null ? null : round3(haus.member.value_kw);
  const links = input.links ?? {};
  const today = input.todayKwh ?? {};

  const teile: VerbrauchTeil[] = [];
  const stamps: (string | null)[] = [];

  // --- 1. Die Ladepunkte -----------------------------------------------------
  // Sie kommen aus `/chargers`, nicht aus der Topologie: ein Ladepunkt hat
  // (noch) keine Entitäts-Telemetrie, seine kW leben allein im Herzschlag.
  // Das ist derselbe Zwischenweg wie der `sources`-Rückfall der PV - er
  // entfällt ersatzlos, sobald die Box `power_kw` je Ladepunkt publiziert
  // (Phase 1 E1).
  const chargers = input.chargers ?? [];
  let ladenKw: number | null = null;
  let ladendeStecker = 0;
  let steckerGesamt = 0;
  for (const c of chargers) {
    stamps.push(c.reportedAt ?? c.lastSeen ?? null);
    const cons = c.connectors ?? [];
    // Eine Säule ohne gemeldeten Stecker ist trotzdem ein Ladepunkt - sie
    // bekommt eine Zeile mit ihrem eigenen Zustand, statt zu verschwinden.
    if (cons.length === 0) {
      // Eine Säule, die noch keinen Stecker gemeldet hat, ist trotzdem ein
      // Ladepunkt - sie bekommt ihre Zeile mit dem EINZIGEN, was belegt ist:
      // ob sie verbunden ist. „Kein Auto eingesteckt" wäre hier eine
      // Behauptung über einen Stecker, den niemand gemeldet hat.
      const seen = c.connected ? null : zuletzt(c.lastSeen);
      teile.push({
        key: `cp:${c.chargePointId}`,
        label: chargerName(c),
        kw: null,
        word: c.connected ? 'Noch kein Stecker gemeldet' : 'Säule getrennt',
        note: seen,
        health: c.connected ? 'ok' : c.lastSeen ? 'stale' : 'never',
        aktiv: false,
        todayKwh: today[`cp:${c.chargePointId}`] ?? null,
        href: links.charger?.(c.chargePointId) ?? null,
        entityId: c.entityId ?? null,
        title: c.chargePointId,
      });
      continue;
    }
    for (const con of cons) {
      steckerGesamt += 1;
      const z = ladeZustand(con, c);
      const laedt = LAEDT.has(z.kind);
      // ⚠ Der Messwert gehört NUR einem wirklich ladenden Stecker: eine
      // stehengebliebene Zahl an einer wartenden Säule wäre eine Behauptung
      // über Energie, die gerade nicht fliesst.
      const kw = z.kind === 'laedt' ? num(con.powerKw) : null;
      if (laedt) ladendeStecker += 1;
      if (kw != null) ladenKw = round3((ladenKw ?? 0) + kw);
      const mehrere = cons.length > 1;
      const note = [z.reason, z.detail, con.sessionSince ? seit(con.sessionSince) : null]
        .filter((s): s is string => s != null && s !== '')
        .join(' · ');
      teile.push({
        key: `cp:${c.chargePointId}#${con.connectorId}`,
        label: mehrere
          ? `${chargerName(c)} · ${connectorName(con.connectorId)}`
          : chargerName(c),
        kw,
        word: z.word,
        note: note === '' ? null : note,
        health: z.kind === 'getrennt' ? (c.lastSeen ? 'stale' : 'never') : 'ok',
        // ⚠ Ein ladender Stecker OHNE Messwert ist AKTIV - genau das macht den
        // Rest unbestimmbar, statt seine Leistung stillschweigend hineinzuziehen.
        aktiv: laedt,
        todayKwh: today[`cp:${c.chargePointId}#${con.connectorId}`] ?? null,
        href: links.charger?.(c.chargePointId) ?? null,
        entityId: c.entityId ?? null,
        title: `${c.chargePointId} · ${connectorName(con.connectorId)}`,
      });
    }
  }

  // --- 2. Die gemessenen Verbraucher-Komponenten ----------------------------
  const statusById = new Map(
    (input.consumerStatus ?? []).map((s) => [s.entityId, s] as const),
  );
  for (const m of node.members) {
    const e = byId.get(m.entity_id);
    if (e?.entityType === HOUSE_LOAD) continue;
    // Ein Ladepunkt, den die Topologie schon als Komponente führt, steht oben
    // bereits mit seinem echten Zustand - zweimal wäre er doppelt gezählt.
    if (chargers.some((c) => c.entityId != null && c.entityId === m.entity_id)) continue;
    const health = healthOf(e);
    const kw = m.value_kw == null ? null : round3(Math.abs(m.value_kw));
    const status = statusById.get(m.entity_id);
    const label = deviceName({ storedLabel: m.label, typeLabel: e?.typeLabel }) ?? 'Gerät';
    let word: string;
    let note: string | null;
    let aktiv: boolean;
    if (kw != null) {
      aktiv = kw > VERBRAUCH_DEADBAND_KW;
      word = aktiv ? 'Aktiv' : 'Aus';
      note = status ? satzOhneWiederholung(status, word) : null;
    } else {
      // Ohne eigenen Messwert trägt nur der gemeldete Zustand - und der sagt
      // AUCH, ob dieses Gerät gerade läuft (die Rest-Regel hängt daran).
      const line = consumerStatusLine(status);
      word = line.text;
      aktiv = laeuft(status);
      note = 'ohne Leistungsmessung';
    }
    teile.push({
      key: `e:${m.entity_id}`,
      label,
      kw,
      word,
      note,
      health,
      aktiv,
      todayKwh: today[`e:${m.entity_id}`] ?? null,
      href: links.komponente?.(m.entity_id) ?? null,
      entityId: m.entity_id,
      title: e?.typeLabel ?? null,
    });
  }

  if (teile.length === 0) return null;

  // --- 3. Der Rest ----------------------------------------------------------
  const gemessen = teile.filter((t) => t.kw != null);
  const summeTeile = gemessen.reduce((s, t) => s + (t.kw as number), 0);
  const rest = restZeile(hausKw, summeTeile, teile, input.hausTodayKwh ?? null, today);

  // --- 4. Gruppen -----------------------------------------------------------
  const kachel = input.ladenKachelSichtbar === true;
  const gruppen = gruppieren(teile, byId, chargers, kachel, ladendeStecker, steckerGesamt);

  return {
    hausKw,
    gruppen,
    rest,
    verbraucherCount: teile.length,
    subLine: ladenKw != null && ladendeStecker > 0 ? `davon Laden ${kwText(ladenKw)}` : null,
    ladenKw,
    ladepunktCount: chargers.length,
    asOf: newestTs(stamps),
  };
}

/**
 * Die Rest-Zeile. Sie ist die einzige Stelle, an der dieses Modul eine Zahl
 * BILDET statt sie durchzureichen - und deshalb die Stelle mit den meisten
 * Ehrlichkeitsregeln.
 */
function restZeile(
  hausKw: number | null,
  summeTeile: number,
  teile: VerbrauchTeil[],
  hausTodayKwh: number | null,
  today: Record<string, number | null>,
): VerbrauchRest {
  const todayKwh = restToday(hausTodayKwh, teile, today);
  if (hausKw == null) {
    return {
      kw: null,
      note: 'nicht bestimmbar - der Hausverbrauch wird gerade nicht gemeldet',
      konflikt: false,
      todayKwh,
    };
  }
  // ⚠ Ein Teil, der IN die Summe gehörte, sich ihr aber entzieht, macht den
  // Rest unbestimmbar - eine Zahl, die die Lücke des Nachbarn enthält, wäre
  // schlimmer als keine.
  const blocker = teile.find((t) => t.aktiv && t.kw == null)
    ?? teile.find((t) => t.kw != null && t.health === 'stale');
  if (blocker) {
    return {
      kw: null,
      note: blocker.kw == null
        ? `nicht bestimmbar (${blocker.label} ohne Leistungsmessung)`
        : `nicht bestimmbar (${blocker.label} meldet sich gerade nicht)`,
      konflikt: false,
      todayKwh,
    };
  }
  const diff = round3(hausKw - summeTeile);
  if (diff < -KONFLIKT_DEADBAND_KW) {
    return {
      kw: null,
      note: `Messwerte passen nicht zusammen (${kwText(diff)})`,
      konflikt: true,
      todayKwh,
    };
  }
  return { kw: Math.max(diff, 0), note: null, konflikt: false, todayKwh };
}

/**
 * Heute-kWh des Rests. Dieselbe Disziplin wie die Leistung: nur, wenn das Haus
 * UND jeder Teil eine Tagessumme hat - sonst „—".
 */
function restToday(
  hausTodayKwh: number | null,
  teile: VerbrauchTeil[],
  today: Record<string, number | null>,
): number | null {
  if (hausTodayKwh == null) return null;
  let sum = 0;
  for (const t of teile) {
    const v = t.todayKwh ?? today[t.key] ?? null;
    if (v == null) return null;
    sum += v;
  }
  const diff = round3(hausTodayKwh - sum);
  return diff < 0 ? null : diff;
}

/**
 * Gruppen bilden, sortieren, und - wenn die Kachel „Laden" sichtbar ist - die
 * Laden-Gruppe auf eine Summenzeile kollabieren (E4).
 */
function gruppieren(
  teile: VerbrauchTeil[],
  byId: Map<string, TopologyEntity>,
  chargers: ChargePoint[],
  ladenKachelSichtbar: boolean,
  ladendeStecker: number,
  steckerGesamt: number,
): VerbrauchGruppe[] {
  const buckets = new Map<VerbrauchGruppeId, VerbrauchTeil[]>();
  for (const t of teile) {
    const id: VerbrauchGruppeId = t.key.startsWith('cp:')
      ? 'laden'
      : gruppeFuerTyp(byId.get(t.entityId ?? '')?.entityType);
    const list = buckets.get(id) ?? [];
    list.push(t);
    buckets.set(id, list);
  }
  const order: VerbrauchGruppeId[] = ['laden', 'waerme', 'sonstiges', 'laden_eigen'];
  const out: VerbrauchGruppe[] = [];
  for (const id of order) {
    const list = buckets.get(id);
    if (!list || list.length === 0) continue;
    const sorted = sortieren(list);
    const gemessen = sorted.filter((t) => t.kw != null);
    const kw = gemessen.length === 0
      ? null
      : round3(gemessen.reduce((s, t) => s + (t.kw as number), 0));
    const collapsed = id === 'laden' && ladenKachelSichtbar;
    out.push({
      id,
      label: GRUPPE_LABEL[id],
      kw,
      headline: id === 'laden'
        ? ladenKopf(ladendeStecker, steckerGesamt, kw)
        : (kw == null ? 'ohne Leistungsmessung' : kwText(kw)),
      teile: collapsed ? [] : sorted,
      collapsed,
      collapsedText: collapsed ? ladepunktText(chargers.length) : null,
    });
  }
  return out;
}

/** Aktive zuerst, nach Leistung; Ruhende darunter, alphabetisch (Konzept §3). */
function sortieren(list: VerbrauchTeil[]): VerbrauchTeil[] {
  return [...list].sort((a, b) => {
    if (a.aktiv !== b.aktiv) return a.aktiv ? -1 : 1;
    const ak = a.kw;
    const bk = b.kw;
    // Ein aktiver Teil OHNE Messwert steht hinter den gemessenen seiner Gruppe:
    // er ist da, aber er trägt keine Zahl, nach der sich sortieren ließe.
    if (ak != null && bk != null && ak !== bk) return bk - ak;
    if (ak != null && bk == null) return -1;
    if (ak == null && bk != null) return 1;
    return a.label.localeCompare(b.label, 'de');
  });
}

/** „1 von 1 lädt · 11,0 kW" / „2 von 6 laden · 22,0 kW" / „kein Auto lädt". */
function ladenKopf(ladend: number, gesamt: number, kw: number | null): string {
  if (gesamt === 0) return 'noch kein Stecker gemeldet';
  if (ladend === 0) return 'lädt gerade nicht';
  const verb = ladend === 1 ? 'lädt' : 'laden';
  const zahl = `${ladend} von ${gesamt} ${verb}`;
  return kw == null ? `${zahl} · Leistung nicht messbar` : `${zahl} · ${kwText(kw)}`;
}

function ladepunktText(n: number): string {
  return n === 1 ? '1 Ladepunkt' : `${n} Ladepunkte`;
}

/** Der Zustandssatz eines gemessenen Geräts - ohne sein Wort zu wiederholen. */
function satzOhneWiederholung(status: ConsumerRuntimeStatus, word: string): string | null {
  const line = consumerStatusLine(status);
  const t = line.text.trim();
  if (t === '' || t.toLowerCase() === word.toLowerCase()) return null;
  return line.reason ? `${t} · ${line.reason}` : t;
}

/**
 * Läuft dieses Gerät laut seinem GEMELDETEN Zustand? Nur ein ausdrücklich
 * laufender Zustand zählt - „Zustand nicht bestätigt" ist kein Beleg dafür,
 * dass etwas läuft, und keiner dafür, dass nichts läuft.
 */
function laeuft(status: ConsumerRuntimeStatus | undefined): boolean {
  const s = status?.state;
  return s === 'running_forced' || s === 'running_optimized' || s === 'clamped';
}

/** „zuletzt 8:50" - null, wenn kein Zeitpunkt gemeldet wurde. */
function zuletzt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  return `zuletzt ${new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' }).format(t)}`;
}

/** „seit 14:10" - leer, wenn der Zeitpunkt nicht lesbar ist. */
function seit(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  return `seit ${new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' }).format(t)}`;
}

/** „11,0 kW" in der Haus-Schreibweise - EIN Formatierer, {@link fmtNum}. */
export function kwText(kw: number): string {
  return fmtNum(kw, 'kW');
}

/** Der Anteil eines Teils an der Haus-Summe (0..1) - für den Balken. */
export function anteilVon(teil: VerbrauchTeil, k: VerbrauchKomposition): number {
  if (teil.kw == null || k.hausKw == null || k.hausKw <= 0) return 0;
  return Math.max(0, Math.min(1, teil.kw / k.hausKw));
}
