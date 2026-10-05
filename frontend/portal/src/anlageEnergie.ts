/**
 * ENERGIEDATEN JE ANLAGE für die „Anlagen nach Standort"-Karten der UEMS-Übersicht
 * (Konzept `data/vp-portfolio-konzept2-p2`, Runde 4, Captain-Freigabe 05.10.2026:
 * „will da eigentlich Energiedaten statt Kennzahlen").
 *
 * Reines Modul (AGENTS.md „Fachableitungen bleiben reine Module; Komponenten
 * rendern ihr Ergebnis"): es nimmt die fertige {@link AnlagenZeile} der Übersicht
 * und die Rollen der Anlage und entscheidet, WELCHE Energiedaten je Anlagentyp
 * Sinn ergeben und wie sie ehrlich lauten. Keine React-Importe, kein Netzwerk,
 * keine eigene Zahl — es formatiert nur die schon berechneten Werte der Zeile.
 *
 * Ehrlichkeit (AGENTS.md „Fehlend ist keine Null. Veraltete Daten nicht als
 * aktuell zeigen"): ein fehlender Wert steht als „–" (`leer`), nie als 0; ein
 * veralteter Ladestand steht datiert und gedämpft (`dim`), nie als „jetzt".
 * Je Anlagentyp nur, was zu den ROLLEN passt: Erzeugung nur mit PV-Rolle,
 * Speicher nur mit Speicher-Rolle (`roleCounts`). Die modellierte Rolle ist die
 * Wahrheit — sie sagt, was die Anlage IST; eine Live-/Telemetriezahl kann ein
 * Simulator-Artefakt sein (die Demo publiziert für reine Messanlagen dasselbe
 * PV-/Speicher-Profil). Eine reine Messanlage trägt daher keine PV-/Speicher-
 * Kachel, auch wenn Telemetrie ankommt.
 *
 * Die Kennzahl (kWh/kg usw.) wandert damit aus der Übersicht in die Tiefe
 * (Anlage · Auswerten); hier stehen nur Energiedaten.
 */
import type { AnlagenZeile, ZeilenZustand } from './portfolioCockpit';
import type { History } from './api';
import { fmtNum } from './format';

/** Der Farbkanal einer Energie-Angabe — die Rollen-Töne des Flusses. */
export type EnergieRolle = 'load' | 'pv' | 'grid' | 'batt';

/** Eine Energie-Angabe einer Anlage: Rolle (Farbe), Beschriftung, Wert, Einheit, Zeitbezug. */
export interface EnergieStat {
  rolle: EnergieRolle;
  /** „Verbrauch" · „Erzeugung" · „Netzbezug"/„Einspeisung"/„Netz" · „Speicher". */
  label: string;
  /** Der formatierte Wert („142.300", „4,3", „ausgeglichen") oder „–" bei `leer`. */
  wert: string;
  /** „kWh" · „kW" · „%" · „" (bei Wort-Werten wie „ausgeglichen"). */
  einheit: string;
  /** „heute" · „jetzt" · „zuletzt 03.10." — nie leer. */
  zeit: string;
  /** Veralteter/gedämpfter Wert (datiert) — keine Frische-Aussage. */
  dim?: boolean;
  /** Der Wert fehlt (steht als „–"); nie eine gemessene 0. */
  leer?: boolean;
}

/** Das Energiedaten-Modell einer Anlage für ihre Karte. */
export interface AnlageEnergie {
  id: string;
  name: string;
  /** „reine Messung" · „PV" · „Speicher" · „PV + Speicher" — der Anlagentyp als Chip. */
  typ: string;
  zustand: ZeilenZustand;
  /** Die Energiedaten in Lese-Reihenfolge; je Anlagentyp zwei bis vier. */
  stats: EnergieStat[];
  /** „Speicher ohne Gerät" — der Fahrplan erreicht die Anlage nicht. */
  speicherOhneGeraet: boolean;
  /** AP-02 IP-10: eine offene Bestandsanlage ohne Standort trägt den Chip. */
  nichtZugeordnet: boolean;
  /** Die Tages-Verlaufskurve (Rollen-Farben); `null` = keine Historie. */
  kurve: AnlageKurve | null;
}

/** Die Tageskurve einer Anlage (Rollen-Farben) für die kleine Verlaufskurve. */
export interface AnlageKurve {
  /** PV-Erzeugung je Viertelstunde in kW; `null` = Lücke. */
  pv: (number | null)[];
  /** Verbrauch je Viertelstunde in kW; `null` = Lücke. */
  load: (number | null)[];
  /** Index der aktuellen Viertelstunde (0..95); rechts davon ist nichts gemessen. */
  jetzt: number;
}

/**
 * Die modellierten Rollen einer Anlage (aus `OverviewSite.roleCounts`); fehlt es,
 * gilt „keine". Sie entscheiden den Anlagentyp und welche Energiedaten die Karte
 * trägt — die Rolle ist die Wahrheit, nicht eine (womöglich simulierte) Live-Zahl.
 */
export interface AnlageRollen {
  pv: number;
  storage: number;
}

function vwert(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function viertelstunde(iso: string): number | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.getHours() * 4 + Math.floor(d.getMinutes() / 15);
}

/**
 * Die Tageskurve einer Anlage aus ihrer Tages-Historie: PV und Verbrauch je
 * Viertelstunde (kWh × 4 = kW). `null`, wenn keine Historie/Werte vorliegen —
 * dann zeigt die Karte keine Kurve (keine erfundene Linie).
 */
export function anlageKurve(history: History | null | undefined, now: Date): AnlageKurve | null {
  if (!history || history.buckets.length === 0) return null;
  const pv: (number | null)[] = Array(96).fill(null);
  const load: (number | null)[] = Array(96).fill(null);
  const faktor = 60 / (history.bucketMinutes || 15);
  let hat = false;
  for (const b of history.buckets) {
    const i = viertelstunde(b.start);
    if (i == null || i < 0 || i > 95) continue;
    const p = vwert(b.pvKwh);
    const l = vwert(b.loadKwh);
    if (p != null) {
      pv[i] = p * faktor;
      hat = true;
    }
    if (l != null) {
      load[i] = l * faktor;
      hat = true;
    }
  }
  if (!hat) return null;
  return { pv, load, jetzt: now.getHours() * 4 + Math.floor(now.getMinutes() / 15) };
}

/** Der Anlagentyp als Wort — aus den modellierten Rollen, nicht aus einem Messwert. */
export function anlageTyp(rollen: AnlageRollen): string {
  const pv = rollen.pv > 0;
  const speicher = rollen.storage > 0;
  if (pv && speicher) return 'PV + Speicher';
  if (pv) return 'PV';
  if (speicher) return 'Speicher';
  return 'reine Messung';
}

function energieZahl(
  rolle: EnergieRolle,
  label: string,
  wert: number | null,
  einheit: string,
  zeit: string,
  digits: number,
): EnergieStat {
  // Fehlender Wert: nur der Strich, OHNE Einheit (überall gleich).
  if (wert == null) return { rolle, label, wert: '–', einheit: '', zeit, leer: true };
  return { rolle, label, wert: fmtNum(wert, '', digits), einheit, zeit };
}

/**
 * „Netz · jetzt": ein einheitliches Label, die Richtung steht im Wert
 * („Bezug 4,5" / „Einspeisung 2,1" + kW, „ausgeglichen", „–" ohne frischen Wert).
 */
function netzStat(netz: AnlagenZeile['netz']): EnergieStat {
  if (!netz) return { rolle: 'grid', label: 'Netz', wert: '–', einheit: '', zeit: 'jetzt', leer: true };
  if (netz.richtung === 'ausgeglichen')
    return { rolle: 'grid', label: 'Netz', wert: 'ausgeglichen', einheit: '', zeit: 'jetzt' };
  return {
    rolle: 'grid',
    label: 'Netz',
    wert: `${netz.richtung === 'bezug' ? 'Bezug' : 'Einspeisung'} ${fmtNum(netz.kw, '', 1)}`,
    einheit: 'kW',
    zeit: 'jetzt',
  };
}

/** Speicher-Ladestand: „jetzt" mit Wort, oder datiert und gedämpft, oder „–". */
function speicherStat(z: AnlagenZeile): EnergieStat {
  if (z.ladestandPct == null)
    return { rolle: 'batt', label: 'Speicher', wert: '–', einheit: '', zeit: 'jetzt', leer: true };
  if (z.ladestandStand)
    // Älter als ein Tag: datiert und gedämpft — nie als aktuelle Zahl (AGENTS.md).
    return {
      rolle: 'batt',
      label: 'Speicher',
      wert: fmtNum(z.ladestandPct, '', 0),
      einheit: '%',
      zeit: z.ladestandStand,
      dim: true,
    };
  return {
    rolle: 'batt',
    label: 'Speicher',
    wert: fmtNum(z.ladestandPct, '', 0),
    einheit: '%',
    zeit: z.ladestandWort ?? 'jetzt',
  };
}

/**
 * Das Energiedaten-Modell einer Anlage. Immer: Verbrauch heute und Netz jetzt.
 * Erzeugung nur mit PV-Rolle, Speicher nur mit Speicher-Rolle (`roleCounts`).
 *
 * Die ROLLE entscheidet, nicht die Telemetrie: eine reine Messanlage trägt genau
 * zwei Angaben (Verbrauch, Netz), auch wenn der Simulator ihr ein PV-/Speicher-
 * Profil schickt; eine PV-Speicher-Anlage vier. So kann keine simulierte Live-
 * Zahl eine Anlage falsch als „PV + Speicher" ausweisen (die Rolle ist die
 * Wahrheit). Fehlende Werte innerhalb einer gezeigten Angabe bleiben „–".
 */
export function anlageEnergie(
  z: AnlagenZeile,
  rollen: AnlageRollen,
  nichtZugeordnet = false,
  kurve: AnlageKurve | null = null,
): AnlageEnergie {
  const stats: EnergieStat[] = [energieZahl('load', 'Verbrauch', z.verbrauchKwh, 'kWh', 'heute', 0)];
  if (rollen.pv > 0) stats.push(energieZahl('pv', 'Erzeugung', z.erzeugungKwh, 'kWh', 'heute', 0));
  stats.push(netzStat(z.netz));
  if (rollen.storage > 0) stats.push(speicherStat(z));
  return {
    id: z.id,
    name: z.name,
    typ: anlageTyp(rollen),
    zustand: z.zustand,
    stats,
    speicherOhneGeraet: z.speicherOhneGeraet,
    nichtZugeordnet,
    kurve,
  };
}
