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
import type { AnlagenSub } from './nav';
import type { AnlageSurface } from './surface';
import { rangeWord } from './verlauf';

/** Die zwei Welten der Historie. */
export type WeltId = 'messwerte' | 'erloese';

/** Woraus eine Zahl entstanden ist — das Abzeichen an der Karte (report §7). */
export type Provenienz = 'gemessen' | 'bewertet' | 'geplant';

/** Kanonische Reihenfolge: erst die Basis-Welt, dann das Geld. */
export const WELT_ORDER: readonly WeltId[] = ['messwerte', 'erloese'];

/** Das Abzeichen: ein Wort plus der Satz, der seine Einschränkung ausspricht. */
export interface ProvenienzInfo {
  label: string;
  /** Der eine Satz, den die UI zum Abzeichen sagen muss (report §7). */
  satz: string;
}

export const PROVENIENZ: Record<Provenienz, ProvenienzInfo> = {
  gemessen: {
    label: 'Gemessen',
    satz:
      'Gemessene Werte Ihrer Anlage; einzelne Ausreißer sind durch den letzten gültigen Wert ersetzt.',
  },
  bewertet: {
    label: 'Bewertet',
    satz: 'Bewertet mit dem heute gepflegten Preisblatt — nicht Ihre Abrechnung.',
  },
  geplant: {
    label: 'Geplant',
    satz: 'Vorab geplant — nicht die gemessene Ersparnis.',
  },
};

/** Alles, was eine Welt beschreibt. */
export interface Welt {
  id: WeltId;
  /** Die Route dieser Welt (`AnlagenSub` — gleiche Zeichenkette wie die Id). */
  sub: AnlagenSub;
  label: string;
  icon: IconName;
  /** Der Einleitungssatz unter dem Titel. */
  lead: string;
  /** Die Unterzeile auf der Wechsel-Karte — sagt, was die Welt enthält. */
  switchLead: string;
  /** Das Abzeichen des Welt-Kopfs (die vorherrschende Art ihrer Zahlen). */
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
    lead: 'Was Ihre Anlage erzeugt, verbraucht und gespeichert hat.',
    switchLead: 'Energie & einzelne Messwerte',
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
    lead: 'Was Ihre Anlage eingebracht und der Strombezug gekostet hat.',
    switchLead: 'Einspeisung · Steuerung · Kosten',
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

/** Eine Karte des Welt-Wechslers. */
export interface WeltSwitchCard {
  welt: Welt;
  active: boolean;
}

/**
 * Das Kartenpaar im Welt-Kopf — der Wechsel in EINEM Klick.
 *
 * Es zeigt die verfügbaren Welten UND die gerade offene (eine per Lesezeichen
 * geöffnete Erlöse-Welt ohne Geld-Modus ist damit nie eine Sackgasse). Bleibt
 * nur eine Welt übrig, gibt es nichts zu wechseln: dann rendert der Kopf gar
 * kein Kartenpaar, statt eine einsame Karte zu zeigen, die wie ein toter
 * Schalter aussieht.
 */
export function weltSwitchCards(
  active: WeltId,
  available: readonly WeltId[],
): WeltSwitchCard[] {
  const ids = WELT_ORDER.filter((id) => id === active || available.includes(id));
  if (ids.length < 2) return [];
  return ids.map((id) => ({ welt: WELTEN[id], active: id === active }));
}

/**
 * Der Link in eine Welt — MIT Zeitraum, damit der Wechsel ihn mitnimmt.
 *
 * Die Parameter sind die des bestehenden Deep-Links (`z=` Zeitraum, `at=`
 * Anker, `verlauf.ts`), also bleibt es EIN Vokabular für Welt-Wechsel,
 * Lesezeichen und Cockpit-Sprung.
 */
export function historieHash(
  siteId: string,
  welt: WeltId,
  range: HistoryRange,
  at?: string | null,
): string {
  const parts = [`z=${rangeWord(range)}`];
  if (at) parts.push(`at=${at}`);
  return `#/anlage/${siteId}/${welt}?${parts.join('&')}`;
}
