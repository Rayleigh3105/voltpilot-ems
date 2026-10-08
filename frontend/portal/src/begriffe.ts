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
  UEMS_AUF_KURS,
  UEMS_AUFFAELLIGKEIT,
  UEMS_AUSGANGSLAGE,
  UEMS_BEOBACHTET,
  UEMS_BEZUGSBASIS,
  UEMS_BEZUGSGROESSE,
  UEMS_ENERGETISCHE_BEWERTUNG_WORT,
  UEMS_EINSPARUNG,
  UEMS_ENERGIEEINSATZ,
  UEMS_ENERGIEZIEL,
  UEMS_ERWARTETE_WIRKUNG,
  UEMS_FESTSTELLUNG,
  UEMS_GEMESSEN_AN,
  UEMS_KENNZAHL,
  UEMS_KOSTENSTELLE,
  UEMS_MANAGEMENTBEWERTUNG,
  UEMS_MANAGEMENTBEWERTUNG_WOZU,
  UEMS_MASSNAHME,
  UEMS_MASSNAHME_ERGEBNISSE,
  UEMS_MESSGRUNDLAGE,
  UEMS_MESSSTELLE,
  UEMS_PROZESS,
  UEMS_VERZEICHNIS,
  UEMS_VORHER,
  UEMS_WIEDERVORLAGE,
  UEMS_WIRKSAMKEIT,
  UEMS_ZWEITE_PERSON,
} from './glossar';

export type BegriffSchluessel =
  | 'energieeinsatz'
  | 'wesentlich'
  | 'umfang'
  | 'messstelle'
  | 'zuordnung'
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
  | 'managementbewertung'
  | 'energetische_bewertung'
  | 'kostenstelle'
  | 'prozess'
  // Konzept Verbessern v1 §7: die Wörter der Flächen unter Verbessern.
  | 'auf_kurs'
  | 'erwartete_wirkung'
  | 'beobachtet'
  | 'belegt'
  | 'vorher'
  | 'gemessen_an'
  | 'auffaelligkeit'
  | 'wirksamkeit'
  | 'zweite_person'
  | 'einsparung';

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
    klartext: 'Eine Stelle, an der Ihr Verbrauch gemessen, abgelesen oder aus anderen Messstellen berechnet wird.',
    beispiel: 'Zum Beispiel der Hauptzähler eines Werks oder der Zähler einer Maschine.',
    fachwort: null,
    frage: 'Was ist eine Messstelle?',
    mehr: 'Die Werte kommen automatisch von einem Gerät, aus Ablesungen von Hand oder werden aus anderen Messstellen berechnet.',
    abgrenzung: 'Nicht dasselbe wie das Gerät: Wird ein Zähler getauscht, bleibt die Messstelle mit ihrer Geschichte.',
  },
  // Konzept Messen m1 §6.4 Punkt 7: die Karte „Zuordnung“ an der Messstelle erklärt ihre vier Zeilen mit „Was heißt das?“.
  zuordnung: {
    wort: 'Zuordnung',
    klartext: 'Wo die Messstelle hängt und wem ihr Verbrauch gehört - je ab einem Tag.',
    beispiel:
      'Ort: das Gebäude oder der Bereich, in dem der Zähler sitzt. Im Stromnetz: am Netzanschluss (Hauptzähler) oder dahinter (Unterzähler). Prozess: der Arbeitsschritt, der die Energie braucht. Kostenstellen: wem der Verbrauch in der Kostenrechnung zugerechnet wird, ganz oder in Anteilen.',
    fachwort: 'Ort, elektrische Stellung, Prozess und Verteilung',
    frage: 'Was heißt das?',
    abgrenzung: 'Eine Änderung gilt ab ihrem Tag; was davor galt, bleibt in der Historie stehen.',
  },
  bezugsgroesse: {
    wort: UEMS_BEZUGSGROESSE,
    klartext: 'Eine Größe, von der Ihr Verbrauch abhängt.',
    beispiel: 'Zum Beispiel Stückzahl, Fläche, Betriebsstunden oder die Außentemperatur.',
    fachwort: 'relevante Variable',
    frage: 'Was ist eine Bezugsgröße?',
    mehr: 'Ihre Werte tragen Sie je Monat ein oder importieren sie; manche kommen aus einem Messkanal oder dem Wetter, Flächen aus dem Gebäudeplan.',
    abgrenzung: `Erst mit ihr wird aus kWh eine ${UEMS_KENNZAHL} wie kWh je kg.`,
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
  // Konzept Verbessern v1 §7: Klartext, Frage und Abgrenzung des Aufklappers „Was ist …?“; die Normwörter nur im Feld
  // `fachwort` (Entscheid 14). Das Energieziel heißt auch in der Norm so - darum ohne Fachwort.
  energieziel: {
    wort: UEMS_ENERGIEZIEL,
    klartext: 'Was Sie erreichen wollen, mit Zahl und Zeitraum: so viel weniger Energie, als die Bezugsbasis bei Ihrer Produktion erwarten lässt.',
    beispiel: 'Zum Beispiel: Der Spritzguss soll im Jahr 2029 4\u00a0% weniger Strom brauchen, als bei der jeweiligen Produktionsmenge zu erwarten ist.',
    fachwort: null,
    frage: 'Was ist ein Energieziel?',
    abgrenzung: 'Nicht die Bezugsbasis: Sie sagt, was normal wäre; das Energieziel, was Sie sich vornehmen. Ob es erreicht ist, entscheidet am Ende eine Person.',
  },
  massnahme: {
    wort: UEMS_MASSNAHME,
    klartext: 'Etwas, das Sie tun, damit Ihr Betrieb weniger Energie braucht - oder damit Ihr Energiemanagement besser läuft. Sie hat eine verantwortliche Person und einen Termin.',
    beispiel: 'Zum Beispiel: Die Werkzeugheizungen in Betriebspausen abschalten, verantwortlich die Instandhaltung, Termin Ende Januar.',
    fachwort: 'Aktionsplan (die Liste Ihrer Maßnahmen), Korrekturmaßnahme (eine Maßnahme aus einer Feststellung)',
    frage: 'Was ist eine Maßnahme?',
    abgrenzung: 'Nicht die Wirkung: Was eine Maßnahme gebracht hat, beobachtet VoltPilot an einer Kennzahl - ob sie es bewirkt hat, sagt eine Person.',
  },
  abweichung: {
    wort: UEMS_ABWEICHUNG,
    klartext: 'Ein Monat, der anders lief als erwartet, und was Sie dazu herausfinden - mit verantwortlicher Person, Frist und Ergebnis.',
    beispiel: 'Zum Beispiel: Im Dezember brauchte der Spritzguss 12,9\u00a0% mehr Strom als erwartet. Die Instandhaltung sagt, die Werkzeugheizungen liefen über die Feiertage durch.',
    fachwort: 'Nichtkonformität nur bei einer Feststellung aus einem Audit',
    frage: 'Was ist eine Abweichung?',
    abgrenzung: 'Nicht die Feststellung aus einem Audit: Die gehört zu Nachweisen. Und noch nicht jede Auffälligkeit: Eine Abweichung entsteht erst, wenn eine Person den Monat untersucht.',
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
  // Befund A19 (Konzept Nachweisen n1): nicht nur aus einem Audit - auch eigene, von außen oder aus einer
  // Managementbewertung (Vertrag `feststellung_quelle`).
  feststellung: {
    wort: UEMS_FESTSTELLUNG,
    klartext: 'Etwas läuft nicht wie geplant - festgestellt bei einem Audit, von Ihnen selbst, von außen oder aus einer Managementbewertung.',
    beispiel: null,
    fachwort: null,
  },
  managementbewertung: {
    wort: UEMS_MANAGEMENTBEWERTUNG,
    klartext: UEMS_MANAGEMENTBEWERTUNG_WOZU,
    beispiel: null,
    fachwort: null,
  },
  // Konzept Auswerten a1 §6.7/§7: die Seite „Energetische Bewertung“ erklärt das Wort mit Satz und Aufklapper; das Beispiel
  // setzt die Seite aus dem gültigen Stand ein („Bewertung 2029, Stand Nr. 1 vom 30.04.2029: 4 von 8 Bereichen wesentlich.“).
  energetische_bewertung: {
    wort: UEMS_ENERGETISCHE_BEWERTUNG_WORT,
    klartext: 'Einmal im Jahr festgestellt: wofür Ihr Unternehmen Energie einsetzt und welche Bereiche wesentlich sind - als freigegebener Stand.',
    beispiel: 'Zum Beispiel: 4 von 8 Bereichen sind wesentlich, festgestellt mit Stand Nr. 1.',
    fachwort: null,
    frage: 'Was ist die energetische Bewertung?',
    abgrenzung: 'Nicht verwechseln mit dem Monatsbericht: der Bericht zählt, die Bewertung ordnet.',
  },
  // Konzept Messen m1 §7 (Captain-Freigabe 05.10.2026): Klartext unter dem Titel, Beispiel aus der eigenen Firma im Aufklapper.
  kostenstelle: {
    wort: UEMS_KOSTENSTELLE,
    klartext: 'Eine Nummer aus Ihrer Buchhaltung, der Verbrauch ganz oder anteilig zugerechnet wird.',
    beispiel: 'Zum Beispiel bekommt die Produktion 70 % eines Zählers und die Montage die übrigen 30 %.',
    fachwort: null,
    frage: 'Was ist eine Kostenstelle?',
    abgrenzung: 'Nicht dasselbe wie ein Prozess: der beschreibt die Arbeit, die Kostenstelle die Rechnung.',
  },
  prozess: {
    wort: UEMS_PROZESS,
    klartext: 'Ein Arbeitsschritt in Ihrem Betrieb, der Energie braucht – egal, in welchem Gebäude er stattfindet.',
    beispiel: 'Zum Beispiel Spritzguss, Druckluft, Kühlung oder Logistik.',
    fachwort: null,
    frage: 'Was ist ein Prozess?',
    mehr: 'Sie ordnen einem Prozess die Messstellen zu, die seinen Verbrauch messen. Dann steht hier, was er im Monat verbraucht hat.',
    abgrenzung: 'Nicht dasselbe wie eine Kostenstelle: die rechnet Verbrauch der Buchhaltung zu, mit Anteilen.',
  },
  // Konzept Verbessern v1 §7: drei Wörter für drei Dinge - erwartet (die Schätzung einer Person), beobachtet (die
  // Messung gegen die Bezugsbasis), belegt (das Urteil einer Person) - und die Wörter rund um Energieziel und Maßnahme.
  auf_kurs: {
    wort: UEMS_AUF_KURS,
    klartext: 'Bisher mindestens so viel weniger, wie Sie sich vorgenommen haben. Knapp dahinter heißt: weniger, aber noch nicht genug.',
    beispiel: 'Zum Beispiel: Nach dem März 2,2\u00a0% mehr statt 4\u00a0% weniger - nicht auf Kurs.',
    fachwort: null,
    frage: 'Was heißt „auf Kurs“?',
    abgrenzung: 'Keine Prognose: Es zählt, was schon gemessen ist. Ob das Energieziel erreicht ist, entscheidet am Ende eine Person.',
  },
  erwartete_wirkung: {
    wort: UEMS_ERWARTETE_WIRKUNG,
    klartext: 'Was eine Person beim Planen schätzt: so viel weniger soll die Maßnahme bringen.',
    beispiel: 'Zum Beispiel: 3\u00a0% weniger Strom im Spritzguss, weil die Heizungen etwa ein Fünftel der Zeit ohne Produktion laufen.',
    fachwort: null,
    frage: 'Was heißt „erwartet“ bei einer Maßnahme?',
    abgrenzung: 'Eine Schätzung, keine Messung: Sie steht immer neben der beobachteten Zahl, nie an ihrer Stelle.',
  },
  beobachtet: {
    wort: UEMS_BEOBACHTET,
    klartext: 'Was VoltPilot nach der Umsetzung misst: wie viel weniger als erwartet, Monat für Monat, gegen die Bezugsbasis.',
    beispiel: 'Zum Beispiel: 3,4\u00a0% weniger als erwartet, Monat für Monat seit der Umsetzung gemessen.',
    fachwort: null,
    frage: 'Was heißt „beobachtet“?',
    abgrenzung: 'Nicht „gespart“ und nicht „bewirkt“: Ob die Maßnahme den Unterschied macht, sagt eine Person.',
  },
  belegt: {
    wort: UEMS_MASSNAHME_ERGEBNISSE.belegt,
    klartext: 'Das Urteil einer Person: Der Unterschied kommt von der Maßnahme - mit Begründung.',
    beispiel: 'Zum Beispiel: Laufzeit der Werkzeugheizungen laut Steuerung 18\u00a0% niedriger, keine andere Änderung am Prozess.',
    fachwort: null,
    frage: 'Was heißt „belegt“?',
    abgrenzung: 'Die Gegenstücke: nicht belegt (es gibt andere Gründe) und nicht messbar (die Zahl sagt nichts).',
  },
  vorher: {
    wort: UEMS_VORHER,
    klartext: 'Wie der Monat aussah, als die Maßnahme geplant wurde - festgehalten, damit man später vergleichen kann.',
    beispiel: 'Zum Beispiel: Dezember 2027, 12,9\u00a0% mehr als erwartet, festgehalten am 15.01.2028.',
    fachwort: UEMS_AUSGANGSLAGE,
    frage: 'Was heißt „Vorher“?',
    abgrenzung: 'Ändert eine Korrektur den Monat, gibt es einen Hinweis; der festgehaltene Wert bleibt, bis eine Person antwortet.',
  },
  gemessen_an: {
    wort: UEMS_GEMESSEN_AN,
    klartext: 'Die Kennzahl und die Bezugsbasis, an denen VoltPilot die Wirkung einer Maßnahme misst.',
    beispiel: 'Zum Beispiel: Stromeinsatz im Spritzguss je kg, gegen die Bezugsbasis des Vorjahrs.',
    fachwort: UEMS_MESSGRUNDLAGE,
    frage: 'Was heißt „gemessen an“?',
    abgrenzung: 'Ohne sie ist eine Maßnahme nicht gemessen. Das ist erlaubt - dann sagt nur eine Person, ob sie geholfen hat.',
  },
  auffaelligkeit: {
    wort: UEMS_AUFFAELLIGKEIT,
    klartext: 'Ein Monat, den VoltPilot vermerkt, weil er über der Bezugsbasis liegt. Eine Person antwortet: untersuchen oder zur Kenntnis nehmen.',
    beispiel: 'Zum Beispiel: März 2029, 2,2\u00a0% mehr Strom im Spritzguss als erwartet.',
    fachwort: null,
    frage: 'Was ist eine Auffälligkeit?',
    abgrenzung: 'Noch keine Abweichung: VoltPilot urteilt nicht, es vermerkt nur.',
  },
  wirksamkeit: {
    wort: UEMS_WIRKSAMKEIT,
    klartext: 'Ob eine Feststellung aus einem Audit behoben ist - das hält eine Person an der Feststellung fest.',
    beispiel: 'Zum Beispiel: Am 15.04.2029 als wirksam festgehalten.',
    fachwort: null,
    frage: 'Was heißt „Wirksamkeit“?',
    abgrenzung: 'Nicht die Wirkung einer Maßnahme: Die Wirksamkeit gehört zu Nachweisen, die Wirkung zu Verbessern.',
  },
  zweite_person: {
    wort: UEMS_ZWEITE_PERSON,
    klartext: 'Ist es für Ihr Unternehmen eingestellt, bestätigt eine zweite Person jedes Urteil.',
    beispiel: 'Zum Beispiel: Das Energiemanagement beantragt „belegt“, die Geschäftsführung bestätigt.',
    fachwort: 'Vier-Augen-Prinzip',
    frage: 'Was heißt „zweite Person“?',
    abgrenzung: 'Wer beantragt hat oder verantwortlich ist, bestätigt nicht selbst.',
  },
  einsparung: {
    wort: UEMS_EINSPARUNG,
    klartext: 'Was Sie weniger brauchen, als zu erwarten war - in kWh.',
    beispiel: 'Zum Beispiel: Bei 900.000\u00a0kWh erwartetem Verbrauch sind 3,4\u00a0% weniger rund 30.600\u00a0kWh.',
    fachwort: 'Energieleistungsverbesserung',
    frage: 'Was heißt „Einsparung“?',
    abgrenzung: 'VoltPilot misst den Unterschied; ob eine Maßnahme ihn bewirkt hat, sagt eine Person.',
  },
};

/**
 * Konzept Verbessern v1, Entscheid 14: die Normwörter, die nur im Feld `fachwort` stehen dürfen - je Begriff genau
 * diese. Der Sprach-Wächter in `copy.test.ts` lässt sie dort und nur dort durch.
 */
export const NORMWOERTER_IM_FACHWORT: Partial<Record<BegriffSchluessel, readonly string[]>> = {
  massnahme: ['Aktionsplan', 'Korrekturmaßnahme'],
  abweichung: ['Nichtkonformität'],
  einsparung: ['Energieleistungsverbesserung'],
};

/**
 * Die letzte Zeile von „Was ist …?“: „Fachwort: …“, bei mehreren Wörtern „Fachwörter: …“ (ein Komma außerhalb der
 * Klammern trennt zwei Wörter).
 */
export function fachwortZeile(fachwort: string): string {
  let tiefe = 0;
  let mehrere = false;
  for (const z of fachwort) {
    if (z === '(') tiefe += 1;
    else if (z === ')') tiefe -= 1;
    else if (z === ',' && tiefe === 0) mehrere = true;
  }
  return `${mehrere ? 'Fachwörter' : 'Fachwort'}: ${fachwort}`;
}

/** Die Frage, die der Knopf an einem Begriff vorliest. */
export const begriffFrage = (wort: string) => `Was heißt „${wort}“?`;

/** Die Beschriftung der Zeile unter dem Seitenkopf. */
export const BEGRIFFE_LABEL = 'Begriffe';
