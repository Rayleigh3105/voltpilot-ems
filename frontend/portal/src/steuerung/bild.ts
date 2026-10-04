/**
 * DAS BILD DER STEUERUNG — die reine Ableitung hinter der Seite
 * (Konzept `docs/konzepte/steuerung`, Prototyp `quelle/sim.js` + `ui-basis.js`).
 *
 * Rein: keine Netzaufrufe, kein React, keine Uhr ausser der übergebenen. Aus
 * den Antworten, die das Portal ohnehin liest, entsteht EIN Bild: die Reihen
 * des Tages (Sonne, Haus, Netz, Speicher, Preis, Temperatur), je gesteuertem
 * Gerät seine Viertelstunden, sein Zustand jetzt mit einem Satz, und die
 * Reihenfolge.
 *
 * Die Ehrlichkeitsregeln, die der Prototyp noch nicht brauchte:
 *
 *  1. **Unbekannt ist keine Null.** Eine Reihe ohne Beleg ist `null`, und die
 *     Fläche zeichnet dort nichts. Ein Gerät ohne Messung zeigt „nicht
 *     gemessen", nie „0,0 kW“.
 *  2. **Gemessen, Plan und Erwartung sind drei Dinge.** Vor „jetzt“ steht, was
 *     gemessen wurde; danach der Fahrplan des Optimierers, wo er das Gerät
 *     plant; sonst - und nur dann - die ERWARTUNG aus dem Smart-Auftrag und der
 *     Prognose (`erwartet`). Die Fläche sagt, welches davon sie zeigt.
 *  3. **Die Herkunft eines Geräts ist anteilig.** Welcher Teil seiner Leistung
 *     aus Sonne, Speicher oder Netz kam, misst niemand je Gerät; es ist der
 *     Anteil der Anlage in dieser Viertelstunde (`quellenAnteil`).
 *  4. **Der Zustand kommt von der Box.** Der Satz eines Geräts übersetzt nur,
 *     was gemeldet ist (`consumer-status`, Ladepunkt-Meldung, Eingriff); ohne
 *     Meldung heißt er „Zustand nicht bestätigt“.
 */
import { liste } from './liste';
import type {
  History,
  PriceSeries,
  SchedulePlan,
  SiteInterventions,
  TelemetryPoint,
  WeatherForecast,
} from '../api';
import type { ConsumerSchedule } from '../consumerSchedule';
import type { Consumer } from '../consumers/types';
import type { ConsumerRuntimeStatus } from '../consumers/status';
import { CONSUMER_REASON_TEXT, CONSUMER_STATE_TEXT, STATUS_UNKNOWN_TEXT } from '../consumers/status';
import type { ManualOverride } from '../consumers/fulfillment';
import type { ChargePoint, ChargeConnector, SiteCharging } from '../ladepunkte';
import { ladeZustand, aktuelleLeistung } from '../ladepunkte';
import type {
  RanglisteEintrag,
  SiteVerbraucher,
  Steuerart,
  VerbraucherEintrag,
} from '../verbraucherZone';
import {
  N,
  TAG,
  aufzaehlung,
  fCt,
  fGrad,
  fKw,
  fPct,
  leer,
  slotVon,
  uhr,
  uhrTag,
  uhrVon,
  type Raster,
  zahl1,
  zahl0,
} from './zeit';

// ---------------------------------------------------------------------------
// Die Reihen des Tages
// ---------------------------------------------------------------------------

export interface Reihen {
  /** PV-Leistung (kW). */
  pv: (number | null)[];
  /** Hausverbrauch am Netzanschluss gemessen, inklusive der Geräte (kW). */
  last: (number | null)[];
  /** Netz: + Bezug, − Einspeisung (kW). */
  netz: (number | null)[];
  /** Speicher: + laden, − entladen (kW). */
  bat: (number | null)[];
  /** Ladestand (%). */
  soc: (number | null)[];
  /** Börsenpreis (ct/kWh). */
  preis: (number | null)[];
  /** Außentemperatur (°C). */
  temp: (number | null)[];
  /** Laut Plan abgeregelte PV (kW). */
  abgeregelt: (number | null)[];
  /** Viertelstunden vor diesem Index sind GEMESSEN (bis „jetzt“). */
  gemessenBis: number;
  /** Sind die Börsenpreise für morgen schon da? */
  morgenBekannt: boolean;
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

export interface ReihenInput {
  raster: Raster;
  verlauf?: History | null;
  plan?: SchedulePlan | null;
  preise?: PriceSeries | null;
  wetter?: WeatherForecast | null;
  live?: TelemetryPoint[] | null;
}

export function reihen(i: ReihenInput): Reihen {
  const r = i.raster;
  const out: Reihen = {
    pv: leer(), last: leer(), netz: leer(), bat: leer(), soc: leer(), preis: leer(),
    temp: leer(), abgeregelt: leer(), gemessenBis: r.jetzt, morgenBekannt: false,
  };
  // Zukunft: der jüngste Fahrplan.
  for (const s of liste(i.plan?.slots)) {
    const t = slotVon(r, s.start);
    if (t == null) continue;
    out.pv[t] = num(s.pvKw);
    out.last[t] = num(s.loadKw);
    out.netz[t] = num(s.gridKw);
    out.bat[t] = num(s.batteryKw);
    out.soc[t] = num(s.socPct);
    out.abgeregelt[t] = num(s.curtailKw);
    const p = num(s.priceEurMwh);
    if (p != null) out.preis[t] = p / 10;
  }
  // Vergangenheit: die gemessenen Viertelstunden des Tages (kWh → kW).
  for (const b of liste(i.verlauf?.buckets)) {
    const t = slotVon(r, b.start);
    if (t == null || t >= r.jetzt) continue;
    const kw = (v: number | null) => (v == null ? null : v * 4);
    const pv = kw(num(b.pvKwh));
    const last = kw(num(b.loadKwh));
    const imp = kw(num(b.gridImportKwh));
    const exp = kw(num(b.gridExportKwh));
    const lad = kw(num(b.batteryChargeKwh));
    const ent = kw(num(b.batteryDischargeKwh));
    out.pv[t] = pv;
    out.last[t] = last;
    out.netz[t] = imp == null && exp == null ? null : (imp ?? 0) - (exp ?? 0);
    out.bat[t] = lad == null && ent == null ? null : (lad ?? 0) - (ent ?? 0);
    out.soc[t] = num(b.socLastPct);
    out.abgeregelt[t] = null;
    const p = num(b.priceEurMwh);
    if (p != null) out.preis[t] = p / 10;
  }
  // Jetzt: die jüngste Telemetrie (höchstens 20 Minuten alt).
  const live = jetztWerte(i.live, r.nowMs);
  if (live) {
    const t = r.jetzt;
    if (live.pv != null) out.pv[t] = live.pv;
    if (live.last != null) out.last[t] = live.last;
    if (live.netz != null) out.netz[t] = live.netz;
    if (live.soc != null) out.soc[t] = live.soc;
    if (live.bat != null) out.bat[t] = live.bat;
  }
  // Preise: die Börse selbst (sie ist die Quelle, auch für die Vergangenheit).
  for (const p of liste(i.preise?.points)) {
    const t = slotVon(r, p.ts);
    const v = num(p.priceEurMwh);
    if (t == null || v == null) continue;
    // Stundenpreise decken vier Viertelstunden.
    const ende = Date.parse(p.end);
    const dauer = Number.isFinite(ende) ? Math.max(1, Math.round((ende - Date.parse(p.ts)) / 900_000)) : 1;
    for (let k = 0; k < dauer && t + k < N; k++) out.preis[t + k] = v / 10;
  }
  for (const w of liste(i.wetter?.points)) {
    const t = slotVon(r, w.ts);
    const v = num(w.temperatureC);
    if (t == null || v == null) continue;
    for (let k = 0; k < 4 && t + k < N; k++) if (out.temp[t + k] == null || k === 0) out.temp[t + k] = v;
  }
  out.morgenBekannt = out.preis.slice(TAG).some((v) => v != null);
  return out;
}

export interface JetztWerte {
  pv: number | null;
  last: number | null;
  netz: number | null;
  soc: number | null;
  bat: number | null;
  ts: string;
}

/** Der jüngste Messpunkt, wenn er frisch ist (≤ 20 Minuten); sonst null. */
export function jetztWerte(punkte: TelemetryPoint[] | null | undefined, nowMs: number): JetztWerte | null {
  const p = [...(punkte ?? [])].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0];
  if (!p) return null;
  const alter = nowMs - Date.parse(p.ts);
  if (!Number.isFinite(alter) || alter > 20 * 60_000) return null;
  const pv = num(p.pvPowerKw);
  const last = num(p.loadKw);
  const netz = num(p.powerKw);
  // Der Speicher ergibt sich aus der Bilanz am Netzanschluss: was die Sonne und
  // das Netz liefern und das Haus nicht braucht, geht in den Speicher.
  const bat = pv != null && last != null && netz != null ? pv + netz - last : null;
  return { pv, last, netz, soc: num(p.socPct), bat, ts: p.ts };
}

/** Die Herkunft des Verbrauchs einer Viertelstunde, als Anteile (Summe 1). */
export interface Anteil {
  pv: number;
  sp: number;
  netz: number;
}

/**
 * Woher der Verbrauch der Anlage in einer Viertelstunde kam: Netzbezug und
 * Speicher-Entladung sind gemessen oder geplant, der Rest ist Sonne. Ein Gerät
 * bekommt denselben Anteil (Regel 3 oben) - `null`, wo die Bilanz fehlt.
 */
export function quellenAnteil(rh: Reihen, t: number): Anteil | null {
  const last = rh.last[t];
  if (last == null || last <= 0.01) return null;
  const imp = Math.max(0, rh.netz[t] ?? 0);
  const ent = Math.max(0, -(rh.bat[t] ?? 0));
  if (rh.netz[t] == null && rh.pv[t] == null) return null;
  const netz = Math.min(1, imp / last);
  const sp = Math.min(1 - netz, ent / last);
  return { pv: Math.max(0, 1 - netz - sp), sp, netz };
}

// ---------------------------------------------------------------------------
// Die Geräte
// ---------------------------------------------------------------------------

export type Form = 'stufenlos' | 'stufig' | 'schalten' | 'freigabe';
export type PillArt = 'on' | 'wait' | 'off' | 'hand' | 'lock' | 'done' | 'stale';
export type Symbol =
  | 'car' | 'flame' | 'heatpump' | 'waves' | 'thermo' | 'snow' | 'washer' | 'wind'
  | 'heater' | 'plug' | 'droplet' | 'fan' | 'dish' | 'sauna' | 'sprout' | 'cpu' | 'battery';

export interface Eingriff {
  art: 'an' | 'aus';
  bisMs: number | null;
}

export interface LadepunktBezug {
  chargePointId: string;
  connectorId: number;
  angesteckt: boolean;
  sitzungSeit: string | null;
  sitzungKwh: number | null;
  karte: string | null;
  laedt: boolean;
}

export interface GeraetBild {
  id: string;
  name: string;
  kurz: string;
  symbol: Symbol;
  typ: string;
  typLabel: string;
  form: Form;
  ladepunkt: LadepunktBezug | null;
  /** Wird die Leistung gemessen (oder nur angenommen)? */
  gemessen: boolean;
  nennKw: number | null;
  stufenKw: number[] | null;
  steuerart: Steuerart | null;
  /** Noch kein Auftrag gewählt (Server: Herkunft `ohne`). */
  ohneAuftrag: boolean;
  /** Läuft mit Sonnenstrom und steht damit in der Reihenfolge. */
  sonnig: boolean;
  schreibbar: boolean;
  nichtSchreibbarGrund: string | null;
  eintrag: VerbraucherEintrag;
  consumer: Consumer | null;
  status: ConsumerRuntimeStatus | null;
  /** Leistung je Viertelstunde: gemessen, Plan oder erwartet (siehe `herkunft`). */
  kw: (number | null)[];
  herkunft: ('gemessen' | 'plan' | 'erwartet' | null)[];
  jetztKw: number | null;
  an: boolean | null;
  pill: [PillArt, string];
  /** Der Satz „warum“ - kurz (Karte) und lang (Blatt). */
  warum: string;
  warumLang: string;
  eingriff: Eingriff | null;
  /** Die Regel, die das Gerät gerade einschaltet (ihr Name), sonst null. */
  regelJetzt: string | null;
  /** Der Smart-Auftrag als kurzer Satz („Mit Sonnenstrom ab 2,0 kW“). */
  auftrag: string;
  regeln: number;
}

export interface SpeicherBild {
  name: string;
  kwh: number | null;
  kw: number | null;
  soc: number | null;
  /** + laden, − entladen; null = nicht gemessen. */
  jetztKw: number | null;
  reservePct: number | null;
  pill: [PillArt, string];
  warum: string;
}

const SYMBOL_TYP: Record<string, Symbol> = {
  wallbox: 'car', 'ev-charger': 'car', 'heating-rod': 'flame', 'heat-pump-sgready': 'heatpump',
  pump: 'droplet', 'generic-load': 'plug', 'modbus-load': 'cpu',
};

/**
 * Das Symbol aus dem Typ - und für eine „Steuerbare Last“ aus dem Namen, den
 * der Kunde vergeben hat. Nur das BILD folgt dem Namen, nie eine Fähigkeit.
 */
export function symbolFuer(typ: string, name: string): Symbol {
  const n = name.toLowerCase();
  if (/pool/.test(n) && /wärme|waerme|wp\b/.test(n)) return 'thermo';
  if (/pool|teich|schwimm/.test(n)) return 'waves';
  if (/wasch/.test(n)) return 'washer';
  if (/trockn/.test(n)) return 'wind';
  if (/spül|spuel/.test(n)) return 'dish';
  if (/klima|kühl|kuehl/.test(n)) return 'snow';
  if (/infrarot|heizk|heizung|radiator/.test(n)) return 'heater';
  if (/sauna/.test(n)) return 'sauna';
  if (/lüft|lueft|ventil/.test(n)) return 'fan';
  if (/garten|bewässer|bewaesser|beet/.test(n)) return 'sprout';
  if (/wärmepumpe|waermepumpe/.test(n)) return 'heatpump';
  if (/heizstab/.test(n)) return 'flame';
  return SYMBOL_TYP[typ] ?? 'plug';
}

const TYPWORT = /^(wallbox|ladepunkt|ladesäule|ladesaeule)\s+/i;

/** Der kurze Name für Legenden und Sätze („Wallbox Werkstatt“ → „Werkstatt“). */
export function kurzName(name: string): string {
  const ohne = name.replace(TYPWORT, '').trim();
  const erstes = ohne.split(/\s+/)[0] ?? ohne;
  return (erstes.length >= 3 ? erstes : ohne) || name;
}

function formFuer(typ: string, c: Consumer | null, ladepunkt: boolean): Form {
  if (typ === 'heat-pump-sgready') return 'freigabe';
  if (ladepunkt) return 'stufenlos';
  if (c?.controlKind === 'stepped') return 'stufig';
  if (c?.controlKind === 'continuous') return 'stufenlos';
  return 'schalten';
}

const QUELLE_SONNIG = new Set(['ueberschuss', 'freigabe_ueberschuss']);

/** Der Smart-Auftrag als Satz - Wörter des Prototyps, Zahlen nur, wo belegt. */
export function auftragSatz(s: Steuerart | null | undefined, g: { form: Form; ladepunkt: boolean }): string {
  if (!s) return 'Noch kein Auftrag';
  const freigabe = g.form === 'freigabe';
  let satz: string;
  switch (s.quelle) {
    case 'ueberschuss':
    case 'freigabe_ueberschuss':
      if (freigabe || s.quelle === 'freigabe_ueberschuss') satz = 'Anheben bei Sonne';
      else if (g.ladepunkt) satz = s.ueberschussModus === 'mindestleistung' ? 'Sonne + Mindestleistung' : 'Nur Sonnenstrom';
      else satz = typeof s.schwelleKw === 'number' ? `Mit Sonnenstrom ab ${fKw(s.schwelleKw)}` : 'Mit Sonnenstrom';
      break;
    case 'guenstig':
    case 'freigabe_guenstig': {
      const grenze = typeof s.preisgrenzeCtKwh === 'number' ? `${zahl1(s.preisgrenzeCtKwh)} ct` : null;
      const anheben = freigabe || s.quelle === 'freigabe_guenstig';
      satz = grenze ? `${anheben ? 'Anheben unter' : 'Unter'} ${grenze}` : anheben ? 'Anheben, wenn günstig' : 'Günstige Stunden';
      break;
    }
    case 'feste_zeiten': {
      const f = s.fenster;
      satz = f?.von && f?.bis ? `${f.von}–${f.bis}${tageWort(f.tage)}` : 'Feste Zeiten';
      break;
    }
    case 'sofort':
      satz = g.ladepunkt ? 'Sofort laden' : 'Ohne Steuerung';
      break;
    default:
      satz = 'Eigene Regel';
  }
  const bis = s.zielFenster?.bis ?? null;
  if (s.ziel === 'bis_uhrzeit' && typeof s.zielEnergieKwh === 'number') {
    const quelle = QUELLE_SONNIG.has(s.quelle) ? ', Sonne zuerst' : s.quelle === 'guenstig' ? ', günstig' : '';
    return `+${zahl0(s.zielEnergieKwh)} kWh${bis ? ` bis ${bis}` : ''}${quelle}`;
  }
  if (s.ziel === 'laufzeit_bis' && typeof s.zielLaufzeitMinuten === 'number') {
    const h = s.zielLaufzeitMinuten / 60;
    const menge = h >= 1 ? `${zahl1(h).replace(/,0$/, '')} Std` : `${s.zielLaufzeitMinuten} Min`;
    const quelle = QUELLE_SONNIG.has(s.quelle) ? ', Sonne zuerst' : s.quelle === 'guenstig' ? ', günstig' : '';
    return `${menge}${bis ? ` bis ${bis}` : ''}${quelle}`;
  }
  return satz;
}

function tageWort(tage: string | null | undefined): string {
  if (tage === 'werktags' || tage === 'weekdays' || tage === 'werktage') return ' werktags';
  if (tage === 'wochenende' || tage === 'weekend') return ' am Wochenende';
  return '';
}

export interface GeraeteInput {
  raster: Raster;
  reihen: Reihen;
  verbraucher: SiteVerbraucher | null;
  consumers?: Consumer[] | null;
  status?: ConsumerRuntimeStatus[] | null;
  overrides?: ManualOverride[] | null;
  charging?: SiteCharging | null;
  interventions?: SiteInterventions | null;
  consumerPlan?: ConsumerSchedule | null;
  /** Gemessene Leistung je Gerät (kW je Viertelstunde heute), wo gelesen. */
  gemessen?: Record<string, (number | null)[]> | null;
  /** Welche aktive Regel gerade für ein Gerät greift (Name je Komponente). */
  regelJetzt?: Record<string, string> | null;
  /** Die laufende Szene: ihr Name und die Geräte, die SIE pausiert hat. */
  szene?: { name: string; ids: string[] } | null;
}

/** Der Ladepunkt eines Eintrags und sein (erster) Stecker. */
function ladepunktVon(
  e: VerbraucherEintrag,
  charging: SiteCharging | null | undefined,
): { cp: ChargePoint; con: ChargeConnector | null } | null {
  if (!e.ladepunkt) return null;
  const cp = liste(charging?.chargers).find(
    (c) => c.chargePointId === e.chargePointId || (c.entityId && c.entityId === e.entityId),
  );
  if (!cp) return null;
  const cons = liste(cp.connectors);
  const con = cons.find((k) => k.charging) ?? cons.find((k) => k.sessionSince) ?? cons[0] ?? null;
  return { cp, con };
}

function eingriffVon(
  id: string,
  overrides: ManualOverride[] | null | undefined,
  interventions: SiteInterventions | null | undefined,
  nowMs: number,
  lp: { con: ChargeConnector | null } | null,
): Eingriff | null {
  const o = liste(overrides).find((x) => x.entityId === id && Date.parse(x.endsAt) > nowMs);
  if (o) return { art: o.kind === 'stop' ? 'aus' : 'an', bisMs: Date.parse(o.endsAt) };
  const iv = liste(interventions?.interventions).find(
    (x) => x.entityId === id && Date.parse(x.endsAt) > nowMs,
  );
  if (iv) return { art: /pause|stop|halten/.test(iv.kind) ? 'aus' : 'an', bisMs: Date.parse(iv.endsAt) };
  if (lp?.con?.boost) return { art: 'an', bisMs: null };
  if (lp?.con && lp.con.reason === 'handeingriff') return { art: 'aus', bisMs: null };
  return null;
}

export function geraete(i: GeraeteInput): GeraetBild[] {
  const r = i.raster;
  const nowMs = r.nowMs;
  const eintraege = liste(i.verbraucher?.verbraucher);
  const pausiert = i.interventions?.automationPaused === true;
  return eintraege.map((e) => {
    const name = e.name?.trim() || e.typLabel || 'Gerät';
    const c = liste(i.consumers).find((x) => x.id === e.entityId) ?? null;
    const st = liste(i.status).find((x) => x.entityId === e.entityId) ?? null;
    const lp = ladepunktVon(e, i.charging);
    const form = formFuer(e.typ, c, e.ladepunkt);
    const s = e.steuerart ?? null;
    const gemessen = e.ladepunkt
      ? lp?.con?.powerKw != null
      : c?.confirmationChannel
        ? c.confirmationChannel === 'power_kw'
        : st?.actualKw != null;
    const eingriff = eingriffVon(e.entityId, i.overrides, i.interventions, nowMs, lp);
    // Pausiert (Gesamtschalter aus): durch eine Szene oder von Hand. Dann
    // gibt es keine erwarteten Läufe - der Plan kennt das Gerät nicht mehr.
    const geraetAus = !lp && c?.controlActivation === 'paused';
    const durchSzene = geraetAus && i.szene?.ids.includes(e.entityId) ? i.szene.name : null;

    // --- Viertelstunden: gemessen bis jetzt, danach Plan oder Erwartung.
    const kw = leer<number>();
    const herkunft: GeraetBild['herkunft'] = Array.from({ length: N }, () => null);
    const mess = i.gemessen?.[e.entityId] ?? null;
    if (mess) {
      for (let t = 0; t < Math.min(r.jetzt, mess.length); t++) {
        if (mess[t] != null) { kw[t] = mess[t]; herkunft[t] = 'gemessen'; }
      }
    }
    // Pausiert: kein Plan, keine Erwartung - VoltPilot schaltet das Gerät nicht.
    const plan = geraetAus ? null : liste(i.consumerPlan?.entities).find((x) => x.entityId === e.entityId);
    if (plan) {
      for (const p of plan.slots) {
        const t = slotVon(r, p.time);
        if (t == null || t < r.jetzt) continue;
        kw[t] = num(p.targetValue);
        herkunft[t] = 'plan';
      }
    } else if (!geraetAus) {
      const nenn = nennLeistung(c, e);
      const erwartung = erwarteteLaeufe(s, { form, nennKw: nenn, ladepunkt: e.ladepunkt }, i.reihen, r.jetzt + 1);
      for (let t = r.jetzt + 1; t < N; t++) {
        if (erwartung[t]) { kw[t] = nenn; herkunft[t] = 'erwartet'; }
      }
    }

    // --- Jetzt
    let jetztKw: number | null = null;
    let an: boolean | null = null;
    if (lp?.con) {
      jetztKw = aktuelleLeistung(lp.con, nowMs);
      an = lp.con.charging === true;
    } else if (st) {
      jetztKw = num(st.actualKw);
      an = /^running/.test(st.state) ? true : st.state === 'unknown' ? null : false;
    }
    if (jetztKw != null) { kw[r.jetzt] = jetztKw; herkunft[r.jetzt] = 'gemessen'; }
    else if (an === true && !gemessen) { kw[r.jetzt] = nennLeistung(c, e); herkunft[r.jetzt] = 'gemessen'; }

    let zustand = zustandVon({ e, form, st, lp, eingriff, pausiert, gemessen, r, an });
    if (!eingriff && !pausiert && geraetAus) {
      zustand = durchSzene
        ? { pill: ['lock', 'gesperrt'], kurz: `Szene „${durchSzene}“: aus`, lang: `Die Szene „${durchSzene}“ hat das Gerät pausiert; es gilt sein sicherer Zustand, bis Sie die Szene beenden.` }
        : { pill: ['lock', 'pausiert'], kurz: 'Pausiert', lang: 'Das Gerät ist pausiert; es gilt sein sicherer Zustand.' };
    }
    const sonnig = !!s && QUELLE_SONNIG.has(s.quelle);
    const regelJetzt = i.regelJetzt?.[e.entityId] ?? null;
    if (!eingriff && !pausiert && !geraetAus && !lp && st) {
      const laeuft = zustand.pill[0] === 'on';
      if (regelJetzt && laeuft) {
        zustand = { ...zustand, kurz: `Regel „${regelJetzt}“ greift`, lang: `Die Regel „${regelJetzt}“ schaltet das Gerät gerade ein.` };
      } else if (zustand.pill[0] === 'wait' && sonnig) {
        const braucht = num(s?.schwelleKw) ?? nennLeistung(c, e);
        const frei = Math.max(0, -(i.reihen.netz[r.jetzt] ?? 0));
        if (braucht != null && i.reihen.netz[r.jetzt] != null) {
          zustand = {
            ...zustand,
            kurz: `Wartet · braucht ${fKw(braucht)}, frei ${fKw(frei)}`,
            lang: `Wartet auf Sonnenstrom: braucht ${fKw(braucht)}, frei sind ${fKw(frei)}.`,
          };
        }
      } else if (laeuft && s?.ziel && s.zielFenster?.bis) {
        zustand = { ...zustand, kurz: `Plan: fertig bis ${s.zielFenster.bis}`, lang: `Läuft nach Plan, damit es bis ${s.zielFenster.bis} fertig ist.` };
      } else if (laeuft && sonnig && st.reasonCode !== 'price_below_threshold') {
        zustand = { ...zustand, kurz: 'Sonnenstrom', lang: 'Läuft mit Sonnenstrom-Überschuss.' };
      }
      if (laeuft && form !== 'freigabe') {
        const a = quellenAnteil(i.reihen, r.jetzt);
        if (a) {
          const d = a.pv >= a.sp && a.pv >= a.netz ? 'Sonne' : a.sp >= a.netz ? 'Speicher' : 'Netz';
          const teile = (['pv', 'sp', 'netz'] as const).filter((q) => a[q] > 0.05).map((q) => ({ pv: 'Sonne', sp: 'Speicher', netz: 'Netz' })[q]);
          zustand = { ...zustand, kurz: `${zustand.kurz} · ${d}`, lang: `${zustand.lang} Strom aus: ${teile.join(', ')} (anteilig).` };
        }
      }
    }
    return {
      id: e.entityId,
      name,
      kurz: kurzName(name),
      symbol: symbolFuer(e.typ, name),
      typ: e.typ,
      typLabel: e.typLabel,
      form,
      ladepunkt: lp
        ? {
            chargePointId: lp.cp.chargePointId,
            connectorId: lp.con?.connectorId ?? 1,
            angesteckt: !!lp.con && lp.con.status != null && !/available|unavailable|faulted/i.test(lp.con.status),
            sitzungSeit: lp.con?.sessionSince ?? null,
            sitzungKwh: num(lp.con?.sessionKwh),
            karte: lp.con?.tagRef ?? null,
            laedt: lp.con?.charging === true,
          }
        : null,
      gemessen,
      nennKw: nennLeistung(c, e),
      stufenKw: c?.levelsKw ?? null,
      steuerart: s,
      ohneAuftrag: s?.herkunft === 'ohne',
      sonnig,
      schreibbar: e.optionen?.schreibbar !== false,
      nichtSchreibbarGrund: e.optionen?.nichtSchreibbarGrund ?? null,
      eintrag: e,
      consumer: c,
      status: st,
      kw,
      herkunft,
      jetztKw,
      an,
      pill: zustand.pill,
      warum: zustand.kurz,
      warumLang: zustand.lang,
      eingriff,
      regelJetzt: regelJetzt && zustand.pill[0] === 'on' ? regelJetzt : null,
      auftrag: auftragSatz(s, { form, ladepunkt: e.ladepunkt }),
      regeln: e.regeln ?? 0,
    };
  });
}

function nennLeistung(c: Consumer | null, e: VerbraucherEintrag): number | null {
  const n = num(c?.ratedPowerKw);
  if (n != null && n > 0) return n;
  const s = num(e.steuerart?.schwelleKw);
  return s != null && s > 0 ? s : null;
}

interface ZustandInput {
  e: VerbraucherEintrag;
  form: Form;
  st: ConsumerRuntimeStatus | null;
  lp: { cp: ChargePoint; con: ChargeConnector | null } | null;
  eingriff: Eingriff | null;
  pausiert: boolean;
  gemessen: boolean;
  r: Raster;
  an: boolean | null;
}

/** Pille und Satz eines Geräts - nur aus Gemeldetem. */
function zustandVon(z: ZustandInput): { pill: [PillArt, string]; kurz: string; lang: string } {
  const bis = z.eingriff?.bisMs != null ? uhrVon(z.r, z.eingriff.bisMs) : null;
  if (z.eingriff) {
    const art = z.eingriff.art === 'aus' ? 'aus' : 'an';
    const satz = bis ? `Ihr Eingriff: ${art} bis ${bis}, dann wieder Smart` : `Ihr Eingriff: ${art}, bis Sie ihn beenden`;
    return { pill: ['hand', `Eingriff: ${art}`], kurz: satz, lang: `${satz}.` };
  }
  if (z.pausiert) return { pill: ['lock', 'Pause'], kurz: 'Automatik pausiert', lang: 'Die Automatik ist pausiert; das Gerät ist in seinem sicheren Zustand.' };
  // --- Ladepunkt: das Wort der Säule.
  if (z.lp) {
    if (!z.lp.cp.connected) return { pill: ['stale', 'keine Verbindung'], kurz: 'Ladepunkt meldet sich nicht', lang: 'Der Ladepunkt meldet sich gerade nicht bei der Box.' };
    if (!z.lp.con) return { pill: ['stale', 'unbekannt'], kurz: STATUS_UNKNOWN_TEXT, lang: STATUS_UNKNOWN_TEXT };
    const lz = ladeZustand(z.lp.con, z.lp.cp, z.r.nowMs);
    const grund = lz.reason ?? z.lp.con.reasonText ?? null;
    const kurz = grund && grund !== lz.word ? `${lz.word} · ${grund}` : lz.word;
    const pill: [PillArt, string] =
      lz.kind === 'laedt' || lz.kind === 'laedt_ohne_messung' || lz.kind === 'startet' ? ['on', 'lädt']
        : lz.kind === 'getrennt' || lz.kind === 'frei' ? ['off', 'kein Auto']
          : lz.kind === 'beendet' ? ['done', 'fertig']
            : lz.kind === 'stoerung' || lz.kind === 'nicht_verfuegbar' ? ['lock', 'Störung']
              : lz.kind === 'reserviert' ? ['off', 'reserviert']
                : ['wait', 'wartet'];
    return { pill, kurz, lang: `${kurz}.` };
  }
  // --- Verbraucher: Zustand und Grund, wie die Box sie meldet.
  const st = z.st;
  if (!st) return { pill: ['stale', 'unbekannt'], kurz: STATUS_UNKNOWN_TEXT, lang: 'Die Box hat für dieses Gerät noch keinen Zustand gemeldet.' };
  const zustandText = CONSUMER_STATE_TEXT[st.state] ?? STATUS_UNKNOWN_TEXT;
  const grund = st.reasonCode ? CONSUMER_REASON_TEXT[st.reasonCode] ?? null : null;
  const freigabe = z.form === 'freigabe';
  let pill: [PillArt, string];
  switch (st.state) {
    case 'running_forced':
    case 'running_optimized':
      pill = ['on', freigabe ? 'angehoben' : 'läuft'];
      break;
    case 'waiting':
      pill = ['wait', 'wartet'];
      break;
    case 'clamped':
      pill = ['wait', 'begrenzt'];
      break;
    case 'fulfilled':
      pill = ['done', 'Ziel erreicht'];
      break;
    case 'missed':
      pill = ['lock', 'nicht erreicht'];
      break;
    case 'ready':
      pill = ['off', 'aus'];
      break;
    case 'disconnected':
    case 'offline':
      pill = ['stale', 'keine Verbindung'];
      break;
    default:
      pill = ['stale', 'unbekannt'];
  }
  const kurz = grund ?? zustandText.replace(/^Läuft · /, '');
  const unbestaetigt = st.confirmed === false ? ' · Ausführung nicht bestätigt' : '';
  const messung = freigabe && pill[0] === 'on' ? ' · Leistung nicht gemessen' : '';
  return {
    pill,
    kurz: `${kurz}${messung}${unbestaetigt}`,
    lang: `${zustandText}${grund ? `: ${grund}` : ''}.${freigabe ? ' Die Freigabe-Leistung wird nicht gemessen.' : ''}${st.confirmed === false ? ' Die Ausführung ist nicht bestätigt.' : ''}`,
  };
}

// ---------------------------------------------------------------------------
// Erwartung aus dem Smart-Auftrag (Regel 2: nur, wo kein Plan das Gerät plant)
// ---------------------------------------------------------------------------

/**
 * Wann das Gerät nach seinem Auftrag voraussichtlich läuft - aus Prognose und
 * Preis. Sonnenstrom: wo der Plan mindestens die Nennleistung einspeisen
 * würde. Günstig: wo der Börsenpreis unter der Grenze liegt. Feste Zeiten:
 * im Fenster. Eine Frist ohne Plan erwartet nichts (die Box entscheidet).
 */
export function erwarteteLaeufe(
  s: Steuerart | null | undefined,
  g: { form: Form; nennKw: number | null; ladepunkt: boolean },
  rh: Reihen,
  ab = 0,
): boolean[] {
  const bits = Array.from({ length: N }, () => false);
  if (!s || s.herkunft === 'ohne') return bits;
  const nenn = g.nennKw ?? num(s.schwelleKw) ?? 1;
  for (let t = ab; t < N; t++) {
    switch (s.quelle) {
      case 'ueberschuss':
      case 'freigabe_ueberschuss': {
        if (g.ladepunkt) break;
        const schwelle = num(s.schwelleKw) ?? nenn;
        const netz = rh.netz[t];
        const pv = rh.pv[t];
        const last = rh.last[t];
        const ueberschuss = netz != null ? -netz : pv != null && last != null ? pv - last : null;
        bits[t] = ueberschuss != null && ueberschuss >= schwelle;
        break;
      }
      case 'guenstig':
      case 'freigabe_guenstig': {
        const p = rh.preis[t];
        const g2 = num(s.preisgrenzeCtKwh);
        bits[t] = p != null && g2 != null && p < g2;
        break;
      }
      case 'feste_zeiten': {
        const f = s.fenster;
        if (!f?.von || !f?.bis) break;
        bits[t] = imFenster(t % TAG, f.von, f.bis);
        break;
      }
      default:
        break;
    }
  }
  return bits;
}

/** Liegt eine Viertelstunde in einem Fenster „22:00–07:00“ (Ende offen)? */
export function imFenster(t: number, von: string, bis: string): boolean {
  const q = (x: string) => {
    const [h, m] = x.split(':').map(Number);
    return Math.round(((h || 0) * 60 + (m || 0)) / 15);
  };
  const a = q(von);
  const b = q(bis);
  return a <= b ? t >= a && t < b : t >= a || t < b;
}

// ---------------------------------------------------------------------------
// Speicher und Reihenfolge
// ---------------------------------------------------------------------------

export function speicherBild(input: {
  raster: Raster;
  reihen: Reihen;
  name: string | null;
  kwh: number | null;
  kw: number | null;
  reservePct: number | null;
}): SpeicherBild {
  const t = input.raster.jetzt;
  const soc = input.reihen.soc[t];
  const k = input.reihen.bat[t];
  let pill: [PillArt, string];
  let warum: string;
  if (k == null) {
    pill = ['stale', 'unbekannt'];
    warum = soc != null ? `Ladestand ${fPct(soc)}` : STATUS_UNKNOWN_TEXT;
  } else if (k > 0.05) {
    pill = ['on', 'lädt'];
    warum = `Lädt mit ${fKw(k)}${soc != null ? ` · Ladestand ${fPct(soc)}` : ''}`;
  } else if (k < -0.05) {
    pill = ['on', 'gibt ab'];
    warum = `Deckt das Haus mit ${fKw(-k)}${soc != null ? ` · Ladestand ${fPct(soc)}` : ''}`;
  } else if (soc != null && soc >= 99.5) {
    pill = ['off', 'voll'];
    warum = 'Voll · der Rest der Sonne geht weiter';
  } else {
    pill = ['off', 'ruht'];
    const reserve = input.reservePct != null && soc != null && soc <= input.reservePct + 0.5;
    warum = `Ruht${soc != null ? ` · Ladestand ${fPct(soc)}` : ''}${reserve ? ' (Reserve)' : ''}`;
  }
  return {
    name: input.name ?? 'Speicher',
    kwh: input.kwh,
    kw: input.kw,
    soc,
    jetztKw: k,
    reservePct: input.reservePct,
    pill,
    warum,
  };
}

/** Der Schlüssel einer Zeile der Reihenfolge: `sp` für den Speicher. */
export const SPEICHER = 'sp';

/**
 * Die Reihenfolge als Schlüssel-Liste - so, wie der Server sie liest. Eine
 * GRUPPE mehrerer Ladepunkte wird in ihre Mitglieder aufgelöst (dieselbe
 * Normalform, die `ranglisteRumpf` beim Speichern schickt).
 */
export function reihenfolgeAus(rangliste: RanglisteEintrag[] | null | undefined): string[] {
  const out: string[] = [];
  for (const e of [...liste(rangliste)].sort((a, b) => a.position - b.position)) {
    if (e.art === 'speicher') out.push(SPEICHER);
    else if (e.entityId) out.push(e.entityId);
    else for (const m of liste(e.mitglieder)) out.push(m.entityId);
  }
  return out;
}

/** Der Rumpf für `PUT /rangliste` aus der Schlüssel-Liste. */
export function reihenfolgeRumpf(ids: string[], geraeteListe: GeraetBild[]): { art: string; entityId?: string }[] {
  return ids.map((id) => {
    if (id === SPEICHER) return { art: 'speicher' };
    const g = geraeteListe.find((x) => x.id === id);
    return { art: g?.ladepunkt || g?.eintrag.ladepunkt ? 'ladepunkt' : 'verbraucher', entityId: id };
  });
}

/**
 * Die Geräte in der Reihenfolge ihrer Plätze: zuerst, wer Sonnenstrom nach
 * Reihenfolge bekommt (samt Speicher), dann alle, die nach Zeit, Frist oder
 * Preis laufen. Wer in der Rangliste fehlt, steht hinten in seiner Gruppe.
 */
export function ordnen(
  reihenfolge: string[],
  liste: GeraetBild[],
  mitSpeicher: boolean,
): { rang: string[]; rest: string[] } {
  const rangIds = reihenfolge.filter(
    (id) => (id === SPEICHER && mitSpeicher) || liste.some((g) => g.id === id && g.sonnig && !g.ohneAuftrag),
  );
  for (const g of liste) if (g.sonnig && !g.ohneAuftrag && !rangIds.includes(g.id)) rangIds.push(g.id);
  if (mitSpeicher && !rangIds.includes(SPEICHER)) rangIds.unshift(SPEICHER);
  const rest = liste
    .filter((g) => !rangIds.includes(g.id) && !g.ohneAuftrag)
    .sort((a, b) => {
      const ia = reihenfolge.indexOf(a.id);
      const ib = reihenfolge.indexOf(b.id);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    })
    .map((g) => g.id);
  return { rang: rangIds, rest };
}

// ---------------------------------------------------------------------------
// Jetzt: der Satz und die Leiste „Wohin geht der Sonnenstrom?“
// ---------------------------------------------------------------------------

export interface LeistenTeil {
  art: 'haus' | 'dev' | 'batt' | 'netz' | 'abgeregelt';
  id: string | null;
  kw: number;
  label: string;
  symbol: string;
}

export interface Leiste {
  pv: number;
  teile: LeistenTeil[];
  wartet: { id: string; name: string; platz: number; braucht: number; frei: number } | null;
}

export interface Moment {
  t: number;
  pv: number | null;
  preis: number | null;
  temp: number | null;
  soc: number | null;
  bat: number | null;
  netz: number | null;
  last: number | null;
  abgeregelt: number | null;
}

export function moment(rh: Reihen, t: number): Moment {
  return {
    t,
    pv: rh.pv[t], preis: rh.preis[t], temp: rh.temp[t], soc: rh.soc[t], bat: rh.bat[t],
    netz: rh.netz[t], last: rh.last[t], abgeregelt: rh.abgeregelt[t],
  };
}

/** Wer läuft in dieser Viertelstunde (kW > 0 oder als laufend gemeldet)? */
export function laufende(liste: GeraetBild[], t: number, jetzt: number): GeraetBild[] {
  return liste.filter((g) => ((g.kw[t] ?? 0) > 0.02) || (t === jetzt && g.an === true));
}

/**
 * Die Leiste: wohin die Sonne in dieser Viertelstunde geht. Haus (samt nicht
 * gemessener Geräte), die Geräte mit Sonnenanteil, der Speicher an seinem
 * Platz der Reihenfolge, die Einspeisung, die laut Plan abgeregelte Leistung.
 */
export function leiste(
  rh: Reihen,
  t: number,
  liste: GeraetBild[],
  reihenfolge: string[],
  jetzt: number,
): Leiste | null {
  const pv = rh.pv[t];
  if (pv == null || pv <= 0.15) return null;
  const anteil = quellenAnteil(rh, t);
  const pvAnteil = anteil?.pv ?? 1;
  const teile: LeistenTeil[] = [];
  const rang: [GeraetBild, number][] = [];
  const pflicht: [GeraetBild, number][] = [];
  let geraeteSonne = 0;
  const ungemessen: string[] = [];
  for (const g of laufende(liste, t, jetzt)) {
    const k = g.kw[t];
    if (k == null) continue;
    const sonne = k * pvAnteil;
    if (sonne < 0.02) continue;
    if (!g.gemessen && t <= jetzt) { ungemessen.push(g.kurz); continue; }
    geraeteSonne += sonne;
    // Pflicht vor Reihenfolge: was eine Regel, ein Eingriff oder eine Frist gerade
    // einschaltet, bekommt die Sonne vor jedem Platz der Reihenfolge.
    const pflichtJetzt = !g.sonnig || !!g.regelJetzt || !!g.eingriff || !!g.steuerart?.ziel;
    (pflichtJetzt ? pflicht : rang).push([g, sonne]);
  }
  rang.sort((a, b) => reihenfolge.indexOf(a[0].id) - reihenfolge.indexOf(b[0].id));
  const exp = Math.max(0, -(rh.netz[t] ?? 0));
  const lad = Math.max(0, rh.bat[t] ?? 0);
  const ab = Math.max(0, rh.abgeregelt[t] ?? 0);
  // Was die Sonne dem Haus gibt: PV minus Einspeisung minus Speicher-Laden.
  const insHaus = Math.max(0, pv - exp - Math.min(lad, pv));
  const haus = Math.max(0, insHaus - geraeteSonne);
  teile.push({
    art: 'haus', id: null, kw: haus,
    label: ungemessen.length ? `Haus und ${ungemessen.join(', ')}` : 'Haus', symbol: 'house',
  });
  for (const [g, k] of pflicht) teile.push({ art: 'dev', id: g.id, kw: k, label: g.kurz, symbol: g.symbol });
  const spPos = reihenfolge.indexOf(SPEICHER);
  const vor = rang.filter(([g]) => spPos < 0 || reihenfolge.indexOf(g.id) < spPos);
  const nach = rang.filter(([g]) => spPos >= 0 && reihenfolge.indexOf(g.id) > spPos);
  for (const [g, k] of vor) teile.push({ art: 'dev', id: g.id, kw: k, label: g.kurz, symbol: g.symbol });
  if (lad > 0.02) teile.push({ art: 'batt', id: SPEICHER, kw: Math.min(lad, pv), label: 'Speicher', symbol: 'battery' });
  for (const [g, k] of nach) teile.push({ art: 'dev', id: g.id, kw: k, label: g.kurz, symbol: g.symbol });
  if (exp > 0.02) teile.push({ art: 'netz', id: null, kw: exp, label: 'Einspeisung', symbol: 'pole' });
  if (ab > 0.02) teile.push({ art: 'abgeregelt', id: null, kw: ab, label: 'abgeregelt', symbol: 'down' });

  // Wer wartet als Nächstes? Der oberste Sonnen-Kunde, der wartet.
  let wartet: Leiste['wartet'] = null;
  if (t === jetzt) {
    const platzListe = reihenfolge.filter((id) => id === SPEICHER || liste.some((g) => g.id === id && g.sonnig));
    for (const id of platzListe) {
      const g = liste.find((x) => x.id === id);
      if (!g || g.pill[0] !== 'wait' || g.eingriff) continue;
      const braucht = num(g.steuerart?.schwelleKw) ?? g.nennKw;
      if (braucht == null) continue;
      wartet = { id: g.id, name: g.name, platz: platzListe.indexOf(id) + 1, braucht, frei: exp };
      break;
    }
  }
  return { pv, teile, wartet };
}

/**
 * Der Kopfsatz: „Sonne 8,0 kW: Werkstatt, Heizstab und Pool laufen. Der
 * Speicher ist voll." - oder nachts „Keine Sonne. Der Speicher liefert 1,2 kW.“
 * Er nennt nur gemessene Geräte beim Namen (ein nicht gemessenes steckt im
 * „Haus“); HTML-frei, die Hervorhebung der Zahl macht die Fläche.
 */
export function kopfsatz(
  rh: Reihen,
  t: number,
  liste: GeraetBild[],
  jetzt: number,
): { vor: string; sonne: string | null; nach: string } {
  const m = moment(rh, t);
  const laufen = laufende(liste, t, jetzt).filter((g) => g.gemessen);
  if (m.pv != null && m.pv > 0.15) {
    const anteil = quellenAnteil(rh, t);
    const sonnig = laufen.filter((g) => (g.kw[t] ?? 0) * (anteil?.pv ?? 1) > 0.05);
    let nach = sonnig.length
      ? `: ${aufzaehlung(sonnig.map((g) => g.kurz))} ${sonnig.length > 1 ? 'laufen' : 'läuft'}.`
      : '.';
    if ((m.bat ?? 0) > 0.05) nach += ' Der Speicher lädt.';
    else if (m.soc != null && m.soc >= 99.5) nach += ' Der Speicher ist voll.';
    const exp = Math.max(0, -(m.netz ?? 0));
    if (exp > 0.1) nach += ` ${fKw(exp)} gehen ins Netz.`;
    if ((m.abgeregelt ?? 0) > 0.1) nach += ` ${fKw(m.abgeregelt ?? 0)} werden abgeregelt.`;
    return { vor: 'Sonne ', sonne: fKw(m.pv), nach };
  }
  if (m.pv == null && m.netz == null) {
    return { vor: 'Für diese Viertelstunde liegen keine Werte vor.', sonne: null, nach: '' };
  }
  const netz = Math.max(0, m.netz ?? 0);
  const sp = Math.max(0, -(m.bat ?? 0));
  let satz = 'Keine Sonne. ';
  if (laufen.length) satz += `${aufzaehlung(laufen.map((g) => g.kurz))} ${laufen.length > 1 ? 'laufen' : 'läuft'}. `;
  satz += sp > 0.05
    ? `Der Speicher liefert ${fKw(sp)}${netz > 0.05 ? `, das Netz ${fKw(netz)}.` : '.'}`
    : `Aus dem Netz kommen ${fKw(netz)}.`;
  return { vor: satz, sonne: null, nach: '' };
}

/** Die Unterzeile: „Börsenpreis 8,4 ct/kWh · 22 °C draußen · Speicher 64 %“. */
export function unterzeile(rh: Reihen, t: number, mitSpeicher: boolean): string {
  const m = moment(rh, t);
  const teile: string[] = [];
  if (m.preis != null) teile.push(`Börsenpreis ${fCt(m.preis)}`);
  else if (t >= TAG && !rh.morgenBekannt) teile.push('Preise für morgen kommen gegen 13 Uhr');
  if (m.temp != null) teile.push(`${fGrad(m.temp)} draußen`);
  if (mitSpeicher && m.soc != null) teile.push(`Speicher ${fPct(m.soc)}`);
  return teile.join(' · ');
}

/** Wann ändert sich bei einem Gerät als Nächstes etwas? */
export function naechsterWechsel(g: GeraetBild, t: number): { t: number; an: boolean } | null {
  const an = (g.kw[t] ?? 0) > 0.02 || (g.an === true);
  for (let x = t + 1; x < N; x++) {
    if (g.kw[x] == null && g.herkunft[x] == null) continue;
    const a = (g.kw[x] ?? 0) > 0.02;
    if (a !== an) return { t: x, an: a };
  }
  return null;
}

/** Die Zeile unter dem Tagesbild zur gewählten Viertelstunde. */
export function momentZeile(rh: Reihen, t: number, liste: GeraetBild[], jetzt: number): { kopf: string; zeile: string } {
  const m = moment(rh, t);
  const kopf = `${uhrTag(t)}–${uhr(t + 1)}${m.pv != null ? ` · Sonne ${fKw(m.pv)}` : ''}${m.preis != null ? ` · ${fCt(m.preis)}` : ''}`;
  const laufen = laufende(liste, t, jetzt);
  if (!laufen.length) return { kopf, zeile: 'Kein gesteuertes Gerät läuft.' };
  return {
    kopf,
    zeile: laufen
      .map((g) => `${g.kurz} ${g.gemessen || t > jetzt ? fKw(g.kw[t] ?? 0) : '(nicht gemessen)'}`)
      .join(' · '),
  };
}
