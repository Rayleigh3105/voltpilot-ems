/**
 * Historie = **zwei Welten** (Konzept `data/vp-historie-konzept-t4`,
 * Captain-Entscheidung H1 vom 30.07.2026): **Messwerte** und **Erlöse** sind
 * zwei eigene Routen (`#/anlage/{id}/messwerte` · `#/anlage/{id}/erloese`) mit
 * demselben Skelett — Welt-Kopf (Icon · Titel · Ehrlichkeits-Abzeichen ·
 * Kartenpaar zum Wechseln) → klebende Zeit-Leiste → Karten → Fußkarte.
 *
 * Dieses Modul ist die reine, unit-getestete Wahrheit dazu (das
 * `surface.ts`/`fleet.ts`-Muster): kein React, kein Netz. Es entscheidet
 *
 * 1. **welche Welten es auf dieser Anlage gibt** — und zwar aus dem
 *    Lese-Modell, nicht aus einer eigenen Liste: `'telemetrie-historie'` ist
 *    Basis (jede Anlage), `'erloes-historie'` ist modusgebunden
 *    (`surface.ts`). Die Navigation folgt dem Modell, statt es zu überstimmen.
 * 2. **wie eine Welt aussieht und heißt** (Label, Icon, Ehrlichkeits-Abzeichen,
 *    Einleitungssatz, Fußtext),
 * 3. **wohin der Ein-Klick-Wechsel führt** — inklusive Zeitraum, damit der
 *    Wechsel den gewählten Zeitraum mitnimmt statt ihn zu verwerfen.
 *
 * **Die Ehrlichkeitsregel (report §7):** eine Karte trägt genau EIN Abzeichen
 * und enthält nur Zahlen derselben Art. „Gemessen" sind Energiemengen,
 * Leistungen und Ladestand; „Bewertet" ist jede Geldzahl (sie wird mit dem
 * HEUTE gepflegten Preisblatt gerechnet, es gibt keine Preishistorie);
 * „Geplant" ist alles aus den gespeicherten Fahrplänen. Genau daraus folgt der
 * Umzug zweier Zahlen: die **Stromkosten** sind bewertet und gehören nicht in
 * die gemessene Energie-Karte, die **geplante Speicher-Ersparnis** ist keine
 * Erlös-Kennzahl und steht nie unbeschriftet neben einer gemessenen.
 */
import type { IconName } from '../designsystem/components/core/Icon';
import type { HistoryRange } from './api';
import type { Provenienz } from './provenienz';
import type { AnlagenSub } from './nav';
import type { AnlageSurface } from './surface';
import { rangeWord } from './verlauf';

/** Die zwei Welten der Historie. */
export type WeltId = 'messwerte' | 'erloese';

/** Das Abzeichen „Gemessen/Bewertet/Geplant" wohnt in `provenienz.ts` (Einstiegs-Bündel). */
export { PROVENIENZ, type Provenienz, type ProvenienzInfo } from './provenienz';

/** Alles, was eine Welt beschreibt. */
export interface Welt {
  id: WeltId;
  /** Die Route dieser Welt (`AnlagenSub` — gleiche Zeichenkette wie die Id). */
  sub: AnlagenSub;
  label: string;
  icon: IconName;
  /**
   * Das Abzeichen der Welt (die vorherrschende Art ihrer Zahlen).
   *
   * ⚠ Es sitzt seit E3 an den KARTEN (`KartenKopf` → `ProvBadge`), nicht mehr
   * an einem Welt-Kopf: den gibt es nicht mehr. Die Welt behält es trotzdem,
   * weil das Portfolio seinen eigenen Kopf hat und die Route ihn für den
   * zugänglichen Namen der Seite braucht.
   */
  badge: Provenienz;
  /** Die Fußkarte „Was diese Zahlen sind". */
  fussText: string;
}

export const WELTEN: Record<WeltId, Welt> = {
  messwerte: {
    id: 'messwerte',
    sub: 'messwerte',
    label: 'Messwerte',
    icon: 'activity',
    badge: 'gemessen',
    fussText:
      'Gemessene Werte Ihrer Anlage in Viertelstunden, zu Tages- und Monatssummen verdichtet. ' +
      'Einzelne Ausreißer werden auf dem Gerät durch den zuletzt gültigen Wert ersetzt, damit ' +
      'Anzeige und Regelung ruhig bleiben — für eine Abrechnung sind diese Werte deshalb nicht geeignet.',
  },
  erloese: {
    id: 'erloese',
    sub: 'erloese',
    label: 'Erlöse',
    icon: 'euro',
    badge: 'bewertet',
    fussText:
      'Bewertet, nicht abgerechnet: jede Viertelstunde wird mit dem heute gepflegten Preisblatt ' +
      'bzw. Ihrem hinterlegten Stromtarif gerechnet. Ändert sich Ihr Tarif, ändern sich damit auch ' +
      'die angezeigten Werte der Vergangenheit. Ein Vermarktungsentgelt Ihres Direktvermarkters ist nicht abgezogen.',
  },
};

/** Die Welt hinter einer Route — null, wenn die Route keine Welt ist. */
export function weltForSub(sub: AnlagenSub | null): Welt | null {
  if (sub === 'messwerte' || sub === 'erloese') return WELTEN[sub];
  return null;
}

/**
 * Welche Welten diese Anlage hat — aus dem M0-Lese-Modell, nie aus einer
 * eigenen Liste. **Messwerte ist Basis** und existiert deshalb auf JEDER
 * Anlage, auch auf einer nie migrierten (dort hat das Modell noch gar keine
 * Tiefen-Ansichten, die Energie-Historie der Anlagen-Telemetrie gibt es
 * trotzdem). **Erlöse ist modusgebunden** und erscheint genau dann, wenn die
 * Projektion `erloes-historie` beisteuert — eine Privat-Anlage ohne Geld-Modus
 * bekommt also gar keinen Erlöse-Eintrag statt einer leeren Fläche.
 */
export function availableWelten(surface: AnlageSurface | null | undefined): WeltId[] {
  const welten: WeltId[] = ['messwerte'];
  if (surface?.deepViews?.includes('erloes-historie')) welten.push('erloese');
  return welten;
}

/**
 * Ein Reiter des Verlaufs, der einen Zeitraum in seiner Adresse führt.
 *
 * ⚠ **Das ist ADDITIV zu {@link WeltId} und darf es bleiben.** Die zwei Welten
 * teilen sich Kopf, Fuß und Ehrlichkeits-Abzeichen (`WELTEN`); die vier anderen
 * Reiter teilen sich davon nur den Zeitraum in der Adresse (Paket P1). Sie in
 * `WeltId` aufzunehmen hieße, ihnen eine `Welt`-Zeile zu erfinden, die niemand
 * rendert.
 */
export type VerlaufZeitReiter = WeltId | 'marktpreise' | 'lastspitzen' | 'prognose';

/**
 * Der Link in eine Welt — MIT Zeitraum, damit der Wechsel ihn mitnimmt.
 *
 * Die Parameter sind die des bestehenden Deep-Links (`z=` Zeitraum, `at=`
 * Anker, `verlauf.ts`), also bleibt es EIN Vokabular für Welt-Wechsel,
 * Lesezeichen und Cockpit-Sprung.
 *
 * ⚠ Seit P1 bauen ihn AUCH die vier Reiter ohne eigene Welt (Marktpreise,
 * Lastspitzen, Prognose) — der Zeitraum ist dort dieselbe Sache und gehört in
 * dieselbe Adresse. **Rein additiv:** ein Lesezeichen OHNE Parameter
 * (`#/anlage/{id}/marktpreise`) bleibt gültig und landet auf dem Vorgabe-
 * Zeitraum, denn `parseVerlaufParams` fällt für jeden unbekannten oder fehlenden
 * Wert sicher zurück.
 */
export function historieHash(
  siteId: string,
  welt: VerlaufZeitReiter,
  range: HistoryRange,
  at?: string | null,
): string {
  const parts = [`z=${rangeWord(range)}`];
  if (at) parts.push(`at=${at}`);
  return `#/anlage/${siteId}/${welt}?${parts.join('&')}`;
}
