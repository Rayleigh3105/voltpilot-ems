import type { StandortAmStichtag, StandorteAmStichtag } from './api';
import { archiviertText, standortListe } from './standorte';
import { bestandSatz, datumText, type Tag } from './uemsOrtsbaum';

/**
 * „Stand am …“ (UEMS AP-02 IP-13, §4.4, Mockup H1, Abnahme A12): die Standorte
 * und der Ortsbaum so, wie sie an einem Tag galten. Das Portal rechnet nichts
 * nach — die Ableitung ist das Lesemodell (`?stichtag=` aus IP-3/IP-5, gleich
 * `standAm` im Vertrag `ortsbaum-vectors.json`); hier steht nur, WAS die Fläche
 * daraus zeigt und welche Sätze sie spricht.
 *
 * Ein Stichtag ist gesetzt, sobald er nicht heute ist — auch ein Tag in der
 * Zukunft (ein eingetragener Umzug ab 01.03.2027 ist dann schon zu sehen).
 * Solange er gesetzt ist, bietet keine Fläche einen Schreibweg an.
 */

export const STAND_AM = 'Stand am';
export const ZURUECK_ZU_HEUTE = 'Zurück zu heute';
export const KEINE_AENDERUNG = 'Änderungen sind hier nicht möglich.';

/** „Sie sehen den Stand am 15.02.2027“ — der erste Teil des Banners (§4.4). */
export function bannerTitel(stichtag: Tag): string {
  return `Sie sehen den Stand am ${datumText(stichtag)}`;
}

/**
 * Der Stichtag, den die Fläche anfragt: `null` = heute (die Sicht mit
 * Schreibwegen). Die Wahl von heute im Datumsfeld ist KEIN Stichtag — sonst
 * stünde das Banner über dem heutigen Stand und jeder Knopf wäre weg.
 */
export function stichtagAus(wahl: Tag, heute: Tag): Tag | null {
  return wahl === heute ? null : wahl;
}

/** Eine Karte der Liste „Standorte“ am Stichtag. */
export type StandAmEintrag =
  | { art: 'standort'; standort: StandortAmStichtag }
  /** Gab es am Stichtag noch nicht: benannt mit dem Satz des Servers (§5.9), nie weggelassen. */
  | { art: 'gab_es_noch_nicht'; standort: StandortAmStichtag; satz: string };

export interface StandAmListe {
  /** In der Reihenfolge der Kurzzeichen — eine Karte springt nicht, wenn der Tag wechselt. */
  eintraege: StandAmEintrag[];
  /** Archiviert, mit Satz: heute „Archiviert am 30.06.2027“, am Stichtag der des Servers („Am … war … archiviert.“). */
  archiviert: { standort: StandortAmStichtag; satz: string }[];
  /** Die Gruppe „Noch nicht zugeordnet“ — nur heute und nur, solange sie etwas enthält (A15). */
  nochNichtZugeordnet: { id: string; name: string }[] | null;
}

function nachKurzzeichen(a: { standort: StandortAmStichtag }, b: { standort: StandortAmStichtag }): number {
  return a.standort.kurzzeichen.localeCompare(b.standort.kurzzeichen, 'de-DE', { numeric: true });
}

/**
 * Die Liste „Standorte“ — heute (`stichtag` = `null`) wie seit IP-6, zu einem
 * gesetzten Stichtag mit den Standorten dieses Tages. Die Gruppe „Noch nicht
 * zugeordnet“ gehört dann NICHT dazu: sie ist die Arbeitsliste von heute, und das
 * Lesemodell nennt darin jede Anlage, die es HEUTE gibt — ohne zu fragen, ob es
 * sie am Stichtag schon gab.
 */
export function standAmListe(antwort: StandorteAmStichtag, stichtag: Tag | null): StandAmListe {
  if (!stichtag) {
    const heute = standortListe(antwort);
    return {
      eintraege: heute.standorte.map((standort) => ({ art: 'standort', standort })),
      archiviert: heute.archiviert.map((standort) => ({ standort, satz: archiviertText(standort) })),
      nochNichtZugeordnet: heute.nochNichtZugeordnet,
    };
  }
  const eintraege: StandAmEintrag[] = antwort.standorte.map((standort) => ({ art: 'standort', standort }));
  const archiviert: StandAmListe['archiviert'] = [];
  for (const s of antwort.nichtGezeigt) {
    // Der Satz ist der des Servers; fehlt er (älteres Backend), spricht ihn der Vertrags-Zwilling.
    if (s.bestand === 'gab_es_noch_nicht') {
      const satz = s.bestandText ?? bestandSatz('gab_es_noch_nicht', s.name, stichtag);
      eintraege.push({ art: 'gab_es_noch_nicht', standort: s, satz });
    } else {
      archiviert.push({ standort: s, satz: s.bestandText ?? bestandSatz('archiviert', s.name, stichtag) });
    }
  }
  return {
    eintraege: eintraege.sort(nachKurzzeichen),
    archiviert: archiviert.sort(nachKurzzeichen),
    nochNichtZugeordnet: null,
  };
}
