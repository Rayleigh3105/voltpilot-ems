import type { BerichteBetroffen, BerichtStandRef } from './api';
import { UEMS_BERICHTE, UEMS_REVISION } from './glossar';

/**
 * UEMS AP-12 IP-9 — die Zeile „Freigegebene Berichte: …“ in den Folgen einer Strukturänderung, rein.
 *
 * Geurteilt wird NICHT hier: `GET /api/v1/berichte/betroffen` nennt je Objekt, Tag und Anlass die
 * freigegebenen Berichtsstände — `betroffen` (gültige Stände, die mit Wirkung ab dem Tag einen
 * Revisions-Anstoß bekämen) und `zitieren` (alle Stände, auch ersetzte, die eine Quelle des Objekts
 * überhaupt zitieren). Dieses Modul setzt die Antwort in Kundensätze; die Dialoge „Fläche ändern“,
 * „Anlage zuordnen“ und „… archivieren?“ rendern sie (`useBerichteFolgen.ts` fragt).
 *
 * - Ändern ab einem Tag: „keine betroffen“ oder „BR-2026-0001 Nr. 2 bekommt den Vermerk „Revision nötig““.
 * - Archivieren: wie viele Stände Messstellen des Orts zitieren — sie bleiben unverändert.
 * - Ohne einen Bericht, den die Person lesen darf (`berichte_vorhanden = false`), gibt es die Zeile
 *   nicht: wer keine Berichte hat, liest das Wort nie.
 */

/** „Freigegebene Berichte“ — der Titel der Zeile. */
export const BERICHTE_FOLGEN_TITEL = `Freigegebene ${UEMS_BERICHTE}`;
export const BERICHTE_KEINE_BETROFFEN = 'keine betroffen';

/** Wofür die Zeile spricht: eine Änderung ab einem Tag — oder das Archivieren eines Standorts bzw. Gebäudes/Bereichs. */
export type BerichteFolgenArt = 'aendern' | 'archivieren_standort' | 'archivieren_ort';

export interface BerichteFolgen {
  titel: string;
  /** Der Satz ohne Schlusspunkt, z. B. „keine betroffen“. */
  text: string;
}

/** Die Zeile zu einer Antwort — `null`, wenn es im Unternehmen keinen lesbaren Bericht gibt. */
export function berichteFolgen(antwort: BerichteBetroffen, art: BerichteFolgenArt): BerichteFolgen | null {
  if (!antwort.berichte_vorhanden) return null;
  const text =
    art === 'aendern'
      ? vermerkSatz(antwort.betroffen)
      : zitiertSatz(antwort.zitieren.length, art === 'archivieren_standort' ? 'dieses Standorts' : 'dieses Orts');
  return { titel: BERICHTE_FOLGEN_TITEL, text };
}

/** „Freigegebene Berichte: keine betroffen“ — die Zeile in einem Stück. */
export function berichteFolgenZeile(f: BerichteFolgen): string {
  return `${f.titel}: ${f.text}`;
}

/** „BR-2026-0001 Nr. 2“ */
export function standNennung(s: BerichtStandRef): string {
  return `${s.kennung} Nr. ${s.nr}`;
}

function vermerkSatz(betroffen: BerichtStandRef[]): string {
  if (betroffen.length === 0) return BERICHTE_KEINE_BETROFFEN;
  const liste = betroffen.map(standNennung).join(', ');
  const vermerk = `den Vermerk „${UEMS_REVISION} nötig“`;
  return betroffen.length === 1 ? `${liste} bekommt ${vermerk}` : `${liste} bekommen ${vermerk}`;
}

function zitiertSatz(anzahl: number, wo: string): string {
  if (anzahl === 0) return BERICHTE_KEINE_BETROFFEN;
  return anzahl === 1
    ? `1 zitiert Messstellen ${wo} — er bleibt unverändert`
    : `${anzahl} zitieren Messstellen ${wo} — sie bleiben unverändert`;
}

/** Nur ein echter Kalendertag (JJJJ-MM-TT) wird gefragt — ein halber oder unmöglicher Tag nie. */
export function istKalendertag(s: string | null | undefined): s is string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
