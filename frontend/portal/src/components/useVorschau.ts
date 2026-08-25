/**
 * Der EINE Weg, wie eine Fläche zu ihrer **Vorschau-Zahl** kommt (Steuerung
 * Stufe 7, Konzept `vp-steuerung-konzept-b3` §3.5/§3.6).
 *
 * Er existiert, weil DREI Flächen dieselbe Frage stellen (Regel aktivieren ·
 * Betriebsmodell wechseln · Vorschlag übernehmen · Handeingriff) und die
 * Antwort dieselben vier Eigenschaften haben muss:
 *
 *  1. **Sie kostet einen echten MILP-Lauf.** Also GENAU EINMAL je geöffneter
 *     Karte, nie in einer Schleife und nie beim Rendern der Liste. Der Deckel
 *     der Route ist die harte Grenze; diese Regel ist die Höflichkeit davor.
 *  2. **Sie darf die Karte nicht aufhalten.** Die Folgen-Karte steht sofort;
 *     die Zahl tritt nach, und bis dahin sagt die Karte, dass gerechnet wird
 *     ({@link VORSCHAU_LAEUFT}) — nie „nicht abschätzbar", was sie eine Sekunde
 *     später widerrufen müsste.
 *  3. **Ein Fehlschlag ist kein Ergebnis.** Ein abgelehnter, überlasteter oder
 *     unerreichbarer Dienst führt zurück auf die ehrliche zahllose Fassung MIT
 *     dem Server-Grund — nie auf eine 0 und nie auf eine geschätzte Zahl.
 *  4. **Ein Wechsel der Frage verwirft die alte Antwort.** Wer die Karte
 *     schliesst und eine andere öffnet, darf nie die Zahl der vorigen
 *     Entscheidung lesen. Das trägt hier der `nonce`, nicht die Fläche.
 *
 * ⚠ **Er fragt NICHTS, solange keine Knöpfe da sind.** Eine Entscheidung, die
 * sich nicht in die drei Knöpfe der Route übersetzen lässt, hat keine
 * belastbare Vorschau — dann bleibt es bei der zahlfreien Fassung, statt eine
 * beliebige Ersatz-Frage zu stellen (Leitprinzip Regel 2).
 */
import { useEffect, useRef, useState } from 'react';
import { ApiError, api, type SteuerungVorschau, type VorschauKnoepfe } from '../api';

export interface VorschauStand {
  /** Die Server-Zahl, sobald sie da ist. */
  ergebnis: SteuerungVorschau | null;
  /** Die Anfrage ist unterwegs. */
  laeuft: boolean;
}

/** Der Ruhezustand — es wurde nichts gefragt und nichts behauptet. */
export const VORSCHAU_STILL: VorschauStand = { ergebnis: null, laeuft: false };

/**
 * Holt die Vorschau für GENAU EINE Entscheidung.
 *
 * @param siteId  die Anlage; `null` fragt nichts.
 * @param knoepfe die Übersetzung der Entscheidung in die drei Route-Knöpfe;
 *                `null` = nicht übersetzbar ⇒ es wird nicht gefragt.
 * @param nonce   wechselt, sobald eine ANDERE Entscheidung gemeint ist. Der
 *                Aufrufer setzt ihn (z. B. auf die Regel-Id); ohne ihn könnte
 *                die Antwort der vorigen Frage stehen bleiben.
 */
export function useVorschau(
  siteId: string | null,
  knoepfe: VorschauKnoepfe | null,
  nonce: string | null,
): VorschauStand {
  const [stand, setStand] = useState<VorschauStand>(VORSCHAU_STILL);
  // Die Knöpfe sind ein frisch gebautes Objekt je Render — als Effekt-
  // Abhängigkeit taugt deshalb nur ihr INHALT, sonst liefe je Render ein
  // MILP-Lauf. Genau der Fehler, gegen den Regel 1 oben geschrieben ist.
  const schluessel = knoepfe ? JSON.stringify(knoepfe) : null;
  const laufend = useRef(0);

  useEffect(() => {
    if (!siteId || !schluessel || !nonce) {
      setStand(VORSCHAU_STILL);
      return;
    }
    const meine = laufend.current + 1;
    laufend.current = meine;
    setStand({ ergebnis: null, laeuft: true });
    let lebt = true;
    api.steuerungVorschau(siteId, JSON.parse(schluessel) as VorschauKnoepfe)
      .then((v) => {
        // Eine überholte Antwort wird VERWORFEN, nie angezeigt (Regel 4).
        if (!lebt || laufend.current !== meine) return;
        setStand({ ergebnis: v, laeuft: false });
      })
      .catch((e) => {
        if (!lebt || laufend.current !== meine) return;
        // Der Server-Grund ist die ehrlichste Auskunft, die es hier gibt — der
        // Deckel nennt sich selbst, ein Ausfall nennt sich selbst.
        const grund = e instanceof ApiError && e.message ? e.message : null;
        setStand({
          ergebnis: grund
            ? {
              deltaEur: null, basisEur: null, varianteEur: null,
              horizonSlots: null, naeherung: true, grund,
            }
            : null,
          laeuft: false,
        });
      });
    return () => { lebt = false; };
  }, [siteId, schluessel, nonce]);

  return stand;
}
