/**
 * Die BRÜCKE zwischen den selbst gebauten Geräten und der Regel-Welt
 * (Einheitsmodell Stufe 3; Konzept `vp-modbus-baukasten-k6` §2.3 Nachtrag
 * „Die Brücke zum Automations-Baukasten").
 *
 * Zwei Absprünge, in beide Richtungen - und bewusst NUR Absprünge:
 *
 * **(a) Gerät → Regel.** Eine Selbstbau-Komponente ist das am besten geeignete
 * Gerät für eine freie Regel, weil sie je Entität lokal publiziert; ihre
 * Messwerte stehen also sofort als Bedingung zur Verfügung. Der Absprung öffnet
 * den geführten Baukasten mit genau dieser Komponente vorausgewählt (`?komponente=`,
 * `SteuerungSeite.tsx`); die Bedingung selbst wählt der Kunde im Baukasten.
 *
 * **(b) Regel → Gerät.** Findet der Kunde in der leeren Auswahl keinen
 * passenden Messwert, bietet die Fläche „Eigenes Gerät (Modbus) anlegen" an,
 * statt ihn in einer Sackgasse stehen zu lassen.
 *
 * **⚠ Der generierte Geräte-Flow bleibt dabei unsichtbar und uneditierbar.**
 * Die Brücke ist eine VORBEFÜLLUNG, keine gemeinsame Leinwand - sonst wäre sie
 * die Hintertür zu einem freien Schreib-Baustein, den es in dieser Stufe
 * ausdrücklich nicht gibt.
 */

import type { SchaltArt } from './schaltFreigabe';

/** Eine Komponente, wie die Brücke sie braucht (bewusst schmal). */
export type BrueckenKomponente = {
  entityId: string;
  label: string;
  communication?: string | null;
  /** Die Messkanäle der Komponente, in ihrer gespeicherten Reihenfolge. */
  channels?: { channel: string; label?: string | null; unit?: string | null }[];
  /**
   * Der FREIGEGEBENE Schalter dieser Komponente (Einheitsmodell Stufe 4,
   * Anforderung 9), sonst absent. `schaltbar` ist die Tatsache - die Freigabe
   * ist erteilt -, `art` sagt, was geschrieben werden darf.
   */
  schalter?: { schaltbar: boolean; art: SchaltArt; min?: number | null } | null;
};

/** Die Anbindungs-Art, an der eine Selbstbau-Komponente erkennbar ist. */
export const SELBSTBAU_COMMUNICATION = 'modbus_baukasten';

/** Ob diese Komponente selbst gebaut ist. */
export function istSelbstbau(k: BrueckenKomponente): boolean {
  return k.communication === SELBSTBAU_COMMUNICATION;
}

/**
 * Ob die Brücke (a) an dieser Komponente angeboten wird.
 *
 * **Ohne Messwert gibt es nichts zu bedingen** - ein Absprung, der in einem
 * Baukasten ohne wählbare Größe endet, wäre eine Sackgasse mit Extraschritt.
 */
export function bietetRegelBruecke(k: BrueckenKomponente): boolean {
  return (k.channels?.length ?? 0) > 0;
}

/** Die Adresse, die den Baukasten mit dieser Komponente vorbefüllt öffnet. */
export function regelBrueckeHash(siteId: string, entityId: string): string {
  return `#/anlage/${siteId}/steuerung?komponente=${encodeURIComponent(entityId)}`;
}

/** Die Adresse, unter der ein eigenes Gerät angelegt wird (Brücke b). */
export function geraetAnlegenHash(siteId: string): string {
  return `#/anlage/${siteId}/modell?neu=selbstbau`;
}

/** Die Beschriftungen - an EINER Stelle, damit beide Richtungen gleich heißen. */
export const REGEL_BRUECKE_LABEL = 'Regel mit dieser Komponente erstellen';
export const GERAET_ANLEGEN_LABEL = 'Eigenes Gerät (Modbus) anlegen';
export const GERAET_ANLEGEN_HINWEIS =
  'Kein passender Messwert dabei? Sie können Ihr eigenes Modbus-Gerät anlegen - '
  + 'seine Messwerte stehen danach hier zur Auswahl.';

/** Der Vorschlag für den Regel-Namen. */
export function vorbefuellterName(k: BrueckenKomponente): string {
  return k.label.trim() === '' ? 'Neue Regel' : `${k.label.trim()}: neue Regel`;
}

/**
 * Die Komponente, wie die Brücke sie sieht, aus einer Editor-Entität.
 *
 * Der Absprung kommt auf der Regel-Seite an, wo nur die Editor-Sicht vorliegt
 * (`measure`/`actuate`). **`schaltbar` folgt dem SCHREIBWEG**, nicht einem
 * Flag: genau `actuate` ist das, was die Freigabe erteilt und worauf die
 * Guard-Kette am Gerät keyt - eine Entität ohne Schreibweg kann nichts
 * schalten, egal was sonst wo steht.
 *
 * ⚠ Die Klemme (`min`) steht in der Editor-Sicht NICHT zur Verfügung, der
 * Sollwert startet deshalb bei 0. Das ist sicher, nicht geraten: der Executor
 * klemmt restrict-only auf die freigegebene Spanne, und der Kunde sieht den
 * Wert im Baukasten, bevor irgendetwas gespeichert wird.
 */
export function brueckenKomponente(e: {
  id: string;
  label: string;
  measure: string[];
  actuate: string[];
}): BrueckenKomponente {
  const schaltbar = e.actuate.length > 0;
  return {
    entityId: e.id,
    label: e.label,
    channels: e.measure.map((channel) => ({ channel })),
    schalter: schaltbar
      ? { schaltbar: true, art: e.actuate.some((a) => a.startsWith('setpoint')) ? 'setpoint' : 'on_off' }
      : null,
  };
}

/** Liest den `?komponente=`-Parameter aus einer Adresse (leer = nicht gesetzt). */
export function komponenteAusHash(hash: string): string | null {
  const q = hash.indexOf('?');
  if (q < 0) return null;
  const value = new URLSearchParams(hash.slice(q + 1)).get('komponente');
  return value && value.trim() !== '' ? value : null;
}
