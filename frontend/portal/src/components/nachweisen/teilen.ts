/**
 * Teilen am Handy (Konzept n1, Entscheid 6, §6.10): über das Teilen-Menü des Telefons (Web Share API), sonst als
 * Rückfall „Link kopieren“. Geteilt wird immer ein Link in den Kundenbereich, nie die Datei selbst: wer ihn öffnet, braucht
 * ein Konto mit Zugang - die Rechte gelten weiter (kein öffentlicher Link, Richtungsfrage 9.3 A).
 */

export type TeilenErgebnis = 'geteilt' | 'kopiert' | 'abgebrochen' | 'fehler';

/** Was der Browser zum Teilen anbietet; im Test hereingereicht. */
export type TeilenUmgebung = {
  share?: (daten: { title?: string; text?: string; url?: string }) => Promise<void>;
  canShare?: (daten: { title?: string; text?: string; url?: string }) => boolean;
  kopieren?: (text: string) => Promise<void>;
};

/** Die Umgebung des Browsers: `navigator.share`, sonst die Zwischenablage. */
export function browserTeilen(): TeilenUmgebung {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  return {
    share: nav && typeof nav.share === 'function' ? (d) => nav.share(d) : undefined,
    canShare: nav && typeof nav.canShare === 'function' ? (d) => nav.canShare(d) : undefined,
    kopieren: nav?.clipboard?.writeText ? (t) => nav.clipboard.writeText(t) : undefined,
  };
}

/** Die Adresse einer Seite im Portal: Herkunft und Pfad dieser Seite, dahinter die Route (`#/portfolio/…`). */
export function seitenLink(hash: string, ort: Pick<Location, 'origin' | 'pathname'> = window.location): string {
  return `${ort.origin}${ort.pathname}${hash.startsWith('#') ? hash : `#${hash}`}`;
}

/**
 * Teilt einen Link: zuerst über das Telefon, und wenn es das nicht gibt, kopiert es ihn. Bricht die Person das Teilen ab,
 * passiert nichts (`abgebrochen`) - kein Rückfall, sie hat sich entschieden.
 */
export async function teilen(daten: { titel: string; url: string }, umgebung: TeilenUmgebung = browserTeilen()): Promise<TeilenErgebnis> {
  const nutzlast = { title: daten.titel, url: daten.url };
  if (umgebung.share && (!umgebung.canShare || umgebung.canShare(nutzlast))) {
    try {
      await umgebung.share(nutzlast);
      return 'geteilt';
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return 'abgebrochen';
      // Andere Fehler (etwa „NotAllowedError“ ohne Nutzer-Geste): weiter mit dem Rückfall.
    }
  }
  if (umgebung.kopieren) {
    try {
      await umgebung.kopieren(daten.url);
      return 'kopiert';
    } catch {
      return 'fehler';
    }
  }
  return 'fehler';
}

/** Die Rückmeldung nach dem Teilen, eine Zeile; `null` wo nichts zu sagen ist. */
export const TEILEN_SATZ: Record<TeilenErgebnis, string | null> = {
  geteilt: null,
  abgebrochen: null,
  kopiert: 'Link kopiert',
  fehler: 'Der Link ließ sich nicht kopieren.',
};
