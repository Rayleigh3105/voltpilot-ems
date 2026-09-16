/** Reiner Zwilling von uems/RollenZuordnungRegeln; noch kein Laufzeit-Aufrufer (H-1). */
export const ROLLEN = { pv: 'PV-Produktion', consumer: 'Verbrauch', grid: 'Netz', keine: 'keine Rolle' } as const;
export const GRUENDE = ['kein_wert', 'veraltet', 'kein_geraet', 'archiviert', 'unvollstaendig'] as const;
export const PROTOKOLL = ['rolle_gesetzt', 'rolle_entzogen'] as const;
export const FRISCHE_SEKUNDEN = 300;
export interface Quelle { entity_id: string | null; point_key: string | null; quell_messstelle_id: string | null }
export interface Stand { wert: number | null; stand: string | null; grund: string | null }
export interface Zuordnung { anlage: string; rolle: string; geraet: string; quelle: Quelle; enthaelt: Quelle[]; zustand: Stand }

export interface RolleUrteil { erlaubt: boolean; zuordnen: boolean; wort: string | null; gesetz: string | null }
export interface NetzUrteil { erlaubt: boolean; code: string | null; status: number | null }
export interface Ergebnis {
  zuordnung_vorhanden: boolean; wert: number | null; unvollstaendig: boolean; stand: string | null;
  beitragend: number; gesamt: number; gezaehlt: Quelle[]; fehler: string | null;
}

export function rolle(r: string | null): RolleUrteil {
  const erlaubt = r !== null && Object.prototype.hasOwnProperty.call(ROLLEN, r);
  return { erlaubt, zuordnen: erlaubt && r !== 'keine', wort: erlaubt ? ROLLEN[r as keyof typeof ROLLEN] : null,
    gesetz: !erlaubt ? null : r === 'keine' ? 'keine' : r === 'grid' ? 'einzelwert' : 'summe' };
}
const gefuellt = (s: string | null): boolean => s !== null && s.trim().length > 0;
export function wertGueltig(q: Quelle): boolean {
  return (gefuellt(q.entity_id) && gefuellt(q.point_key) && q.quell_messstelle_id === null)
    || (q.entity_id === null && q.point_key === null && gefuellt(q.quell_messstelle_id));
}
const gleich = (a: Quelle | null, b: Quelle | null): boolean => a === null || b === null ? a === b
  : a.entity_id === b.entity_id && a.point_key === b.point_key && a.quell_messstelle_id === b.quell_messstelle_id;
const enthaelt = (z: Zuordnung, q: Quelle): boolean => z.enthaelt.some((x) => gleich(x, q));

/** Gründe der Quellenauflösung haben Vorrang; Frische wird für JEDE Quelle gleich geprüft. */
export function frische(jetzt: string, s: Stand): Stand {
  if (s.grund !== null) {
    if (!(GRUENDE as readonly string[]).includes(s.grund)) throw new Error('eingang_ungueltig');
    return { ...s, wert: null };
  }
  if (s.wert === null || !Number.isFinite(s.wert) || s.stand === null) return { ...s, wert: null, grund: 'kein_wert' };
  const alter = Date.parse(jetzt) - Date.parse(s.stand);
  if (!Number.isFinite(alter) || alter < 0) return { ...s, wert: null, grund: 'kein_wert' };
  return alter > FRISCHE_SEKUNDEN * 1000 ? { ...s, wert: null, grund: 'veraltet' } : { ...s };
}

/** Vollständig aufgelöste Herkunft, vor dem Wertlesen: kein Rückfall auf ein Blatt bei stummer Summe. */
function auswahl(anlage: string, r: string, zuordnungen: Zuordnung[]): { alle: Zuordnung[]; gezaehlt: Zuordnung[] } {
  if (!rolle(r).zuordnen) throw new Error('eingang_ungueltig');
  const alle = zuordnungen.filter((z) => z.anlage === anlage && z.rolle === r);
  const eindeutig: Zuordnung[] = [];
  for (const z of alle) {
    if (!wertGueltig(z.quelle) || z.enthaelt.some((q) => !wertGueltig(q)) || enthaelt(z, z.quelle)
      || (z.quelle.quell_messstelle_id === null && z.enthaelt.length > 0)) throw new Error('eingang_ungueltig');
    const schon = eindeutig.find((x) => gleich(x.quelle, z.quelle));
    if (!schon) eindeutig.push(z);
    else if (schon.zustand.wert !== z.zustand.wert || schon.zustand.stand !== z.zustand.stand
      || schon.zustand.grund !== z.zustand.grund || !schon.enthaelt.every((q) => enthaelt(z, q))
      || !z.enthaelt.every((q) => enthaelt(schon, q))) throw new Error('eingang_ungueltig');
  }
  // Die äußere Summe vertritt ihre inneren Summen und Blattkanäle, unabhängig von Listen-Reihenfolge.
  const gezaehlt = eindeutig.filter((z) => !eindeutig.some((x) => x !== z && enthaelt(x, z.quelle)));
  if (alle.length > 0 && gezaehlt.length === 0) throw new Error('eingang_ungueltig');
  for (let i = 0; i < gezaehlt.length; i++) {
    for (const b of gezaehlt.slice(i + 1)) {
      if (r !== 'grid' && gezaehlt[i].enthaelt.some((q) => enthaelt(b, q))) throw new Error('ueberlappende_summenwerte');
    }
  }
  return { alle, gezaehlt };
}
export function netz(anlage: string, z: Zuordnung[]): NetzUrteil {
  const erlaubt = auswahl(anlage, 'grid', z).gezaehlt.length <= 1;
  return { erlaubt, code: erlaubt ? null : 'netz_mehrfach', status: erlaubt ? null : 409 };
}
export function zaehlung(anlage: string, r: string, jetzt: string, z: Zuordnung[]): Ergebnis {
  const { alle, gezaehlt } = auswahl(anlage, r, z);
  const gesamt = new Set(alle.map((x) => x.geraet)).size;
  if (r === 'grid' && gezaehlt.length > 1) return { zuordnung_vorhanden: true, wert: null, unvollstaendig: true,
    stand: null, beitragend: 0, gesamt, gezaehlt: [], fehler: 'netz_mehrfach' };
  const liefernde = gezaehlt.map((x) => ({ quelle: x, zustand: frische(jetzt, x.zustand) }))
    .filter((x) => x.zustand.wert !== null);
  const beitragend = new Set(alle.filter((x) => liefernde.some((l) => gleich(l.quelle.quelle, x.quelle)
    || enthaelt(l.quelle, x.quelle))).map((x) => x.geraet)).size;
  let stand: string | null = null;
  for (const l of liefernde) if (stand === null || Date.parse(l.zustand.stand!) > Date.parse(stand)) stand = l.zustand.stand;
  return { zuordnung_vorhanden: alle.length > 0,
    wert: liefernde.length === 0 ? null : liefernde.reduce((s, x) => s + x.zustand.wert!, 0),
    unvollstaendig: beitragend < gesamt, stand, beitragend, gesamt, gezaehlt: gezaehlt.map((x) => x.quelle), fehler: null };
}
/** Ein Ersetzen hält alt/neu an EINEM rolle_gesetzt fest; ein idempotentes Schreiben erzeugt nichts. */
export function aenderung(alt: Quelle | null, neu: Quelle | null): string[] {
  if ((alt !== null && !wertGueltig(alt)) || (neu !== null && !wertGueltig(neu))) throw new Error('eingang_ungueltig');
  return gleich(alt, neu) ? [] : [neu === null ? 'rolle_entzogen' : 'rolle_gesetzt'];
}
