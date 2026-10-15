import type { StandortAusfall } from './api';

/**
 * Die einzige Wortableitung der Ausfall-Anzeige. Eine Box-Ursache wird ausschließlich gesprochen,
 * wenn die Route an genau dieser Messstelle Box UND Beginn als festgehaltenen Fakt liefert.
 */
export function messstelleAusfallSatz(
  fakt: StandortAusfall['messstellen'][number] | null | undefined,
  zeit: (iso: string) => string,
): string | null {
  if (!fakt || fakt.art !== 'gemessen' || !fakt.box || !fakt.seit) return null;
  return `Unvollständig seit ${zeit(fakt.seit)} (${fakt.box})`;
}

export function standortAusfallSatz(ausfall: StandortAusfall | null | undefined): string | null {
  if (!ausfall || ausfall.boxen_ausgefallen < 1 || ausfall.messstellen_unvollstaendig < 1) return null;
  const boxenVerb = ausfall.boxen_ausgefallen === 1 ? 'meldet sich nicht' : 'melden sich nicht';
  const messstellenWort = ausfall.messstellen_unvollstaendig === 1 ? 'Messstelle' : 'Messstellen';
  return `${ausfall.boxen_ausgefallen} von ${ausfall.boxen_gesamt} Boxen ${boxenVerb} · ${ausfall.messstellen_unvollstaendig} ${messstellenWort} unvollständig`;
}

export function anlageAusfallSatz(ausfall: StandortAusfall | null | undefined, anlageId: string): string | null {
  const boxen = ausfall?.boxen.filter((b) => b.anlagen.includes(anlageId)) ?? [];
  return boxen.length === 1 ? `${boxen[0].name} meldet sich nicht` : null;
}

export function ausfaelleJeMessstelle(ausfaelle: readonly StandortAusfall[]): ReadonlyMap<string, StandortAusfall['messstellen'][number]> {
  return new Map(ausfaelle.flatMap((a) => a.messstellen.map((m) => [m.id, m] as const)));
}
