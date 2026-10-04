/**
 * WAS DIE STEUERUNG FRAGT: Geräte, die in der Anlage angelegt und verbunden
 * sind, aber noch keinen Auftrag haben (Konzept „Anlage verbindet, Steuerung
 * entscheidet").
 *
 * Die Steuerung legt NICHTS an. Ein Gerät kommt aus der Anlage und steht dann
 * hier auf eine von drei Arten:
 *  - **neu**: noch kein Auftrag (Server: Herkunft `ohne`) → Karte mit Vorschlag,
 *  - **nur messen**: der Kunde hat „Nicht steuern, nur messen“ gewählt - gemerkt
 *    als Haltung `nur_messen` ohne Frist (`suggestion-states`), bis er sie mit
 *    „Steuern“ zurücknimmt,
 *  - **noch nicht steuerbar**: der Server sagt `schreibbar: false` und nennt den
 *    Grund; der Weg dorthin, wo er sich lösen lässt, ist die Anlage.
 *
 * An einer Anlage, die nicht an „Steuern & Optimieren“ teilnimmt, fragt die
 * Steuerung nicht (Steuern-Regel #779): was sonst **neu** wäre, steht dort
 * **still** - ohne Vorschlag, mit dem Weg zur Steuerart (`seite.ts`).
 *
 * Rein und getestet (`neu.test.ts`).
 */
import { liste } from './liste';
import type { SuggestionStates } from '../api';
import { entwurfAus, fehlt, wunschAus, type SteuerartEntwurf, type SteuerartWunsch } from '../steuerartDialog';
import type { GeraetBild } from './bild';

/** Der Schlüssel, unter dem „nur messen“ gemerkt wird. */
export const nurMessenKey = (id: string) => `steuerung-nur-messen:${id}`;

export interface Einordnung {
  neu: GeraetBild[];
  nurMessen: GeraetBild[];
  nichtSteuerbar: GeraetBild[];
  /** Ohne Auftrag an einer Anlage ohne Teilnahme: kein Vorschlag. */
  still: GeraetBild[];
}

export function einordnen(alle: GeraetBild[], vorschlaege: SuggestionStates | null | undefined, nowMs: number): Einordnung {
  const stumm = new Set(
    liste(vorschlaege?.states)
      .filter((s) => s.state === 'nur_messen' || (s.mutedUntil != null && Date.parse(s.mutedUntil) > nowMs))
      .map((s) => s.key),
  );
  const out: Einordnung = { neu: [], nurMessen: [], nichtSteuerbar: [], still: [] };
  for (const g of alle) {
    if (!g.ohneAuftrag) continue;
    if (!g.schreibbar) out.nichtSteuerbar.push(g);
    else if (stumm.has(nurMessenKey(g.id))) out.nurMessen.push(g);
    else out.neu.push(g);
  }
  return out;
}

/** Welche Quelle ein Gerät dieses Typs zuerst vorgeschlagen bekommt. */
const VORZUG: Record<string, string[]> = {
  'heat-pump-sgready': ['freigabe_ueberschuss', 'freigabe_guenstig'],
  pump: ['feste_zeiten', 'ueberschuss', 'guenstig'],
};
const STANDARD_VORZUG = ['ueberschuss', 'guenstig', 'feste_zeiten', 'sofort'];

/**
 * Der Vorschlag für ein neues Gerät: die erste freie Quelle in der Vorzugsliste
 * seines Typs, die sich allein mit den Vorgaben des SERVERS vollständig
 * belegen lässt (nie mit einer erfundenen Zahl). `null`, wenn keine das kann -
 * dann gibt es nur „Anders einstellen“.
 */
export function vorschlag(g: GeraetBild): { entwurf: SteuerartEntwurf; wunsch: SteuerartWunsch } | null {
  const optionen = g.eintrag.optionen;
  const frei = liste(optionen?.quellen).filter((q) => !q.gesperrt).map((q) => q.id);
  if (!frei.length) return null;
  const vorzug = VORZUG[g.typ] ?? STANDARD_VORZUG;
  const reihe = [...vorzug.filter((q) => frei.includes(q)), ...frei.filter((q) => !vorzug.includes(q))];
  const basis = entwurfAus({ ...g.eintrag, steuerart: { quelle: '', herkunft: 'ohne' } });
  for (const quelle of reihe) {
    const entwurf: SteuerartEntwurf = { ...basis, quelle, ziel: '' };
    if (fehlt(entwurf, optionen) == null) return { entwurf, wunsch: wunschAus(entwurf, g.eintrag.ladepunkt) };
  }
  return null;
}
