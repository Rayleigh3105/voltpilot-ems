/**
 * Die GEOMETRIE der Tagesuhr am Telefon - einer Uhr, die geht wie eine echte
 * Uhr (Überblick 20.10.2026, Variante A; Rückmeldung: „die Uhr geht nicht nach
 * der Uhr im echten Leben").
 *
 * Die frühere Uhr war ein 24-Stunden-Zifferblatt (12 Uhr oben, Mitternacht
 * unten): um 14 Uhr zeigte ihr Zeiger dorthin, wo jede andere Uhr 1 Uhr zeigt.
 * Diese Uhr hat 12 Stunden rund wie am Handgelenk:
 *
 *  - **Heute** zeigt der Ring, was AB JETZT kommt - elf Stunden nach vorn
 *    ({@link BLICK_MIN}), über Mitternacht hinaus mit dem Folgetag. Die Lücke
 *    der zwölften Stunde hinter dem Zeiger zeigt, wo der Blick endet; ohne sie
 *    läse man das Stück vor dem Zeiger als „eben vorbei".
 *  - **Gestern und morgen** gibt es kein Jetzt und keinen Zeiger; die Uhr
 *    zeigt den Vormittag (0–12 Uhr) oder den Nachmittag (12–24 Uhr).
 *
 * Ein Ring, ein Zeiger: die Phasen in der Farbe ihrer Speicher-Richtung, ihr
 * Symbol ab {@link SYMBOL_AB_MIN}, die Uhrzeit jedes Wechsels außen am Ring.
 * Dieses Modul rechnet nur Formen; Farben, Wörter und Bedienung liegen in
 * `components/FahrplanUhr.tsx`, die Phasen im Tagesmodell (`fahrplanTag.ts`).
 * Rein: kein React, kein Netz.
 */

import { TAG_MINUTEN, uhrzeit, type TagModell } from './fahrplanTag';
import type { SlotRole } from './fahrplanWhy';

/** Die Uhr zeichnet in ein Quadrat dieser Größe (Einheiten). */
export const UHR_MASS = 340;
export const UHR_C = UHR_MASS / 2;
/** Der Ring: außen und innen. */
export const UHR_R = { aussen: 138, innen: 112 } as const;

/** Wie weit die Uhr heute nach vorn blickt (Minuten): elf der zwölf Stunden. */
export const BLICK_MIN = 11 * 60;
const HALBER_TAG = 12 * 60;
/** Ab dieser Dauer (Minuten) trägt ein Bogen das Symbol seiner Tätigkeit. */
export const SYMBOL_AB_MIN = 45;
/** Zwei Wechselzeiten, die enger stehen (Grad), teilen sich keinen Platz. */
const MARKEN_ABSTAND_GRAD = 17;

export type UhrHaelfte = 'vormittag' | 'nachmittag';

/** Eine Phase auf der Uhr - aus dem gezeigten Tag oder (nach Mitternacht) dem Folgetag. */
export interface UhrPhase {
  quelle: 'tag' | 'folgetag';
  /** Index in `phasenRoh` ihres Tages (für das Warum). */
  phaseIndex: number;
  role: SlotRole;
  label: string;
  /** Minuten seit Mitternacht des gezeigten Tages; der Folgetag zählt ab 1440. */
  von: number;
  bis: number;
}

/** Welcher Ausschnitt des Tages auf der Uhr liegt. */
export interface UhrFenster {
  von: number;
  bis: number;
  /** Wo der Zeiger steht (Minute); null = kein Jetzt an diesem Tag. */
  zeiger: number | null;
}

/**
 * Die Phasen des Tages, nach Mitternacht weiter mit dem Folgetag. Was über
 * Mitternacht dieselbe Tätigkeit bleibt, wird EIN Bogen (sonst teilte die
 * Kalendergrenze „Verbrauch decken" in zwei).
 */
export function uhrPhasen(tag: TagModell, folgetag: TagModell | null = null): UhrPhase[] {
  const out: UhrPhase[] = tag.phasen.map((p) => ({
    quelle: 'tag' as const,
    phaseIndex: p.phaseIndex,
    role: p.role,
    label: p.label,
    von: p.von,
    bis: p.bis,
  }));
  if (folgetag) {
    for (const p of folgetag.phasen) {
      const von = p.von + TAG_MINUTEN;
      const bis = p.bis + TAG_MINUTEN;
      const letzte = out[out.length - 1];
      if (letzte && letzte.role === p.role && letzte.label === p.label && Math.abs(letzte.bis - von) < 1) {
        letzte.bis = bis;
        continue;
      }
      out.push({ quelle: 'folgetag', phaseIndex: p.phaseIndex, role: p.role, label: p.label, von, bis });
    }
  }
  return out;
}

/**
 * Der Ausschnitt: heute ab jetzt elf Stunden (höchstens bis zum Ende des
 * Plans), sonst die gewählte Tageshälfte. Ohne Phasen ein leeres Fenster.
 */
export function uhrFenster(tag: TagModell, phasen: readonly UhrPhase[], haelfte: UhrHaelfte): UhrFenster {
  const planEnde = phasen.length > 0 ? phasen[phasen.length - 1].bis : 0;
  if (tag.jetzt != null) {
    return { von: tag.jetzt, bis: Math.min(tag.jetzt + BLICK_MIN, planEnde), zeiger: tag.jetzt };
  }
  const von = haelfte === 'vormittag' ? 0 : HALBER_TAG;
  return { von, bis: Math.min(von + HALBER_TAG, planEnde), zeiger: null };
}

/** Der Winkel einer Uhrzeit auf einer 12-Stunden-Uhr (Grad, 0 = 12 Uhr, im Uhrzeigersinn). */
export function uhrWinkel(minute: number): number {
  const m = ((minute % HALBER_TAG) + HALBER_TAG) % HALBER_TAG;
  return (m / HALBER_TAG) * 360;
}

/** Ein Punkt in Polarkoordinaten um die Mitte (Winkel wie {@link uhrWinkel}). */
export function uhrPunkt(r: number, grad: number): { x: number; y: number } {
  const a = ((grad - 90) * Math.PI) / 180;
  return { x: UHR_C + r * Math.cos(a), y: UHR_C + r * Math.sin(a) };
}

const n = (v: number) => v.toFixed(1);

/** Ein Ringstück von `a0` bis `a1` (Grad, a1 > a0). */
export function ringStueck(r1: number, r2: number, a0: number, a1: number): string {
  const gross = a1 - a0 > 180 ? 1 : 0;
  const p0 = uhrPunkt(r2, a0);
  const p1 = uhrPunkt(r2, a1);
  const p2 = uhrPunkt(r1, a1);
  const p3 = uhrPunkt(r1, a0);
  return (
    `M${n(p0.x)} ${n(p0.y)}A${r2} ${r2} 0 ${gross} 1 ${n(p1.x)} ${n(p1.y)}` +
    `L${n(p2.x)} ${n(p2.y)}A${r1} ${r1} 0 ${gross} 0 ${n(p3.x)} ${n(p3.y)}Z`
  );
}

export interface UhrBogen {
  phase: UhrPhase;
  /** Der sichtbare Teil der Phase im Fenster. */
  von: number;
  bis: number;
  d: string;
  /** Wo das Symbol steht; null = zu kurz dafür. */
  symbol: { x: number; y: number } | null;
}

export interface UhrMarke {
  minute: number;
  text: string;
  x: number;
  y: number;
}

export interface UhrModell {
  fenster: UhrFenster;
  boegen: UhrBogen[];
  /** Die Uhrzeit jedes Wechsels im Fenster, außen am Ring. */
  marken: UhrMarke[];
  /** Zwölf Stundenstriche; jeder dritte lang. */
  striche: { x1: number; y1: number; x2: number; y2: number; lang: boolean }[];
  zahlen: { text: string; x: number; y: number }[];
  /** Spitze des Zeigers (mitten im Ring); null ohne Jetzt. */
  zeiger: { x: number; y: number } | null;
}

/** Spalt zwischen zwei Bögen (Grad), damit Nachbarn gleicher Farbe trennbar bleiben. */
const SPALT_GRAD = 0.7;

export function uhrModell(phasen: readonly UhrPhase[], fenster: UhrFenster): UhrModell {
  const { innen, aussen } = UHR_R;
  const start = uhrWinkel(fenster.von);
  const grad = (minute: number) => start + ((minute - fenster.von) / HALBER_TAG) * 360;
  const boegen: UhrBogen[] = [];
  for (const p of phasen) {
    const von = Math.max(p.von, fenster.von);
    const bis = Math.min(p.bis, fenster.bis);
    if (bis - von < 1) continue;
    const a0 = grad(von) + SPALT_GRAD;
    const a1 = grad(bis) - SPALT_GRAD;
    if (a1 <= a0) continue;
    boegen.push({
      phase: p,
      von,
      bis,
      d: ringStueck(innen, aussen, a0, a1),
      symbol: bis - von >= SYMBOL_AB_MIN ? uhrPunkt((innen + aussen) / 2, (a0 + a1) / 2) : null,
    });
  }

  const marken: UhrMarke[] = [];
  const belegt: number[] = fenster.zeiger != null ? [grad(fenster.zeiger)] : [];
  for (const b of boegen) {
    if (b.von <= fenster.von + 0.5) continue;
    const g = grad(b.von);
    if (belegt.some((x) => Math.abs(x - g) < MARKEN_ABSTAND_GRAD)) continue;
    belegt.push(g);
    const p = uhrPunkt(aussen + 16, g);
    marken.push({ minute: b.von, text: uhrzeit(b.von % TAG_MINUTEN), x: p.x, y: p.y });
  }

  const striche: UhrModell['striche'] = [];
  for (let h = 0; h < 12; h++) {
    const lang = h % 3 === 0;
    const a = uhrPunkt(innen - 8, h * 30);
    const b = uhrPunkt(innen - (lang ? 20 : 14), h * 30);
    striche.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, lang });
  }
  const zahlen = (
    [
      [0, '12'],
      [3, '3'],
      [6, '6'],
      [9, '9'],
    ] as const
  ).map(([h, text]) => ({ text, ...uhrPunkt(innen - 36, h * 30) }));

  return {
    fenster,
    boegen,
    marken,
    striche,
    zahlen,
    zeiger: fenster.zeiger == null ? null : uhrPunkt((innen + aussen) / 2, uhrWinkel(fenster.zeiger)),
  };
}

/**
 * Die Unterschrift der Uhr: heute „Ab jetzt bis 00:45" (das Ende auf die
 * Viertelstunde abgerundet), sonst die Tageshälfte.
 */
export function uhrUnterschrift(fenster: UhrFenster): string {
  if (fenster.zeiger == null) {
    return fenster.von < HALBER_TAG ? 'Vormittag · 0 bis 12 Uhr' : 'Nachmittag · 12 bis 24 Uhr';
  }
  const ende = Math.floor(fenster.bis / 15) * 15;
  return `Ab jetzt bis ${ende === TAG_MINUTEN ? '24:00' : uhrzeit(ende % TAG_MINUTEN)}`;
}
