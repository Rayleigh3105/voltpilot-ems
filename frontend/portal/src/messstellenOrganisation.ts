import { useEffect, useSyncExternalStore } from 'react';
import { api, type Kostenstelle, type Prozess } from './api';
import { reiterDa, type MessstellenReiter } from './kostenstellenUebersicht';

/**
 * Die Kataloge hinter den Reitern der Welt Messstellen (AP-13 IP-9): Kostenstellen und Prozesse. Seit N5 (Konzept
 * „Navigation aus einem Guss“) stehen „Kostenstellen“ und „Prozesse“ in derselben Reihe wie „Messstellen“ und
 * „Bezugsgrößen“ — die Reihe der Gruppe „Messen“ braucht also dieselben Kataloge wie die Seite. Beide lesen sie hier,
 * damit sie nie Verschiedenes behaupten und die Kataloge nur einmal geladen werden.
 *
 * Ein Katalog, der nicht antwortet, bringt keinen Reiter — das Register bleibt, wie es war.
 */
export type Organisation = { kostenstellen: Kostenstelle[]; prozesse: Prozess[] };

let stand: Organisation | null = null;
let laeuft: Promise<void> | null = null;
const hoerer = new Set<() => void>();

function melden() {
  for (const h of hoerer) h();
}

/** Lädt beide Kataloge; `neu` fragt erneut (die Seite beim Öffnen), sonst gilt, was schon da ist oder unterwegs. */
export function organisationLaden(neu = false): Promise<void> {
  if (laeuft && !neu) return laeuft;
  laeuft = Promise.all([
    api.kostenstellen().then(
      (k) => k.kostenstellen,
      () => [] as Kostenstelle[],
    ),
    api.prozesse().then(
      (p) => p.prozesse,
      () => [] as Prozess[],
    ),
  ]).then(([kostenstellen, prozesse]) => {
    stand = { kostenstellen, prozesse };
    melden();
  });
  return laeuft;
}

function abonnieren(h: () => void) {
  hoerer.add(h);
  return () => {
    hoerer.delete(h);
  };
}

const lesen = () => stand;

/** Die Kataloge, sobald geladen (`null` = unterwegs); `an` = false fragt nichts und liefert `null`. */
export function useOrganisation(an: boolean, neu = false): Organisation | null {
  const wert = useSyncExternalStore(abonnieren, lesen, lesen);
  useEffect(() => {
    if (an) void organisationLaden(neu);
    // `neu` gilt für das Öffnen der Seite, nicht für jeden Wechsel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [an]);
  return an ? wert : null;
}

/** Die Reiter, die es mit diesen Katalogen gibt (`reiterDa`); `null` = noch unbekannt. */
export const organisationReiter = (o: Organisation | null): MessstellenReiter[] | null =>
  o ? reiterDa(o.kostenstellen.length, o.prozesse.length) : null;

/**
 * Die offene Fläche Messstellen: ihr Reiter und ihre Wahl. Die Reihe von „Messen“ zeigt diesen Reiter und wählt über
 * die Fläche — wie früher deren eigene Reihe: mit dem Zeitraum der Fläche, die Adresse ersetzt statt gestapelt.
 */
export type MessstellenFlaeche = { offen: MessstellenReiter; waehlen: (r: MessstellenReiter) => void };

let flaeche: MessstellenFlaeche | null = null;
const flaecheLesen = () => flaeche;

/** Die Fläche meldet sich an; die Abmeldung gilt nur, solange noch ihre eigene Meldung steht. */
export function flaecheMelden(f: MessstellenFlaeche): () => void {
  flaeche = f;
  melden();
  return () => {
    if (flaeche !== f) return;
    flaeche = null;
    melden();
  };
}

/** Die offene Fläche Messstellen (`null` = keine). */
export function useMessstellenFlaeche(): MessstellenFlaeche | null {
  return useSyncExternalStore(abonnieren, flaecheLesen, flaecheLesen);
}

/** Nur für Tests: vergisst den geladenen Stand und die Fläche. */
export function organisationVergessen() {
  stand = null;
  laeuft = null;
  flaeche = null;
  melden();
}
