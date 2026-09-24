/**
 * Die ANTWORTEN unter der Tagesuhr bzw. dem Bildfahrplan (Konzept „Tagesuhr
 * und Bildfahrplan", E1: „Tagesuhr, direkt darunter die Antworten"; E9: sie
 * beginnen im ersten Bildschirm).
 *
 * Jede Antwort ist EIN Satz auf eine Kundenfrage und trägt ihren ORT im Bild
 * (`ziel`): ein Tipp dreht den Zeiger der Uhr dorthin, am Rechner markiert der
 * Bildfahrplan die Stelle. Antwort und Bild erklären sich gegenseitig.
 *
 * Ehrlichkeit:
 *  - „Wie geht es weiter?" und „Reicht der Speicher?" sind PLAN-Aussagen und
 *    tragen das Abzeichen „Geplant". „voll"/„leer" werden nur gesagt, wo eine
 *    Viertelstunde die Grenze als BINDEND trägt (`soc_max`/`soc_floor`), nie
 *    aus einer Zahl geraten.
 *  - „Was bringt es heute?" rechnet NICHTS: es ist die Steuerungs-Aussage der
 *    Erlöse-Welt (`speicherAussage`, Messlatte „derselbe Speicher ohne smarte
 *    Steuerung", Entscheid E6) — dieselbe Zahl wie Cockpit und Erlöse-Seite.
 *    Ohne Aussage gibt es keine Antwort, nie eine 0.
 *  - „Was hat sich geändert?" folgt mit der Zeitmaschine (Schritt 3), sobald
 *    frühere Planstände lesbar sind; bis dahin wird darüber nichts behauptet.
 *
 * Rein: kein React, kein Netz.
 */

import { phaseVon, uhrzeit, TAG_MINUTEN, type TagModell, type TagPhase } from './fahrplanTag';
import type { SpeicherAussage } from './speicherAussage';

export type AntwortKey = 'weiter' | 'reicht' | 'bringt';

/** Der Ort einer Antwort im Tagesbild. */
export interface AntwortZiel {
  /** Wohin der Zeiger zeigt (Minute des Tages, Mitte einer Viertelstunde). */
  minute: number;
  /** Der markierte Zeitraum; null = keiner. */
  von: number | null;
  bis: number | null;
  /** Ein markierter Punkt auf der Ladestandslinie (Minute); null = keiner. */
  punkt: number | null;
  /** Welche Ebene der Uhr dabei hervortritt. */
  ebene: 'taetigkeit' | 'ladestand';
}

export interface Antwort {
  key: AntwortKey;
  frage: string;
  /** Die Uhrzeit, für die die Antwort gilt, wenn nicht „jetzt" („15:30 Uhr"). */
  zeit: string | null;
  antwort: string;
  zusatz: string | null;
  /**
   * Eine zweite, leisere Zeile — bei „Was bringt es heute?" die Energie, die
   * im Speicher für später liegt (das Bestandskonto der Erlöse-Welt, E6
   * „dazu die Energie für morgen"); sonst null.
   */
  notiz: string | null;
  /** Das Ehrlichkeits-Abzeichen. */
  art: 'geplant' | 'gemessen';
  ziel: AntwortZiel | null;
  /** Wohin „Details" führt. */
  details: 'stationen' | 'erloese';
  /**
   * true = der Zusatz ist der Nachtrag-Satz (Speicher-Stammdaten fehlen) und
   * führt, wie auf der Erlöse-Seite, zu den Speicher-Einstellungen.
   */
  nachtrag: boolean;
}

/** Ab dieser Uhrzeit (Minuten) zählt eine Entlade-Phase zum Abend. */
export const ABEND_AB_MIN = 16 * 60;

function hatFlag(tag: TagModell, i: number, flag: string): boolean {
  return (tag.slots[i]?.slotFlags ?? []).includes(flag);
}

function pct(v: number): string {
  return `${Math.round(v).toLocaleString('de-DE')} %`;
}

/** Der Punkt (Minute) mitten in der letzten Viertelstunde einer Phase. */
function letzteViertelMitte(tag: TagModell, ph: TagPhase): number {
  const roh = tag.phasenRoh[ph.phaseIndex];
  const v = tag.viertel[roh.endIdx];
  return (v.von + v.bis) / 2;
}

/**
 * „Wie geht es weiter?" ab der gewählten Viertelstunde: die nächsten zwei
 * Phasen mit ihrem Listenwort (E8) und ihrer Startzeit, dazu — falls der Plan
 * es trägt — wann der Speicher voll ist.
 */
export function antwortWeiter(tag: TagModell, auswahl: number, istJetzt: boolean): Antwort | null {
  if (!tag.hatWarum || auswahl < 0 || auswahl >= tag.slots.length) return null;
  const aktuell = phaseVon(tag, auswahl);
  if (!aktuell) return null;
  const k = tag.phasen.indexOf(aktuell);
  const naechste = tag.phasen.slice(k + 1, k + 3);
  const zeit = istJetzt ? null : `${uhrzeit(tag.viertel[auswahl].von)} Uhr`;
  if (naechste.length === 0) {
    // Die letzte Phase: sie endet um Mitternacht - oder dort, wo der geladene
    // Plan endet. Dann wird nichts über die Zeit danach behauptet.
    const bisMitternacht = aktuell.bis >= TAG_MINUTEN;
    return {
      key: 'weiter',
      frage: 'Wie geht es weiter?',
      zeit,
      antwort: bisMitternacht
        ? `${aktuell.label} bis Mitternacht.`
        : `${aktuell.label} bis ${uhrzeit(aktuell.bis)} Uhr.`,
      zusatz: bisMitternacht ? null : 'Weiter reicht der Fahrplan noch nicht.',
      notiz: null,
      art: 'geplant',
      ziel: null,
      details: 'stationen',
      nachtrag: false,
    };
  }
  const antwort =
    naechste.map((p, n) => `${n === 0 ? 'Ab' : 'ab'} ${uhrzeit(p.von)} ${p.label}`).join(', ') + '.';
  // „Voll ab …" nur, wenn der Plan eine Viertelstunde NACH der Auswahl als voll
  // markiert und die Auswahl selbst noch nicht voll ist.
  let zusatz: string | null = null;
  if (!hatFlag(tag, auswahl, 'soc_max')) {
    const voll = tag.viertel.find((v) => v.i > auswahl && hatFlag(tag, v.i, 'soc_max'));
    if (voll) zusatz = `Voll ab ${uhrzeit(voll.von)} Uhr.`;
  }
  const letzte = naechste[naechste.length - 1];
  return {
    key: 'weiter',
    frage: 'Wie geht es weiter?',
    zeit,
    antwort,
    zusatz,
    notiz: null,
    art: 'geplant',
    ziel: {
      minute: naechste[0].von + 7.5,
      von: naechste[0].von,
      bis: letzte.bis,
      punkt: null,
      ebene: 'taetigkeit',
    },
    details: 'stationen',
    nachtrag: false,
  };
}

/**
 * „Reicht der Speicher heute Abend?": die letzte Phase „Verbrauch decken", die
 * am Abend beginnt, ihr Ende und der geplante Ladestand danach. Nur für Tage,
 * deren Plan den Abend überhaupt enthält.
 */
export function antwortReicht(tag: TagModell): Antwort | null {
  if (!tag.hatWarum || tag.viertel.length === 0) return null;
  const letzteMinute = tag.viertel[tag.viertel.length - 1].bis;
  if (letzteMinute <= ABEND_AB_MIN) return null;
  const abend = tag.phasen.filter((p) => p.role === 'eigenverbrauch' && p.von >= ABEND_AB_MIN);
  const frage = 'Reicht der Speicher heute Abend?';
  if (abend.length === 0) {
    return {
      key: 'reicht',
      frage,
      zeit: null,
      antwort: 'Heute Abend ist kein Entladen geplant.',
      zusatz: null,
      notiz: null,
      art: 'geplant',
      ziel: null,
      details: 'stationen',
      nachtrag: false,
    };
  }
  const ph = abend[abend.length - 1];
  const roh = tag.phasenRoh[ph.phaseIndex];
  const endeSoc = tag.slots[roh.endIdx]?.socPct;
  const bisMitternacht = ph.bis >= TAG_MINUTEN;
  // Leer heißt: die Grenze bindet in der letzten Viertelstunde der Phase oder
  // direkt danach — nur dann ist das Ende kein Aufheben, sondern Erschöpfung.
  const naechsterI = roh.endIdx + 1;
  const leer =
    hatFlag(tag, roh.endIdx, 'soc_floor') ||
    (naechsterI < tag.slots.length && hatFlag(tag, naechsterI, 'soc_floor'));
  let antwort: string;
  let zusatz: string | null;
  if (bisMitternacht) {
    antwort = 'Ja, bis Mitternacht.';
    zusatz = endeSoc == null ? null : `Um Mitternacht bleiben ${pct(Number(endeSoc))} im Speicher.`;
  } else if (leer) {
    antwort = `Bis ${uhrzeit(ph.bis)} Uhr.`;
    zusatz = 'Dann ist er leer, und Ihr Haus bezieht den Rest aus dem Netz.';
  } else {
    antwort = `Ja, bis ${uhrzeit(ph.bis)} Uhr.`;
    zusatz = endeSoc == null ? null : `Danach bleiben ${pct(Number(endeSoc))} im Speicher.`;
  }
  return {
    key: 'reicht',
    frage,
    zeit: null,
    antwort,
    zusatz,
    notiz: null,
    art: 'geplant',
    ziel: {
      minute: letzteViertelMitte(tag, ph),
      von: ph.von,
      bis: ph.bis,
      punkt: ph.bis,
      ebene: 'ladestand',
    },
    details: 'stationen',
    nachtrag: false,
  };
}

/**
 * „Was bringt es heute?" — die Steuerungs-Aussage der Erlöse-Welt, unverändert.
 * Ohne Aussage (älteres Backend, keine Kasse) gibt es keine Antwort.
 */
export function antwortBringt(aussage: SpeicherAussage | null): Antwort | null {
  if (!aussage || !aussage.hatAussage) return null;
  return {
    key: 'bringt',
    frage: 'Was bringt es heute?',
    zeit: null,
    antwort: aussage.steuerung ? aussage.wert : 'Noch kein Vergleich',
    zusatz: aussage.steuerung ? aussage.satz : aussage.ohneVergleich,
    notiz: aussage.bestand,
    art: 'gemessen',
    ziel: null,
    details: 'erloese',
    nachtrag: !aussage.steuerung && aussage.nachtragLink,
  };
}

/** Alle Antworten in ihrer festen Reihenfolge; fehlende entfallen. */
export function antworten(input: {
  tag: TagModell;
  auswahl: number;
  istJetzt: boolean;
  speicher: SpeicherAussage | null;
}): Antwort[] {
  return [
    antwortWeiter(input.tag, input.auswahl, input.istJetzt),
    antwortReicht(input.tag),
    antwortBringt(input.speicher),
  ].filter((a): a is Antwort => a != null);
}
