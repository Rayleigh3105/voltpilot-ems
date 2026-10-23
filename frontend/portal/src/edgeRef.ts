/**
 * Die Kennung einer VoltPilot-Box im Portal (Anlage-Flow a1, B4) - der Zwilling von
 * `EdgeRef.java` (API) und `refCheckChar` (Box, `edge-app/core/internal/agent/agent.go`).
 * Vektoren: `docs/contracts/edge-ref-vectors.json`; alle drei lesen sie.
 *
 * Die Box zeigt ihre Kennung in ihrer App („edge-“ + sechs Zeichen + Prüfzeichen); einen
 * Aufkleber gibt es nicht (Captain, Runde 1). Das Feld nimmt, was der Kunde tippt oder
 * einfügt: Groß-/Kleinschreibung, Leerzeichen, ein fehlender Präfix oder Bindestrich spielen
 * keine Rolle. Ein Tippfehler fällt beim Tippen auf, nicht erst als Gerät, das sich nie meldet.
 *
 * Reines Modul: kein React, kein Netzwerk.
 */

export const KENNUNG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const KENNUNG_PRAEFIX = 'edge-';
const KOERPER = 6;
/** Kennungen aus dem Herstellregister (Server prüft sie gegen das Register). */
const REGISTER_PRAEFIX = 'VP-';

/** Das Prüfzeichen zu sechs Zeichen - positionsgewichtete Summe mod 31. */
export function pruefzeichen(koerper: string): string {
  let summe = 0;
  for (let i = 0; i < koerper.length; i++) summe += (i + 1) * KENNUNG_ALPHABET.indexOf(koerper[i]);
  return KENNUNG_ALPHABET[summe % KENNUNG_ALPHABET.length];
}

/** Wie `EdgeRef.isValid`: „edge-“ + sechs Zeichen + passendes Prüfzeichen. */
export function kennungGueltig(kennung: string): boolean {
  if (!kennung.startsWith(KENNUNG_PRAEFIX)) return false;
  const rest = kennung.slice(KENNUNG_PRAEFIX.length);
  if (rest.length !== KOERPER + 1) return false;
  for (const z of rest) if (!KENNUNG_ALPHABET.includes(z)) return false;
  return rest[KOERPER] === pruefzeichen(rest.slice(0, KOERPER));
}

export type KennungZustand =
  /** Nichts eingetragen. */
  | 'leer'
  /** Noch zu kurz - kein Fehler, solange der Kunde tippt. */
  | 'unvollstaendig'
  | 'gueltig'
  /** Ein Zeichen, das es in keiner Kennung gibt (0, 1, i, l, o, …). */
  | 'zeichen'
  /** Sieben Zeichen, aber das Prüfzeichen passt nicht - oder zu viele Zeichen. */
  | 'pruefzeichen'
  /** Eine Kennung aus dem Herstellregister (VP-…); der Server prüft sie. */
  | 'register';

export interface KennungPruefung {
  /** Was gesendet wird - die kanonische Form. */
  kennung: string;
  zustand: KennungZustand;
}

/**
 * Aus der Eingabe die Kennung und ihr Zustand. Fälle: `edge-ref-vectors.json → eingabe`.
 */
export function pruefeKennung(eingabe: string): KennungPruefung {
  const roh = eingabe.replace(/\s+/g, '');
  if (!roh) return { kennung: '', zustand: 'leer' };
  if (roh.toUpperCase().startsWith(REGISTER_PRAEFIX)) return { kennung: roh.toUpperCase(), zustand: 'register' };
  let koerper = roh.toLowerCase().replace(/[-_]/g, '');
  // „edge“ vor dem Körper: getippt (mit oder ohne Bindestrich) oder eingefügt. Ein Körper,
  // der selbst mit „edge“ beginnt, hat höchstens sieben Zeichen - erst mehr heißt Präfix.
  if (koerper.startsWith('edge') && (koerper.length > KOERPER + 1 || /^\s*edge\s*-/i.test(eingabe))) {
    koerper = koerper.slice(4);
  }
  const kennung = KENNUNG_PRAEFIX + koerper;
  if ([...koerper].some((z) => !KENNUNG_ALPHABET.includes(z))) return { kennung, zustand: 'zeichen' };
  if (koerper.length <= KOERPER) return { kennung, zustand: 'unvollstaendig' };
  if (kennungGueltig(kennung)) return { kennung, zustand: 'gueltig' };
  // „edgek7m…“ ohne Bindestrich: bis der Präfix erkennbar ist, ist das noch kein Fehler.
  if (koerper.startsWith('edge') && koerper.length <= KOERPER + 1) return { kennung, zustand: 'unvollstaendig' };
  return { kennung, zustand: 'pruefzeichen' };
}

/** Der Satz am Feld (Konzept a1, Schritt 2) - `null`, wenn nichts zu sagen ist. */
export function kennungFehler(p: KennungPruefung, abgeschickt: boolean): string | null {
  switch (p.zustand) {
    case 'zeichen':
      return 'Diese Kennung stimmt nicht. Eine Kennung enthält kein 0, 1, i, l oder o.';
    case 'pruefzeichen':
      return 'Diese Kennung stimmt nicht. Bitte vergleichen Sie sie Zeichen für Zeichen mit der App Ihrer Box.';
    case 'unvollstaendig':
      return abgeschickt ? 'Die Kennung hat nach „edge-“ sieben Zeichen.' : null;
    case 'leer':
      return abgeschickt ? 'Bitte tragen Sie die Kennung Ihrer Box ein.' : null;
    default:
      return null;
  }
}

/** Kann gesendet werden: eine gültige Kennung oder eine aus dem Herstellregister. */
export function kennungSendbar(p: KennungPruefung): boolean {
  return p.zustand === 'gueltig' || p.zustand === 'register';
}
