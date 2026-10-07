import { api, type Bezugsgroesse } from './api';
import * as B from './bezugsgroesseListe';
import { heuteIn } from './kennzahlKarte';
import { VORGABE_ZEITZONE } from './uemsOrtsbaum';

/**
 * Was die Liste der Bezugsgrößen und die Seite einer Bezugsgröße lesen (Konzept Messen m1 §6.8): die Liste, die Orte
 * (für Rechte, Zone und den Weg zu den Gebäuden) und der heutige Tag in der Zone des Unternehmens.
 */
/** Alles, was Liste und Seite lesen: die Liste, die Orte (Rechte, Gebäude-Weg), die Werte je Bezugsgröße. */
export interface BezugsStand {
  liste: B.Liste;
  daten: B.OrtsDaten;
  orte: B.Ort[];
  heute: string;
  zone: string;
}

export async function bezugsLaden(): Promise<BezugsStand> {
  const [liste, unternehmen, standorte, prozesse, kostenstellen, register] = await Promise.all([
    api.bezugsgroessen(), api.unternehmen(), api.standorte(), api.prozesse(), api.kostenstellen(), api.messstellenRegister(),
  ]);
  const baeume = await Promise.all(standorte.standorte.map((s) => api.standortOrte(s.id)));
  const daten = { unternehmen, standorte: standorte.standorte, baeume, prozesse: prozesse.prozesse, kostenstellen: kostenstellen.kostenstellen, messstellen: register.register };
  const zone = unternehmen?.zeitzone ?? VORGABE_ZEITZONE;
  const heute = heuteIn(zone, Date.now());
  return { liste, daten, orte: B.geltungsOrte(daten, heute), heute, zone };
}

/** Der Standort einer Bezugsgröße (für das Recht und die Zone): `null` = Unternehmen, `undefined` = unbekannt. */
export function standortDer(b: Bezugsgroesse, orte: B.Ort[]): string | null | undefined {
  if (b.geltung_art === 'standort') return b.geltung_id;
  if (b.geltung_art === 'unternehmen' || b.geltung_art === 'prozess' || b.geltung_art === 'kostenstelle') return null;
  return orte.find((o) => o.key === B.ortKey(b.geltung_art, b.geltung_id))?.standort;
}

/** Die Zone einer Bezugsgröße: die ihres Standorts, sonst die des Unternehmens. */
export const zoneDer = (b: Bezugsgroesse, s: BezugsStand): string =>
  s.daten.standorte.find((x) => x.id === standortDer(b, s.orte))?.zeitzone ?? s.zone;

