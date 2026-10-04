/**
 * Reiter „Laden“ - die reinen Ableitungen (Prototyp `ui-laden.js`).
 *
 * Das Netzanschluss-Band liest den Ladepark-Rahmen der Box (gemessene Hauslast,
 * Grenze, Sicherheitsabstand); der Ladeplan eines Ziels ist eine SCHÄTZUNG aus
 * Prognose und Preis - Sonne zuerst, dann die günstigsten Viertelstunden bis
 * zur Uhrzeit - und heißt auch so.
 *
 * Die Anschlussgrenze prüft das Rahmen-Blatt wie der Server (`PUT
 * /charging-frame`, AP-01 IP-13) gegen den heute gebundenen Netzanschluss,
 * die Grundlast der letzten 7 Tage und die Hausreserve - mit demselben Grund.
 */
import type { Netzanschluss } from '../api';
import { KW, zahl as ergebnisZahl } from '../uemsErgebnis';
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

// ---------------------------------------------------------------------------
// Anschlussgrenze gegen den Netzanschluss (AP-01 IP-13)
// ---------------------------------------------------------------------------

/** Der Netzanschluss der Anlage zum heutigen Tag, wie das Rahmen-Blatt ihn kennt. */
export type AnschlussStand =
  | { zustand: 'laden' }
  | { zustand: 'fehler' }
  | { zustand: 'ungebunden' }
  | { zustand: 'gebunden'; kennzeichen: string; vereinbartKw: number | null };

/** Das Datum in der Zeitzone des Browsers - so liest auch der Netzanschluss-Stichtag. */
export function lokalesDatum(datum: Date): string {
  const jahr = datum.getFullYear();
  const monat = String(datum.getMonth() + 1).padStart(2, '0');
  const tag = String(datum.getDate()).padStart(2, '0');
  return `${jahr}-${monat}-${tag}`;
}

function nummer(wert: string | number | null | undefined): number | null {
  if (wert == null || wert === '') return null;
  const n = Number(wert);
  return Number.isFinite(n) ? n : null;
}

/**
 * Die heute laufende Bindung der Anlage. Nur sie zählt: eine beendete oder erst
 * künftige Bindung gilt heute nicht (der Server prüft gegen dieselbe).
 */
export function heutigerAnschluss(liste: readonly Netzanschluss[], anlageId: string, heute: string): AnschlussStand {
  const gebunden = liste.find((n) => n.anlagen.some((b) =>
    b.anlage.id === anlageId && b.gueltig_ab <= heute && (b.gueltig_bis == null || b.gueltig_bis >= heute)));
  if (!gebunden) return { zustand: 'ungebunden' };
  return { zustand: 'gebunden', kennzeichen: gebunden.kennzeichen, vereinbartKw: nummer(gebunden.vereinbart_kw) };
}

/** Eine Leistung im Wortlaut der Grenzprüfung („200 kW“). */
export const kwVereinbart = (wert: number) => ergebnisZahl(wert, KW, null, 'vereinbart');

/** Was nach Grundlast und Hausreserve innerhalb der Grenze zum Laden bleibt; `null` ohne beide. */
export function ladebudgetKw(grenzeKw: number | null, grundlastKw: number | null, reserveKw: number | null): number | null {
  return grenzeKw != null && grundlastKw != null && reserveKw != null ? grenzeKw - grundlastKw - reserveKw : null;
}

/**
 * Der Grund, aus dem eine Anschlussgrenze nicht übernommen werden kann - `null`,
 * wenn sie besteht. Ohne Bindung prüft sie gegen den Übergangswert des Blatts;
 * fehlt der noch, entscheidet das Blatt beim Übernehmen.
 */
export function grenzePruefung(
  grenzeKw: number | null,
  anschluss: AnschlussStand,
  uebergangKw: number | null,
  grundlastKw: number | null,
  reserveKw: number | null,
): string | null {
  if (grenzeKw == null || !Number.isFinite(grenzeKw)) return null;
  if (anschluss.zustand === 'fehler') return 'Der Netzanschluss konnte nicht geprüft werden. Versuchen Sie es erneut.';
  if (anschluss.zustand === 'gebunden' && anschluss.vereinbartKw == null) {
    return `Beim Netzanschluss ${anschluss.kennzeichen} ist keine vereinbarte Leistung hinterlegt.`;
  }
  const vereinbartKw = anschluss.zustand === 'gebunden' ? anschluss.vereinbartKw
    : anschluss.zustand === 'ungebunden' ? uebergangKw : null;
  if (vereinbartKw == null) return null;
  if (grenzeKw > vereinbartKw) {
    return `${kwVereinbart(grenzeKw)} liegen über ${kwVereinbart(vereinbartKw)} vereinbarter Leistung — bitte prüfen.`;
  }
  if (grundlastKw == null || reserveKw == null) {
    return 'Für die Prüfung fehlen die Grundlast der letzten 7 Tage oder die Hausreserve.';
  }
  if (grenzeKw - grundlastKw - reserveKw <= 0) {
    return 'Grundlast und Hausreserve lassen innerhalb der Anschlussgrenze kein Ladebudget übrig.';
  }
  return null;
}
