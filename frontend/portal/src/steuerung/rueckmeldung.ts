/**
 * „Gewählt ist nicht geladen“ (Konzept k1, Regel 4): nach „So laden“ drei
 * getrennte Schritte statt „Gilt ab jetzt“ - gesendet › Box hat übernommen ›
 * Wirkung gemessen. Dieselbe Trennung wie das Gerätblatt (Wunsch › Box hat
 * angenommen › Wirkung) und die Hausregel: Annahme, Geräteantwort und Wirkung
 * eines Befehls sind drei Aussagen.
 *
 * Rein. Die Uhr der Box und die des Browsers gehen nie gleich; deshalb zählt
 * nicht „gemeldet nach dem Senden“ nach der Uhr, sondern: eine NEUERE Meldung
 * als die, die beim Senden schon da war (`vorher`). Vertrag und Vektoren:
 * `docs/contracts/ladepunkt-quelle-echo.md`, Abschnitt `portal`.
 */
import { LADEQUELLE } from '../glossar';
import type { LadepunktBezug } from './bild';
import type { LadeQuelle } from './laden';
import { kwText } from './ladeVorschau';

/** Weicht das Echo so lange nach dem Senden noch ab, ist es eine Abweichung, kein Warten mehr. */
export const ABWEICHUNG_NACH_MS = 120_000;

/** Was beim Senden einer Wahl festgehalten wird. */
export interface Gesendet {
  modus: LadeQuelle;
  /** Uhr des Browsers - nur zur Anzeige („13:11“). */
  ms: number;
  /** Die Meldung der Säule, die beim Senden schon da war (`reportedAt`). */
  vorherGemeldet: string | null;
  /** Die Messung des Steckers, die beim Senden schon da war (`meteredAt`). */
  vorherGemessen: string | null;
}

export type BoxSchritt = 'bestaetigt' | 'wartet' | 'abweichend' | 'unbekannt';

/** Der zweite Schritt aus dem Vergleich des Servers (Vektoren, Abschnitt `portal`). */
export function boxSchritt(uebernommen: boolean | null, gemeldetNachSenden: boolean, msSeitSenden: number): BoxSchritt {
  if (uebernommen == null) return 'unbekannt';
  if (!gemeldetNachSenden) return 'wartet';
  if (uebernommen) return 'bestaetigt';
  return msSeitSenden > ABWEICHUNG_NACH_MS ? 'abweichend' : 'wartet';
}

const neuer = (jetzt: string | null, vorher: string | null) => {
  if (!jetzt) return false;
  if (!vorher) return true;
  const a = Date.parse(jetzt);
  const b = Date.parse(vorher);
  return Number.isFinite(a) && Number.isFinite(b) ? a > b : jetzt !== vorher;
};

export type Zustand = 'fertig' | 'laeuft' | 'offen' | 'warn';

export interface Zeile {
  zustand: Zustand;
  text: string;
  unter: string;
}

/** Die drei Zeilen der Rückmeldung. `uhr` formt einen Zeitpunkt („13:11“). */
export function rueckmeldung(
  l: Pick<LadepunktBezug, 'angesteckt' | 'laedt' | 'leistungKw' | 'gemessenAm' | 'grund' | 'uebernommen' | 'gemeldetAm'> | null,
  g: Gesendet,
  nowMs: number,
  uhr: (ms: number) => string,
): [Zeile, Zeile, Zeile] {
  const eins: Zeile = { zustand: 'fertig', text: `Gesendet: ${LADEQUELLE[g.modus]}`, unter: uhr(g.ms) };
  const box = boxSchritt(l?.uebernommen ?? null, neuer(l?.gemeldetAm ?? null, g.vorherGemeldet), nowMs - g.ms);
  const zwei: Zeile = box === 'bestaetigt'
    ? { zustand: 'fertig', text: 'Box hat übernommen', unter: l?.gemeldetAm ? uhr(Date.parse(l.gemeldetAm)) : '' }
    : box === 'abweichend'
      ? { zustand: 'warn', text: 'Box fährt noch die alte Wahl', unter: 'Meldet sie sich weiter so, prüfen Sie die Verbindung der Box.' }
      : box === 'unbekannt'
        ? { zustand: 'offen', text: 'Box hat noch nicht bestätigt', unter: 'Diese Box meldet die Übernahme noch nicht.' }
        : { zustand: 'laeuft', text: 'Box hat noch nicht bestätigt', unter: 'meist wenige Sekunden' };
  let drei: Zeile;
  if (!l || !neuer(l.gemessenAm, g.vorherGemessen)) {
    drei = { zustand: box === 'bestaetigt' ? 'laeuft' : 'offen', text: 'Wirkung noch nicht gemessen', unter: 'aus der Messung der Säule' };
  } else {
    const am = `gemessen ${uhr(Date.parse(l.gemessenAm as string))}`;
    if (!l.angesteckt) drei = { zustand: 'fertig', text: 'Kein Auto angesteckt', unter: `${am} · die Wahl gilt ab der nächsten Ladung` };
    else if (l.laedt && l.leistungKw != null && l.leistungKw > 0.05) drei = { zustand: 'fertig', text: `Lädt mit ${kwText(l.leistungKw)}`, unter: am };
    else drei = { zustand: 'fertig', text: 'Wartet, lädt gerade nicht', unter: l.grund ? `${l.grund} · ${am}` : am };
  }
  return [eins, zwei, drei];
}
