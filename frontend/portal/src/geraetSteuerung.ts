/**
 * Der Baustein „Steuerung" einer Geräteseite (Konzept „Geräteseiten: Ein
 * Blick, eine Antwort", Baustein 3; Korrektur K1).
 *
 * Er beantwortet zwei Fragen: **Wer entscheidet gerade?** und **Was kann ich
 * selbst tun?** - mit EINEM Schalter, der den ECHTEN Zustand zeigt
 * (Automatik · Laden · Halten, Automatik · Ein · Aus, Automatik · Sofort laden
 * · Pausieren).
 *
 * ⚠ **Es entsteht KEINE zweite Steuerungs-Ableitung.** Zustand, Grund, Quelle
 * und die angebotenen Handlungen kommen WÖRTLICH aus `steuerungJetzt.ts`
 * (`speicherZeile`, `geraetZeile`, `ladepunktZeilen`) - derselben Ableitung,
 * die die Jetzt-Zone der Steuerungs-Seite rendert. Geräteseite und Steuerung
 * können sich damit über dieselbe Sekunde nicht widersprechen.
 *
 * ⚠ **Ein Segment löst nur aus**: gehandelt wird im BESTEHENDEN Dialog
 * (Handeingriff-Folgenkarte, Verbraucher-Eingriff, Ladepunkt-Folgenkarte) mit
 * seinen Folgen-Texten und Dauern. Ein Segment, das der Zustand nicht hergibt,
 * ist gesperrt - und gibt es gar keine Handlung, steht statt des Schalters ihr
 * Grund (`keinEingriff`).
 *
 * K1 (behobener Widerspruch): ein laufender Heizstab bot „Jetzt starten" an.
 * Der Schalter zeigt jetzt, was gilt - und „Ein" ist dann das aktive Segment,
 * nicht ein Knopf.
 */
import type { Intervention } from './api';
import type { HandeingriffAktion } from './handeingriff';
import type { LadepunktAktion } from './ladepunkte';
import type { ManualOverride, SofortAktion } from './consumers/fulfillment';
import type { JetztZeile } from './steuerungJetzt';

/** Die Handlung, die ein Segment im bestehenden Dialog öffnet. */
export type SegmentAktion =
  | { art: 'speicher'; wert: HandeingriffAktion }
  | { art: 'verbraucher'; wert: SofortAktion }
  | { art: 'ladepunkt'; wert: LadepunktAktion };

export interface Segment {
  /** Stabiler Schlüssel - zugleich der Testanker. */
  key: string;
  label: string;
  /** Der Zustand, der gerade gilt. Genau EIN Segment ist aktiv. */
  aktiv: boolean;
  /** Was ein Tipp öffnet; `null` = gesperrt (oder schon aktiv). */
  aktion: SegmentAktion | null;
}

export interface SteuerungView {
  /** Die Zeile der Jetzt-Zone - Zustand, Grund, Quelle, Countdown. */
  zeile: JetztZeile;
  /** Leer, wenn der Zustand keine Handlung hergibt - dann steht `keinEingriff`. */
  segmente: Segment[];
  keinEingriff: string | null;
}

/** Die kurzen Namen der Segmente. Die langen stehen im Dialog-Titel. */
export const SEGMENT_LABEL = {
  automatik: 'Automatik',
  laden: 'Laden',
  halten: 'Halten',
  ein: 'Ein',
  aus: 'Aus',
  sofort: 'Sofort laden',
  pausieren: 'Pausieren',
} as const;

function mitSchalter(zeile: JetztZeile, segmente: Segment[]): SteuerungView {
  // ⚠ Ein Schalter, an dem kein Segment etwas auslöst, wäre eine Anzeige, die
  // wie eine Handlung aussieht - dann steht der Grund statt seiner.
  const bedienbar = segmente.some((s) => s.aktion != null);
  return {
    zeile,
    segmente: bedienbar ? segmente : [],
    keinEingriff: bedienbar ? null : zeile.keinEingriff,
  };
}

/**
 * Der Speicher: Automatik · Laden · Halten.
 *
 * @param eingriff der laufende Handeingriff an diesem Speicher (`GET /interventions`),
 *                 oder null - er entscheidet, welches Segment AKTIV ist.
 */
export function speicherSteuerung(zeile: JetztZeile, eingriff: Intervention | null): SteuerungView {
  const aktionen = zeile.aktionen as readonly string[];
  const laufend = zeile.quelle === 'handeingriff' && eingriff != null;
  const aktiv = !laufend
    ? 'automatik'
    : eingriff?.kind === 'speicher_laden'
      ? 'laden'
      : eingriff?.kind === 'speicher_halten'
        ? 'halten'
        : null;
  const seg = (key: 'automatik' | 'laden' | 'halten', wert: HandeingriffAktion): Segment => ({
    key,
    label: SEGMENT_LABEL[key],
    aktiv: aktiv === key,
    aktion: aktiv !== key && aktionen.includes(wert) ? { art: 'speicher', wert } : null,
  });
  return mitSchalter(zeile, [
    seg('automatik', 'resume'),
    seg('laden', 'speicher_laden'),
    seg('halten', 'speicher_halten'),
  ]);
}

/**
 * Ein schaltbarer Verbraucher: Automatik · Ein · Aus.
 *
 * @param override der laufende Handeingriff dieses Verbrauchers, oder null.
 */
export function verbraucherSteuerung(
  zeile: JetztZeile,
  override: ManualOverride | null,
): SteuerungView {
  const aktionen = zeile.aktionen as readonly string[];
  const laufend = zeile.quelle === 'handeingriff' && override != null;
  const aktiv = !laufend ? 'automatik' : override?.kind === 'stop' ? 'aus' : 'ein';
  const seg = (key: 'automatik' | 'ein' | 'aus', wert: SofortAktion): Segment => ({
    key,
    label: SEGMENT_LABEL[key],
    aktiv: aktiv === key,
    aktion: aktiv !== key && aktionen.includes(wert) ? { art: 'verbraucher', wert } : null,
  });
  return mitSchalter(zeile, [
    seg('automatik', 'resume'),
    seg('ein', 'start'),
    seg('aus', 'stop'),
  ]);
}

/**
 * Ein Ladepunkt: Automatik · Sofort laden · Pausieren.
 *
 * ⚠ Der aktive Zustand kommt aus der ZEILE selbst (`ladepunkt.eingriff`): der
 * Herzschlag meldet je Stecker nur, dass ein Eingriff läuft und welcher - ein
 * Ende kennt er nicht, also gibt es hier auch keins.
 */
export function ladepunktSteuerung(zeile: JetztZeile): SteuerungView {
  const aktionen = zeile.aktionen as readonly string[];
  const eingriff = zeile.quelle === 'handeingriff' ? zeile.ladepunkt?.eingriff ?? null : null;
  const aktiv = eingriff === 'pausiert' ? 'pausieren' : eingriff ? 'sofort' : 'automatik';
  const seg = (key: 'automatik' | 'sofort' | 'pausieren', wert: LadepunktAktion): Segment => ({
    key,
    label: SEGMENT_LABEL[key],
    aktiv: aktiv === key,
    aktion: aktiv !== key && aktionen.includes(wert) ? { art: 'ladepunkt', wert } : null,
  });
  return mitSchalter(zeile, [
    seg('automatik', 'resume'),
    seg('sofort', 'voll_laden'),
    seg('pausieren', 'laden_pausieren'),
  ]);
}

/**
 * Der eine Satz „Wer entscheidet gerade?" - aus Quelle und Countdown der
 * Zeile zusammengesetzt, nie neu formuliert. Ohne belegte Quelle: null (die
 * Zeile behauptet dann keinen Urheber).
 */
export function werEntscheidet(zeile: JetztZeile): string | null {
  const quelle = (zeile.quelleText ?? '').trim();
  if (!quelle) return null;
  return zeile.bis ? `${quelle} · ${zeile.bis}` : quelle;
}
