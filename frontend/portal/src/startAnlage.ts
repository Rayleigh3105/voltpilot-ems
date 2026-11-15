import { isBootHash } from './nav';

/**
 * DIE ANLAGE DES LEEREN STARTS (Performance Welle 3, offener Hebel 2 der zweiten Welle).
 *
 * Die installierte App startet auf `/` (`start_url`), ohne Anlage in der Adresse. Der Vorab-Abruf nach Route
 * (`seitenVorab.ts`) griff dort nicht: welche Seite kommt, entscheidet die Startweiche erst nach `/me`, `/sites` und
 * `/funktionen` (`canonicalShellRoute`). Beim Privatkunden mit einer Anlage ist das immer dieselbe Anlage.
 *
 * Darum merkt sich das Portal, auf welcher Anlage (Cockpit) der letzte Start OHNE Adresse gelandet ist, und stellt
 * beim nächsten solchen Start deren Seitendaten gleich mit `/me` vorab. Nur Vorab-Abruf: Navigation und Weiterleitung
 * entscheidet weiter allein die Startweiche. Landet ein leerer Start woanders (Portfolio, Standort, Übersicht), wird
 * die Anlage vergessen - ein Kunde mit mehreren Anlagen bekommt so keine vergeudeten Abrufe für eine Seite, die er
 * beim Start gar nicht sieht.
 *
 * Gemerkt wird je angemeldetem Nutzer (`sub` des Tokens) und Kundenbereich, nie für platform-admin. Ein anderer Nutzer
 * verwirft die Anlage, Abmelden auch (`auth.ts` `logout`). Eine nicht mehr erlaubte Anlage richtet keinen Schaden an:
 * der Server lehnt die Vorab-Abrufe ab wie jeden anderen, eine Ablehnung wird nie geteilt (`vorabAbrufen`), und die
 * Weiche landet den Nutzer, wo sie ohnehin hinführt. Im Speicher steht nur die Anlagen-ID, kein Token.
 */

const SCHLUESSEL = 'vp.startAnlage';

interface Gemerkt {
  nutzer: string;
  bereich: string | null;
  anlage: string;
}

function lesen(): Gemerkt | null {
  try {
    const roh = localStorage.getItem(SCHLUESSEL);
    if (roh === null) return null;
    const g = JSON.parse(roh) as Partial<Gemerkt> | null;
    if (
      typeof g?.nutzer === 'string' &&
      typeof g.anlage === 'string' &&
      /^[0-9A-Za-z-]+$/.test(g.anlage) &&
      (g.bereich === null || typeof g.bereich === 'string')
    ) {
      return { nutzer: g.nutzer, bereich: g.bereich, anlage: g.anlage };
    }
  } catch {
    /* unlesbar: wie nicht gemerkt */
  }
  vergissStartAnlage();
  return null;
}

/** Vergisst die gemerkte Anlage (Abmelden, Nutzerwechsel, ein leerer Start, der nicht auf einer Anlage landet). */
export function vergissStartAnlage(): void {
  try {
    localStorage.removeItem(SCHLUESSEL);
  } catch {
    /* kein Speicher: nichts zu vergessen */
  }
}

/**
 * Hält fest, wo der leere Start gelandet ist: auf dem Cockpit von `anlage`, oder (`null`) woanders. Ohne bekannten
 * Nutzer wird nichts gemerkt.
 */
export function merkeStartAnlage(nutzer: string | undefined, bereich: string | null, anlage: string | null): void {
  if (!nutzer || !anlage) {
    vergissStartAnlage();
    return;
  }
  try {
    localStorage.setItem(SCHLUESSEL, JSON.stringify({ nutzer, bereich, anlage } satisfies Gemerkt));
  } catch {
    /* voller oder gesperrter Speicher: dann eben ohne Vorab beim nächsten Start */
  }
}

/**
 * Die Adresse, deren Seitendaten beim ersten Laden vorab gehen: die Adresse selbst, beim leeren Start die gemerkte
 * Anlage DIESES Nutzers in diesem Kundenbereich. Gehört die gemerkte Anlage einem anderen Nutzer, wird sie verworfen.
 */
export function vorabAdresse(hash: string, nutzer: string | undefined, bereich: string | null): string {
  if (!isBootHash(hash) || !nutzer) return hash;
  const g = lesen();
  if (!g) return hash;
  if (g.nutzer !== nutzer) {
    vergissStartAnlage();
    return hash;
  }
  return g.bereich === bereich ? `#/anlage/${g.anlage}` : hash;
}
