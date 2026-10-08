import type { Bericht, BerichtDetail, Selbstauskunft } from './api';
import { revisionBanner, type RevisionBanner } from './berichtDialoge';
import { BEWERTUNG_VORLAGE } from './bewertungFrist';
import { UEMS_BEWERTUNG_SAETZE, UEMS_ENTWURF } from './glossar';

/**
 * UEMS AP-16 IP-25 (§5.5, S1/S4/S5, R7/R10/R15): der Bewertungsstand auf der Seite „Bewertung“ — rein.
 *
 * Die Bewertung ist ein Bericht der Vorlage `energetische_bewertung` (E5 = A); Stände, Anstöße, Entwurf und Frist kommen
 * fertig aus den Bericht-Routen (`GET /api/v1/berichte`, `…/{kennung}`, `…/entwurf`). Hier wird nur gewählt und in Sätze
 * gesetzt — nichts gerechnet, nichts geprüft, was die Route nicht schon gesagt hat. Statuszeile, Datumsblöcke und
 * Entwurf in Worten (Konzept Auswerten a1 §6.7) stehen in `bewertungErgebnis.ts`. Das Recht aller Handlungen an dieser
 * Vorlage ist `bewertung.abrufen` (`BerichtRechte.kennung` mit Vorlage, Rechte-Matrix AP-16 §6.1).
 */

export const BEWERTUNG_RECHT = 'bewertung.abrufen';

export const STAND_TITEL = 'Bewertungsstand';
export const ANLEGEN_KNOPF = 'Bewertung anlegen';
export const ENTWURF_LADEFEHLER = `Der ${UEMS_ENTWURF} konnte nicht geladen werden.`;
export const LADEFEHLER = 'Der Bewertungsstand konnte nicht geladen werden.';
export const DATEI_FEHLER = 'Die Datei konnte nicht abgerufen werden.';

/** Darf die Person die Bewertung sehen, anlegen, freigeben und abrufen? Nur aus `/me` (`unternehmen_rechte`). */
export const darfBewertung = (s: Pick<Selbstauskunft, 'unternehmen_rechte'> | null | undefined): boolean =>
  !!s && s.unternehmen_rechte.includes(BEWERTUNG_RECHT);

/**
 * Die Bewertung der Seite: nicht archiviert; zuerst die gültige (mit Frist, nicht abgelöst), sonst die jüngst angelegte.
 * Ohne sie `null` — Bestandskunden merken nichts (R11).
 */
export const bewertungWaehlen = (berichte: readonly Bericht[] | null): Bericht | null => {
  const offen = (berichte ?? []).filter((b) => b.vorlage === BEWERTUNG_VORLAGE && b.archiviert_am === null);
  const gueltig = offen.find((b) => b.ueberpruefung != null && b.ueberpruefung.abgeloest_durch == null);
  if (gueltig) return gueltig;
  return [...offen].sort((a, b) => b.angelegt_am.localeCompare(a.angelegt_am))[0] ?? null;
};


/** Das Jahr der Bewertung (§5.7 „Bewertung 2026“): das Jahr des letzten Monats ihrer Datengrundlage. */
export const bewertungJahr = (b: Pick<Bericht, 'zeitraum'>): number => Number(b.zeitraum.split('/').pop()!.slice(0, 4));

/** Der Revision-Vermerk (§5.5 Schritt 3, R7): „Revision nötig — <Anlass>“, nur für offene Anstöße am gültigen Stand. */
export const revisionVermerk = (detail: BerichtDetail): RevisionBanner | null => revisionBanner(detail);

/**
 * R15 — nach einer Kriterien-Änderung, wenn es einen freigegebenen Bewertungsstand gibt: „Bewertungsstand Nr. 2 bekommt
 * einen Anstoß — …“. Die Naht (Pfad 2) setzt ihn, der Satz sagt nur, was kommt; ohne Stand `null`.
 */
export const kriterienAnstoss = (berichte: readonly Bericht[] | null): string | null => {
  const b = bewertungWaehlen(berichte);
  return b && b.neueste_nr !== null ? UEMS_BEWERTUNG_SAETZE.kriterienAnstoss(b.neueste_nr) : null;
};
