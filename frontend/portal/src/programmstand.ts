/**
 * UEMS EZ-16 „Programmstand im Portal“ (Konzept vp-erzeuger-wago-konzept §4.10, EW-13 B): welcher Stand des
 * VoltPilot-SPS-Programms auf einer Anlagensteuerung läuft. Den Vergleich Ist gegen Soll macht nur der Server
 * (`erzeuger/Programmstand`); hier stehen nur die Sätze, die Geräteseite und das Blatt „Steuerung jetzt“ zeigen.
 *
 * Unbekannt ist kein Stand: ohne gültigen Wert heißt es „nicht gelesen“, nie „aktuell“ und nie 0.
 */

/** `Programmstand` der Route `GET /api/v1/sites/{siteId}/anlagensteuerungen` (openapi). */
export interface Programmstand {
  zustand: 'aktuell' | 'aelter' | 'unbekannt';
  /** JJMM wie gelesen; null = kein gültiger Wert. */
  ist: number | null;
  ist_text: string | null;
  soll: number;
  soll_text: string;
  /** `fassung` = die Registerbild-Fassung nennt den Soll; `bibliothek` = der Stand der VoltPilot-Bibliothek. */
  soll_quelle: 'fassung' | 'bibliothek';
  /** Datenalter des Ist-Werts; null ohne Wert. */
  gemessen_am: string | null;
  /** Älter als erwartet — Kandidat für die Überwachung (EZ-11). */
  warnen: boolean;
}

export type ProgrammstandTon = 'ok' | 'warn' | 'neutral';

export interface ProgrammstandZeile {
  /** „26.10 · aktuell“, „26.05 · älter als erwartet“, „nicht gelesen“. */
  wert: string;
  /** Der Hinweis unter der Zeile — nur, wenn die Anlage einen alten Stand fährt. */
  hinweis: string | null;
  ton: ProgrammstandTon;
}

/** Die Zeile „Programmstand“ der Geräteseite. */
export function programmstandZeile(p: Programmstand): ProgrammstandZeile {
  if (p.zustand === 'aelter' && p.ist_text) {
    return {
      wert: `${p.ist_text} · älter als erwartet`,
      hinweis: alterStandSatz(p),
      ton: 'warn',
    };
  }
  if (p.zustand === 'aktuell' && p.ist_text) {
    return { wert: `${p.ist_text} · aktuell`, hinweis: null, ton: 'ok' };
  }
  return { wert: 'nicht gelesen', hinweis: null, ton: 'neutral' };
}

/** „Fährt einen alten Stand (26.05, erwartet 26.10).“ */
export function alterStandSatz(p: Programmstand): string {
  return `Fährt einen alten Stand (${p.ist_text}, erwartet ${p.soll_text}).`;
}

/**
 * Der Grund für das Blatt „Steuerung jetzt“ (`SteuerWarum`, Abschnitt „Warum“): nur, wenn die Steuerung einen
 * alten Stand fährt — ein aktueller oder unbekannter Stand erklärt keine Steuerung und bleibt auf der Geräteseite.
 */
export function programmstandGrund(p: Programmstand | null | undefined): [string, string] | null {
  if (!p || p.zustand !== 'aelter' || !p.ist_text) return null;
  return ['Programm', `Die Anlagensteuerung fährt einen alten Stand (${p.ist_text}, erwartet ${p.soll_text}).`];
}
