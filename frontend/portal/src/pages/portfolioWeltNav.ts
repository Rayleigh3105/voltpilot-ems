/** Navigation aus einer Portfolio-Zeile in dieselbe Welt einer Anlage. */
import type { HistoryRange } from '../api';
import { historieHash, type WeltId } from '../historieWelten';

function gehe(hash: string): void {
  window.location.hash = hash;
  // Ein Seitenwechsel ist Navigation, keine Scroll-Fortsetzung (wie `navigate`).
  window.scrollTo({ top: 0 });
}

/** Aus einer Tabellenzeile in DIESELBE Welt DIESER Anlage — gleicher Zeitraum. */
export function oeffneAnlagenWelt(
  siteId: string,
  welt: WeltId,
  range: HistoryRange,
  at?: string | null,
): void {
  gehe(historieHash(siteId, welt, range, at));
}
