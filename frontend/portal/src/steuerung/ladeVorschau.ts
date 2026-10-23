/**
 * „Womit laden?“ - die VORSCHAU je Ladequelle (Konzept k1 „Jede Wahl zeigt
 * ihren Tag“, Captain-Entscheid E1=B/E3=A vom 23.10.2026).
 *
 * Rein: Reihen rein, Tagesbild raus. Je Modus ein Band bis zur Abfahrt - je
 * Viertelstunde die Ladeleistung, getrennt nach Sonne, Speicher und Netz - und
 * drei Zahlen: wie viel bis zur Abfahrt möglich ist, wie viel davon Netzstrom,
 * was eine kWh im Schnitt kostet. Es ist eine SCHÄTZUNG aus Prognose und
 * Preis und heißt in jeder Fläche auch so; die Box entscheidet selbst.
 *
 * Die Regeln sind die Fachregel (`docs/verbrauchssteuerung.md`), vereinfacht
 * auf Viertelstunden - der Prototyp ist `werkzeug/sim.js` des Konzepts, seine
 * Zahlen stehen als Vektoren in `ladeVorschau.test.ts`:
 *  - Vorrang „Speicher zuerst“: der Speicher nimmt den Überschuss zuerst, das
 *    Auto den Rest; „Autos zuerst“ umgekehrt.
 *  - Nur Sonne: das Auto lädt nur, wenn sein Überschuss die Startleistung
 *    erreicht; sonst Pause. Netzstrom nie.
 *  - Sonne + Minimum: immer mindestens die Mindestleistung, Fehlendes aus dem
 *    Netz, Überschuss obendrauf.
 *  - Sonne + Speicher: über der Untergrenze bekommt das Auto den Überschuss und
 *    die Freigabe des Speichers; an der Untergrenze nur Sonne. Die Untergrenze
 *    kommt aus dem Fahrplan (`evReleaseFloorSocPct`), wo er eine trägt; sonst
 *    rechnet die Vorschau sie grob nach (rückwärts bis zur nächsten Sonne, plus
 *    Reserve - wie `storage_release.py`, nur ohne vorsichtige Prognose).
 *  - Günstig: volle Leistung, solange der BEZUGSPREIS unter der Grenze liegt.
 *  - Ladeziel: zuerst lädt der Modus selbst bis zur Menge; fehlt etwas, kommt
 *    der Rest in den billigsten freien Viertelstunden aus dem Netz (wie der
 *    Optimierer mit Frist).
 *
 * Geld: Netzstrom zum Bezugspreis der Viertelstunde (`importPriceCtKwh`),
 * Sonne und Speicher zum Einspeisewert (`exportValueCtKwh`, was die kWh sonst
 * gebracht hätte). Fehlt ein Preis, wo er gebraucht wird, gibt es keinen
 * Schnitt - unbekannt ist keine Null.
 *
 * Annahmen (Konzept Abschnitt 5, hier festgelegt):
 *  - Abfahrt ohne Ziel: der nächste Morgen 7:00, mindestens acht Stunden hin
 *    ({@link abfahrt}); mit Ziel dessen Uhrzeit.
 *  - Mehrere Ladepunkte: die Vorschau rechnet den Ladepunkt allein mit dem
 *    Überschuss der Anlage; was ein Auto weiter oben in der Reihenfolge
 *    bekommt, fehlt ihm in Wirklichkeit (die Karte nennt den Platz).
 *  - Der Hausverbrauch der Reihen enthält die Ladung dieses Ladepunkts (Plan
 *    oder Messung); sie wird herausgerechnet, sonst nähme das Auto sich selbst
 *    den Überschuss weg.
 */
import type { ChargingConfig, SchedulePlan, SiteAsset } from '../api';
import { liste } from './liste';
import type { LadeQuelle } from './laden';
import type { GeraetBild } from './bild';
import type { SeitenBild } from './seite';
import { N, uhr } from './zeit';

/** Die Länge einer Viertelstunde in Stunden. */
const DT = 0.25;

export const LADE_QUELLEN: readonly LadeQuelle[] = ['sonne', 'min', 'speicher', 'guenstig'];

/** Die Reihen, aus denen die Vorschau rechnet - je Viertelstunde des Rasters. */
export interface VorschauReihen {
  /** PV-Leistung (kW). */
  pv: readonly (number | null)[];
  /** Hausverbrauch OHNE diesen Ladepunkt (kW). */
  last: readonly (number | null)[];
  /** Ladestand des Speichers (%). */
  soc: readonly (number | null)[];
  /** Bezugspreis (ct/kWh). */
  bezug: readonly (number | null)[];
  /** Einspeisewert (ct/kWh). */
  einspeise: readonly (number | null)[];
  /** Untergrenze des Fahrplans für „Sonne + Speicher“ (%); fehlt = Vorschau rechnet selbst. */
  grenze?: readonly (number | null)[] | null;
}

export interface VorschauSpeicher {
  kapKwh: number;
  /** Lade- und Entladeleistung (kW). */
  kw: number;
  /** Mindestladestand (%), unter den nie entladen wird. */
  minPct: number;
  /** Reserve über der Untergrenze (kWh) - nur für die eigene Nachrechnung. */
  reserveKwh: number;
}

export interface VorschauRahmen {
  /** Erste Viertelstunde (jetzt). */
  t0: number;
  /** Abfahrt: erste Viertelstunde, die nicht mehr zählt. */
  t1: number;
  /** Höchste Ladeleistung des Ladepunkts (kW). */
  maxKw: number;
  /** Ab dieser Leistung lädt ein Auto überhaupt (kW, Rahmen der Box). */
  startKw: number;
  /** „Sonne + Minimum“: die Mindestleistung (kW). */
  mindestKw: number;
  speicher: VorschauSpeicher | null;
  /** Vorrang: true = Speicher zuerst (Vorgabe). */
  speicherZuerst: boolean;
  /** „Günstig“: die Preisgrenze (ct/kWh Bezugspreis); null = keine. */
  preisgrenzeCt: number | null;
  /** Ladeziel (kWh) bis zur Abfahrt; null = kein Ziel. */
  zielKwh: number | null;
}

export interface VorschauSlot {
  t: number;
  sonne: number;
  speicher: number;
  netz: number;
  /** Liegt der Bezugspreis unter der Preisgrenze? (nur „Günstig“) */
  billig: boolean;
  /** Keine Sonne in dieser Viertelstunde (für den Nacht-Schatten). */
  nacht: boolean;
}

export interface Vorschau {
  modus: LadeQuelle;
  /** Die Viertelstunden [t0, bis). */
  slots: VorschauSlot[];
  /** Erste Viertelstunde nach der Vorschau - früher als die Abfahrt, wenn Reihen fehlen. */
  bis: number;
  /** Fehlen Reihen vor der Abfahrt? */
  gekuerzt: boolean;
  kwh: number;
  sonneKwh: number;
  speicherKwh: number;
  netzKwh: number;
  /** Ø ct/kWh; null, wenn ein gebrauchter Preis fehlt oder nichts lädt. */
  ctKwh: number | null;
  /** Letzte Viertelstunde mit Ladung + 1; null = lädt nicht. */
  fertig: number | null;
  /** Mit Ziel: wird die Menge bis zur Abfahrt erreicht? null = kein Ziel. */
  schafft: boolean | null;
  /** Rechnet „Sonne + Speicher“ mit der Untergrenze des Fahrplans (true) oder selbst (false)? */
  grenzeAusPlan: boolean;
  /** Ladestand des Speichers unbekannt: er bleibt in der Vorschau außen vor. */
  speicherUnbekannt: boolean;
}

const zahl = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Die Abfahrt: mit Ziel dessen Uhrzeit, ohne Ziel der nächste Morgen 7:00 -
 * liegt der weniger als vier Stunden voraus (es ist früher Morgen), der Morgen
 * danach. Nie hinter das Raster.
 */
export function abfahrt(jetzt: number, zielBis: string | null | undefined, n: number): number {
  const hhmm = /^(\d{1,2}):(\d{2})$/.exec(zielBis ?? '') ? (zielBis as string) : '07:00';
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm)!;
  let t = Math.round((Number(m[1]) * 60 + Number(m[2])) / 15);
  while (t <= jetzt) t += 96;
  if (!zielBis && t - jetzt < 16) t += 96;
  return Math.min(t, n);
}

/** Das q-Quantil einer Liste (linear zwischen den Nachbarn). */
export function quantil(werte: readonly number[], q: number): number | null {
  if (!werte.length) return null;
  const s = [...werte].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

/**
 * Die eigene Untergrenze (kWh je Viertelstunde), rückwärts ab der nächsten
 * Sonne nach einer Nacht: E(t) = E(t+1) + Defizit, Überschuss füllt wieder auf,
 * nie unter Mindestladestand + Reserve und nie über die Kapazität.
 */
function eigeneUntergrenze(r: VorschauReihen, t0: number, bis: number, sp: VorschauSpeicher): (number | null)[] {
  const emin = (sp.kapKwh * sp.minPct) / 100;
  let ende = bis;
  let nacht = false;
  for (let t = t0; t < bis; t++) {
    const s = (r.pv[t] ?? 0) - (r.last[t] ?? 0);
    if (s < 0) nacht = true;
    if (nacht && s > 0.05) { ende = t; break; }
  }
  const g: (number | null)[] = [];
  let e = emin + sp.reserveKwh;
  for (let t = ende - 1; t >= t0; t--) {
    const s = (r.pv[t] ?? 0) - (r.last[t] ?? 0);
    e = s < 0 ? e + Math.min(-s, sp.kw) * DT : e - Math.min(s, sp.kw) * DT;
    e = Math.max(emin + sp.reserveKwh, Math.min(sp.kapKwh, e));
    g[t] = e;
  }
  return g;
}

/** Trägt der Fahrplan im Fenster eine Untergrenze? */
function planGrenze(r: VorschauReihen, t0: number, bis: number): boolean {
  if (!r.grenze) return false;
  for (let t = t0; t < bis; t++) if (zahl(r.grenze[t])) return true;
  return false;
}

/** Die Vorschau EINES Modus. */
export function ladeVorschau(modus: LadeQuelle, r: VorschauReihen, o: VorschauRahmen): Vorschau {
  const { t0, t1, maxKw, startKw, mindestKw, speicherZuerst } = o;
  // Die Vorschau reicht nur so weit, wie Sonne und Verbrauch bekannt sind.
  let bis = t0;
  while (bis < t1 && zahl(r.pv[bis]) && zahl(r.last[bis])) bis++;
  let socStart: number | null = null;
  for (let t = t0; t < Math.min(bis, t0 + 4); t++) if (zahl(r.soc[t])) { socStart = r.soc[t] as number; break; }
  const sp = o.speicher && socStart != null ? o.speicher : null;
  const emin = sp ? (sp.kapKwh * sp.minPct) / 100 : 0;
  const ausPlan = modus === 'speicher' && sp != null && planGrenze(r, t0, bis);
  const grenze: (number | null)[] | null = modus !== 'speicher' || !sp ? null
    : ausPlan ? Array.from({ length: bis + 1 }, (_, t) => (zahl(r.grenze?.[t]) ? ((r.grenze![t] as number) / 100) * sp.kapKwh : null))
      : eigeneUntergrenze(r, t0, bis, sp);
  let e = sp ? ((socStart as number) / 100) * sp.kapKwh : 0;
  const slots: VorschauSlot[] = [];
  for (let t = t0; t < bis; t++) {
    const s = (r.pv[t] as number) - (r.last[t] as number);
    const bezug = r.bezug[t];
    const billig = modus === 'guenstig' && o.preisgrenzeCt != null && zahl(bezug) && bezug < o.preisgrenzeCt;
    let aSonne = 0;
    let aSpeicher = 0;
    let aNetz = 0;
    let lade = 0;
    let entlade = 0;
    // Das Haus zuerst: fehlt Sonne, deckt der Speicher bis zum Mindestladestand.
    if (sp && s < 0) entlade = Math.min(-s, sp.kw, Math.max(0, (e - emin) / DT));
    const platz = sp ? Math.max(0, (sp.kapKwh - e) / DT) : 0;
    if (modus === 'guenstig') {
      if (billig) {
        const auto = maxKw;
        aSonne = Math.min(auto, Math.max(0, s));
        aNetz = auto - aSonne;
      }
      if (sp && s > aSonne) lade = Math.min(s - aSonne, sp.kw, platz);
    } else {
      // Die Untergrenze gilt am Ende der Viertelstunde: nimmt das Auto den Überschuss,
      // lädt der Speicher in ihr nicht - das darf ihn nicht unter die nächste Grenze bringen.
      const naechste = grenze ? (grenze[t + 1] ?? grenze[t]) : null;
      const nachHaus = e - entlade * DT;
      const ueber = sp != null && naechste != null && nachHaus > naechste + 0.05;
      if (ueber) {
        const frei = Math.min(sp.kw - entlade, (nachHaus - naechste) / DT);
        const roh = Math.max(0, s) + Math.max(0, frei);
        if (roh >= startKw) {
          const auto = Math.min(maxKw, roh);
          aSonne = Math.min(auto, Math.max(0, s));
          aSpeicher = auto - aSonne;
        }
        if (s > aSonne) lade = Math.min(s - aSonne, sp.kw, platz);
      } else if (speicherZuerst) {
        if (sp && s > 0) lade = Math.min(s, sp.kw, platz);
        const rest = Math.max(0, s - lade);
        if (modus === 'min') {
          const auto = Math.min(maxKw, Math.max(mindestKw, rest));
          aSonne = Math.min(auto, rest);
          aNetz = auto - aSonne;
        } else if (rest >= startKw) {
          aSonne = Math.min(maxKw, rest);
        }
      } else {
        // Autos zuerst: das Auto nimmt den Überschuss, der Speicher den Rest.
        const ueberschuss = Math.max(0, s);
        if (modus === 'min') {
          const auto = Math.min(maxKw, Math.max(mindestKw, ueberschuss));
          aSonne = Math.min(auto, ueberschuss);
          aNetz = auto - aSonne;
        } else if (ueberschuss >= startKw) {
          aSonne = Math.min(maxKw, ueberschuss);
        }
        if (sp && s > aSonne) lade = Math.min(s - aSonne, sp.kw, platz);
      }
    }
    if (sp) e = Math.max(emin, Math.min(sp.kapKwh, e + (lade - entlade - aSpeicher) * DT));
    slots.push({ t, sonne: aSonne, speicher: aSpeicher, netz: aNetz, billig, nacht: (r.pv[t] as number) < 0.05 });
  }
  if (o.zielKwh != null && o.zielKwh > 0) zielAnwenden(slots, r, o.zielKwh, maxKw);
  return zusammenfassen(modus, slots, r, {
    bis, gekuerzt: bis < t1, schafft: o.zielKwh != null && o.zielKwh > 0 ? zielErreicht(slots, o.zielKwh) : null,
    grenzeAusPlan: ausPlan, speicherUnbekannt: o.speicher != null && socStart == null,
  });
}

/**
 * Das Ziel: die eigene Ladung des Modus endet, sobald die Menge erreicht ist;
 * fehlt etwas, lädt der Rest in den billigsten freien Viertelstunden aus dem
 * Netz. Ohne bekannten Bezugspreis gilt eine Viertelstunde nicht als billig.
 */
function zielAnwenden(slots: VorschauSlot[], r: VorschauReihen, zielKwh: number, maxKw: number) {
  let summe = 0;
  for (const s of slots) {
    const e = (s.sonne + s.speicher + s.netz) * DT;
    if (summe >= zielKwh - 1e-6) { s.sonne = 0; s.speicher = 0; s.netz = 0; continue; }
    if (summe + e > zielKwh) {
      const f = (zielKwh - summe) / e;
      s.sonne *= f; s.speicher *= f; s.netz *= f;
      summe = zielKwh;
    } else summe += e;
  }
  let rest = zielKwh - summe;
  if (rest <= 0.05) return;
  const frei = slots.filter((s) => s.sonne + s.speicher + s.netz < 0.05 && zahl(r.bezug[s.t]))
    .sort((a, b) => (r.bezug[a.t] as number) - (r.bezug[b.t] as number) || a.t - b.t);
  for (const s of frei) {
    if (rest <= 0.05) break;
    const e = Math.min(rest, maxKw * DT);
    s.netz = e / DT;
    rest -= e;
  }
}

function zielErreicht(slots: VorschauSlot[], zielKwh: number): boolean {
  return zielKwh - slots.reduce((a, s) => a + (s.sonne + s.speicher + s.netz) * DT, 0) <= 0.3;
}

function zusammenfassen(
  modus: LadeQuelle, slots: VorschauSlot[], r: VorschauReihen,
  rest: Pick<Vorschau, 'bis' | 'gekuerzt' | 'schafft' | 'grenzeAusPlan' | 'speicherUnbekannt'>,
): Vorschau {
  let sonne = 0;
  let speicher = 0;
  let netz = 0;
  let kosten = 0;
  let preisFehlt = false;
  let fertig: number | null = null;
  for (const s of slots) {
    sonne += s.sonne * DT;
    speicher += s.speicher * DT;
    netz += s.netz * DT;
    if (s.netz > 0.005) {
      const b = r.bezug[s.t];
      if (zahl(b)) kosten += s.netz * DT * b; else preisFehlt = true;
    }
    if (s.sonne + s.speicher > 0.005) {
      const w = r.einspeise[s.t];
      if (zahl(w)) kosten += (s.sonne + s.speicher) * DT * w; else preisFehlt = true;
    }
    if (s.sonne + s.speicher + s.netz > 0.05) fertig = s.t + 1;
  }
  const kwh = sonne + speicher + netz;
  return {
    modus, slots, ...rest, kwh, sonneKwh: sonne, speicherKwh: speicher, netzKwh: netz,
    ctKwh: kwh > 0.05 && !preisFehlt ? kosten / kwh : null, fertig,
  };
}

/** Zusammenhängende Ladezeiten als [von, bis). */
export function laeufe(v: Pick<Vorschau, 'slots'>): [number, number][] {
  const out: [number, number][] = [];
  let cur: [number, number] | null = null;
  for (const s of v.slots) {
    const an = s.sonne + s.speicher + s.netz > 0.05;
    if (an && !cur) cur = [s.t, s.t + 1];
    else if (an && cur) cur[1] = s.t + 1;
    else if (!an && cur) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out;
}

const NF1 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const NF0 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
/** Geschütztes Leerzeichen vor der Einheit (UEMS-Zahlenformat). */
const NB = ' ';
const minus = (s: string) => s.replace('-', '−');

/** „7,4 kW“. */
export const kwText = (v: number) => `${NF1.format(v)}${NB}kW`;
/** Eine Menge über Stunden: ganze kWh („24 kWh“). */
export const kwhText = (v: number) => `${NF0.format(v)}${NB}kWh`;
/** Ein Schnitt in ganzen Cent („8 ct“). */
export const ctText = (v: number) => minus(`${NF0.format(v)}${NB}ct`);
/** „07:00“ ohne führende Null („7:00“) - die Abfahrt als kurze Uhrzeit. */
export const uhrKurz = (t: number) => uhr(t).replace(/^0/, '');

/**
 * Die zwei kurzen Sätze unter dem Band: was jetzt passiert und wie es weiter
 * geht („Jetzt 7,4 kW aus Sonne“ · „Pause ab 17:30 Uhr“).
 */
export function vorschauSaetze(v: Vorschau, abfahrtT: number): { jetzt: string; dann: string | null } {
  const s0 = v.slots[0];
  const l = laeufe(v);
  const bis = uhrKurz(abfahrtT);
  let jetzt: string;
  const p = s0 ? s0.sonne + s0.speicher + s0.netz : 0;
  if (s0 && p > 0.05) {
    const teile = [s0.sonne > 0.05 ? 'Sonne' : null, s0.speicher > 0.05 ? 'Speicher' : null, s0.netz > 0.05 ? 'Netz' : null].filter(Boolean);
    jetzt = `Jetzt ${kwText(p)} aus ${teile.join(' + ')}`;
  } else jetzt = l.length ? `Lädt ab ${uhrKurz(l[0][0])} Uhr` : `Lädt bis ${bis} nicht`;
  let dann: string | null = null;
  if (l.length) {
    const ende = l[0][1];
    if (ende >= v.bis) dann = v.gekuerzt ? `durchgehend, soweit die Prognose reicht` : `durchgehend bis ${bis}`;
    else if (l.length > 1) dann = `Pause ${uhrKurz(ende)} bis ${uhrKurz(l[1][0])} Uhr`;
    else dann = `Pause ab ${uhrKurz(ende)} Uhr`;
  }
  return { jetzt, dann };
}

// ---------------------------------------------------------------------------
// Aus den Daten der Seite
// ---------------------------------------------------------------------------

/** Was die Vorschau von der Anlage braucht - einmal je Seite. */
export interface VorschauAnlage {
  speicher: VorschauSpeicher | null;
  speicherZuerst: boolean;
  /** Startleistung je Auto (Rahmen der Box). */
  startKw: number;
}

/** Mindestleistung je Auto, wenn der Rahmen keine meldet (Vorgabe der Box). */
export const START_KW_VORGABE = 1.4;

/**
 * Speicher (Summe der Speicher der Anlage), Vorrang und Startleistung. Ohne
 * Kapazität oder Leistung kein Speicher in der Vorschau - geraten wird nicht.
 */
export function vorschauAnlage(
  assets: readonly SiteAsset[] | null | undefined,
  plan: Pick<SchedulePlan, 'effectiveFloorSocPct'> | null | undefined,
  config: Pick<ChargingConfig, 'storagePriority' | 'storageReleaseReserveKwh' | 'storageReleaseReserveStandardKwh'> | null | undefined,
  mindestleistungKw: number | null | undefined,
): VorschauAnlage {
  let kap = 0;
  let kw = 0;
  for (const a of liste(assets)) {
    if (a.type !== 'battery' || !zahl(a.capacityKwh) || a.capacityKwh <= 0) continue;
    const p = Math.min(a.maxChargeKw ?? Infinity, a.maxDischargeKw ?? Infinity);
    if (!Number.isFinite(p) || p <= 0) continue;
    kap += a.capacityKwh;
    kw += p;
  }
  return {
    speicher: kap > 0 ? {
      kapKwh: kap, kw,
      minPct: zahl(plan?.effectiveFloorSocPct) ? plan.effectiveFloorSocPct : 10,
      reserveKwh: config?.storageReleaseReserveKwh ?? config?.storageReleaseReserveStandardKwh ?? 1,
    } : null,
    speicherZuerst: (config?.storagePriority ?? 'speicher_vor_auto') === 'speicher_vor_auto',
    startKw: zahl(mindestleistungKw) && mindestleistungKw > 0 ? mindestleistungKw : START_KW_VORGABE,
  };
}

/** Eine Wahl im Blatt: Modus, Ziel und Preisgrenze. */
export interface LadeWahlEntwurf {
  modus: LadeQuelle;
  /** kWh bis zur Ziel-Uhrzeit; 0 = kein Ziel. */
  zielKwh: number;
  /** Uhrzeit des Ziels („07:00“). */
  zielBis: string;
  preisgrenzeCt: number | null;
}

/**
 * Die Vorschau eines Ladepunkts für eine Wahl. Der Hausverbrauch JETZT ist
 * gemessen und enthält die laufende Ladung dieses Ladepunkts - sie wird
 * herausgerechnet. Die Viertelstunden danach kommen aus dem Fahrplan, dessen
 * Last nur die Grundlast trägt (die Ladepunkte plant er selbst).
 */
export function vorschauFuer(bild: Pick<SeitenBild, 'raster' | 'reihen' | 'jetztGemessen'>, g: Pick<GeraetBild, 'nennKw' | 'jetztKw' | 'steuerart'>,
  anlage: VorschauAnlage, w: LadeWahlEntwurf): { vorschau: Vorschau; abfahrt: number } {
  const rh = bild.reihen;
  const t0 = bild.raster.jetzt;
  const t1 = abfahrt(t0, w.zielKwh > 0 ? w.zielBis : null, N);
  const last = rh.last.slice();
  if (bild.jetztGemessen && zahl(last[t0]) && zahl(g.jetztKw)) last[t0] = Math.max(0, (last[t0] as number) - g.jetztKw);
  const mindest = g.steuerart?.mindestleistungKw;
  const vorschau = ladeVorschau(w.modus, {
    pv: rh.pv, last, soc: rh.soc, bezug: rh.bezug, einspeise: rh.einspeise, grenze: rh.speicherGrenze ?? null,
  }, {
    t0, t1, maxKw: g.nennKw ?? 11, startKw: anlage.startKw,
    mindestKw: zahl(mindest) && mindest > 0 ? mindest : anlage.startKw,
    speicher: anlage.speicher, speicherZuerst: anlage.speicherZuerst,
    preisgrenzeCt: w.modus === 'guenstig' ? w.preisgrenzeCt : null,
    zielKwh: w.zielKwh > 0 ? w.zielKwh : null,
  });
  return { vorschau, abfahrt: t1 };
}

/** Ohne Auto ist „Jetzt …“ eine Annahme: „Mit Auto: jetzt 7,4 kW aus Sonne“. */
export function mitAuto(jetzt: string, angesteckt: boolean): string {
  return angesteckt ? jetzt : `Mit Auto: ${jetzt.replace(/^Jetzt /, 'jetzt ').replace(/^Lädt /, 'lädt ')}`;
}
