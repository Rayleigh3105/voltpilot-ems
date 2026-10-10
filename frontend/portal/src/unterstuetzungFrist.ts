/**
 * Die Fristen einer Unterstützung im Gewähren-Dialog: heute, Vorgabe-Ende, höchstes Ende und die Prüfung.
 *
 * ⚠ EIGENES MODUL (Bündel-Wächter `test/bundle-smoke.sh`, 09.10.2026): der Banner steht auf jeder Seite und braucht
 * aus `unterstuetzung.ts` nur seine Texte und die Liste; die Fristen zogen `bezugsPeriode.ts` ins Einstiegs-Bündel.
 * `unterstuetzung.ts` reicht sie unverändert weiter.
 */
import { iso, tagPlus } from './bezugsPeriode';
import { VORGABE_ZEITZONE } from './uemsZustand';

export const heute = () => iso(Date.now(), VORGABE_ZEITZONE).slice(0, 10);
export const vorgabeEnde = () => tagPlus(heute(), 30);
export function hoechstesEnde(ab = heute()): string {
  const [j, m, t] = ab.split('-').map(Number);
  return `${j + 1}-${String(m).padStart(2, '0')}-${String(Math.min(t, new Date(Date.UTC(j + 1, m, 0)).getUTCDate())).padStart(2, '0')}`;
}
export function pruefeUnterstuetzung(standorte: string[], bis: string, ab = heute()): string | null {
  if (!standorte.length) return 'Wählen Sie mindestens einen Standort.';
  if (!bis || bis > hoechstesEnde(ab)) return 'Wählen Sie ein Enddatum innerhalb von höchstens 12 Monaten.';
  if (bis < ab) return 'Das Enddatum darf nicht vor dem Beginn liegen.';
  return null;
}
