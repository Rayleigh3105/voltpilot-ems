/**
 * Plattform › Übersicht (Konzept `vp-adminview-konzept-k1` §4.3, Scheibe S4):
 * die neue Landung von `#/plattform` - Antwort zuerst, Ausnahmen zählen statt
 * Ganzheiten.
 *
 * **Keine neue Wahrheit.** Jede Zahl hier ist ein zweites Urteil einer schon
 * bestehenden Ableitung (Software: `geraeteUpdates.boxZeile`; Verbindung und
 * Flotte: `adminFleet.fleetBoxGroups`; Steuerung: `adminFleet.
 * controlMatrixRows`; Plan: `adminFleet.fleetRows`) - nie eine eigene
 * Berechnung über dieselben Felder. Das ist die Regel „Ein Ort je Fakt"
 * (§4.1) angewandt auf die Landung.
 *
 * **Vier Kacheln bewusst UNVOLLSTÄNDIG belassen** gegenüber dem Konzept-Bild:
 * „warten auf Scharfschaltung" (Steuerungs-Freigabe) gehört zu Scheibe S3
 * (Reiter Anlage, parallele Aufgabe) - diese Scheibe zählt nur die
 * Abweichung Plan gegen Ausführung, die schon aus `/admin/fleet` kommt. Die
 * Kachel wächst, sobald S3 ihren Lesepfad hat; das ist kein Fehlen, sondern
 * eine Grenze gegen das parallele Werk.
 *
 * **Dienste**: Tunnel- und Werkstatt-Dienst kommen aus den Antworten, die
 * diese Seite ohnehin lädt; Optimierer, Preise und Messwerte kommen additiv
 * aus dem S6-Lesemodell (Lücke L1, `GET /admin/plattform/dienste`) - das
 * dritte, optionale Argument von {@link uebersichtDienste}.
 *
 * Reines Modul: kein React, kein Netzwerk.
 */
import type { IconName } from '../designsystem/components/core/Icon';
import type {
  AdminFleetRelease,
  AdminFleetSite,
} from './admin/fleetApi';
import type { AdminPlattformDienste, PendingEnrollment } from './admin/adminApi';
import {
  controlMatrixInputs,
  controlMatrixRows,
  fleetBoxGroups,
  fleetRows,
  relAge,
  type FleetBoxGroup,
  type FleetBoxRow,
  type Tone,
} from './adminFleet';
import {
  BOX_ART_LABELS,
  edgeUpdatesUrteil,
  rolloutsLaufend,
  type BoxArt,
  type EdgeUpdatesKpi,
  type EdgeUpdatesLine,
  type FleetRow as EdgeFleetRow,
  type Rollout,
} from './adminEdgeUpdates';
import { boxZeile, linieDerBox, segmentArt, type BoxZeile } from './geraeteUpdates';
import { pendingRows } from './onboardingFunnel';
import type {
  FernwartungBox,
  FernwartungUebersicht,
} from './adminFernwartung';
import { zeitpunkt } from './adminFernwartung';
import type { WerkstattDienst } from './werkstattBank';
import type { Route } from './nav';
import { geraeteAkteHash, geraeteAkteRoute, mandantHash, type GeraeteAkteReiter } from './nav';

export type UebersichtTon = Tone;

// ── Kacheln ─────────────────────────────────────────────────────────────────

export type KachelId = 'verbindung' | 'software' | 'steuerung' | 'plan';

export interface UebersichtKachel {
  id: KachelId;
  icon: IconName;
  label: string;
  zahl: number;
  ton: UebersichtTon;
  /** Lang (Rechner) und kurz (Telefon, EIN Wort) für denselben Zustand. */
  wort: string;
  wortKurz: string;
  kontext: string;
}

/** Eingaben der vier Kacheln - dieselben Antworten, die die Seite ohnehin lädt. */
export interface KachelnEingabe {
  sites: AdminFleetSite[];
  releases: AdminFleetRelease[];
  edgeLines: EdgeUpdatesLine[];
  edgeKpi: EdgeUpdatesKpi;
  edgeRollouts: Rollout[];
}

export function uebersichtKacheln(input: KachelnEingabe, now: Date): UebersichtKachel[] {
  return [
    verbindungKachel(input.sites, now),
    softwareKachel(input.edgeKpi, input.edgeLines, input.edgeRollouts),
    steuerungKachel(input.sites, now),
    planKachel(input.sites, now),
  ];
}

function verbindungKachel(sites: AdminFleetSite[], now: Date): UebersichtKachel {
  const boxen = fleetBoxGroups(sites, now).flatMap((g) => g.boxes);
  const total = boxen.length;
  // E6: „verzögert" ist reine Anzeige - sie zählt hier NICHT als Ausnahme,
  // sonst würde die ruhigste aller drei Live-Kacheln genau dann unruhig, wenn
  // noch kein echter Alarm vorliegt.
  const offline = boxen.filter((b) => b.connectionZustand === 'offline').length;
  const nie = boxen.filter((b) => b.connectionZustand === 'nie').length;
  const zahl = offline + nie;
  const teile = [nie > 0 ? `${nie} nie gemeldet` : null, `von ${total}`].filter(Boolean);
  return {
    id: 'verbindung',
    icon: 'wifi',
    label: 'Verbindung',
    zahl,
    ton: zahl > 0 ? 'warn' : 'ok',
    wort: zahl > 0 ? (zahl === 1 ? 'meldet sich nicht' : 'melden sich nicht') : `Alle ${total} verbunden ✓`,
    wortKurz: zahl > 0 ? 'offline' : `alle ${total} ✓`,
    kontext: teile.join(' · '),
  };
}

function softwareKachel(
  kpi: EdgeUpdatesKpi,
  lines: EdgeUpdatesLine[],
  rollouts: Rollout[],
): UebersichtKachel {
  // Dieselbe Wahrheit wie die Software-Seite (`adminEdgeUpdates.edgeUpdatesUrteil`,
  // Muster `kpiText`): je Linie gemessen, Rückfall auf `kpi` nur ohne `lines`.
  const { veraltet, bekannt } = edgeUpdatesUrteil(kpi, lines);
  const zahl = veraltet;
  const linienTexte = lines
    .filter((l) => l.devices > 0 && l.known - l.upToDate > 0)
    .map((l) => `${BOX_ART_LABELS[l.boxArt]} ${l.known - l.upToDate} älter`);
  const laufend = rolloutsLaufend(rollouts);
  const ohneStand = kpi.unknown > 0 ? `${kpi.unknown} ohne Stand` : null;
  const teile = [laufend > 0 ? `${laufend} ${laufend === 1 ? 'läuft' : 'laufen'}` : null, ...linienTexte, ohneStand].filter(Boolean);
  // Admin-Durchgang F18: meldet KEINE Box einen bewertbaren Stand, ist „0 · Alle aktuell ✓"
  // eine Behauptung ohne Grundlage - die Software-Seite sagt dazu „keinen bewertbaren Stand".
  if (bekannt === 0 && kpi.unknown > 0) {
    return {
      id: 'software',
      icon: 'refresh-cw',
      label: 'Software',
      zahl: kpi.unknown,
      ton: 'off',
      wort: 'ohne bewertbaren Stand',
      wortKurz: 'ohne Stand',
      kontext: laufend > 0 ? `${laufend} ${laufend === 1 ? 'läuft' : 'laufen'}` : '',
    };
  }
  return {
    id: 'software',
    icon: 'refresh-cw',
    label: 'Software',
    zahl,
    ton: zahl > 0 ? 'warn' : 'ok',
    wort: zahl > 0 ? 'nicht aktuell' : 'Alle aktuell ✓',
    wortKurz: zahl > 0 ? 'veraltet' : 'aktuell ✓',
    kontext: teile.join(' · '),
  };
}

function steuerungKachel(sites: AdminFleetSite[], now: Date): UebersichtKachel {
  const inputs = controlMatrixInputs(sites);
  const rows = controlMatrixRows(inputs, now);
  const zahl = rows.filter((r) => r.battery.tone === 'warn' || r.curtail.tone === 'warn').length;
  return {
    id: 'steuerung',
    icon: 'zap',
    label: 'Steuerung',
    zahl,
    ton: zahl > 0 ? 'warn' : 'ok',
    wort: zahl > 0 ? (zahl === 1 ? 'Abweichung' : 'Abweichungen') : 'Keine Abweichungen ✓',
    wortKurz: zahl > 0 ? 'Abweichung' : 'ok ✓',
    kontext: rows.length === 1 ? '1 Anlage mit Speicher' : `${rows.length} Anlagen mit Speicher`,
  };
}

function planKachel(sites: AdminFleetSite[], now: Date): UebersichtKachel {
  const rows = fleetRows(sites, now);
  const zahl = rows.filter((r) => r.planTone === 'warn').length;
  const laeufe = sites
    .map((s) => s.lastPlanGeneratedAt)
    .filter((t): t is string => !!t)
    .map((t) => Date.parse(t))
    .filter((t) => Number.isFinite(t));
  const juengster = laeufe.length > 0 ? relAge(now.getTime() - Math.max(...laeufe)) : null;
  return {
    id: 'plan',
    icon: 'history',
    label: 'Plan',
    zahl,
    ton: zahl > 0 ? 'warn' : 'ok',
    wort: zahl > 0 ? 'ohne frischen Plan' : 'Alle Pläne frisch ✓',
    wortKurz: zahl > 0 ? 'ohne Plan' : 'frisch ✓',
    kontext: juengster ? `jüngster Lauf ${juengster}` : 'noch kein Lauf',
  };
}

// ── Braucht dich ────────────────────────────────────────────────────────────

/**
 * Die Rangfolge aus dem Report (§4.3 Punkt 3): Fehler > Zurückhalten >
 * offline mit wartender Anfrage > Stufe 1 > Fenster ohne Schlüssel >
 * Werkstatt nicht bereit > nicht zugeordnete Anmeldung.
 */
const RANG = {
  fehler: 0,
  halt: 1,
  offlineAnfrage: 2,
  stufe1: 3,
  fensterOhneSchluessel: 4,
  werkstattNichtBereit: 5,
  anmeldung: 6,
} as const;

export type BrauchtDichArt = keyof typeof RANG;

/** Beschriftung einer Art für die Sammel-Handlung „alle dieser Art erledigen". */
export const BRAUCHT_DICH_ART_LABEL: Record<BrauchtDichArt, string> = {
  fehler: 'Fehler',
  halt: 'Zurückgehalten',
  offlineAnfrage: 'Offline mit Anfrage',
  stufe1: 'Nur von Hand',
  fensterOhneSchluessel: 'Fenster ohne Schlüssel',
  werkstattNichtBereit: 'Werkstatt nicht bereit',
  anmeldung: 'Ohne Kunde',
};

export interface BrauchtDichZeile {
  key: string;
  icon: IconName;
  ton: UebersichtTon;
  box: string;
  kunde: string | null;
  grund: string;
  /** Ein Wort/kurzer Satz für die Telefon-Zeile. */
  kurz: string;
  schrittLabel: string;
  route: Route;
  rang: number;
  art: BrauchtDichArt;
}

/** Ein serverseitig abgelegter „erledigt"-Stand (Lücke: `/admin/plattform/braucht-dich`). */
export interface BrauchtDichErledigtEintrag {
  schluessel: string;
  stand: string;
  erledigtAm: string;
  erledigtVon: string;
}

export interface BrauchtDichErledigtZeile extends BrauchtDichZeile {
  erledigtAm: string;
  erledigtVon: string;
}

/**
 * Trennt aktive von erledigten Zeilen: erledigt gilt, solange der mitgegebene
 * Grund (`stand`) genau dem aktuellen `grund` der Zeile entspricht - trägt ein
 * Eintrag einen neueren Zustand/Text, erscheint er wieder in `aktiv`. Keine
 * zweite Wahrheit: die Anzeige-Felder (Box, Kunde, Route, …) kommen immer aus
 * der aktuellen Ableitung, nie aus der Ablage.
 */
export function brauchtDichMitErledigt(
  zeilen: readonly BrauchtDichZeile[],
  erledigt: readonly BrauchtDichErledigtEintrag[],
): { aktiv: BrauchtDichZeile[]; erledigt: BrauchtDichErledigtZeile[] } {
  const byKey = new Map(erledigt.map((e) => [e.schluessel, e]));
  const aktiv: BrauchtDichZeile[] = [];
  const erledigtZeilen: BrauchtDichErledigtZeile[] = [];
  for (const z of zeilen) {
    const e = byKey.get(z.key);
    if (e && e.stand === z.grund) {
      erledigtZeilen.push({ ...z, erledigtAm: e.erledigtAm, erledigtVon: e.erledigtVon });
    } else {
      aktiv.push(z);
    }
  }
  return { aktiv, erledigt: erledigtZeilen };
}

export interface BrauchtDichEingabe {
  edgeFleet: readonly EdgeFleetRow[];
  fernwartungBoxen: readonly FernwartungBox[];
  werkstatt: WerkstattDienst | null;
  pending: readonly PendingEnrollment[];
}

export function uebersichtBrauchtDich(input: BrauchtDichEingabe, now: Date): BrauchtDichZeile[] {
  const out: BrauchtDichZeile[] = [];

  for (const row of input.edgeFleet) {
    const z = boxZeile(row, now);
    const segment = segmentArt(row.stand);
    const akte = (reiter: GeraeteAkteReiter) => geraeteAkteRoute(z.row.externalRef, reiter);
    if (segment === 'fehler') {
      out.push({
        key: `fehler-${z.ref}`, icon: 'alert-triangle', ton: 'warn', box: z.name, kunde: z.ort,
        grund: satzText(z) ?? 'Update braucht dich', kurz: 'Fehler', schrittLabel: 'Software',
        route: akte('software'), rang: RANG.fehler, art: 'fehler',
      });
    } else if (segment === 'halt') {
      out.push({
        key: `halt-${z.ref}`, icon: 'alert-triangle', ton: 'warn', box: z.name, kunde: z.ort,
        grund: satzText(z) ?? 'Update zurückgehalten', kurz: 'hält zurück', schrittLabel: 'Software',
        route: akte('software'), rang: RANG.halt, art: 'halt',
      });
    } else if (z.offline && z.ziel) {
      out.push({
        key: `offline-anfrage-${z.ref}`, icon: 'wifi', ton: 'warn', box: z.name, kunde: z.ort,
        grund: `Meldet sich nicht, Update wartet${z.verbindung.gesehen ? ` · ${z.verbindung.gesehen}` : ''}`,
        kurz: 'offline', schrittLabel: 'Software', route: akte('software'), rang: RANG.offlineAnfrage,
        art: 'offlineAnfrage',
      });
    } else if (segment === 'hand') {
      out.push({
        key: `hand-${z.ref}`, icon: 'hand', ton: 'warn', box: z.name, kunde: z.ort,
        grund: 'Nur von Hand (Stufe 1)', kurz: 'nur von Hand', schrittLabel: 'Software',
        route: akte('software'), rang: RANG.stufe1, art: 'stufe1',
      });
    }
  }

  for (const box of input.fernwartungBoxen) {
    for (const fenster of box.laufendeFenster) {
      if (fenster.zustand !== 'offen') continue;
      if (fenster.rueckmeldung?.schluesselAbgeholtUm) continue;
      out.push({
        key: `fenster-${fenster.id}`, icon: 'lock', ton: 'warn', box: box.edgeRef,
        kunde: box.siteName ? (box.tenantName ? `${box.siteName} · ${box.tenantName}` : box.siteName) : null,
        grund: `Fenster offen seit ${zeitpunkt(fenster.geoeffnetAm, now)} · Schlüssel nicht abgeholt`,
        kurz: 'Fenster ohne Schlüssel', schrittLabel: 'Verbindung', route: geraeteAkteRoute(box.edgeRef, 'verbindung'),
        rang: RANG.fensterOhneSchluessel, art: 'fensterOhneSchluessel',
      });
    }
  }

  for (const lauf of input.werkstatt?.laeufe ?? []) {
    if (lauf.zustand !== 'angehalten') continue;
    const ref = lauf.stand.box ?? null;
    if (!ref) continue;
    out.push({
      key: `werkstatt-${lauf.kennung}`, icon: 'sliders', ton: 'warn', box: ref, kunde: null,
      grund: lauf.grund ?? 'Einrichtung angehalten, braucht einen Handgriff',
      kurz: 'Werkstatt nicht bereit', schrittLabel: 'Einrichtung', route: geraeteAkteRoute(ref, 'einrichtung'),
      rang: RANG.werkstattNichtBereit, art: 'werkstattNichtBereit',
    });
  }

  for (const p of pendingRows([...input.pending], now)) {
    if (!p.suspect && p.hint !== 'War schon einmal verbunden und wurde getrennt') continue;
    out.push({
      key: `anmeldung-${p.externalRef}`, icon: 'link', ton: 'warn', box: p.externalRef, kunde: 'ohne Kunde',
      grund: p.hint, kurz: 'ohne Kunde', schrittLabel: 'Akte', route: geraeteAkteRoute(p.externalRef),
      rang: RANG.anmeldung, art: 'anmeldung',
    });
  }

  return out.sort((a, b) => a.rang - b.rang || a.box.localeCompare(b.box, 'de'));
}

function satzText(z: BoxZeile): string | null {
  if (!z.satz) return null;
  return z.satz.map((t) => (typeof t === 'string' ? t : t.mono)).join('');
}

// ── Flotte (Gerätewand) ─────────────────────────────────────────────────────

/**
 * Der Zustand einer Box auf der Gerätewand - dieselben Töne wie die
 * Live-Zustände der Akte (§5.3). Die Verbindung schlägt das Update: eine Box,
 * die sich nicht meldet, „läuft" nicht.
 */
export type FlottenTon = 'ok' | 'verzoegert' | 'aus' | 'nie' | 'lauf' | 'hand';

/**
 * Ein bis zwei Wörter je Zustand - dieselben wie die Filter der Geräte-Liste
 * (`geraeteListe.ts`). Auf der Wand trägt nur eine Abweichung ihr Wort; eine
 * gesunde Box zeigt ihre grüne Leuchte und nennt „verbunden" nur dem
 * Vorleseprogramm.
 */
export const FLOTTEN_WORT: Record<FlottenTon, string> = {
  ok: 'verbunden',
  verzoegert: 'verzögert',
  aus: 'offline',
  nie: 'nie gemeldet',
  lauf: 'Update läuft',
  hand: 'nur von Hand',
};

/** 0 = Störung, 1 = Hinweis, 2 = ruhig - die Reihenfolge der Wand. */
export type FlottenStufe = 0 | 1 | 2;
const FLOTTEN_STUFE: Record<FlottenTon, FlottenStufe> = { aus: 0, nie: 0, verzoegert: 1, lauf: 1, hand: 1, ok: 2 };
const FLOTTEN_RANG: Record<FlottenTon, number> = { aus: 0, nie: 1, verzoegert: 2, lauf: 3, hand: 4, ok: 5 };

export interface FlottenBox {
  ref: string;
  /** Wie in der Akte und in „Braucht dich": zuerst der Kunde, dann die Anlage. */
  kunde: string;
  tenantId: string;
  anlage: string;
  /** Nur bei mehreren Boxen an EINER Anlage: der Gerätename, sonst die Kennung. */
  zusatz: string | null;
  /** Die Linie der Box (Umriss auf der Wand); `null` = unbekannt. */
  linie: BoxArt | null;
  ton: FlottenTon;
  stufe: FlottenStufe;
}

/** Eine Anlage ohne Box: kein Feld auf der Wand, ein leiser Hinweis mit Weg zur Kundenakte. */
export interface FlottenOhneBox {
  kunde: string;
  tenantId: string;
  anlage: string;
}

export interface Flottenbild {
  /** Störungen zuerst, dann Hinweise, dann die ruhigen - je nach Kunde und Anlage. */
  boxen: FlottenBox[];
  kunden: number;
  ohneBox: FlottenOhneBox[];
}

/**
 * Die Gerätewand (§4.3 Punkt 4; Konzept `vp-flottenbild-konzept` Weg B,
 * Captain-Entscheid E1=B vom 07.11.2026): jede Box ein kleines Gerät mit
 * Leuchte, Störungen vorn. Die Verbindung kommt aus `fleetBoxGroups` (derselbe
 * Fakt wie die Verbindungs-Kachel); „läuft" und „nur von Hand" kommen aus der
 * Linie der Box (`segmentArt`), weil nur dort gemeldet wird, OB ein Update
 * gerade läuft.
 *
 * **Name wie in der Akte.** Eine Box bekommt beim Verbinden keinen Namen
 * (`DeviceRepository.claim`), ihr `name` fällt dann auf die Kennung zurück.
 * Erkennbar ist sie am Kunden und an der Anlage - so nennen sie auch „Braucht
 * dich" (`geraeteUpdates.boxName`) und der Kopf der Akte.
 */
export function uebersichtFlotte(groups: FleetBoxGroup[], edgeFleet: readonly EdgeFleetRow[]): Flottenbild {
  const linieByRef = new Map(edgeFleet.map((r) => [r.externalRef, r]));
  const boxen: FlottenBox[] = [];
  const ohneBox: FlottenOhneBox[] = [];
  for (const { site, boxes } of groups) {
    if (boxes.length === 0) {
      ohneBox.push({ kunde: site.tenantName, tenantId: site.tenantId, anlage: site.siteName });
      continue;
    }
    for (const box of boxes) {
      const row = linieByRef.get(box.externalRef) ?? null;
      const ton = flottenTon(box, row ? segmentArt(row.stand) : null);
      boxen.push({
        ref: box.externalRef,
        kunde: site.tenantName,
        tenantId: site.tenantId,
        anlage: site.siteName,
        zusatz: boxes.length > 1 ? box.name : null,
        linie: row ? linieDerBox(row) : null,
        ton,
        stufe: FLOTTEN_STUFE[ton],
      });
    }
  }
  boxen.sort((a, b) => a.stufe - b.stufe
    || FLOTTEN_RANG[a.ton] - FLOTTEN_RANG[b.ton]
    || a.kunde.localeCompare(b.kunde, 'de')
    || a.anlage.localeCompare(b.anlage, 'de')
    || (a.zusatz ?? '').localeCompare(b.zusatz ?? '', 'de')
    || a.ref.localeCompare(b.ref));
  return { boxen, kunden: new Set(boxen.map((b) => b.tenantId)).size, ohneBox };
}

function flottenTon(box: FleetBoxRow, segment: ReturnType<typeof segmentArt> | null): FlottenTon {
  if (box.connectionZustand === 'nie') return 'nie';
  if (box.connectionZustand === 'offline') return 'aus';
  // E6: „verzögert" ist noch keine Störung - ein eigener, ruhigerer Ton.
  if (box.connectionZustand === 'verzoegert') return 'verzoegert';
  if (segment === 'lauf') return 'lauf';
  if (segment === 'hand') return 'hand';
  return 'ok';
}

/**
 * Ab dieser Flottengröße klappt das Telefon die ruhigen Boxen zu (E2=A). Die
 * Grenze hängt an der Größe der Flotte, nicht am Zustand - sonst wechselte die
 * Wand bei jedem Ausfall ihre Form.
 */
export const FLOTTE_TELEFON_KLAPPEN_AB = 13;

/** Am Telefon: Störungen und Hinweise bleiben offen, ab 13 Boxen klappen die ruhigen zu. */
export function flotteAmTelefon(bild: Flottenbild): { offen: FlottenBox[]; zugeklappt: FlottenBox[] } {
  if (bild.boxen.length < FLOTTE_TELEFON_KLAPPEN_AB) return { offen: bild.boxen, zugeklappt: [] };
  return {
    offen: bild.boxen.filter((b) => b.stufe < 2),
    zugeklappt: bild.boxen.filter((b) => b.stufe === 2),
  };
}

// ── Dienste ─────────────────────────────────────────────────────────────────

export interface UebersichtDienst {
  id: string;
  label: string;
  text: string;
  ton: UebersichtTon;
}

/**
 * Tunnel- und Werkstatt-Dienst - die zwei Rückmeldungen, die diese Scheibe
 * schon lädt. Optimierer, Preise und Messwerte kommen mit S6 (Lücke L1) dazu;
 * bis dahin bleibt die Zeile bewusst kurz, statt eine erfundene Zahl zu
 * zeigen.
 */
const PLATTFORM_DIENST_LABEL: Record<string, string> = {
  optimierer: 'Optimierer',
  preise: 'Preise',
  messwerte: 'Messwerte',
};

/** Ab wann ein L1-Dienst als verzögert gilt - großzügiger als Tunnel/Werkstatt, da diese Dienste nur alle 15 Min. bzw. stündlich laufen. */
const L1_DIENST_WARN_MS = 30 * 60_000;

export function uebersichtDienste(
  fernwartung: FernwartungUebersicht | null,
  werkstatt: WerkstattDienst | null,
  now: Date,
  plattformDienste?: AdminPlattformDienste | null,
): UebersichtDienst[] {
  const out: UebersichtDienst[] = [];
  // L1 (S6): Optimierer, Preise, Messwerte - additiv aus dem Lesemodell, in
  // der Reihenfolge des Konzepts (§4.3) VOR Tunnel- und Werkstatt-Dienst.
  for (const d of plattformDienste?.dienste ?? []) {
    const label = PLATTFORM_DIENST_LABEL[d.name];
    if (!label) continue; // tunnel-dienst/werkstatt-dienst bleiben bei ihrer eigenen, frischeren Quelle unten.
    if (d.zuletztAm == null) {
      out.push({ id: d.name, label, text: 'noch nie gemeldet', ton: 'warn' });
      continue;
    }
    const alterMs = now.getTime() - Date.parse(d.zuletztAm);
    out.push({
      id: d.name, label, text: `zuletzt ${relAge(alterMs)}`,
      ton: alterMs <= L1_DIENST_WARN_MS ? 'ok' : 'warn',
    });
  }
  const rueckmeldungen = fernwartung?.rueckmeldungen ?? [];
  if (rueckmeldungen.length > 0) {
    const juengste = rueckmeldungen.reduce((a, b) => (Date.parse(a.zuletztAm) > Date.parse(b.zuletztAm) ? a : b));
    const alterMs = now.getTime() - Date.parse(juengste.zuletztAm);
    out.push({
      id: 'tunnel-dienst', label: 'Tunnel-Dienst', text: `meldet ${relAge(alterMs)}`,
      ton: alterMs <= 90_000 ? 'ok' : 'warn',
    });
  }
  if (werkstatt && werkstatt.alterSekunden != null) {
    out.push({
      id: 'werkstatt-dienst', label: 'Werkstatt-Dienst', text: `meldet ${relAge(werkstatt.alterSekunden * 1000)}`,
      ton: werkstatt.aktuell ? 'ok' : 'warn',
    });
  }
  return out;
}

// ── Auffällig ───────────────────────────────────────────────────────────────

export interface AuffaelligZeile {
  key: string;
  ort: string;
  text: string;
  /** Die Begründung des Servers (Pflege-Hinweis), sonst `null`. */
  detail: string | null;
  /**
   * Wo der Hinweis behoben wird (Admin-Durchgang F2: vorher führte keine Zeile irgendwohin):
   * die Akte › Anlage der führenden Box, ohne Box die Kundenakte, bei einer abgelehnten
   * Anfrage die Akte › Software.
   */
  ziel: string;
}

/**
 * Pflege-Hinweise, Prognose-Ausreißer und abgelehnte Fassungen - klein, ohne
 * Takt-Zahl, bewusst ohne Geld (§4.3 Punkt 6). Eine Box, die schon in
 * „Braucht dich" steht (Segment `fehler`), erscheint hier kein zweites Mal.
 */
export function uebersichtAuffaellig(
  sites: AdminFleetSite[],
  edgeFleet: readonly EdgeFleetRow[],
  now: Date,
): AuffaelligZeile[] {
  const out: AuffaelligZeile[] = [];
  const boxJeAnlage = new Map(sites.map((s) => {
    const boxen = s.boxes ?? [];
    return [s.siteId, (boxen.find((b) => b.fuehrtAnlage) ?? boxen[0])?.externalRef ?? null];
  }));
  for (const site of fleetRows(sites, now)) {
    const box = boxJeAnlage.get(site.siteId) ?? null;
    const ziel = box ? geraeteAkteHash(box, 'anlage') : mandantHash(site.tenantId);
    for (const p of site.pflege) {
      out.push({ key: `pflege-${site.siteId}-${p.code}`, ort: site.siteName, text: p.label, detail: p.detail ?? null, ziel });
    }
  }
  for (const row of edgeFleet) {
    if (segmentArt(row.stand) === 'fehler') continue;
    if (row.fakten?.angenommen.stand !== 'abgelehnt') continue;
    const name = row.siteName?.trim() || row.label || row.externalRef;
    out.push({
      key: `abgelehnt-${row.externalRef}`, ort: name,
      text: `Anfrage abgelehnt${row.fakten.angenommen.grund ? `: ${row.fakten.angenommen.grund}` : ''}`,
      detail: null, ziel: geraeteAkteHash(row.externalRef, 'software'),
    });
  }
  return out;
}
