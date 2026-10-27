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
 *  - Der TAGESSCHALTER (E2 = A) fragt je Tag wie der Prototyp: gestern „Wie
 *    ging es weiter?" und „Was hat es gebracht?" (die Aussage des vollen
 *    Tages); morgen „Reicht der Speicher morgen Abend?", aber keine Geldzahl
 *    (für morgen gibt es keine gemessene). „Hat der Speicher gestern
 *    gereicht?" fragt nach dem, was WIRKLICH geschah — ohne gemessenen
 *    Ladestand (Ist-Spur, Schritt 2) bleibt die Frage aus, statt sie mit dem
 *    Plan zu beantworten.
 *
 * Rein: kein React, kein Netz.
 */

import { phaseVon, uhrzeit, TAG_MINUTEN, type TagModell, type TagPhase } from './fahrplanTag';
import type { TagArt } from './fahrplanTagesbild';
import type { AutarkieHeute } from './fahrplanSonnenstrom';
import { MESSLATTE_DATIV, type SpeicherAussage } from './speicherAussage';

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
  /**
   * Die KURZFORM als Zeile (Überblick 20.10.2026): ein Etikett statt der
   * Frage, ein Wert, höchstens eine leise Zeile - dieselbe Aussage wie
   * `antwort`/`zusatz`, nur in Stichworten („Als Nächstes · 18:15 Einspeisen").
   */
  kurz: { label: string; wert: string; meta: string | null };
  /** Das Ehrlichkeits-Abzeichen. */
  art: 'geplant' | 'gemessen';
  ziel: AntwortZiel | null;
  /**
   * Wohin „Details" führt. `sonnenstrom` (Konzept
   * `vp-fahrplan-eigenverbrauch-konzept` §4.3/§4.5, E2 = A): die
   * Autarkie-Kachel zeigt kein Geld mehr, also führt ihr Detail nicht zur
   * Erlöse-Seite, sondern öffnet „Ihr Sonnenstrom heute".
   */
  details: 'stationen' | 'erloese' | 'sonnenstrom';
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
export function antwortWeiter(
  tag: TagModell,
  auswahl: number,
  istJetzt: boolean,
  art: TagArt = 'heute',
): Antwort | null {
  if (!tag.hatWarum || auswahl < 0 || auswahl >= tag.slots.length) return null;
  const aktuell = phaseVon(tag, auswahl);
  if (!aktuell) return null;
  const k = tag.phasen.indexOf(aktuell);
  const naechste = tag.phasen.slice(k + 1, k + 3);
  const zeit = istJetzt ? null : `${uhrzeit(tag.viertel[auswahl].von)} Uhr`;
  const frage = art === 'gestern' ? 'Wie ging es weiter?' : 'Wie geht es weiter?';
  if (naechste.length === 0) {
    // Die letzte Phase: sie endet um Mitternacht - oder dort, wo der geladene
    // Plan endet. Dann wird nichts über die Zeit danach behauptet.
    const bisMitternacht = aktuell.bis >= TAG_MINUTEN;
    return {
      key: 'weiter',
      frage,
      zeit,
      antwort: bisMitternacht
        ? `${aktuell.label} bis Mitternacht.`
        : `${aktuell.label} bis ${uhrzeit(aktuell.bis)} Uhr.`,
      zusatz: bisMitternacht ? null : 'Weiter reicht der Fahrplan noch nicht.',
      notiz: null,
      kurz: {
        label: art === 'gestern' ? 'Danach' : 'Als Nächstes',
        wert: bisMitternacht ? `${aktuell.label} bis Mitternacht` : `${aktuell.label} bis ${uhrzeit(aktuell.bis)}`,
        meta: bisMitternacht ? null : 'Weiter reicht der Plan noch nicht',
      },
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
  const dann = naechste[1];
  return {
    key: 'weiter',
    frage,
    zeit,
    antwort,
    zusatz,
    notiz: null,
    kurz: {
      label: art === 'gestern' ? 'Danach' : 'Als Nächstes',
      wert: `${uhrzeit(naechste[0].von)} ${naechste[0].label}`,
      meta: dann ? `dann ${uhrzeit(dann.von)} ${dann.label}` : (zusatz?.replace(/\.$/, '') ?? null),
    },
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
export function antwortReicht(tag: TagModell, art: TagArt = 'heute'): Antwort | null {
  // Gestern fragte man, ob er GEREICHT hat — das sagt erst der gemessene
  // Ladestand (Ist-Spur), nicht der Plan.
  if (art === 'gestern') return null;
  if (!tag.hatWarum || tag.viertel.length === 0) return null;
  const letzteMinute = tag.viertel[tag.viertel.length - 1].bis;
  if (letzteMinute <= ABEND_AB_MIN) return null;
  const abend = tag.phasen.filter((p) => p.role === 'eigenverbrauch' && p.von >= ABEND_AB_MIN);
  const wann = art === 'morgen' ? 'morgen' : 'heute';
  const frage = `Reicht der Speicher ${wann} Abend?`;
  if (abend.length === 0) {
    return {
      key: 'reicht',
      frage,
      zeit: null,
      antwort: `${art === 'morgen' ? 'Morgen' : 'Heute'} Abend ist kein Entladen geplant.`,
      zusatz: null,
      notiz: null,
      kurz: { label: art === 'morgen' ? 'Morgen Abend' : 'Heute Abend', wert: 'Kein Entladen geplant', meta: null },
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
  let kurzWert: string;
  let kurzMeta: string | null;
  if (bisMitternacht) {
    antwort = 'Ja, bis Mitternacht.';
    zusatz = endeSoc == null ? null : `Um Mitternacht bleiben ${pct(Number(endeSoc))} im Speicher.`;
    kurzWert = 'Reicht bis 24 Uhr';
    kurzMeta = endeSoc == null ? null : `${pct(Number(endeSoc))} bleiben`;
  } else if (leer) {
    antwort = `Bis ${uhrzeit(ph.bis)} Uhr.`;
    zusatz = 'Dann ist er leer, und Ihr Haus bezieht den Rest aus dem Netz.';
    kurzWert = `Leer um ${uhrzeit(ph.bis)}`;
    kurzMeta = 'danach Strom aus dem Netz';
  } else {
    antwort = `Ja, bis ${uhrzeit(ph.bis)} Uhr.`;
    zusatz = endeSoc == null ? null : `Danach bleiben ${pct(Number(endeSoc))} im Speicher.`;
    kurzWert = `Reicht bis ${uhrzeit(ph.bis)}`;
    kurzMeta = endeSoc == null ? null : `${pct(Number(endeSoc))} bleiben`;
  }
  return {
    key: 'reicht',
    frage,
    zeit: null,
    antwort,
    zusatz,
    notiz: null,
    kurz: { label: art === 'morgen' ? 'Morgen Abend' : 'Heute Abend', wert: kurzWert, meta: kurzMeta },
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
export function antwortBringt(
  aussage: SpeicherAussage | null,
  art: TagArt = 'heute',
  /**
   * Die Sonnen-Erzählung (Konzept `vp-fahrplan-eigenverbrauch-konzept`
   * §4.3/§4.5, E2 = A): gesetzt, ersetzt sie die Geld-Kachel für HEUTE durch
   * „Aus eigenem Strom X %" - unabhängig von der Steuerungs-Aussage, denn die
   * Autarkie hat ihre eigene Quelle (`fahrplanSonnenstrom.autarkieHeute`).
   * Vorgabe `null` lässt diese Funktion unverändert (Preis-Erzählung).
   */
  autarkie: AutarkieHeute | null = null,
): Antwort | null {
  if (art === 'heute' && autarkie != null) {
    // „Geld bleibt auf der Erlöse-Seite" (E2-Begründung): das Detail führt
    // deshalb NICHT zu `erloese`, sondern öffnet „Ihr Sonnenstrom heute".
    return {
      key: 'bringt',
      frage: 'Wie viel deckt die Sonne?',
      zeit: null,
      antwort: `Aus eigenem Strom: ${autarkie.pct} % Ihres heutigen Verbrauchs.`,
      zusatz:
        autarkie.quelle === 'gemischt'
          ? 'Gemessen bis jetzt, für den Rest des Tages geplant.'
          : 'Noch keine Messung für heute - der Wert ist bisher rein geplant.',
      notiz: null,
      kurz: {
        label: 'Aus eigenem Strom',
        wert: `${autarkie.pct} %`,
        meta: autarkie.quelle === 'gemischt' ? 'heute, Rest geplant' : 'geplant',
      },
      art: 'geplant',
      ziel: null,
      details: 'sonnenstrom',
      nachtrag: false,
    };
  }
  // Für morgen gibt es keine gemessene Aussage - und keine zweite Geldzahl (E6).
  if (art === 'morgen' || !aussage || !aussage.hatAussage) return null;
  // Am laufenden Tag führt der PLAN des ganzen Tages (dieselbe Messlatte, M2):
  // der Zwischenstand am Mittag ist fast immer klein oder negativ, weil die
  // Energie für den Abend noch im Speicher liegt - als Hauptzahl las er sich
  // wie „die Steuerung verliert Geld" (Demo 20.10.2026: − 0,03 € bei + 6,39 €
  // geplant). Der Zwischenstand bleibt als leise Zeile darunter.
  const laufend = art === 'heute' && aussage.zwischenstand && aussage.geplantWert != null;
  const gemessen = aussage.steuerung ? aussage.wert : 'Noch kein Vergleich';
  return {
    key: 'bringt',
    frage: art === 'gestern' ? 'Was hat es gebracht?' : 'Was bringt es heute?',
    zeit: null,
    antwort: laufend
      ? `Geplant für heute: ${aussage.geplantWert} gegenüber ${MESSLATTE_DATIV}.`
      : aussage.steuerung
        ? aussage.wert
        : 'Noch kein Vergleich',
    zusatz: aussage.steuerung ? aussage.satz : aussage.ohneVergleich,
    notiz: aussage.bestand,
    kurz: laufend
      ? { label: 'Heute geplant', wert: aussage.geplantWert ?? '', meta: `bisher ${gemessen}` }
      : { label: art === 'gestern' ? 'Gestern' : 'Heute', wert: gemessen, meta: aussage.chip },
    art: laufend ? 'geplant' : 'gemessen',
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
  /** Der Tag des Tagesschalters; ohne Angabe heute. */
  art?: TagArt;
  /** Die Sonnen-Erzählung (§4.3/§4.5, E2 = A); siehe {@link antwortBringt}. */
  autarkie?: AutarkieHeute | null;
}): Antwort[] {
  const art = input.art ?? 'heute';
  return [
    antwortWeiter(input.tag, input.auswahl, input.istJetzt, art),
    antwortReicht(input.tag, art),
    antwortBringt(input.speicher, art, input.autarkie ?? null),
  ].filter((a): a is Antwort => a != null);
}
