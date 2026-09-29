/**
 * Reiter „Laden“ - die reinen Ableitungen (Prototyp `ui-laden.js`).
 *
 * Das Netzanschluss-Band liest den Ladepark-Rahmen der Box (gemessene Hauslast,
 * Grenze, Sicherheitsabstand); der Ladeplan eines Ziels ist eine SCHÄTZUNG aus
 * Prognose und Preis - Sonne zuerst, dann die günstigsten Viertelstunden bis
 * zur Uhrzeit - und heißt auch so.
 */
import type { LadeparkRahmen } from '../verbraucherZone';
import { quellenAnteil, type GeraetBild, type Reihen } from './bild';
import { N } from './zeit';

export type LadeWahl = 'aus' | 'smart' | 'schnell';
export type LadeQuelle = 'sonne' | 'min' | 'guenstig';

export function ladeWahl(g: GeraetBild): LadeWahl {
  if (g.eingriff) return g.eingriff.art === 'aus' ? 'aus' : 'schnell';
  return g.steuerart?.quelle === 'sofort' ? 'schnell' : 'smart';
}

export function ladeQuelle(g: GeraetBild): LadeQuelle | null {
  const s = g.steuerart;
  if (!s) return null;
  if (s.quelle === 'guenstig') return 'guenstig';
  if (s.quelle === 'ueberschuss') return s.ueberschussModus === 'mindestleistung' ? 'min' : 'sonne';
  return null;
}

export interface Band {
  anschlussKw: number;
  teile: { k: 'haus' | 'lp' | 'frei' | 'res'; kw: number; label: string }[];
  hausKw: number | null;
  ladenNetzKw: number;
  freiKw: number;
  ladenKw: number;
}

/** Die Aufteilung des Netzanschlusses jetzt. `null` ohne Grenze. */
export function band(rahmen: LadeparkRahmen | null | undefined, lp: GeraetBild[], rh: Reihen, t: number): Band | null {
  const anschluss = rahmen?.effektivGrenzeKw ?? rahmen?.netzanschlussKw ?? null;
  if (anschluss == null || anschluss <= 0) return null;
  const abstand = (anschluss * (rahmen?.sicherheitsabstandPct ?? 0)) / 100;
  const a = quellenAnteil(rh, t);
  let ladenNetz = 0;
  let laden = 0;
  const lps: Band['teile'] = [];
  for (const g of lp) {
    const kw = g.jetztKw ?? 0;
    if (kw <= 0.02) continue;
    laden += kw;
    const netz = kw * (a?.netz ?? 1);
    ladenNetz += netz;
    if (netz > 0.05) lps.push({ k: 'lp', kw: netz, label: g.kurz });
  }
  const haus = rahmen?.hausLastKw ?? null;
  const frei = Math.max(0, anschluss - abstand - (haus ?? 0) - ladenNetz);
  return {
    anschlussKw: anschluss,
    teile: [
      { k: 'haus', kw: haus ?? 0, label: 'Haus' },
      ...lps,
      { k: 'frei', kw: frei, label: 'frei' },
      { k: 'res', kw: abstand, label: 'Abstand' },
    ],
    hausKw: haus,
    ladenNetzKw: ladenNetz,
    freiKw: frei,
    ladenKw: laden,
  };
}

export interface Ladeplan {
  kw: (number | null)[];
  kwh: number;
  pvKwh: number;
  netzKwh: number;
  eur: number;
  fertig: number | null;
  schafft: boolean;
}

/**
 * Wie ein Ladeziel voraussichtlich erfüllt wird: mit der Ladeleistung `kw`
 * zuerst in Viertelstunden mit Überschuss (höchster zuerst), dann - wenn
 * erlaubt - in den günstigsten. Eine Schätzung; die Box plant selbst.
 */
export function ladeplan(rh: Reihen, von: number, bis: number, zielKwh: number, kw: number, nurGuenstig: boolean): Ladeplan {
  const ende = Math.min(bis, N);
  const kandidaten: { t: number; sonne: number; preis: number }[] = [];
  for (let t = von; t < ende; t++) {
    kandidaten.push({ t, sonne: Math.max(0, -(rh.netz[t] ?? 0)), preis: rh.preis[t] ?? Number.POSITIVE_INFINITY });
  }
  const reihe = nurGuenstig
    ? [...kandidaten].sort((a, b) => a.preis - b.preis)
    : [
        ...kandidaten.filter((k) => k.sonne > 0.5).sort((a, b) => b.sonne - a.sonne),
        ...kandidaten.filter((k) => k.sonne <= 0.5).sort((a, b) => a.preis - b.preis),
      ];
  const out: (number | null)[] = Array.from({ length: N }, () => null);
  let rest = zielKwh;
  let pvKwh = 0;
  let netzKwh = 0;
  let eur = 0;
  let fertig: number | null = null;
  for (const k of reihe) {
    if (rest <= 0.01) break;
    if (!Number.isFinite(k.preis) && k.sonne <= 0.5) continue;
    const e = Math.min(rest, kw / 4);
    out[k.t] = e * 4;
    const sonne = Math.min(e, k.sonne / 4);
    pvKwh += sonne;
    netzKwh += e - sonne;
    if (Number.isFinite(k.preis)) eur += ((e - sonne) * k.preis) / 100;
    rest -= e;
    fertig = fertig == null ? k.t + 1 : Math.max(fertig, k.t + 1);
  }
  return { kw: out, kwh: zielKwh - Math.max(0, rest), pvKwh, netzKwh, eur, fertig, schafft: rest <= 0.3 };
}

/** Die nächste Viertelstunde, an der es eine Uhrzeit ist („morgen 07:00“, falls heute vorbei). */
export function naechsteUhrzeit(jetzt: number, hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return jetzt;
  const t = Math.round((Number(m[1]) * 60 + Number(m[2])) / 15);
  return t > jetzt ? t : t + 96;
}
