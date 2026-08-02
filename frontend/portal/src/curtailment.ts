// Die DREI-STUFEN-WAHRHEIT der Abregelung — die EINE Stelle, an der aus dem
// `curtailment`-Block des Herzschlags Kunden-Sätze werden (Scout
// `vp-pilsting-abregeln` Frage 3, PR 3 von 4).
//
// Warum es sie gibt: der Optimierer plant `curtail_kw`, aber ob die Anlage die
// Drosselung AUSFÜHRT, hängt an einer manuellen Freigabe je Wechselrichter —
// und die Cloud las den Beleg dafür bis hierher gar nicht. Fix 1 hat deshalb
// jede Fläche auf „geplant" umgestellt (Stufe 1). Mit dem ingestierten Block
// werden Stufe 2 und 3 möglich:
//
//   Stufe 1 `plan`            kein Beleg (ältere Edge, kein Aktor, veralteter
//                             Block) → der Plan-Wortlaut aus Fix 1, unverändert.
//   Stufe 2 `nicht_umgesetzt` die Anlage setzt es (noch) nicht um — MIT dem
//                             nennbaren Grund („0 von 2 Wechselrichtern
//                             freigegeben").
//   Stufe 3 `ausgefuehrt`     angewandt UND vom Wechselrichter bestätigt —
//                             erst hier ist Gegenwart erlaubt.
//           `uebersteuert`    angewandt, aber die gemessene Leistung hält sich
//                             nicht daran: eine fremde Steuerung übersteuert.
//
// Drei Regeln, die hier nicht wegoptimiert werden dürfen:
//   1. Ein FEHLENDER Beleg ist Stufe 1 — nie eine Behauptung in die eine oder
//      andere Richtung (die Ehrlichkeitsregel des Repos).
//   2. Ein VERALTETER Beleg ist ebenfalls Stufe 1: ein sechs Minuten alter
//      Rücklese-Stand belegt nicht, was die Anlage JETZT tut.
//   3. Nur ein ausdrückliches `allMatch === true` ist eine Bestätigung —
//      `null` heißt „nichts angewandt", nicht „widersprochen".
import type { CurtailmentStatus } from './api';
import { fmtNum } from './format';

/** Die vier Zustände der Beleg-Lage (Stufe 3 hat zwei Ausprägungen). */
export type CurtailStufe = 'plan' | 'nicht_umgesetzt' | 'ausgefuehrt' | 'uebersteuert';

/**
 * Ab dieser Alterung ist der Block kein Beleg mehr. Bewusst dasselbe Fenster
 * wie `control.CONTROL_STALE_MS` — beide Wahrheiten reisen im SELBEN Herzschlag,
 * also altern sie gleich. (Die Konstante wird hier eigenständig geführt, damit
 * `control.ts` von diesem Modul abhängen kann und nicht umgekehrt.)
 */
export const CURTAIL_STALE_MS = 5 * 60 * 1000;

/** Was die Flächen aus dem Block wissen — abgeleitet, nie roh weitergereicht. */
export interface CurtailTruth {
  stufe: CurtailStufe;
  /**
   * Der Grund, warum NICHT (oder nicht sauber) ausgeführt wird, als Halbsatz
   * ohne Punkt („0 von 2 Wechselrichtern freigegeben"). Null bei Stufe 1 und
   * bei sauberer Ausführung.
   */
  cause: string | null;
  /** Die angewandte Begrenzung in kW; null = keine bekannt. */
  appliedCapKw: number | null;
  /** true, wenn der Block zu alt ist, um etwas zu belegen. */
  stale: boolean;
}

/** Der Zustand ohne jeden Beleg — exakt das Verhalten vor PR 3. */
export const CURTAIL_PLAN: CurtailTruth = {
  stufe: 'plan',
  cause: null,
  appliedCapKw: null,
  stale: false,
};

function num(v: number | null | undefined): number | null {
  return v == null || !Number.isFinite(Number(v)) ? null : Number(v);
}

/** „0 von 2 Wechselrichtern freigegeben" — Singular/Plural korrekt. */
export function releaseNote(certifiedUnits: number, units: number): string {
  const wr = units === 1 ? 'Wechselrichter' : 'Wechselrichtern';
  return `${certifiedUnits} von ${units} ${wr} freigegeben`;
}

/**
 * Die Beleg-Lage aus dem gemeldeten Block. Die Reihenfolge der Prüfungen ist
 * die Aussagekraft: erst was die Ausführung ganz verhindert (Not-Aus, fehlende
 * Freigabe, nichts angewandt), dann die Übersteuerung (die schärfste, weil
 * gemessene Aussage), dann die Bestätigung.
 */
export function curtailTruth(
  status: CurtailmentStatus | null | undefined,
  now: Date = new Date(),
): CurtailTruth {
  // Ein Block ohne Einheiten beschreibt keinen Aktor — daraus „0 von 0
  // freigegeben" zu machen wäre eine Aussage über nichts.
  if (!status || !(status.units > 0)) return CURTAIL_PLAN;

  const ageMs = now.getTime() - new Date(status.checkedAt).getTime();
  if (Number.isNaN(ageMs) || ageMs > CURTAIL_STALE_MS) {
    return { ...CURTAIL_PLAN, stale: true };
  }

  const cap = num(status.appliedCapKw);
  if (!status.controlEnabled) {
    return {
      stufe: 'nicht_umgesetzt',
      cause: 'die Wechselrichter-Steuerung ist ausgeschaltet',
      appliedCapKw: null,
      stale: false,
    };
  }
  if (status.certifiedUnits < status.units) {
    // Auch eine TEILWEISE Freigabe ist Stufe 2: die Anlage drosselt dann nur
    // einen Teil, und „vom Wechselrichter bestätigt" wäre zu viel versprochen.
    return {
      stufe: 'nicht_umgesetzt',
      cause: releaseNote(status.certifiedUnits, status.units),
      appliedCapKw: cap,
      stale: false,
    };
  }
  if (!status.active) {
    return {
      stufe: 'nicht_umgesetzt',
      cause: 'die Anlage wendet gerade keine Begrenzung an',
      appliedCapKw: null,
      stale: false,
    };
  }
  if (status.possibleOverride) {
    return {
      stufe: 'uebersteuert',
      cause: 'möglicherweise übersteuert eine lokale Einstellung die Begrenzung',
      appliedCapKw: cap,
      stale: false,
    };
  }
  if (status.allMatch !== true) {
    // Angewandt, aber (noch) nicht bestätigt — das ist keine Ausführung.
    return {
      stufe: 'nicht_umgesetzt',
      cause: 'die Begrenzung ist noch nicht bestätigt',
      appliedCapKw: cap,
      stale: false,
    };
  }
  return { stufe: 'ausgefuehrt', cause: null, appliedCapKw: cap, stale: false };
}

/**
 * Die Beleg-Lage gilt für den Slot, der JETZT läuft — nicht für einen
 * angetippten Vormittags- oder Abend-Slot. Und sie sagt nur etwas, wenn dort
 * überhaupt abgeregelt werden soll.
 *
 * Deshalb geht JEDE Fläche durch diesen Filter, statt die Wahrheit irgendwo
 * durchzureichen: „vom Wechselrichter bestätigt" an einem 15-Uhr-Slot wäre
 * eine Behauptung über die Zukunft.
 */
export function curtailTruthForSlot(
  truth: CurtailTruth | null | undefined,
  slotRole: string | null | undefined,
  isCurrentSlot = true,
): CurtailTruth {
  if (!truth || !isCurrentSlot || slotRole !== 'abregeln') return CURTAIL_PLAN;
  return truth;
}

/** true, sobald ein Beleg vorliegt (Stufe 2 oder 3). */
export function hasCurtailEvidence(truth: CurtailTruth): boolean {
  return truth.stufe !== 'plan';
}

/** „12,5 kW" — die Begrenzung als Zahl, null wenn keine bekannt ist. */
function capText(truth: CurtailTruth): string | null {
  return truth.appliedCapKw == null ? null : fmtNum(truth.appliedCapKw, 'kW', 1);
}

/**
 * Der EINE Satz über die Ausführung — geteilt von Jetzt-Held, Fahrplan-Panel
 * und Steuerungs-Karte, damit die drei sich nicht widersprechen können.
 * Null bei Stufe 1: ohne Beleg wird nichts über die Ausführung gesagt.
 */
export function curtailExecutionNote(truth: CurtailTruth): string | null {
  switch (truth.stufe) {
    case 'plan':
      return null;
    case 'nicht_umgesetzt':
      return `Ihre Anlage setzt das noch nicht um (${truth.cause}).`;
    case 'uebersteuert':
      return (
        'Die Einspeisung soll begrenzt sein, der Wechselrichter hält die ' +
        'Begrenzung aber nicht — möglicherweise übersteuert ihn eine lokale Einstellung.'
      );
    case 'ausgefuehrt': {
      const cap = capText(truth);
      return cap == null
        ? 'Die Einspeisung ist begrenzt — vom Wechselrichter bestätigt.'
        : `Die Einspeisung ist auf ${cap} begrenzt — vom Wechselrichter bestätigt.`;
    }
  }
}

/**
 * Der WARN-Satz des Jetzt-Helden (bernstein): er entsteht entweder aus dem
 * Beleg (Stufe 2/3-übersteuert) oder — solange es keinen gibt — aus dem
 * Widerspruch zwischen Plan und gemessener Einspeisung (der Fix-1-Satz).
 *
 * `exportKw` ist die GEMESSENE Einspeisung in kW (positiv), null wenn nichts
 * Frisches gemessen wurde. Bei Stufe 3 (bestätigt) ist eine verbleibende
 * Einspeisung KEIN Widerspruch — eine Begrenzung ist ein Deckel, keine Null,
 * und der nicht abregelbare Anteil der Anlage speist weiter ein. Dort schweigt
 * dieser Satz und `curtailExecutionNote` trägt die (gute) Nachricht.
 */
export function curtailWarnLine(
  truth: CurtailTruth,
  exportKw: number | null,
): string | null {
  const exp = num(exportKw);
  const measured = exp != null && exp > 0 ? fmtNum(exp, 'kW', 1) : null;
  switch (truth.stufe) {
    case 'ausgefuehrt':
      return null;
    case 'uebersteuert':
      return curtailExecutionNote(truth);
    case 'nicht_umgesetzt':
      return measured == null
        ? `Ihre Anlage setzt die geplante Drosselung noch nicht um (${truth.cause}).`
        : `Ihre Anlage speist gerade ${measured} ein – sie setzt die Drosselung ` +
            `noch nicht um (${truth.cause}).`;
    case 'plan':
      // Fix 1, unverändert: ohne Beleg nennt der Satz BEIDE Möglichkeiten und
      // behauptet keine.
      return measured == null
        ? null
        : `Ihre Anlage speist gerade ${measured} ein – die Drosselung ist auf dieser ` +
            'Anlage noch nicht freigegeben oder nicht bestätigt.';
  }
}

/**
 * Der Rollen-Titel der Abregelung. Gegenwart NUR bei belegter Ausführung —
 * das ist der ganze Punkt der drei Stufen.
 *
 * `framed` = der umgebende Satz sagt schon „Geplant ist gerade: …", dann
 * entfällt der „— geplant"-Zusatz (sonst stünde es zweimal in einer Zeile).
 */
export function curtailRoleLabel(truth: CurtailTruth, framed = false): string {
  const base = 'Einspeisung pausier';
  if (truth.stufe === 'ausgefuehrt') return `${base}t (Negativpreis)`;
  if (truth.stufe === 'uebersteuert') return `${base}en (Negativpreis) — nicht gehalten`;
  return `${base}en (Negativpreis)${framed ? '' : ' — geplant'}`;
}

/**
 * Die Verbalphrase des Jetzt-Helden („… pausiert gerade die Einspeisung").
 * Konjunktiv, solange nichts belegt ist.
 */
export function curtailActionPhrase(truth: CurtailTruth): string {
  return truth.stufe === 'ausgefuehrt'
    ? 'pausiert gerade die Einspeisung'
    : 'soll gerade die Einspeisung pausieren';
}

/** Der Bindungs-Chip des Slot-Panels. */
export function curtailChipLabel(truth: CurtailTruth): string {
  return truth.stufe === 'ausgefuehrt' ? 'Drosselung aktiv' : 'Drosselung geplant';
}
