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
 * den geführten Baukasten mit genau diesem Messwert vorbefüllt.
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

import type { GuidedRule } from './flows/guidedBuilder';

/** Eine Komponente, wie die Brücke sie braucht (bewusst schmal). */
export type BrueckenKomponente = {
  entityId: string;
  label: string;
  communication?: string | null;
  /** Die Messkanäle der Komponente, in ihrer gespeicherten Reihenfolge. */
  channels?: { channel: string; label?: string | null; unit?: string | null }[];
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

/**
 * Die Vorbefüllung des geführten Baukastens aus einer Komponente.
 *
 * Der ERSTE Messwert wird gewählt - er ist der, den der Kunde beim Anlegen
 * zuerst beschrieben hat, also mit hoher Wahrscheinlichkeit der wichtigste.
 * Schwelle und Richtung bleiben bewusst bei neutralen Vorgaben: eine geratene
 * Schwelle wäre eine Behauptung über ein Gerät, das wir nicht kennen.
 *
 * @returns null, wenn die Komponente keinen Messwert hat
 */
export function vorbefuellteRegel(k: BrueckenKomponente): GuidedRule | null {
  const kanal = k.channels?.[0];
  if (!kanal) return null;
  return {
    conditions: [
      {
        kind: 'entity',
        entityId: k.entityId,
        channel: kanal.channel,
        direction: 'above',
        threshold: 0,
      },
    ],
    combinator: 'and',
    // Die AKTION bleibt offen: was passieren soll, weiß nur der Kunde - und
    // eine vorbelegte Benachrichtigung wäre eine Regel, die er nie wollte.
    action: { kind: 'notify', message: '' },
  };
}

/** Der Vorschlag für den Regel-Namen. */
export function vorbefuellterName(k: BrueckenKomponente): string {
  return k.label.trim() === '' ? 'Neue Regel' : `${k.label.trim()}: neue Regel`;
}

/** Liest den `?komponente=`-Parameter aus einer Adresse (leer = nicht gesetzt). */
export function komponenteAusHash(hash: string): string | null {
  const q = hash.indexOf('?');
  if (q < 0) return null;
  const value = new URLSearchParams(hash.slice(q + 1)).get('komponente');
  return value && value.trim() !== '' ? value : null;
}
