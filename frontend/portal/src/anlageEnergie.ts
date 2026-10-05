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
 * Je Anlagentyp nur, was passt: Erzeugung nur mit PV-Rolle, Speicher nur mit
 * Speicher-Rolle (eine reine Messanlage trägt keine PV-/Speicher-Kachel).
 *
 * Die Kennzahl (kWh/kg usw.) wandert damit aus der Übersicht in die Tiefe
 * (Anlage · Auswerten); hier stehen nur Energiedaten.
 */
import type { AnlagenZeile, ZeilenZustand } from './portfolioCockpit';
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
}

/** Die Rollen einer Anlage (aus `OverviewSite.roleCounts`); fehlt es, gilt „keine". */
export interface AnlageRollen {
  pv: number;
  storage: number;
}

/** Der Anlagentyp als Wort — aus den Rollen, nicht aus einem Messwert. */
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
  if (wert == null) return { rolle, label, wert: '–', einheit, zeit, leer: true };
  return { rolle, label, wert: fmtNum(wert, '', digits), einheit, zeit };
}

/** „Netz jetzt": Richtung + Betrag in kW; „ausgeglichen" als Wort; „–" ohne frischen Messwert. */
function netzStat(netz: AnlagenZeile['netz']): EnergieStat {
  if (!netz) return { rolle: 'grid', label: 'Netz', wert: '–', einheit: '', zeit: 'jetzt', leer: true };
  if (netz.richtung === 'ausgeglichen')
    return { rolle: 'grid', label: 'Netz', wert: 'ausgeglichen', einheit: '', zeit: 'jetzt' };
  return {
    rolle: 'grid',
    label: netz.richtung === 'bezug' ? 'Netzbezug' : 'Einspeisung',
    wert: fmtNum(netz.kw, '', 1),
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
 * Nur mit PV-Rolle: Erzeugung heute. Nur mit Speicher-Rolle: Speicher.
 * So trägt eine reine Messanlage genau zwei Angaben, eine PV-Speicher-Anlage vier.
 */
export function anlageEnergie(
  z: AnlagenZeile,
  rollen: AnlageRollen,
  nichtZugeordnet = false,
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
  };
}
