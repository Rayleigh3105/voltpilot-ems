/**
 * Die ÜBERSICHT „Meine Anlagen" für Endkundinnen und Endkunden (Konzept
 * „Meine Anlagen neu", Entscheide Ü1–Ü5 = A): vier Blöcke, eine Frage je
 * Block — Läuft alles? · Was hat es heute gebracht? · Was passiert gerade? ·
 * Wie steht jede Anlage?
 *
 * Reine Ableitungen, kein React, kein Netz. Es wird nichts neu gerechnet:
 * das Geld kommt aus dem mandantenweiten `GET /earnings` (Tag) über
 * `erloeseAggregat`/`portfolioVergleich`/`portfolioSteuerung`, die Live-Werte
 * aus `GET /overview` über dieselben Helfer wie die Anlagen-Tabelle, die
 * Tageskurven aus der Historie je Anlage (derselbe Abruf wie der Reiter
 * Energie).
 *
 * Ehrlichkeitsregeln:
 * - **Fehlend ist keine Null.** Ein Live-Wert zählt nur mit frischem Messwert;
 *   die Unterzeile sagt, über wie viele Anlagen er spricht.
 * - **Kein Ladestand-Mittel.** Der Ladestand steht nur je Anlage; über alle
 *   Anlagen wird nur gezählt, wie viele gerade laden oder entladen.
 * - **Die Tageskurve hat Lücken, wo eine Anlage fehlt** — eine Summe über
 *   einen Teil der Anlagen wäre ein Einbruch, den es nicht gab.
 */
import type { Earnings, History, HistoryRange, Overview, OverviewSite } from './api';
import { siteLiveFresh } from './fleet';
import { fmtNum, NBSP, seitDauer } from './format';
import { batteryState, deriveBatteryKw, gridState } from './live';
import { siteSoc, siteStatus } from './portfolio';
import { betrag, geldTon, vergleichUnter } from './erloeseSeite';
import {
  erloeseAggregat,
  portfolioVergleich,
  type ErloeseAggregat,
  type PortfolioHistoryInput,
} from './portfolioHistorie';
import { portfolioSteuerung, type PortfolioSteuerung } from './portfolioSeite';
import type { SpeicherAussage } from './speicherAussage';

function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function anlagenWort(n: number): string {
  return n === 1 ? 'Anlage' : 'Anlagen';
}

/** „beide Anlagen" · „alle 3 Anlagen" · „2 von 3 Anlagen" · „1 Anlage". */
export function ueberAnlagen(mit: number, gesamt: number): string {
  if (gesamt === 1) return mit === 1 ? '1 Anlage' : 'keine Anlage';
  if (mit === gesamt) return gesamt === 2 ? 'beide Anlagen' : `alle ${gesamt} Anlagen`;
  return `${mit} von ${gesamt} ${anlagenWort(gesamt)}`;
}

// ---------------------------------------------------------------------------
// 1 · Läuft alles?
// ---------------------------------------------------------------------------

export interface StatusZeile {
  ton: 'ok' | 'warn' | 'off';
  text: string;
  /** Die Anlage, die Aufmerksamkeit braucht — Ziel des Links. */
  zielId: string | null;
}

/**
 * Die Statuszeile: grün mit der Zahl der Anlagen, sonst der GRUND mit der
 * Anlage, die ihn trägt („Werkstatt am Bach meldet sich seit 45 Min. nicht").
 */
export function statusZeile(sites: readonly OverviewSite[], now: Date): StatusZeile {
  const gesamt = sites.length;
  if (gesamt === 0) return { ton: 'off', text: 'Noch keine Anlage angelegt', zielId: null };
  const mitStatus = sites.map((s) => ({ s, st: siteStatus(s) }));
  const problem =
    mitStatus.find((x) => x.st.label === 'Meldet sich nicht') ??
    mitStatus.find((x) => x.st.label === 'Wartet auf Daten') ??
    mitStatus.find((x) => x.st.label === 'Kein Gerät');
  if (!problem) {
    return {
      ton: 'ok',
      text: `Alles in Ordnung · ${gesamt} ${anlagenWort(gesamt)}`,
      zielId: null,
    };
  }
  const weitere = mitStatus.filter((x) => x.st.tone !== 'ok').length - 1;
  const zusatz = weitere > 0 ? ` · ${weitere} weitere ${weitere === 1 ? 'Anlage braucht' : 'Anlagen brauchen'} Aufmerksamkeit` : '';
  const { s, st } = problem;
  const text =
    st.label === 'Meldet sich nicht'
      ? `${s.name} meldet sich ${seitDauer(s.lastSeenAt, now) ?? ''} nicht`.replace(/\s+/g, ' ')
      : st.label === 'Wartet auf Daten'
        ? `${s.name} wartet auf die ersten Daten`
        : `${s.name} hat noch kein Gerät`;
  return {
    ton: st.label === 'Kein Gerät' ? 'off' : 'warn',
    text: text + zusatz,
    zielId: s.id,
  };
}

// ---------------------------------------------------------------------------
// 2 · Was hat es heute gebracht?
// ---------------------------------------------------------------------------

export interface HeuteKarte {
  /** „+ 5,92 €" — „—" ohne bewertete Viertelstunde. */
  wert: string;
  ton: 'minus' | 'leer' | null;
  /** Der ehrliche Vergleich (am laufenden Tag nur bis zur gleichen Stunde). */
  unter: string | null;
  pfeil: '↑' | '↓' | null;
  steuerung: PortfolioSteuerung | null;
  /** „Erzeugt 22,9 kWh" / „Verbraucht 20,2 kWh" — Summen des Tages. */
  erzeugt: string | null;
  verbraucht: string | null;
  aggregat: ErloeseAggregat | null;
}

export function heuteKarte(input: {
  earnings: Earnings | null;
  sites: readonly { id: string; name: string }[];
  overview: Overview | null;
  speicher: (aggregat: ErloeseAggregat) => SpeicherAussage | null;
  now: Date;
}): HeuteKarte {
  const aggregat = input.earnings ? erloeseAggregat(input.earnings.sites, input.sites) : null;
  const anker = input.now;
  const vergleich = aggregat
    ? portfolioVergleich({
        range: 'day' as HistoryRange,
        anchor: anker,
        now: input.now,
        server: input.earnings?.vergleich ?? null,
        jetztEur: aggregat.nettoEur,
        vorherEur: null,
      })
    : null;
  const v = aggregat?.nettoEur == null ? null : vergleichUnter(vergleich, null);
  const summe = (f: (s: OverviewSite) => number | null | undefined) => {
    let s = 0;
    let hat = false;
    for (const site of input.overview?.sites ?? []) {
      const w = num(f(site));
      if (w == null) continue;
      s += w;
      hat = true;
    }
    return hat ? s : null;
  };
  const pv = summe((s) => s.energyToday?.pvKwh);
  const load = summe((s) => s.energyToday?.loadKwh);
  return {
    wert: betrag(aggregat?.nettoEur ?? null),
    ton: geldTon(aggregat?.nettoEur ?? null),
    unter: v?.text ?? null,
    pfeil: v?.pfeil ?? null,
    steuerung: aggregat ? portfolioSteuerung(input.speicher(aggregat), aggregat) : null,
    erzeugt: pv == null ? null : `Erzeugt ${fmtNum(pv, 'kWh', 1)}`,
    verbraucht: load == null ? null : `Verbraucht ${fmtNum(load, 'kWh', 1)}`,
    aggregat,
  };
}

/** Die Tageskurve aller Anlagen: kW je Viertelstunde, `null` = Lücke. */
export interface TagesKurve {
  pv: (number | null)[];
  load: (number | null)[];
  /** Index der laufenden Viertelstunde (0..95); rechts davon ist „noch offen". */
  jetzt: number;
  /** Größter Wert beider Reihen (für den gemeinsamen Maßstab). */
  max: number;
}

function viertelstunde(iso: string): number | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.getHours() * 4 + Math.floor(d.getMinutes() / 15);
}

/**
 * Summiert Erzeugung und Verbrauch aller Anlagen je Viertelstunde (kWh × 4 =
 * kW). Eine Viertelstunde zählt nur, wenn JEDE Anlage mit Werten an diesem
 * Tag sie trägt — sonst bleibt sie eine Lücke. `null`, wenn keine Anlage
 * Werte hat.
 */
export function tagesKurve(inputs: readonly PortfolioHistoryInput[], now: Date): TagesKurve | null {
  const mitWerten = inputs.filter((i) => i.history && i.history.buckets.length > 0) as {
    history: History;
  }[];
  if (mitWerten.length === 0) return null;
  const pv: (number | null)[] = Array(96).fill(null);
  const load: (number | null)[] = Array(96).fill(null);
  const zaehler: number[] = Array(96).fill(0);
  const pvSumme: number[] = Array(96).fill(0);
  const loadSumme: number[] = Array(96).fill(0);
  for (const { history } of mitWerten) {
    const faktor = 60 / (history.bucketMinutes || 15);
    for (const b of history.buckets) {
      const i = viertelstunde(b.start);
      if (i == null || i < 0 || i > 95) continue;
      const p = num(b.pvKwh);
      const l = num(b.loadKwh);
      if (p == null || l == null) continue;
      zaehler[i] += 1;
      pvSumme[i] += p * faktor;
      loadSumme[i] += l * faktor;
    }
  }
  let max = 0;
  for (let i = 0; i < 96; i++) {
    if (zaehler[i] !== mitWerten.length) continue;
    pv[i] = pvSumme[i];
    load[i] = loadSumme[i];
    max = Math.max(max, pvSumme[i], loadSumme[i]);
  }
  return { pv, load, jetzt: now.getHours() * 4 + Math.floor(now.getMinutes() / 15), max };
}

// ---------------------------------------------------------------------------
// 3 · Was passiert gerade?
// ---------------------------------------------------------------------------

export interface JetztWert {
  id: 'sonne' | 'verbrauch' | 'speicher' | 'netz';
  name: string;
  wert: string;
  unter: string;
  rolle: 'pv' | 'load' | 'batt' | 'grid';
}

export interface JetztBlock {
  werte: JetztWert[];
  /** „vor 1 Min." — das Alter des jüngsten frischen Messwerts. */
  stand: string | null;
}

function kw(v: number): string {
  return fmtNum(Math.abs(v), 'kW', 1);
}

/**
 * Die vier Live-Werte in Worten. Nur Anlagen mit FRISCHEM Messwert zählen;
 * ohne einen einzigen frischen Wert gibt es den Block nicht (`null`).
 */
export function jetztBlock(overview: Overview | null, now: Date): JetztBlock | null {
  const sites = overview?.sites ?? [];
  const frisch = sites.filter((s) => siteLiveFresh(s, now));
  if (frisch.length === 0) return null;
  const gesamt = sites.length;
  const summe = (f: (s: OverviewSite) => number | null | undefined) => {
    const w = frisch.map((s) => num(f(s))).filter((x): x is number => x != null);
    return { wert: w.length ? w.reduce((a, b) => a + b, 0) : null, n: w.length };
  };
  const pv = summe((s) => s.live?.pvKw);
  const load = summe((s) => s.live?.loadKw);
  const grid = summe((s) => s.live?.gridKw);

  let laedt = 0;
  let entlaedt = 0;
  let mitSpeicher = 0;
  for (const s of sites) {
    const soc = siteSoc(s);
    if (soc == null) continue;
    mitSpeicher += 1;
    if (!siteLiveFresh(s, now) || !s.live) continue;
    const st = batteryState(soc, deriveBatteryKw(s.live.pvKw, s.live.loadKw, s.live.gridKw));
    if (st === 'laedt') laedt += 1;
    if (st === 'entlaedt') entlaedt += 1;
  }

  const werte: JetztWert[] = [];
  if (pv.wert != null) {
    werte.push({ id: 'sonne', name: 'Sonne', wert: kw(pv.wert), unter: ueberAnlagen(pv.n, gesamt), rolle: 'pv' });
  }
  if (load.wert != null) {
    werte.push({ id: 'verbrauch', name: 'Verbrauch', wert: kw(load.wert), unter: ueberAnlagen(load.n, gesamt), rolle: 'load' });
  }
  if (mitSpeicher > 0) {
    const wort = laedt > 0 && entlaedt === 0 ? 'lädt' : entlaedt > 0 && laedt === 0 ? 'entlädt' : laedt > 0 ? 'lädt und entlädt' : 'ruht';
    const n = laedt > 0 && entlaedt === 0 ? laedt : entlaedt > 0 && laedt === 0 ? entlaedt : laedt + entlaedt;
    werte.push({
      id: 'speicher',
      name: 'Speicher',
      wert: wort,
      unter: wort === 'ruht' ? ueberAnlagen(mitSpeicher, mitSpeicher) : ueberAnlagen(n, mitSpeicher),
      rolle: 'batt',
    });
  }
  if (grid.wert != null) {
    const st = gridState(grid.wert);
    werte.push({
      id: 'netz',
      name: 'Netz',
      wert: st === 'ausgeglichen' ? 'ausgeglichen' : kw(grid.wert),
      unter: st === 'bezug' ? 'Bezug' : st === 'einspeisung' ? 'Einspeisung' : 'kein Bezug',
      rolle: 'grid',
    });
  }
  const juengster = frisch
    .map((s) => s.live?.ts ?? null)
    .filter((t): t is string => t != null)
    .sort()
    .pop();
  return { werte, stand: juengster ? standText(juengster, now) : null };
}

/** „Stand: gerade eben" · „Stand: vor 4 Min." · „Stand: vor 2 Std." */
export function standText(iso: string, now: Date): string | null {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const min = Math.floor((now.getTime() - t) / 60_000);
  if (min < 1) return 'Stand: gerade eben';
  if (min < 60) return `Stand: vor ${min} Min.`;
  return `Stand: vor ${Math.floor(min / 60)} Std.`;
}

// ---------------------------------------------------------------------------
// 4 · Wie steht jede Anlage?
// ---------------------------------------------------------------------------

export interface AnlagenKarte {
  id: string;
  name: string;
  ton: 'ok' | 'warn' | 'off';
  /** Ein Satz über das, was die Anlage gerade tut — oder warum nicht. */
  satz: string;
  zahlen: { name: string; wert: string }[];
  /** Erzeugung heute je Viertelstunde (kW), für die kleine Kurve. */
  kurve: (number | null)[] | null;
  jetzt: number;
}

function satzVon(s: OverviewSite, now: Date): string {
  const st = siteStatus(s);
  if (st.label === 'Kein Gerät') return 'Noch kein Gerät verbunden';
  if (st.label === 'Wartet auf Daten') return 'Wartet auf die ersten Daten';
  if (st.label === 'Meldet sich nicht') {
    const alter = seitDauer(s.lastSeenAt, now);
    return `Meldet sich ${alter ? `${alter} ` : ''}nicht`;
  }
  if (!siteLiveFresh(s, now) || !s.live) return 'Keine aktuellen Messwerte';
  const soc = siteSoc(s);
  const batt = batteryState(soc, deriveBatteryKw(s.live.pvKw, s.live.loadKw, s.live.gridKw));
  const sonne = (s.live.pvKw ?? 0) > 0.05;
  const netz = gridState(s.live.gridKw);
  if (batt === 'laedt') return sonne ? 'Lädt den Speicher mit Sonnenstrom' : 'Lädt den Speicher';
  if (batt === 'entlaedt') return 'Versorgt sich aus dem Speicher';
  if (netz === 'einspeisung') return 'Speist Sonnenstrom ins Netz';
  if (netz === 'bezug') return 'Bezieht Strom aus dem Netz';
  return sonne ? 'Deckt den Verbrauch aus der Sonne' : 'Alles ruhig';
}

/**
 * Eine Karte je Anlage: Satz, drei Zahlen (Sonne jetzt · Speicher · Ergebnis
 * heute), Tageskurve der Erzeugung. Was Aufmerksamkeit braucht, steht oben;
 * sonst die Reihenfolge der Anlagen.
 */
export function anlagenKarten(input: {
  overview: Overview | null;
  aggregat: ErloeseAggregat | null;
  historien: readonly PortfolioHistoryInput[] | null;
  now: Date;
}): AnlagenKarte[] {
  const { now } = input;
  const nettoById = new Map((input.aggregat?.zeilen ?? []).map((z) => [z.siteId, z.nettoEur] as const));
  const histById = new Map((input.historien ?? []).map((h) => [h.siteId, h.history] as const));
  const jetzt = now.getHours() * 4 + Math.floor(now.getMinutes() / 15);
  const rang = (s: OverviewSite) => {
    const l = siteStatus(s).label;
    return l === 'Meldet sich nicht' ? 0 : l === 'Wartet auf Daten' ? 1 : l === 'Kein Gerät' ? 2 : 3;
  };
  return [...(input.overview?.sites ?? [])]
    .sort((a, b) => rang(a) - rang(b) || a.name.localeCompare(b.name, 'de'))
    .map((s) => {
      const st = siteStatus(s);
      const frisch = siteLiveFresh(s, now);
      const soc = siteSoc(s);
      const netto = nettoById.get(s.id) ?? null;
      const zahlen: { name: string; wert: string }[] = [
        { name: 'Sonne', wert: frisch && s.live?.pvKw != null ? fmtNum(s.live.pvKw, 'kW', 1) : '—' },
      ];
      if (soc != null) zahlen.push({ name: 'Speicher', wert: `${Math.round(soc)}${NBSP}%` });
      zahlen.push({ name: 'Heute', wert: betrag(netto) });
      const h = histById.get(s.id) ?? null;
      let kurve: (number | null)[] | null = null;
      if (h && h.buckets.length > 0) {
        kurve = Array(96).fill(null);
        const faktor = 60 / (h.bucketMinutes || 15);
        for (const b of h.buckets) {
          const i = viertelstunde(b.start);
          const p = num(b.pvKwh);
          if (i == null || i < 0 || i > 95 || p == null) continue;
          kurve[i] = p * faktor;
        }
      }
      return {
        id: s.id,
        name: s.name,
        ton: st.tone === 'ok' ? 'ok' : st.label === 'Kein Gerät' ? 'off' : 'warn',
        satz: satzVon(s, now),
        zahlen,
        kurve,
        jetzt,
      };
    });
}

/**
 * Welche Blöcke die Übersicht zeigt und in welcher Reihenfolge — aus dem
 * Layout der Fläche („Anpassen"). Ein Block steht, solange nicht ALLE seine
 * verfügbaren Bausteine ausgeblendet wurden; die Reihenfolge folgt dem ersten
 * seiner Bausteine im Layout.
 */
export type UebersichtBlock = 'heute' | 'jetzt' | 'anlagen';

const BLOCK_BAUSTEINE: Record<UebersichtBlock, readonly string[]> = {
  heute: ['erloese', 'erzeugung-heute', 'verbrauch-heute'],
  jetzt: ['pv-jetzt', 'netz-heute', 'speicher'],
  anlagen: ['anlagen'],
};

export function uebersichtBloecke(
  order: readonly string[],
  verfuegbar: readonly string[],
  /** Die Standard-Reihenfolge — sie ordnet Blöcke ohne sichtbaren Baustein. */
  canonical: readonly string[] = [],
): UebersichtBlock[] {
  const bloecke = (Object.keys(BLOCK_BAUSTEINE) as UebersichtBlock[]).filter((b) => {
    const ids = BLOCK_BAUSTEINE[b];
    const verfuegbare = ids.filter((id) => verfuegbar.includes(id));
    if (verfuegbare.length === 0) return true;
    return verfuegbare.some((id) => order.includes(id));
  });
  // Die Standard-Reihenfolge, in der die SICHTBAREN Bausteine die Reihenfolge
  // des Layouts annehmen; fehlende Bausteine behalten ihren Standardplatz.
  const sichtbar = order.filter((id) => canonical.includes(id));
  let k = 0;
  const reihe = canonical.length
    ? [...canonical.map((id) => (sichtbar.includes(id) ? sichtbar[k++] : id)), ...order.filter((id) => !canonical.includes(id))]
    : [...order];
  const pos = (b: UebersichtBlock) => {
    const idx = BLOCK_BAUSTEINE[b].map((id) => reihe.indexOf(id)).filter((i) => i >= 0);
    return idx.length ? Math.min(...idx) : reihe.length + bloecke.indexOf(b);
  };
  return [...bloecke].sort((a, b) => pos(a) - pos(b));
}
