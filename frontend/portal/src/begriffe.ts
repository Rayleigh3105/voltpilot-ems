/**
 * Die Begriffe des Energiemanagements in Alltagssprache (Konzept „Energiemanagement ohne Fachsprache“ K3).
 *
 * Je Begriff: das Wort, das das Portal zeigt, ein Satz in Alltagssprache, wo es hilft ein Beispiel, und — wo es eines
 * gibt — das Fachwort, unter dem Berater und Normtexte dasselbe kennen. Die Wörter selbst bleiben die des
 * Fachmodell-Glossars (`docs/fachmodell/glossar.md` → `glossar.ts`); diese Datei erklärt sie nur.
 *
 * ⚠ Die Sprach-Wächter in `copy.test.ts` gelten auch hier: keine Normnummern, keine Abkürzungen wie SEU oder EnPI, kein
 * Wort, das Konformität oder Vollständigkeit verspricht. Ein Fachwort steht deshalb ohne Abschnitt und ohne Kürzel.
 */
import {
  UEMS_ABWEICHUNG,
  UEMS_BEZUGSBASIS,
  UEMS_BEZUGSGROESSE,
  UEMS_ENERGIEEINSATZ,
  UEMS_ENERGIEZIEL,
  UEMS_FESTSTELLUNG,
  UEMS_KENNZAHL,
  UEMS_MANAGEMENTBEWERTUNG,
  UEMS_MANAGEMENTBEWERTUNG_WOZU,
  UEMS_MASSNAHME,
  UEMS_MESSSTELLE,
  UEMS_VERZEICHNIS,
  UEMS_WIEDERVORLAGE,
} from './glossar';

export type BegriffSchluessel =
  | 'energieeinsatz'
  | 'wesentlich'
  | 'umfang'
  | 'messstelle'
  | 'bezugsgroesse'
  | 'kennzahl'
  | 'bezugsbasis'
  | 'bereinigt'
  | 'energieziel'
  | 'massnahme'
  | 'abweichung'
  | 'verzeichnis'
  | 'wiedervorlage'
  | 'audit'
  | 'feststellung'
  | 'managementbewertung';

export interface Begriff {
  /** Das Wort, wie das Portal es zeigt. */
  wort: string;
  /** Ein Satz in Alltagssprache. */
  klartext: string;
  /** Ein Beispiel, wo der Satz allein zu abstrakt bleibt; wo es geht, ersetzt die Fläche es durch eines aus der eigenen Firma. */
  beispiel: string | null;
  /** Das Wort, unter dem Berater und Normtexte dasselbe kennen — ohne Nummer und ohne Kürzel. */
  fachwort: string | null;
  /**
   * Konzept Messen m1 §7: die Frage des Aufklappers „Was ist …?“ (mit Artikel), nur für die Begriffe, die eine Fläche
   * mit Satz unter dem Titel und Aufklapper erklärt statt mit der Zeile „Begriffe:“.
   */
  frage?: string;
  /** Ein Satz, der zum Beispiel gehört: was man mit dem Ding tut oder woher es kommt. */
  mehr?: string;
  /** Die Abgrenzung: womit man es nicht verwechseln soll. */
  abgrenzung?: string;
}

export const BEGRIFFE: Record<BegriffSchluessel, Begriff> = {
  energieeinsatz: {
    wort: UEMS_ENERGIEEINSATZ,
    klartext: 'Ein Bereich oder Prozess, in dem Ihr Betrieb Energie einsetzt.',
    beispiel: 'Zum Beispiel Druckluft, Spritzguss oder die Beleuchtung einer Halle.',
    fachwort: null,
    // Konzept Auswerten a1 §7: „Verbrauch“ erklärt den Begriff mit dem Aufklapper; im Portal heißt er dort „Bereich“.
    frage: 'Was ist ein Energieeinsatz?',
    abgrenzung: 'Nicht der Zähler: Ein Bereich kann von mehreren Zählern gemessen werden.',
  },
  wesentlich: {
    wort: 'wesentlich',
    klartext: 'Ein Energieeinsatz, auf den Sie besonders achten, weil er groß ist oder sich viel bewegen lässt. Die Einstufung trifft immer eine Person.',
    beispiel: null,
    fachwort: 'wesentlicher Energieeinsatz',
  },
  umfang: {
    wort: 'Umfang',
    klartext: 'Welche Standorte und Energieträger die energetische Bewertung betrachtet.',
    beispiel: 'Zum Beispiel: alle Standorte, Strom und Gas.',
    fachwort: null,
  },
  messstelle: {
    wort: UEMS_MESSSTELLE,
    klartext: 'Ein Punkt, an dem Energie gemessen oder aus anderen Messstellen berechnet wird.',
    beispiel: 'Zum Beispiel der Hauptzähler eines Werks oder der Unterzähler einer Maschine.',
    fachwort: null,
  },
  bezugsgroesse: {
    wort: UEMS_BEZUGSGROESSE,
    klartext: 'Eine Größe, von der Ihr Verbrauch abhängt.',
    beispiel: 'Zum Beispiel Stückzahl, Fläche, Betriebsstunden oder die Außentemperatur.',
    fachwort: 'relevante Variable',
  },
  kennzahl: {
    wort: UEMS_KENNZAHL,
    klartext: 'Energie je Einheit — so lässt sich vergleichen, auch wenn sich die Menge ändert.',
    beispiel: 'Zum Beispiel kWh je Stück, je Quadratmeter oder je Betriebsstunde.',
    fachwort: 'Energieleistungskennzahl',
  },
  bezugsbasis: {
    wort: UEMS_BEZUGSBASIS,
    klartext: 'Ihr Vergleichszeitraum. Mit ihm sehen Sie, ob Sie wirklich weniger Energie brauchen — auch wenn mehr produziert wurde.',
    beispiel:
      'Mit 2025 als Bezugsbasis vergleicht VoltPilot jeden Monat mit dem Verbrauch, der nach dem Muster von 2025 bei der Menge dieses Monats zu erwarten wäre.',
    fachwort: 'energetische Ausgangsbasis',
  },
  bereinigt: {
    wort: 'bereinigt',
    klartext: 'Auf gleiche Bedingungen umgerechnet, damit ein Vergleich fair ist.',
    beispiel: 'Zum Beispiel auf dieselbe Produktionsmenge oder dasselbe Wetter wie im Vergleichszeitraum.',
    fachwort: null,
  },
  energieziel: {
    wort: UEMS_ENERGIEZIEL,
    klartext: 'Was Sie erreichen wollen, mit Zahl und Zeitraum.',
    beispiel: 'Zum Beispiel 5 % weniger Strom je Stück im Jahr 2028.',
    fachwort: null,
  },
  massnahme: {
    wort: UEMS_MASSNAHME,
    klartext: 'Was Sie tun, um ein Ziel zu erreichen oder eine Abweichung zu beheben. Ob sie etwas bewirkt, beurteilt eine Person — der Vergleich mit der Bezugsbasis hilft dabei.',
    beispiel: null,
    fachwort: null,
  },
  abweichung: {
    wort: UEMS_ABWEICHUNG,
    klartext: 'Etwas lief anders als erwartet — zum Beispiel ein Verbrauch deutlich über der Bezugsbasis. Sie halten fest, was Sie dazu wissen und tun.',
    beispiel: null,
    fachwort: null,
  },
  verzeichnis: {
    wort: UEMS_VERZEICHNIS,
    klartext: 'Die Übersicht, was Ihr Energiemanagement festgehalten hat — und wo das Original liegt.',
    beispiel: null,
    fachwort: 'dokumentierte Information',
  },
  wiedervorlage: {
    wort: UEMS_WIEDERVORLAGE,
    klartext: 'Alles, was demnächst ansteht: fällige Überprüfungen, Termine von Maßnahmen, geplante Audits.',
    beispiel: null,
    fachwort: null,
  },
  audit: {
    wort: 'Audit',
    klartext: 'Eine Prüfung, bei der Sie selbst oder jemand in Ihrem Auftrag nachsieht, ob das Energiemanagement so läuft, wie Sie es festgelegt haben.',
    beispiel: null,
    fachwort: 'internes Audit',
  },
  feststellung: {
    wort: UEMS_FESTSTELLUNG,
    klartext: 'Etwas, das bei einem Audit aufgefallen ist — mit dem, was Sie dazu tun.',
    beispiel: null,
    fachwort: null,
  },
  managementbewertung: {
    wort: UEMS_MANAGEMENTBEWERTUNG,
    klartext: UEMS_MANAGEMENTBEWERTUNG_WOZU,
    beispiel: null,
    fachwort: null,
  },
};

/** Die Frage, die der Knopf an einem Begriff vorliest. */
export const begriffFrage = (wort: string) => `Was heißt „${wort}“?`;

/** Die Beschriftung der Zeile unter dem Seitenkopf. */
export const BEGRIFFE_LABEL = 'Begriffe';
