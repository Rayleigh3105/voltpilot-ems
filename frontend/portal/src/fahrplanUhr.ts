/**
 * Die GEOMETRIE der Tagesuhr (Konzept „Tagesuhr und Bildfahrplan", E1: am
 * Telefon steht die Uhr ganz oben, direkt darunter die Antworten).
 *
 * Ein Tag ist ein Kreis: oben Mittag, unten Mitternacht, im Uhrzeigersinn.
 * Von außen nach innen: die Sonne als Strahlen, der Strompreis als schmaler
 * Ring, die Tätigkeit des Speichers als breiter Ring (immer mit Symbol), innen
 * der Ladestand als Fläche — je weiter außen, desto voller.
 *
 * Dieses Modul rechnet nur Formen (SVG-Pfade in einem 440er-Quadrat). Farben,
 * Wörter und Bedienung liegen in `components/FahrplanUhr.tsx`; die Daten kommen
 * aus dem Tagesmodell (`fahrplanTag.ts`). Rein: kein React, kein Netz.
 */

import { TAG_MINUTEN, ladestandPlan, type TagModell } from './fahrplanTag';
import type { PhaseKind, SlotRole } from './fahrplanWhy';

/** Kantenlänge des Zeichenquadrats. */
export const UHR_MASS = 440;
/** Mittelpunkt. */
export const UHR_C = UHR_MASS / 2;

/** Die Radien der Ringe (Einheiten des Zeichenquadrats). */
export const UHR_R = {
  strahlInnen: 184.5,
  strahlMax: 13,
  preis0: 171,
  preis1: 177,
  marke0: 178,
  taet0: 136,
  taet1: 165,
  soc0: 72,
  soc1: 124,
  beschriftung: 207,
  mitte: 66,
} as const;

/**
 * Ab dieser Dauer bekommt eine Phase ihr Symbol in den Ring gezeichnet (Minuten).
 * Kürzer ist der Bogen am Telefon schmaler als das Symbol selbst.
 */
export const SYMBOL_AB_MIN = 45;

/** Winkel einer Uhrzeit im Bogenmaß: 00:00 unten, 12:00 oben, im Uhrzeigersinn. */
export function uhrWinkel(minute: number): number {
  return ((90 + (minute / TAG_MINUTEN) * 360) * Math.PI) / 180;
}

/** Der Punkt auf Radius r bei einer Uhrzeit. */
export function uhrPunkt(r: number, minute: number): { x: number; y: number } {
  const a = uhrWinkel(minute);
  return { x: UHR_C + r * Math.cos(a), y: UHR_C + r * Math.sin(a) };
}

function p(r: number, minute: number): string {
  const { x, y } = uhrPunkt(r, minute);
  return `${x.toFixed(2)} ${y.toFixed(2)}`;
}

/** Ein Ringstück zwischen zwei Radien und zwei Uhrzeiten (geschlossener Pfad). */
export function uhrRing(r0: number, r1: number, m0: number, m1: number): string {
  if (m1 - m0 >= TAG_MINUTEN) {
    const mitte = m0 + TAG_MINUTEN / 2;
    return uhrRing(r0, r1, m0, mitte) + uhrRing(r0, r1, mitte, m1);
  }
  const gross = ((m1 - m0) / TAG_MINUTEN) * 360 > 180 ? 1 : 0;
  return (
    `M${p(r1, m0)}A${r1} ${r1} 0 ${gross} 1 ${p(r1, m1)}` +
    `L${p(r0, m1)}A${r0} ${r0} 0 ${gross} 0 ${p(r0, m0)}Z`
  );
}

/** Ein offener Bogen auf Radius r. */
export function uhrBogen(r: number, m0: number, m1: number): string {
  const ende = m1 - m0 >= TAG_MINUTEN ? m0 + TAG_MINUTEN - 0.01 : m1;
  const gross = ((ende - m0) / TAG_MINUTEN) * 360 > 180 ? 1 : 0;
  return `M${p(r, m0)}A${r} ${r} 0 ${gross} 1 ${p(r, ende)}`;
}

/**
 * Aus einer Zeiger-Position (relativ zum Mittelpunkt, in Einheiten des
 * Zeichenquadrats) die Uhrzeit und den Abstand zur Mitte. Der Abstand
 * entscheidet, ob ein Tipp die Mitte meint („zurück zu jetzt").
 */
export function uhrzeitAus(dx: number, dy: number): { minute: number; abstand: number } {
  const grad = (Math.atan2(dy, dx) * 180) / Math.PI;
  const t = (((grad - 90) % 360) + 360) % 360;
  return { minute: (t / 360) * TAG_MINUTEN, abstand: Math.sqrt(dx * dx + dy * dy) };
}

/** Radius des Ladestands (0–100 %) in der Fläche. */
export function socRadius(pct: number): number {
  const v = Math.max(0, Math.min(100, pct));
  return UHR_R.soc0 + (v / 100) * (UHR_R.soc1 - UHR_R.soc0);
}

/** Ein Stück des Tätigkeitsrings. */
export interface UhrPhasenStueck {
  phaseIndex: number;
  role: SlotRole;
  kind: PhaseKind;
  d: string;
  /** Vorbei (oder der vergangene Teil der laufenden Phase) — gedämpft gezeichnet. */
  vorbei: boolean;
}

export interface UhrSymbol {
  phaseIndex: number;
  role: SlotRole;
  kind: PhaseKind;
  x: number;
  y: number;
}

export interface UhrPreisStueck {
  i: number;
  d: string;
  /** 0 = günstigste, 1 = teuerste Viertelstunde des Tages; null = kein Preis. */
  stufe: number | null;
}

export interface UhrPreisMarke {
  art: 'min' | 'max';
  i: number;
  ct: number;
  /** Das Dreieck am Ring. */
  d: string;
  /** Mittelpunkt der Beschriftung. */
  x: number;
  y: number;
}

export interface UhrStrahl {
  d: string;
  gemessen: boolean;
}

export interface UhrStunde {
  minute: number;
  /** Der Strich am Ring. */
  d: string;
  gross: boolean;
  /** Beschriftung („12"); null = nur Strich. */
  text: string | null;
  x: number;
  y: number;
}

export interface UhrModell {
  phasen: UhrPhasenStueck[];
  symbole: UhrSymbol[];
  preis: UhrPreisStueck[];
  preisMarken: UhrPreisMarke[];
  strahlen: UhrStrahl[];
  /** Die geplante Ladestandsfläche und ihre Kante; null ohne Ladestand. */
  ladestand: { flaeche: string; kante: string } | null;
  stunden: UhrStunde[];
  /** Das Dreieck „jetzt" am Außenrand; null, wenn der Tag nicht heute ist. */
  jetzt: string | null;
}

/** Der Umriss der Phase, in der der Zeiger steht (etwas größer als ihr Ring). */
export function uhrPhasenRahmen(von: number, bis: number): string {
  return uhrRing(UHR_R.taet0 - 1.2, UHR_R.taet1 + 1.2, von + 0.6, bis - 0.6);
}

/** Die Markierung einer Antwort am Tätigkeitsring (gestrichelter Rahmen). */
export function uhrAntwortRahmen(von: number, bis: number): string {
  return uhrRing(UHR_R.taet0 - 4.5, UHR_R.taet1 + 4.5, von + 0.3, bis - 0.3);
}

function sonnenMax(tag: TagModell): number {
  let max = 0;
  for (const s of tag.slots) {
    const f = Number(s.pvKw ?? 0);
    const m = Number(s.measuredPvKw ?? 0);
    if (Number.isFinite(f)) max = Math.max(max, f);
    if (Number.isFinite(m)) max = Math.max(max, m);
  }
  return max;
}

/** Die Formen der Uhr für einen Tag. */
export function uhrModell(tag: TagModell): UhrModell {
  const jetzt = tag.jetzt;

  // Tätigkeit: die laufende Phase wird am Jetzt geteilt (vorbei gedämpft).
  const phasen: UhrPhasenStueck[] = [];
  const symbole: UhrSymbol[] = [];
  for (const ph of tag.phasen) {
    const von = ph.von + 0.6;
    const bis = ph.bis - 0.6;
    if (bis <= von) continue;
    if (ph.laeuft && jetzt != null && jetzt > von && jetzt < bis) {
      phasen.push({ phaseIndex: ph.phaseIndex, role: ph.role, kind: ph.kind, d: uhrRing(UHR_R.taet0, UHR_R.taet1, von, jetzt), vorbei: true });
      phasen.push({ phaseIndex: ph.phaseIndex, role: ph.role, kind: ph.kind, d: uhrRing(UHR_R.taet0, UHR_R.taet1, jetzt, bis), vorbei: false });
    } else {
      phasen.push({ phaseIndex: ph.phaseIndex, role: ph.role, kind: ph.kind, d: uhrRing(UHR_R.taet0, UHR_R.taet1, von, bis), vorbei: ph.vorbei });
    }
    if (ph.bis - ph.von >= SYMBOL_AB_MIN) {
      const m = uhrPunkt((UHR_R.taet0 + UHR_R.taet1) / 2, (ph.von + ph.bis) / 2);
      symbole.push({ phaseIndex: ph.phaseIndex, role: ph.role, kind: ph.kind, x: m.x, y: m.y });
    }
  }

  // Preis je Viertelstunde, als Stufe zwischen günstigster und teuerster.
  const preis: UhrPreisStueck[] = [];
  const preisMarken: UhrPreisMarke[] = [];
  const pr = tag.preis;
  const spanne = pr && pr.max > pr.min ? pr.max - pr.min : 0;
  tag.viertel.forEach((v) => {
    const ct = pr ? pr.ct[v.i] : null;
    preis.push({
      i: v.i,
      // Eine Hauch-Überlappung schließt die Haarfugen zwischen den Stücken.
      d: uhrRing(UHR_R.preis0, UHR_R.preis1, v.von, Math.min(TAG_MINUTEN, v.bis + 0.3)),
      stufe: ct == null ? null : spanne > 0 ? (ct - pr!.min) / spanne : 0.5,
    });
  });

  // Sonne: ein Strahl je Viertelstunde, erwartet hell, gemessen kräftig.
  const strahlen: UhrStrahl[] = [];
  const maxKw = sonnenMax(tag);
  const strahlEnde: number[] = [];
  tag.viertel.forEach((v) => {
    const s = tag.slots[v.i];
    const mitte = (v.von + v.bis) / 2;
    let ende: number = UHR_R.strahlInnen;
    const fc = Number(s.pvKw ?? NaN);
    if (maxKw > 0 && Number.isFinite(fc) && fc > 0.05) {
      const r = UHR_R.strahlInnen + (fc / maxKw) * UHR_R.strahlMax;
      strahlen.push({ d: `M${p(UHR_R.strahlInnen, mitte)}L${p(r, mitte)}`, gemessen: false });
      ende = Math.max(ende, r);
    }
    const gm = Number(s.measuredPvKw ?? NaN);
    if (maxKw > 0 && (v.vorbei || v.laeuft) && Number.isFinite(gm) && gm > 0.05) {
      const r = UHR_R.strahlInnen + (gm / maxKw) * UHR_R.strahlMax;
      strahlen.push({ d: `M${p(UHR_R.strahlInnen, mitte)}L${p(r, mitte)}`, gemessen: true });
      ende = Math.max(ende, r);
    }
    strahlEnde[v.i] = ende;
  });

  if (pr) {
    for (const [art, i] of [['min', pr.iMin], ['max', pr.iMax]] as const) {
      const v = tag.viertel[i];
      const m = (v.von + v.bis) / 2;
      const d = `M${p(UHR_R.preis1 + 1, m)}L${p(UHR_R.preis1 + 7, m - 13.5)}L${p(UHR_R.preis1 + 7, m + 13.5)}Z`;
      const r = Math.max(UHR_R.preis1 + 20, (strahlEnde[i] ?? UHR_R.strahlInnen) + 10);
      const pos = uhrPunkt(r, m);
      preisMarken.push({ art, i, ct: pr.ct[i] as number, d, x: pos.x, y: pos.y });
    }
  }

  // Geplanter Ladestand: die Werte gelten am ENDE ihrer Viertelstunde.
  const soc = ladestandPlan(tag);
  let ladestand: UhrModell['ladestand'] = null;
  const punkte: { m: number; v: number }[] = [];
  tag.viertel.forEach((v) => {
    const s = soc[v.i];
    if (s != null) punkte.push({ m: v.bis, v: s });
  });
  if (punkte.length >= 2) {
    const kante = punkte.map((q, n) => `${n ? 'L' : 'M'}${p(socRadius(q.v), q.m)}`).join('');
    const m0 = punkte[0].m;
    const m1 = punkte[punkte.length - 1].m;
    let zurueck: string;
    if (m1 - m0 > TAG_MINUTEN / 2) {
      const mitte = (m0 + m1) / 2;
      zurueck =
        `A${UHR_R.soc0} ${UHR_R.soc0} 0 0 0 ${p(UHR_R.soc0, mitte)}` +
        `A${UHR_R.soc0} ${UHR_R.soc0} 0 0 0 ${p(UHR_R.soc0, m0)}`;
    } else {
      zurueck = `A${UHR_R.soc0} ${UHR_R.soc0} 0 0 0 ${p(UHR_R.soc0, m0)}`;
    }
    const flaeche = `M${p(UHR_R.soc0, m0)}` + kante.replace(/^M/, 'L') + `L${p(UHR_R.soc0, m1)}` + zurueck + 'Z';
    ladestand = { flaeche, kante };
  }

  const stunden: UhrStunde[] = [];
  for (let h = 0; h < 24; h++) {
    const minute = h * 60;
    const gross = h % 6 === 0;
    const beschriftet = h % 3 === 0;
    const pos = uhrPunkt(UHR_R.beschriftung, minute);
    stunden.push({
      minute,
      d: `M${p(gross ? UHR_R.marke0 : UHR_R.marke0 + 1, minute)}L${p(gross ? 186 : 182.5, minute)}`,
      gross,
      text: beschriftet ? String(h).padStart(2, '0') : null,
      x: pos.x,
      y: pos.y,
    });
  }

  return {
    phasen,
    symbole,
    preis,
    preisMarken,
    strahlen,
    ladestand,
    stunden,
    jetzt:
      jetzt == null
        ? null
        : `M${p(187, jetzt - 11)}L${p(187, jetzt + 11)}L${p(179.5, jetzt)}Z`,
  };
}
