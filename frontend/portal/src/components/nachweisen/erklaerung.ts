/**
 * Das Erklär-Blatt hinter dem i-Knopf (Konzept Nachweisen n1, Runde 2, §7 und Entscheid 24): Erklärungen stehen nicht
 * mehr als Satz unter dem Titel oder als offener Aufklapper im Fluss der Seite, sondern öffnen erst auf Antippen.
 *
 * Aufbau, immer in dieser Reihenfolge: die Frage als Titel („Was ist ein Nachweis?“), der Klartext, „Bei Ihnen:“ mit
 * einem Beispiel aus den eigenen Daten, „Nicht verwechseln:“ mit der Abgrenzung und als letzte, leise Zeile das
 * Normwort. Höchstens 45 Wörter einschließlich der Frage (Text-Grenze §0.4, Entscheid 22).
 *
 * ⚠ Das Normwort steht NUR im Feld `fachwort` (Entscheid 18): es ist die eine Stelle, an der ein Wort stehen darf,
 * unter dem Berater und Prüfende dasselbe kennen. Klartext, Beispiel und Abgrenzung sprechen die Wörter des Portals.
 */
export interface Erklaerung {
  /** Die Frage: Titel des Blatts und Name des i-Knopfs für Vorleser. */
  frage: string;
  /** Ein Satz in Alltagssprache. */
  klartext: string;
  /** Ein Beispiel aus den eigenen Daten; ohne Daten entfällt die Zeile (kein erfundenes Beispiel). */
  beiIhnen?: string | null;
  /** Womit man es nicht verwechseln soll. */
  nichtVerwechseln?: string | null;
  /** Entscheid 18: das Normwort, nur hier und immer als letzte Zeile. */
  fachwort?: string | null;
}

export const BEI_IHNEN = 'Bei Ihnen:';
export const NICHT_VERWECHSELN = 'Nicht verwechseln:';
export const NORMWORT = 'Normwort:';

/** Text-Grenze des Erklär-Blatts (§0.4): höchstens 45 Wörter einschließlich der Frage. */
export const ERKLAER_WOERTER_HOECHSTENS = 45;

/**
 * Die Zählregel des Konzepts (§0.6, `woerter.js`): ein Wort ist jedes durch Leerraum getrennte Stück mit mindestens
 * einem Buchstaben oder einer Ziffer; „·“ und „-“ allein zählen nicht, Zahlen und Daten zählen mit.
 */
export function woerter(text: string): number {
  return text.split(/\s+/u).filter((stueck) => /[\p{L}\p{N}]/u.test(stueck)).length;
}

/** Alle Zeilen des Blatts, wie sie dastehen - für die Zählung und für Tests. */
export function erklaerZeilen(e: Erklaerung): string[] {
  return [
    e.frage,
    e.klartext,
    ...(e.beiIhnen ? [`${BEI_IHNEN} ${e.beiIhnen}`] : []),
    ...(e.nichtVerwechseln ? [`${NICHT_VERWECHSELN} ${e.nichtVerwechseln}`] : []),
    ...(e.fachwort ? [`${NORMWORT} ${e.fachwort}`] : []),
  ];
}

export const erklaerWoerter = (e: Erklaerung) => erklaerZeilen(e).reduce((summe, zeile) => summe + woerter(zeile), 0);
