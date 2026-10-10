/**
 * Reiter und Adresse der Welt Messstellen (UEMS AP-13 IP-9): „Liste“ · „Kostenstellen“ · „Prozesse“.
 *
 * ⚠ EIGENES MODUL (Bündel-Wächter `test/bundle-smoke.sh`, 09.10.2026): die Reiter-Leiste (`PortfolioTabs`) und
 * die Kataloge dahinter (`messstellenOrganisation.ts`) stehen im ersten Bild und brauchen nur diese Wörter und
 * Adressen; `kostenstellenUebersicht.ts` zog dafür das ganze Kostenstellen-Bild samt `messstellenListe.ts` ins
 * Einstiegs-Bündel. `kostenstellenUebersicht.ts` reicht alles hier unverändert weiter.
 */
import type { KostenstelleEnergiePeriode } from './api';
import { hashForRoute, pageRoute } from './nav';

// ------------------------------------------------------------------------------------ Reiter und Adresse

export type MessstellenReiter = 'liste' | 'kostenstellen' | 'prozesse';

export const REITER_WORT: Readonly<Record<MessstellenReiter, string>> = {
  liste: 'Liste',
  kostenstellen: 'Kostenstellen',
  prozesse: 'Prozesse',
};

/** Der zugängliche Name der Reiter-Leiste. */
export const REITER_LABEL = 'Reiter der Messstellen';

/**
 * Die Reiter der Welt Messstellen am Unternehmen — nur mit Inhalt: ohne Kostenstelle und ohne Prozess gibt es keine
 * Leiste, und das Register bleibt zeichengleich (Bestandsschutz). „Liste“ ist das Register.
 */
export function reiterDa(kostenstellen: number, prozesse: number): MessstellenReiter[] {
  if (kostenstellen === 0 && prozesse === 0) return [];
  const out: MessstellenReiter[] = ['liste'];
  if (kostenstellen > 0) out.push('kostenstellen');
  if (prozesse > 0) out.push('prozesse');
  return out;
}

const query = (hash: string): URLSearchParams => new URLSearchParams(hash.split('?').slice(1).join('?'));

/** Der Reiter der Adresse (`#/portfolio/messstellen?reiter=kostenstellen`); ohne oder unbekannt die Liste. */
export function reiterAus(hash: string): MessstellenReiter {
  const r = query(hash).get('reiter');
  return r === 'kostenstellen' || r === 'prozesse' ? r : 'liste';
}

/** Die Kostenstelle, auf die ein Sprung zeigt (`kostenstelle=4200`) — ihre Karte wird hervorgehoben. */
export const hervorAus = (hash: string): string | null => query(hash).get('kostenstelle')?.trim() || null;

/** Die Adresse eines Reiters mit Zeitraum — ein Lesezeichen hält beides. */
export function reiterHash(reiter: MessstellenReiter, zeitraum: { periode: KostenstelleEnergiePeriode; am: string } | null): string {
  const basis = hashForRoute(pageRoute('portfolio-messstellen'));
  if (reiter === 'liste') return basis;
  const q = new URLSearchParams({ reiter });
  if (zeitraum) {
    q.set('periode', zeitraum.periode);
    q.set('am', zeitraum.am);
  }
  return `${basis}?${q.toString()}`;
}
