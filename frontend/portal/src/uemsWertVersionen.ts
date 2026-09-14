/**
 * VERSIONEN AM WERT (UEMS AP-08 IP-18) als reine Ableitung: wurde eine Zahl der
 * Tages- oder Monatskarte schon einmal geändert, sieht der Kunde, was vorher
 * dastand, wer es geändert hat, wann und warum.
 *
 * Der Satz, der das Paket definiert: eine Korrektur ist erst dann
 * nachvollziehbar, wenn man den alten Wert noch sieht.
 *
 * Die Naht ist `versionen` am Wert von `…/werte`: ab 2 gibt es eine Historie
 * unter `…/werte/versionen` — bei 1 oder `null` (die Stunde hat keine eigenen
 * Versionen) wird gar nicht gefragt.
 *
 * Hier wird NICHTS gerechnet und keine Zahl formatiert:
 *  - `wert_alt` und `wert_neu` spricht `anzeige` der Tageskarte, also
 *    `uemsErgebnis.menge`/`teile` mit der Ebene der Periode (E11);
 *  - wer, wann und warum stehen gespeichert an der Fassung; der Zeitpunkt wird
 *    in der Zeitzone des Standorts gelesen (`zeitText`), nie in der des Browsers;
 *  - fehlt das „warum“, sagt ein ehrlicher Satz das — nie ein erfundener Grund,
 *    nie Art, Methode oder Status als Ersatz.
 *
 * Die ERSTE Fassung eines Vorgangs ist keine Änderung, sondern sein Anfang: ein
 * Ersatzwert ist „eingetragen von …“, eine Korrektur „vorgeschlagen von …“ —
 * die Wörter folgen dem Anfangs-Status der Vokabulare `ersatzwert_status`
 * (`wirksam`) und `korrektur_status` (`vorschlag`). Version 1 der Periode hat
 * keine Entscheidung: sie ist das Original aus der Verdichtung.
 *
 * REIN: kein Netz, kein Zustand, keine Uhr.
 */

import type {
  MessstelleWerte,
  MessstelleWerteEntscheidung,
  MessstelleWerteHistorie,
  MessstelleWerteUrheber,
  MessstelleWerteVersion,
} from './api';
import { KORREKTUR_ART_TEXT, METHODE_TEXT, zeitText } from './uemsEreignis';
import { TRENNER } from './uemsErgebnis';
import { anzeige, type WertAnzeige } from './uemsWerteKarte';

/** Ab so vielen Versionen gibt es eine Historie (die Naht von IP-18). */
export const HISTORIE_AB = 2;

/** Die Anfrage an `…/werte/versionen`: GENAU der Schritt, `von`/`bis` so, wie die Route sie geliefert hat. */
export interface VersionenAnfrage {
  raster: MessstelleWerteHistorie['raster'];
  von: string;
  bis: string;
}

/** Der Einstieg an der Karte. */
export interface Einstieg {
  /** „3 Versionen“. */
  text: string;
  unter: string;
  anfrage: VersionenAnfrage;
}

export const EINSTIEG_UNTER = 'Was vorher dastand — wer, wann und warum';
export const VERSIONEN_TITEL = 'Versionen';
export const GILT_JETZT = 'gilt jetzt';
export const ORIGINAL = 'Original';
export const VORHER = 'vorher';
export const DANACH = 'danach';
export const OHNE_GRUND = 'Kein Grund angegeben.';
/** `korrektur_status` `freigegeben` hat `grund_pflicht: false` — das ist die Wahrheit, keine Ausrede. */
export const OHNE_GRUND_FREIGABE = 'Kein Grund angegeben — eine Freigabe verlangt keinen.';
export const FASSUNG_FEHLT = 'Diese Fassung ist nicht gespeichert — wer, wann und warum sind nicht bekannt.';
export const OHNE_ENTSCHEIDUNG = 'Zu dieser Version ist keine Entscheidung gespeichert.';
export const KEINE_HISTORIE = 'Für diesen Zeitraum gibt es keine früheren Versionen.';

/** Die Namen der Vorgänge. */
export const VORGANG_TEXT: Record<MessstelleWerteEntscheidung['vorgang'], string> = {
  ersatzwert: 'Ersatzwert',
  korrektur: 'Korrektur',
};

/**
 * Was eine Fassung mit ihrem Status getan hat — die Wörter von `ersatzwert_status` und `korrektur_status`
 * (`events-vocabulary-vectors.json`). Es gibt bewusst kein „geändert“.
 */
export const STATUS_VERB: Record<string, string> = {
  wirksam: 'eingetragen',
  vorschlag: 'vorgeschlagen',
  freigegeben: 'freigegeben',
  abgelehnt: 'abgelehnt',
  zurueckgenommen: 'zurückgenommen',
};

/** Der Anfang eines Vorgangs (die anlegende Fassung), unabhängig vom Status, den sie heute trägt. */
export const ANFANG_VERB: Record<MessstelleWerteEntscheidung['vorgang'], string> = {
  ersatzwert: STATUS_VERB.wirksam,
  korrektur: STATUS_VERB.vorschlag,
};

/** Wer, wann, warum — einmal für die Fassung selbst, einmal für ihre anlegende. */
export interface Urheberschaft {
  /** „eingetragen von Ines Kaltenbach“; ohne Urheber nur das Verb. */
  wer: string;
  /** „20.11.2026 15:10“ in der Zeitzone des Standorts; `null` = nicht gespeichert. */
  wann: string | null;
  /** Der Text des Menschen in „…“ — oder ein ehrlicher Satz, dass keiner da ist. */
  warum: string;
  /** Der Satz oben ist KEIN Text eines Menschen (die Darstellung setzt ihn ab). */
  warumFehlt: boolean;
  /** „Beleg: …“ oder `null`. */
  beleg: string | null;
}

export interface EntscheidungAnzeige {
  schluessel: string;
  /** „Ersatzwert EW-2026-0005“. */
  vorgang: string;
  /** Die Fassung selbst; `null`, wenn sie nicht gespeichert ist (dann steht `fehlt`). */
  fassung: Urheberschaft | null;
  /** „Methode „Zuwachs gleichmäßig verteilen““ bzw. die Art der Korrektur; `null` = keine. */
  was: string | null;
  /** An einer späteren Fassung: wie der Vorgang angefangen hat („vorgeschlagen von VoltPilot“). */
  angelegt: Urheberschaft | null;
  /** `FASSUNG_FEHLT` oder `null`. */
  fehlt: string | null;
}

/** Ein Wert in der Historie: die Zahl und — getrennt — was sie begleitet. */
export interface HistorieWert {
  zahl: string;
  /** „mit Ersatzwert · Verlauf 58 %“; `null` = der Schritt wird nicht gesprochen. */
  info: string | null;
  ton: WertAnzeige['zustandTon'];
}

export interface VersionAnzeige {
  schluessel: string;
  /** „Version 3“. */
  titel: string;
  /** „gilt jetzt“ an der neuesten, „Original“ an Version 1 (beides zugleich nie: dann gäbe es keine Historie). */
  etikett: string | null;
  /** Was vorher dastand; an Version 1 `null`. */
  vorher: HistorieWert | null;
  danach: HistorieWert;
  /** Nur an Version 1: „gebildet am 04.11.2026 00:15“. */
  gebildet: string | null;
  entscheidungen: EntscheidungAnzeige[];
  /** `OHNE_ENTSCHEIDUNG` an einer späteren Version ohne gespeicherte Entscheidung. */
  ohneEntscheidung: string | null;
}

export interface HistorieAnzeige {
  /** Neueste zuerst — sie ist die Zahl, die die Karte zeigt. */
  versionen: VersionAnzeige[];
  /** `KEINE_HISTORIE`, wenn die Route keine Versionen nennt. */
  leer: string | null;
}

/** Hat dieser Schritt eine Historie? Die Stunde nie (`versionen` null), eine unveränderte Periode nie (1). */
export const hatHistorie = (versionen: number | null): boolean => versionen !== null && versionen >= HISTORIE_AB;

/**
 * Der Einstieg an der Karte (Raster `tag` bzw. `monat`, genau ein Schritt) — `null`, wenn es nichts zu zeigen
 * gibt. Gefragt wird mit `von`/`bis` des Schritts, unverändert.
 */
export const einstieg = (antwort: MessstelleWerte): Einstieg | null => {
  const w = antwort.werte[0];
  if (!w || antwort.raster === 'stunde' || !hatHistorie(w.versionen)) return null;
  return {
    text: `${w.versionen} Versionen`,
    unter: EINSTIEG_UNTER,
    anfrage: { raster: antwort.raster, von: w.von, bis: w.bis },
  };
};

const zitat = (text: string): string => `„${text}“`;

const person = (wer: MessstelleWerteUrheber | null): string => (wer ? ` von ${wer.name}` : '');

const urheberschaft = (
  verb: string,
  wer: MessstelleWerteUrheber | null,
  wann: string | null,
  warum: string | null,
  beleg: string | null,
  zone: string,
  ohneGrund: string,
): Urheberschaft => ({
  wer: `${verb}${person(wer)}`,
  wann: wann === null ? null : zeitText(wann, zone),
  warum: warum === null ? ohneGrund : zitat(warum),
  warumFehlt: warum === null,
  beleg: beleg === null ? null : `Beleg: ${beleg}`,
});

/** Das Verb einer Fassung: der Anfang nach dem Vorgang, jede weitere nach ihrem Status. */
const verbDer = (e: MessstelleWerteEntscheidung): string => {
  if (e.fassung === 1) return ANFANG_VERB[e.vorgang];
  const verb = e.status === null ? undefined : STATUS_VERB[e.status];
  return verb ?? `Fassung ${e.fassung}`;
};

const wasDer = (e: MessstelleWerteEntscheidung): string | null => {
  if (e.methode !== null) return `Methode ${zitat(METHODE_TEXT[e.methode] ?? e.methode)}`;
  if (e.art !== null && e.vorgang === 'korrektur') return KORREKTUR_ART_TEXT[e.art] ?? e.art;
  return null;
};

/** Eine Entscheidung: wer, wann, warum — und an einer späteren Fassung, wie der Vorgang angefangen hat. */
export const entscheidung = (e: MessstelleWerteEntscheidung, zone: string): EntscheidungAnzeige => {
  const schluessel = `${e.kennung}|${e.fassung}`;
  const vorgang = `${VORGANG_TEXT[e.vorgang]} ${e.kennung}`;
  if (e.fehlt.includes('fassung')) {
    return { schluessel, vorgang, fassung: null, was: null, angelegt: null, fehlt: FASSUNG_FEHLT };
  }
  const ohneGrund = e.status === 'freigegeben' ? OHNE_GRUND_FREIGABE : OHNE_GRUND;
  return {
    schluessel,
    vorgang,
    fassung: urheberschaft(verbDer(e), e.wer, e.wann, e.warum, e.beleg, zone, ohneGrund),
    was: wasDer(e),
    angelegt:
      e.fassung === 1 || e.angelegt === null
        ? null
        : urheberschaft(ANFANG_VERB[e.vorgang], e.angelegt.wer, e.angelegt.wann, e.angelegt.warum, e.angelegt.beleg, zone, OHNE_GRUND),
    fehlt: null,
  };
};

const wert = (h: MessstelleWerteHistorie, w: MessstelleWerteVersion['wert_neu']): HistorieWert => {
  const a = anzeige(h, w, false);
  const info = [a.zustand, a.abdeckung].filter((t): t is string => t !== null);
  return { zahl: a.zahl, info: a.zustand === null ? null : info.join(TRENNER), ton: a.zustandTon };
};

/** Die Historie EINER Periode — neueste Version zuerst. */
export const historie = (h: MessstelleWerteHistorie): HistorieAnzeige => {
  if (h.versionen.length === 0) return { versionen: [], leer: KEINE_HISTORIE };
  const neueste = Math.max(...h.versionen.map((v) => v.version));
  const versionen = [...h.versionen]
    .sort((a, b) => b.version - a.version)
    .map((v): VersionAnzeige => {
      const erste = v.version === 1;
      const entscheidungen = v.entscheidungen.map((e) => entscheidung(e, h.zeitzone));
      return {
        schluessel: String(v.version),
        titel: `Version ${v.version}`,
        etikett: v.version === neueste ? GILT_JETZT : erste ? ORIGINAL : null,
        vorher: erste || v.wert_alt === null ? null : wert(h, v.wert_alt),
        danach: wert(h, v.wert_neu),
        gebildet: erste && v.gebildet_am !== null ? `gebildet am ${zeitText(v.gebildet_am, h.zeitzone)}` : null,
        entscheidungen,
        ohneEntscheidung: !erste && entscheidungen.length === 0 ? OHNE_ENTSCHEIDUNG : null,
      };
    });
  return { versionen, leer: null };
};
