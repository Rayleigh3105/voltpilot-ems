/**
 * Die Steuern-Regel und die Geld-Regel: zwei Fakten je Anlage bzw. Standort, abgeleitet aus `GET /funktionen`.
 *
 * ⚠ EIGENES MODUL (Bündel-Wächter `test/bundle-smoke.sh`, 09.10.2026): die Schale (`App.tsx`), `anlageGeld.ts`
 * und `anlegeNurMessen.ts` brauchen beim ersten Bild nur diese Regeln; `uebersicht.ts` zog dafür das ganze
 * Übersichts-Bild samt `portfolioCockpit.ts` ins Einstiegs-Bündel. `uebersicht.ts` reicht sie unverändert weiter.
 */
import type { FunktionStandort, Funktionen, OverviewSite } from './api';
import type { FunktionZustand } from './uemsFunktion';

// ---------------------------------------------------------------------------
// Wer steuert — und wer Geld sehen darf
// ---------------------------------------------------------------------------

/**
 * Die Anlagen, die AKTIV an „Steuern & Optimieren" ihres Standorts teilnehmen;
 * `null` = unbekannt (die Funktionen sind nicht geladen). Eine angehaltene oder
 * nur eingerichtete Teilnahme steuert nicht.
 */
export function steuerndeAnlagen(funktionen: Funktionen | null): Set<string> | null {
  if (!funktionen) return null;
  const out = new Set<string>();
  for (const st of funktionen.standorte) {
    for (const a of st.steuern.anlagen) if (a.teilnahme.zustand === 'aktiv') out.add(a.id);
  }
  return out;
}

/** Teilnahme-Zustände, die schweigen: keine Teilnahme oder eine beendete. */
const STEUERN_STILL: ReadonlySet<FunktionZustand> = new Set<FunktionZustand>(['kein_objekt', 'archiviert']);

/**
 * DIE STEUERN-REGEL (Captain über firstmate 003/004, 15.09.2026: „Von steuern
 * soll beim messen eigentlich noch nicht die rede sein."): ein Standort spricht
 * von „Steuern & Optimieren", sobald mindestens EINE seiner Anlagen teilnimmt —
 * die Ebene ist die Anlage. Ein Standort, an dem keine teilnimmt, schweigt ganz:
 * keine Zeile „Noch nicht eingerichtet", kein Schritt „einrichten".
 *
 * Teilnehmen heißt: im Entwurf, eingerichtet, angehalten oder aktiv — jeder
 * dieser Zustände entsteht erst auf den Anstoß des Kunden. Nur `kein_objekt`
 * und `archiviert` schweigen. Eine angehaltene oder noch nicht gestartete
 * Teilnahme zu verschweigen, nähme ihm den Weg zurück; kollidieren Schweigen und
 * Erreichbarkeit, gewinnt die Erreichbarkeit („Okay ich will aber schon das
 * Messkunden auch zu Kunden werden wo man verbraucher steuern kann.").
 *
 * ⚠ Gezählt wird an den Anlagen, die `GET /funktionen` unter DIESEM Standort
 * nennt — dieselbe Quelle wie die Zeile, die dann erscheint; so steht nie eine
 * Steuern-Zeile ohne Teilnahme da. „reine Messung" in Kopfzeile und
 * Standort-Zahlen bleibt ({@link steuertTeil}): das Wort benennt, was der Kunde
 * ist, nicht was ihm fehlt.
 */
export function steuernSpricht(fs: FunktionStandort): boolean {
  return fs.steuern.anlagen.some((a) => !STEUERN_STILL.has(a.teilnahme.zustand));
}

/**
 * DIE GELD-REGEL als Fakt je Anlage (AP-01 §4.6, Captain-Vorgabe 10.09.2026:
 * „Die Messdatenkunden brauchen keine Geldanzeige.").
 *
 * Eine Anlage darf Geld zeigen, wenn sie aktiv an „Steuern & Optimieren"
 * teilnimmt ODER einen Erzeuger bzw. Speicher hat (`roleCounts.pv`/`storage`).
 * Geld-Bausteine erscheinen auf der Ebene nur, wenn diese Menge nicht leer ist,
 * und zählen nur ihre Anlagen.
 *
 * ⚠ Unbekannt ist nie „erlaubt": ohne `roleCounts` (älteres Backend) zählt keine
 * Rolle, ohne Funktionen keine Teilnahme — im Zweifel zeigt die Übersicht kein
 * Geld, nie einem Messkunden eines.
 */
export function geldAnlagen(sites: readonly OverviewSite[], funktionen: Funktionen | null): Set<string> {
  const steuert = steuerndeAnlagen(funktionen);
  const out = new Set<string>();
  for (const s of sites) {
    const erzeugerOderSpeicher = (s.roleCounts?.pv ?? 0) > 0 || (s.roleCounts?.storage ?? 0) > 0;
    if (erzeugerOderSpeicher || steuert?.has(s.id)) out.add(s.id);
  }
  return out;
}
