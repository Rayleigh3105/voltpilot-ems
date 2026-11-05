// Das Tor des Börsenpreis-Streifens als eigenes, winziges Modul: die Anlagen-Seite (im Einstieg)
// braucht nur diese eine Regel. Läge sie in `strompreis.ts`, zöge der eine Aufruf Film-Wortlaut,
// Preisfenster und Bezugspreis-Vorschau mit ins erste Bild (Bündel-Wächter `test/bundle-smoke.sh`).
// `strompreis.ts` reicht sie unverändert weiter.
import type { TarifArt } from './api';
import { preisRolle } from './preisRolle';
import { hasMode, type ActiveMode } from './surface';

/**
 * Wo der Streifen erscheint: exakt die Signalmenge, die auch die
 * Marktpreise-Ansicht erreichbar macht (`surface.ts`/`ebenenNav`) — der
 * Markt-Modus ODER ein dynamischer Tarif. Keine neue Regel, kein Drift.
 *
 * Der Tarif-Teil liest {@link preisRolle} (Konzept
 * `vp-fahrplan-eigenverbrauch-konzept` §5.1/§5.4) — die EINE Klassen-Regel,
 * die auch `fahrplanTag.bildPreisArt` und der Preise-Reiter lesen; der
 * Markt-Modus bleibt ein eigenes Signal, dieselbe Regel entscheidet ihn
 * bereits über `plantKind`.
 */
export function gateStrompreis(
  modes: ActiveMode[],
  tarifArt: TarifArt | null | undefined,
): boolean {
  if (hasMode(modes, 'marktvermarktung')) return true;
  return preisRolle({ tarifArt: tarifArt ?? 'ohne', plantKind: 'eigenverbrauch' }).erzaehlung === 'preis';
}
