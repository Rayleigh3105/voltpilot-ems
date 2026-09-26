/**
 * Der Nav-Eintrag der Erlöse-Welt im Portfolio.
 *
 * ⚠ EIGENES MODUL (UX-Review V-01, 24.09.2026): die Schale (`App.tsx`) braucht
 * beim ersten Bild nur diese eine Frage; `portfolioHistorie.ts` zog dafür die
 * ganze Portfolio-Historie samt `historieWelten.ts` ins Einstiegs-Bündel.
 * `portfolioHistorie.ts` reicht die Funktion unverändert weiter.
 */
import type { Site } from './api';
import { activeModes } from './surface';

/**
 * Gibt es im Portfolio überhaupt Geld zu zeigen? Genau dann, wenn **mindestens
 * eine Anlage einen Geld-Modus hat** — dieselbe Regel wie auf der Anlage
 * (`erloes-historie` kommt aus dem Markt- bzw. dem Lastspitzen-Manifest,
 * `surface.ts`), nur über die Flotte. Eine reine Privat-Flotte bekommt gar
 * keinen Erlöse-Eintrag statt einer Fläche, die dann nichts erklärt.
 *
 * **Bewusste Grenze (dokumentiert, kein Versehen):** abgeleitet wird aus den
 * Stammdaten, die die Schale ohnehin geladen hat (`SiteDto`) — es kostet
 * KEINEN zusätzlichen Abruf je Anlage. Ein Geld-Modus, der ausschließlich aus
 * einem aktiven Markt-FLOW stammt (ohne Direktvermarktung, ohne Netzladen auf
 * dynamischem Tarif, ohne Leistungspreis), ist hier deshalb nicht sichtbar; die
 * Erlöse-Welt DIESER Anlage bleibt über die Anlage selbst erreichbar.
 */
export function hatGeldWelt(sites: readonly Site[]): boolean {
  return sites.some((s) =>
    activeModes({
      config: {
        plantKind: s.plantKind,
        tarifArt: s.tarifArt,
        netzladenErlaubt: s.netzladenErlaubt,
        leistungspreisEurKw: s.leistungspreisEurKw ?? null,
      },
    }).some((m) => m.manifest.deepViews.includes('erloes-historie')),
  );
}
