/**
 * Die Navigation der zwei Portfolio-Welten (PR G) — bewusst winzig und an EINER
 * Stelle, damit beide Seiten identisch springen.
 *
 * **Warum die Adresse direkt geschrieben wird und nicht `onNavigate` läuft:**
 * die Route-Modelle der Schale (`nav.ts Route`) tragen keine Parameter, der
 * Zeitraum reist aber genau darin (`?z=…&at=…`). Ein Hash-Schreiben löst
 * `hashchange` aus, worauf die Schale ihre Route ohnehin neu liest — dasselbe
 * Muster, mit dem die Anlagen-Welten ihren Tagesdrilldown schreiben.
 */
import type { HistoryRange } from '../api';
import { historieHash, type WeltId } from '../historieWelten';
import {
  PORTFOLIO_WELTEN,
  PORTFOLIO_WELT_ORDER,
  portfolioHash,
  type PortfolioWeltId,
} from '../portfolioHistorie';
import type { PortfolioSwitchCard } from '../components/PortfolioWelt';

/**
 * Das Kartenpaar des Welt-Wechslers: es zeigt die verfügbaren Welten UND die
 * gerade offene (eine per Lesezeichen geöffnete Erlöse-Welt ohne Geld-Modus ist
 * damit nie eine Sackgasse). Bleibt nur eine Welt übrig, gibt es nichts zu
 * wechseln — dann rendert der Kopf gar kein Paar (die `weltSwitchCards`-Regel).
 */
export function portfolioSwitchCards(
  active: PortfolioWeltId,
  geldWelt: boolean,
): PortfolioSwitchCard[] {
  const ids = PORTFOLIO_WELT_ORDER.filter(
    (id) => id === active || id === 'messwerte' || geldWelt,
  );
  if (ids.length < 2) return [];
  return ids.map((id) => ({ welt: PORTFOLIO_WELTEN[id], active: id === active }));
}

function gehe(hash: string): void {
  window.location.hash = hash;
  // Ein Seitenwechsel ist Navigation, keine Scroll-Fortsetzung (wie `navigate`).
  window.scrollTo({ top: 0 });
}

/** In die andere Portfolio-Welt wechseln — der Zeitraum reist mit. */
export function oeffnePortfolioWelt(
  welt: PortfolioWeltId,
  range: HistoryRange,
  at?: string | null,
): void {
  gehe(portfolioHash(welt, range, at));
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
