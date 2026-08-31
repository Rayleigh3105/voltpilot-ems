/**
 * Der ERSTBESUCH-HINWEIS der Verbraucher-Zone (Verbrauchsmanagement v1 P2;
 * Konzept `vp-verbrauchsmgmt-konzept-v1` §7.4).
 *
 * Beim ersten Öffnen sagt er in EINEM Kasten, was VoltPilot aus dem Bestand
 * ÜBERNOMMEN hat — und woher. Das ist die Gegenleistung für die automatische
 * Ableitung (E2): der Kunde sieht seine bisherigen Einstellungen wieder, unter
 * neuen Wörtern, und weiß, dass nichts verloren ging.
 *
 * **⚠ Er zählt NUR AUF, was der Server wirklich projiziert hat.** Jede Zeile
 * hängt an einer Zeile der Zone (Quelle + Herkunft); es steht nichts da, was
 * die Antwort nicht sagt, und ohne eine einzige Komponente entsteht gar kein
 * Kasten — ein „nichts ist verloren gegangen" über eine leere Anlage wäre eine
 * Aussage über nichts.
 *
 * **Drei Entscheidungen, die man kennen muss:**
 *
 *  1. **JE ANLAGE gemerkt** (§7.4 wörtlich) — anders als der Zonen-Erklärkasten
 *     (`steuerungIntro.ts`, je ORGANISATION). Der Grund ist der INHALT: dieser
 *     Kasten zählt die Geräte DIESER Anlage auf, also ist er auf der nächsten
 *     Anlage ein anderer Kasten und nicht derselbe zum zweiten Mal.
 *  2. **Kein neuer Speicher**: die Marke wohnt in `cockpit_layout.document.seen`
 *     der ANLAGEN-Schicht (`layer=eigen`) — dieselbe Mechanik, anderer Scope.
 *  3. **`localStorage` ist verboten** (die Haus-Regel): der Kasten muss auf
 *     jedem Gerät desselben Kunden weg sein.
 *
 * Rein + deterministisch: kein React, kein Netz.
 */
import type { CockpitLayoutDocument } from './cockpitLayout';
import { quelleLang, zeilenName, type SiteVerbraucher } from './verbraucherZone';

/** Der Schlüssel dieses einen Kastens. */
export const STEUERART_INTRO_KEY = 'steuerart-intro';

export const STEUERART_INTRO_TITEL = 'Neu: Jedes Gerät hat jetzt eine Steuerart';

/**
 * Der Schluss-Satz. Er ist die eigentliche Zusage von §7.4 und steht IMMER —
 * er ist der Grund, warum es diesen Kasten gibt.
 */
export const STEUERART_INTRO_SCHLUSS = 'Nichts ist verloren gegangen.';

export const STEUERART_INTRO_SCHLIESSEN = 'Verstanden';
export const STEUERART_INTRO_SCHLIESSEN_TITEL =
  'Diese Erklärung für diese Anlage nicht mehr anzeigen';

/**
 * Wurde der Kasten für diese Anlage schon weggeklickt? Eine fehlende Antwort
 * (älteres Backend, Ladefehler) heißt **NICHT gesehen** — einmal zu viel ist
 * harmlos, beim ersten Mal zu fehlen ist es nicht.
 */
export function introGesehen(
  document: CockpitLayoutDocument | null | undefined,
  key: string = STEUERART_INTRO_KEY,
): boolean {
  return (document?.seen ?? []).includes(key);
}

/** Das Dokument mit der Marke — additiv, jede Anordnung reist unverändert mit. */
export function mitGesehen(
  document: CockpitLayoutDocument | null | undefined,
  key: string = STEUERART_INTRO_KEY,
): CockpitLayoutDocument {
  const basis: CockpitLayoutDocument = document ?? {
    order: [], hidden: [], shown: [], lead: null,
  };
  const seen = basis.seen ?? [];
  return { ...basis, seen: seen.includes(key) ? seen : [...seen, key] };
}

export interface IntroZeile {
  entityId: string;
  /** „Wallbox Garage → Überschuss (Sonne zuerst)". */
  text: string;
  /** Woher die Steuerart stammt — der zweite Halbsatz von §7.4. */
  herkunft: string;
}

/**
 * Woher die Projektion eine Steuerart hat, in Kundendeutsch.
 *
 * **⚠ Jeder Satz benennt eine BELEGTE Quelle.** `standard` heißt: aus der
 * Ladepark-Einstellung dieser Anlage; `policy` heißt: aus einer Regel, die
 * schon da war; `ohne` heißt: es gab nichts — dann steht kein „übernommen" da,
 * sondern die Wahrheit.
 */
const HERKUNFT_WORT: Record<string, string> = {
  standard: 'aus Ihrer Ladepark-Einstellung',
  policy: 'aus Ihrer bisherigen Regel',
  ohne: 'bisher nicht gesteuert',
};

/**
 * Die Zeilen des Kastens — eine je steuerbarer Komponente.
 *
 * Eine Komponente, deren Regel sich nicht auf eine Steuerart abbilden ließ
 * (Projektions-Nr. 9), wird ausdrücklich als solche genannt: „bleibt eine
 * eigene Regel". Das ist die ehrlichste Zeile des Kastens — sie sagt, dass
 * VoltPilot dort NICHTS umgedeutet hat.
 */
export function introZeilen(daten: SiteVerbraucher | null | undefined): IntroZeile[] {
  const out: IntroZeile[] = [];
  for (const e of daten?.verbraucher ?? []) {
    const name = zeilenName(e);
    if (e.steuerart?.quelle === 'eigene_regel') {
      out.push({
        entityId: e.entityId,
        text: `„${name}" bleibt eine eigene Regel`,
        herkunft: 'unverändert übernommen',
      });
      continue;
    }
    out.push({
      entityId: e.entityId,
      text: `„${name}" → ${quelleLang(e.steuerart)}`,
      herkunft: HERKUNFT_WORT[e.steuerart?.herkunft] ?? '',
    });
  }
  return out;
}

/**
 * Der Satz über der Rangliste (§7.4). Er steht NUR, wenn es wirklich eine
 * gibt — auf einer Anlage ohne Speicher und ohne zweites Gerät ist eine
 * „Reihenfolge" keine Aussage.
 */
export function ranglisteSatz(daten: SiteVerbraucher | null | undefined): string | null {
  const liste = daten?.rangliste ?? [];
  if (liste.length < 2) return null;
  const erste = liste[0];
  return erste.art === 'speicher'
    ? 'Die Reihenfolge bei knapper Leistung haben wir aus Ihren bisherigen Einstellungen '
      + 'gebildet — Speicher zuerst.'
    : `Die Reihenfolge bei knapper Leistung haben wir aus Ihren bisherigen Einstellungen `
      + `gebildet — „${erste.name}" zuerst.`;
}

/** Zeigt der Kasten überhaupt etwas? Ohne Zeile entsteht er gar nicht. */
export function introSichtbar(daten: SiteVerbraucher | null | undefined): boolean {
  return introZeilen(daten).length > 0;
}
