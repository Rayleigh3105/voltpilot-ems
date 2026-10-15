/**
 * Satz-Ableitung und Vorgaben einer Überwachung (Alerting Scheibe 2, Konzept vp-alerting-konzept-m1
 * §6.4, §9) - reine Ableitung, keine Komponente rendert hier (`frontend/portal/AGENTS.md`,
 * „Fachableitungen bleiben reine Module“).
 *
 * Eine Überwachung ist ein Satz: „Sag mir Bescheid, wenn ‹Wert› ‹Bedingung› [länger als ‹Dauer›] ·
 * ‹Schwere›.“ Die drei Vorgaben aus §9 (selbst getroffen, begründet):
 *  - Dauer 5 Minuten (Momentanwerte), Erholdauer 5 Minuten - gegen Flattern [G1].
 *  - Rückkehrschwelle 5 % der Schwelle, mindestens die Auflösung der Größe; bei „unter“ liegt die
 *    Rückkehr HÖHER als die Schwelle (zurück über sie), bei „ueber“ NIEDRIGER (zurück unter sie).
 */
import type { Bedingungsart, Periode, Schwere, WerteKatalogEintrag } from './werteKatalog';

const NBSP = ' ';

/**
 * Dieselben drei Wörter wie `meldungen.ts` `SCHWERE_WORT` (Entscheid 6A) - absichtlich noch einmal
 * hier und nicht von dort importiert: `meldungen.ts` ist bewusst das Lazy-Stück NUR der
 * `MeldungenPage`, diese Ableitung dagegen gehört zum Cockpit-Blatt (`UeberwachenBlatt.tsx`,
 * EnergieBuehne-Bündel) - ein Import würde beide Bündel aneinanderketten.
 */
const SCHWERE_WORT: Record<Schwere, string> = {
  hinweis: 'Hinweis',
  warnung: 'Warnung',
  dringend: 'Dringend',
};

export interface VorgabenBedingung {
  dauer_s: number;
  erholen_s: number;
  /** Nur für `ueber` / `unter`. */
  rueckkehr?: number;
  /** Nur für `ausserhalb`: Rückkehr der unteren Grenze (höher als `schwelle`). */
  rueckkehrUnten?: number;
  /** Nur für `ausserhalb`: Rückkehr der oberen Grenze (niedriger als `schwelleOben`). */
  rueckkehrOben?: number;
}

function rundeAufAufloesung(x: number, aufloesung: number): number {
  return Math.round(x / aufloesung) * aufloesung;
}

function rueckkehrAbstand(schwelle: number, aufloesung: number): number {
  return Math.max(Math.abs(schwelle) * 0.05, aufloesung);
}

/**
 * Die Vorgaben einer Bedingung (§9): Dauer und Erholdauer sind für jede Bedingungsart 5 Minuten;
 * `ueber`/`unter`/`ausserhalb` bekommen zusätzlich eine vorgeschlagene Rückkehrschwelle.
 * `aufloesung` ist die kleinste sinnvolle Schrittweite der Größe (Vorgabe 0,1, wie kW; 1 für %).
 */
export function vorgabenFuerBedingung(
  art: Bedingungsart,
  schwelle?: number,
  schwelleOben?: number,
  aufloesung = 0.1,
): VorgabenBedingung {
  const dauer_s = 300;
  const erholen_s = 300;
  if (art === 'ueber' && schwelle != null) {
    const abstand = rueckkehrAbstand(schwelle, aufloesung);
    return { dauer_s, erholen_s, rueckkehr: rundeAufAufloesung(schwelle - abstand, aufloesung) };
  }
  if (art === 'unter' && schwelle != null) {
    const abstand = rueckkehrAbstand(schwelle, aufloesung);
    return { dauer_s, erholen_s, rueckkehr: rundeAufAufloesung(schwelle + abstand, aufloesung) };
  }
  if (art === 'ausserhalb' && schwelle != null && schwelleOben != null) {
    return {
      dauer_s,
      erholen_s,
      rueckkehrUnten: rundeAufAufloesung(schwelle + rueckkehrAbstand(schwelle, aufloesung), aufloesung),
      rueckkehrOben: rundeAufAufloesung(schwelleOben - rueckkehrAbstand(schwelleOben, aufloesung), aufloesung),
    };
  }
  return { dauer_s, erholen_s };
}

/** Eine rohe Bedingung, wie sie das Blatt baut und `POST /api/v1/meldungen/regeln` erwartet.
 * `periode` und `aenderung` (Alerting Scheibe 4, §6.4) gelten nur für die periodischen Leserarten
 * `menge`/`geld` - NIE im Minutentakt ausgewertet. */
export type BedingungEingabe =
  | { art: 'ueber' | 'unter'; schwelle: number; rueckkehr?: number; dauer_s?: number }
  | { art: 'ausserhalb'; schwelleUnten: number; schwelleOben: number; rueckkehrUnten?: number; rueckkehrOben?: number; dauer_s?: number }
  | { art: 'zustand'; ziel: string[]; dauer_s?: number }
  | { art: 'keine_daten'; dauer_s?: number }
  | { art: 'ereignis'; arten?: string[]; dauer_s?: number }
  | { art: 'periode'; richtung: 'ueber' | 'unter'; schwelle: number; periode: Periode; endgueltig?: boolean }
  | { art: 'aenderung'; richtung: 'hoeher' | 'niedriger' | 'beide'; schwelleProzent: number; periode: Periode };

/** Die Wörter der Perioden (§6.3/§6.4) - "im ‹Periode›", für den Satz und die Chips des Blatts. */
export const PERIODE_WORT: Record<Periode, string> = {
  tag: 'Tag',
  woche: 'Woche',
  monat: 'Monat',
  abrechnungszeitraum: 'Abrechnungszeitraum',
};

function imPeriodeText(periode: Periode): string {
  return periode === 'woche' ? 'in der Woche' : `im ${PERIODE_WORT[periode]}`;
}

function dauerText(sekunden: number): string {
  if (sekunden <= 0) return '0 Sekunden';
  if (sekunden % 3600 === 0) {
    const h = sekunden / 3600;
    return `${h} Stunde${h === 1 ? '' : 'n'}`;
  }
  if (sekunden % 60 === 0) {
    const m = sekunden / 60;
    return `${m} Minute${m === 1 ? '' : 'n'}`;
  }
  return `${sekunden} Sekunden`;
}

function zahlText(x: number, nachkommastellen = 1): string {
  return new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: nachkommastellen,
    maximumFractionDigits: nachkommastellen,
  }).format(x);
}

function wertMitEinheit(x: number, einheit: string, nachkommastellen = 1): string {
  return einheit ? `${zahlText(x, nachkommastellen)}${NBSP}${einheit}` : zahlText(x, nachkommastellen);
}

const ZUSTANDSWORT: Record<string, string> = {
  nicht_erreichbar: 'nicht erreichbar',
  erreichbar: 'erreichbar',
  stale: 'veraltet',
  never: 'noch nie geliefert',
  ok: 'in Ordnung',
};

function zustandswort(zustand: string): string {
  return ZUSTANDSWORT[zustand] ?? zustand.replace(/_/g, ' ');
}

function zieleText(ziel: readonly string[]): string {
  const woerter = ziel.map(zustandswort);
  if (woerter.length === 1) return woerter[0];
  return `${woerter.slice(0, -1).join(', ')} oder ${woerter[woerter.length - 1]}`;
}

/**
 * Der deutsche Satz einer Überwachung (§6.4): „Sag mir Bescheid, wenn ‹Wert› ‹Bedingung› [länger
 * als ‹Dauer›] liegt. · ‹Schwere›“. `einheit` ist optional (die Testfälle brauchen sie nicht; der
 * echte Aufrufer liefert sie aus `GET /api/v1/werte`, `nachkommastellen` folgt dem UEMS-Zahlenformat
 * (kW/m³ 1 Stelle, % 0 Stellen - Vorgabe 1).
 */
export function ueberwachungSatz(
  eintrag: WerteKatalogEintrag,
  bedingung: BedingungEingabe,
  schwere: Schwere,
  einheit = '',
  nachkommastellen = 1,
): string {
  // `dauer_s` gilt nur für Momentanwerte - `periode`/`aenderung` (§6.4 Nr. 2) kennen keine Dauer.
  const dauer = dauerText('dauer_s' in bedingung ? bedingung.dauer_s ?? 300 : 300);
  let kern: string;
  switch (bedingung.art) {
    case 'ueber':
      kern = `${eintrag.satzname} länger als ${dauer} über ${wertMitEinheit(bedingung.schwelle, einheit, nachkommastellen)} liegt`;
      break;
    case 'unter':
      kern = `${eintrag.satzname} länger als ${dauer} unter ${wertMitEinheit(bedingung.schwelle, einheit, nachkommastellen)} liegt`;
      break;
    case 'ausserhalb':
      kern = `${eintrag.satzname} länger als ${dauer} außerhalb ${wertMitEinheit(bedingung.schwelleUnten, einheit, nachkommastellen)} bis ${wertMitEinheit(bedingung.schwelleOben, einheit, nachkommastellen)} liegt`;
      break;
    case 'zustand':
      kern = `${eintrag.satzname} länger als ${dauer} ${zieleText(bedingung.ziel)} ist`;
      break;
    case 'ereignis':
      kern = `${eintrag.satzname} ein Ereignis meldet`;
      break;
    case 'keine_daten':
      kern = `${eintrag.satzname} seit ${dauer} ohne neuen Wert ist`;
      break;
    case 'periode':
      kern = `${eintrag.satzname} ${imPeriodeText(bedingung.periode)} ${bedingung.richtung === 'ueber' ? 'über' : 'unter'} ${wertMitEinheit(bedingung.schwelle, einheit, nachkommastellen)} liegt`;
      break;
    case 'aenderung':
      kern = `${eintrag.satzname} sich gegenüber der vorigen Periode (${PERIODE_WORT[bedingung.periode]}) um mehr als ${zahlText(bedingung.schwelleProzent, 0)}${NBSP}% ${richtungswortAenderung(bedingung.richtung)}`;
      break;
  }
  return `Sag mir Bescheid, wenn ${kern}. · ${SCHWERE_WORT[schwere]}`;
}

function richtungswortAenderung(richtung: 'hoeher' | 'niedriger' | 'beide'): string {
  switch (richtung) {
    case 'hoeher':
      return 'steigt';
    case 'niedriger':
      return 'fällt';
    default:
      return 'ändert';
  }
}
