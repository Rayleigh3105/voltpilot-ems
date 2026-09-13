/**
 * Die ARTEN einer Bezugsgröße als eigenes, reines Modul (UEMS AP-09 §4.2) —
 * der TS-Zwilling von `services/api .../uems/BezugsArt`.
 *
 * Der Vertrag und die Wahrheit stehen in
 * `docs/contracts/v2/bezugsdaten-vectors.json` (Block `arten`). Wer eine Regel
 * ändert, ändert die Datei UND beide Zwillinge.
 *
 * Eine Art spricht nur vorhandene Wörter: welche Einheiten, welche Wertart,
 * welche Perioden, welche Geltungsbereiche und welche Herkünfte möglich sind,
 * steht in den Wörtern der vorhandenen Vokabulare. Die Einheiten fragt dieses
 * Modul darum bei `bezugsEinheit.ts` an, statt sie zu kopieren; ein Wort, das
 * kein Vokabular führt, wird nie wählbar (Invariante 6).
 *
 * Keine zweite Liste: weder die Arten noch ihre Wörter stehen in dieser Datei —
 * sie kommen herein, im Test aus der Vektor-Datei.
 *
 * Die Art schränkt ein, sie rechnet nicht um: eine Einheit derselben Größe, die
 * die Art nicht führt, passt nicht. Umgerechnet wird ein gelieferter Wert nur
 * über `einheit` aus `bezugsEinheit.ts`.
 *
 * REIN: kein Netz, kein Zustand, keine Uhr. Noch ruft keine Fläche das Modul an.
 */

import { groesseVon } from './bezugsEinheit';

/** `einheiten`/`geltung`: jedes Wort des Vokabulars („jede Einheit des Vokabulars", „jedes Objekt"). */
export const ALLE = 'alle';

/** `einheiten`: die Einheit der Messstelle, an der die Größe hängt („Einheit der Messstelle (m³ …)"). */
export const EINHEIT_DER_MESSSTELLE = 'messstelle';

/** Die Felder, die `pruefen` als nicht passend nennen kann — in dieser Reihenfolge. */
export const FELDER = ['art', 'wertart', 'geltung_art', 'einheit', 'periode_art', 'herkunft_art'] as const;

export type ArtFeld = (typeof FELDER)[number];

/** Eine Art, wie sie im Block `arten.je_art` steht. */
export type Art = {
  name: string;
  einheiten: string[] | typeof ALLE | typeof EINHEIT_DER_MESSSTELLE;
  wertart: string;
  perioden: string[];
  geltung: string[] | typeof ALLE;
  herkunft: string[];
};

/** Die vorhandenen Vokabulare, wie die Datei sie führt (`vokabulare` + `einheiten`). */
export type Vokabular = {
  wertart: string[];
  geltung_art: string[];
  periode_art: string[];
  herkunft_art: string[];
  einheiten: Record<string, string[]>;
};

/** Die Angaben einer Bezugsgröße, gegen die ihre Art geprüft wird. `herkunft_art` null = nicht geprüft. */
export type ArtEingang = {
  wertart: string | null;
  geltung_art: string | null;
  einheit: string | null;
  periode_art: string | null;
  herkunft_art: string | null;
  einheit_der_messstelle: string | null;
};

const imVokabular = (woerter: string[], vokabular: string[]): string[] =>
  woerter.filter((w) => vokabular.includes(w));

/**
 * Die wählbaren Einheiten einer Art, jede ein Wort des Einheiten-Vokabulars.
 * Eine Liste bleibt in ihrer Reihenfolge; `alle` ist das ganze Vokabular in
 * seiner Reihenfolge; `messstelle` ist genau die Einheit der Messstelle — ohne
 * Messstelle oder mit einer Einheit, die das Vokabular nicht führt, keine.
 */
export const einheitenDer = (
  art: Art,
  einheiten: Record<string, string[]>,
  einheitDerMessstelle: string | null,
): string[] => {
  const kandidaten =
    art.einheiten === ALLE
      ? Object.values(einheiten).flat()
      : art.einheiten === EINHEIT_DER_MESSSTELLE
        ? einheitDerMessstelle === null
          ? []
          : [einheitDerMessstelle]
        : art.einheiten;
  return kandidaten.filter((e) => groesseVon(e, einheiten) !== null);
};

/** Die wählbaren Geltungsbereich-Arten einer Art; `alle` ist das ganze Vokabular. */
export const geltungDer = (art: Art, geltungArten: string[]): string[] =>
  art.geltung === ALLE ? [...geltungArten] : imVokabular(art.geltung, geltungArten);

/** Die wählbaren Perioden einer Art; leer heißt: keine Periode (jede Wertart außer Periodenwert). */
export const periodenDer = (art: Art, periodeArten: string[]): string[] => imVokabular(art.perioden, periodeArten);

/** Die möglichen Herkünfte der Werte einer Art. */
export const herkunftDer = (art: Art, herkunftArten: string[]): string[] => imVokabular(art.herkunft, herkunftArten);

/**
 * Passt eine Bezugsgröße zu ihrer Art? Die Antwort nennt ALLE Felder, die nicht
 * passen, in der Reihenfolge `FELDER`; leer heißt: passt. Eine Art, die das
 * Vokabular der Arten nicht führt, ist nur `art`.
 */
export const pruefen = (
  artWort: string,
  e: ArtEingang,
  arten: Record<string, Art>,
  v: Vokabular,
): ArtFeld[] => {
  const art = Object.prototype.hasOwnProperty.call(arten, artWort) ? arten[artWort] : undefined;
  if (!art) return ['art'];
  const abweichend: ArtFeld[] = [];
  if (art.wertart !== e.wertart || !v.wertart.includes(art.wertart)) abweichend.push('wertart');
  if (e.geltung_art === null || !geltungDer(art, v.geltung_art).includes(e.geltung_art)) {
    abweichend.push('geltung_art');
  }
  if (e.einheit === null || !einheitenDer(art, v.einheiten, e.einheit_der_messstelle).includes(e.einheit)) {
    abweichend.push('einheit');
  }
  const passtPeriode =
    art.perioden.length === 0
      ? e.periode_art === null
      : e.periode_art !== null && periodenDer(art, v.periode_art).includes(e.periode_art);
  if (!passtPeriode) abweichend.push('periode_art');
  if (e.herkunft_art !== null && !herkunftDer(art, v.herkunft_art).includes(e.herkunft_art)) {
    abweichend.push('herkunft_art');
  }
  return abweichend;
};
