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
import type {
  FahrerAbfahrt, FahrerAnfrage, FahrerEinstellungen, LadepunktAnsicht, LadepunktErtraege, LadepunktErtragTeil,
  LadepunktListe, Rueckspeisen,
} from '../ladepunktErtraege';
import {
  MISPEL_LADESTAND_ZULETZT, MISPEL_LAEDT_IMMER_SOFORT, MISPEL_PLAN_VON, MISPEL_ZURUECKSPEISEN_RUHT,
} from '../glossar';
import { KW, zahl as ergebnisZahl } from '../uemsErgebnis';
import type { LadeparkRahmen } from '../verbraucherZone';
import { quellenAnteil, type GeraetBild, type Reihen } from './bild';
import { liste } from './liste';
import { N, TAG, fEur, uhr, uhrVon, zahl0, zahl1, type Raster } from './zeit';

export type LadeWahl = 'aus' | 'smart' | 'schnell';
export type LadeQuelle = 'sonne' | 'min' | 'guenstig';

export function ladeWahl(g: GeraetBild): LadeWahl {
  if (g.eingriff) return g.eingriff.art === 'aus' ? 'aus' : 'schnell';
  return g.steuerart?.quelle === 'sofort' ? 'schnell' : 'smart';
}

/**
 * Was „Smart“ an einem Ladepunkt tun muss. „Schnell“ hat ZWEI Gründe (siehe
 * {@link ladeWahl}): ein laufender Eingriff („Jetzt voll laden“/Pause) oder die
 * Steuerart `sofort` - der Anlagen-Standard „schnell“ einer Anlage, deren Kunde
 * nie gewählt hat (API `SteuerartProjektion.anlagenStandard`). Ein Eingriff
 * endet; steht die Steuerart auf `sofort`, wird „Smart“ zur Steuerart „Sonne
 * zuerst“, der Vorgabe innerhalb der Karte. Beides in EINEM Klick.
 *
 * Vorher beendete „Smart“ nur einen Eingriff: die Karte blieb bei `sofort` auf
 * „Schnell“, und „Nur Sonne“ (die Chips erscheinen nur unter „Smart“) war nie
 * erreichbar (Produktion, 04.10.2026).
 */
export function smartSchritte(g: Pick<GeraetBild, 'eingriff' | 'steuerart'>): {
  eingriffBeenden: boolean;
  steuerart: LadeQuelle | null;
} {
  return {
    eingriffBeenden: g.eingriff != null,
    steuerart: g.steuerart?.quelle === 'sofort' ? 'min' : null,
  };
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

// ---------------------------------------------------------------------------
// MiSpeL MP-41b: die Wallbox-Karte an einem bidirektionalen Ladepunkt
// (Bedienkonzept BK-41 Variante A, Vertrag mispel-ladepunkt-bidirektional.md § 5a)
// ---------------------------------------------------------------------------

/**
 * Was am Ladepunkt gerade steckt - und damit, welches Ladeziel gilt:
 * - `mit_ladestand`: das Auto meldet seinen Ladestand → „Abfahrt und Reserve“ in % und km;
 * - `ohne_ladestand`: kein (aktueller) Ladestand → das heutige Ladeziel „Menge bis Uhrzeit“;
 * - `ohne_rueckspeisen`: die Wallbox meldet ein Auto ohne Rückspeise-Funktion → lädt wie heute;
 * - `kein_auto`: nichts angesteckt; ob das nächste Auto zurückspeisen kann, prüft die Wallbox beim Anstecken.
 */
export type FahrzeugStand = 'mit_ladestand' | 'ohne_ladestand' | 'ohne_rueckspeisen' | 'kein_auto';

export interface WallboxMispel {
  ansicht: LadepunktAnsicht;
  fahrer: FahrerEinstellungen;
  fahrzeug: FahrzeugStand;
  ladestandPct: number | null;
  /** MiSpeL MP-41c (BK-41c-2 A): die eigene Uhr des frischen Ladestands (ms); `null` = unbekannt (älterer Stand). */
  ladestandUm: number | null;
  /** MiSpeL MP-41c: ein Ladestand älter als das Fenster - „Ladestand zuletzt 62 % um 12:58“ im Kopf. */
  ladestandZuletzt: { pct: number; um: number } | null;
  /** Welche Stufe die Fähigkeit des Ladepunkts heute trägt (A1 S. 26 Fn. 21). */
  traegt: Record<Rueckspeisen, boolean>;
  /** MiSpeL MP-41c: was das Zurückspeisen gerade anhält (derselbe Grund wie im Optimierer), `null` = nichts. */
  halt: RueckspeiseHalt | null;
  /** Die Szene, die den Ladepunkt pausiert hat (ihr Name), wenn `halt` = `szene`. */
  szene: string | null;
}

const OHNE_FAHRER = (ansicht: LadepunktAnsicht): FahrerEinstellungen => ({
  erfasst: false, rueckspeisen: 'aus', rueckspeisen_wirksam: 'aus',
  reserve_pct: ansicht.fahrzeugfenster?.mindest_soc_pct ?? null, vollzyklen_je_tag: null, abfahrten: [],
  naechste_fahrt: null, km_je_prozent: null, geaendert_am: null, geaendert_von: null,
});

/**
 * Die MiSpeL-Teile der Wallbox-Karte - `null`, wenn der Ladepunkt heute nicht
 * bidirektional nutzbar ist oder die Ladepunkte unbekannt sind: dann bleibt
 * die Karte byte-gleich wie vor MP-41b (Bestandsschutz).
 */
export function wallboxMispel(g: GeraetBild, ladepunkte: LadepunktListe | null | undefined): WallboxMispel | null {
  const ansicht = liste(ladepunkte?.ladepunkte).find((x) => x.komponente === g.id) ?? null;
  const f = ansicht?.faehigkeit;
  if (!ansicht || !f || f.nutzbarkeit !== 'bidirektional' || (!f.v2h && !f.v2g)) return null;
  const l = g.ladepunkt;
  const fahrzeug: FahrzeugStand = !l?.angesteckt ? 'kein_auto'
    : l.fahrzeugBidirektional === false ? 'ohne_rueckspeisen'
      : l.ladestandPct != null ? 'mit_ladestand' : 'ohne_ladestand';
  const zuletztPct = fahrzeug === 'ohne_ladestand' ? l?.ladestandZuletztPct ?? null : null;
  const um = l?.ladestandUm ?? null;
  return {
    ansicht,
    fahrer: ansicht.fahrer_einstellungen ?? OHNE_FAHRER(ansicht),
    fahrzeug,
    ladestandPct: fahrzeug === 'mit_ladestand' ? l?.ladestandPct ?? null : null,
    ladestandUm: fahrzeug === 'mit_ladestand' ? um : null,
    ladestandZuletzt: zuletztPct != null && um != null ? { pct: zuletztPct, um } : null,
    traegt: { aus: true, v2h: f.v2h, v2g: f.v2g },
    halt: rueckspeiseHalt(g),
    szene: g.szene ?? null,
  };
}

/**
 * MiSpeL MP-41c - was das Zurückspeisen gerade anhält: der Eingriff am Stecker
 * („Aus“, „Schnell“), die dauerhafte Steuerart „sofort“ (BK-41c-3 A: „Schnell“
 * heißt immer nur laden) oder eine Szene. Dieselben Wörter wie
 * `fahrzeugspeicher.halte_grund` im Optimierer und der Entladeschutz der Box,
 * in derselben Reihenfolge: der Lademodus am Stecker vor der Szene.
 */
export type RueckspeiseHalt = 'lademodus_aus' | 'lademodus_schnell' | 'lademodus_sofort' | 'szene';

export function rueckspeiseHalt(g: Pick<GeraetBild, 'eingriff' | 'steuerart' | 'szene'>): RueckspeiseHalt | null {
  if (g.eingriff) return g.eingriff.art === 'aus' ? 'lademodus_aus' : 'lademodus_schnell';
  if (g.steuerart?.quelle === 'sofort') return 'lademodus_sofort';
  return g.szene ? 'szene' : null;
}

/**
 * Der Satz unter „Aus · Smart · Schnell“ bei „Schnell“ (BK-41c-3 A): ein
 * Eingriff gilt für diese Ladung, die Steuerart „sofort“ immer. Nur an einer
 * Wallbox-Karte (`mispel`); jeder andere Ladepunkt behält seinen Satz (Bestand).
 */
export function schnellSatz(g: Pick<GeraetBild, 'eingriff'>, mispel: boolean): string {
  if (mispel && !g.eingriff) return `${MISPEL_LAEDT_IMMER_SOFORT} mit voller Leistung, auch mit Netzstrom — so ist dieser Ladepunkt eingestellt.`;
  return 'Lädt so schnell es geht, nur für diese Ladung. Netzstrom erlaubt.';
}

/** Das Alter des Ladestands nach seiner Uhr: bis eine Minute „jetzt“, danach „vor 3 Min.“ (BK-41c-2 A). */
export function ladestandAlterText(umMs: number | null, nowMs: number): string {
  if (umMs == null || nowMs - umMs <= 60_000) return 'jetzt';
  return `vor ${zahl0(Math.floor((nowMs - umMs) / 60_000))} Min.`;
}

/** Der Kopf bei einem alten Ladestand: „Ladestand zuletzt 62 % um 12:58“ (BK-41c-2 A); `null` ohne. */
export function ladestandZuletztText(m: WallboxMispel | null, r: Raster): string | null {
  const z = m?.ladestandZuletzt;
  return z ? `${MISPEL_LADESTAND_ZULETZT} ${zahl0(z.pct)}\u00a0% um ${uhrVon(r, z.um)}` : null;
}

/** Reichweite zu einem Ladestand, auf 10 km gerundet („≈ 300 km“, untrennbar); `null` ohne Kapazität - unbekannt ist keine Null. */
export function kmZu(pct: number | null, kmJeProzent: number | null): string | null {
  if (pct == null || kmJeProzent == null || !(kmJeProzent > 0)) return null;
  // Untrennbar: „(≈ 310 km)“ bricht am Telefon nie mitten im Wert um.
  return `≈\u00a0${zahl0(Math.round((pct * kmJeProzent) / 10) * 10)}\u00a0km`;
}

/** „80 % (≈ 300 km)“ oder nur „80 %“. */
export function pctKm(pct: number, kmJeProzent: number | null): string {
  const km = kmZu(pct, kmJeProzent);
  return km ? `${zahl0(pct)} % (${km})` : `${zahl0(pct)} %`;
}

const TAGE = ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

/** ISO-Wochentage kurz: „Mo–Fr“, „Sa, So“, „täglich“. Läufe ab drei Tagen werden zusammengezogen. */
export function wochentageText(tage: readonly number[]): string {
  const t = [...new Set(tage)].filter((x) => x >= 1 && x <= 7).sort((a, b) => a - b);
  if (t.length === 7) return 'täglich';
  const teile: string[] = [];
  for (let i = 0; i < t.length;) {
    let j = i;
    while (j + 1 < t.length && t[j + 1] === t[j] + 1) j++;
    if (j - i >= 2) teile.push(`${TAGE[t[i]]}–${TAGE[t[j]]}`);
    else for (let k = i; k <= j; k++) teile.push(TAGE[t[k]]);
    i = j + 1;
  }
  return teile.join(', ');
}

/** „Akku schonen“ in Worten: wie viel das Auto höchstens am Tag zurückgibt. */
export function schonenText(vollzyklen: number | null): string | null {
  if (vollzyklen == null) return null;
  if (vollzyklen <= 0.5) return 'höchstens eine halbe Ladung am Tag zurück';
  if (vollzyklen <= 1) return 'höchstens eine volle Ladung am Tag zurück';
  return `höchstens ${zahl0(vollzyklen)} volle Ladungen am Tag zurück`;
}

/** Wochentag (ISO, 1 = Montag) und Minute des Tages in der Zeitzone des Browsers. */
function ortszeit(ms: number): { tag: number; minute: number } {
  const d = new Date(ms);
  return { tag: ((d.getDay() + 6) % 7) + 1, minute: d.getHours() * 60 + d.getMinutes() };
}

function minuten(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Die nächste Abfahrt ab jetzt: „nur die nächste Fahrt“ zuerst, sonst der Wochenplan. `null` ohne Abfahrt. */
export function naechsteAbfahrt(f: FahrerEinstellungen, nowMs: number): { wann: string; socPct: number; einmalig: boolean } | null {
  if (f.naechste_fahrt) {
    const d = new Date(f.naechste_fahrt.abfahrt);
    const tag = Number.isFinite(d.getTime()) ? TAGE[((d.getDay() + 6) % 7) + 1] : '';
    return { wann: `${tag} ${f.naechste_fahrt.abfahrt.slice(11, 16)}`.trim(), socPct: f.naechste_fahrt.abfahrt_soc_pct, einmalig: true };
  }
  const jetzt = ortszeit(nowMs);
  for (let d = 0; d < 8; d++) {
    const tag = ((jetzt.tag - 1 + d) % 7) + 1;
    const a = liste(f.abfahrten).find((x) => x.wochentage.includes(tag) && (d > 0 || (minuten(x.abfahrt) ?? 0) > jetzt.minute));
    if (a) return { wann: `${d === 0 ? 'heute' : d === 1 ? 'morgen' : TAGE[tag]} ${a.abfahrt.slice(0, 5)}`, socPct: a.abfahrt_soc_pct, einmalig: false };
  }
  return null;
}

/** Die Zeile „Abfahrt und Reserve“ an der Karte (BK-41 A: „Abfahrt Mo–Fr 07:15 · 80 % (≈ 300 km)“). */
export function abfahrtZeile(f: FahrerEinstellungen, nowMs: number): { titel: string; unter: string } {
  const km = f.km_je_prozent;
  const plan = liste(f.abfahrten);
  const reserve = f.reserve_pct != null ? `Reserve ${pctKm(f.reserve_pct, null)}` : 'Keine Reserve gesagt';
  const schonen = schonenText(f.vollzyklen_je_tag);
  const unter = [reserve, schonen].filter(Boolean).join(' · ');
  if (f.naechste_fahrt) {
    const n = naechsteAbfahrt(f, nowMs);
    const danach = plan.length ? ` · danach wieder ${wochentageText(plan[0].wochentage)} ${plan[0].abfahrt.slice(0, 5)}` : '';
    return { titel: `Nur die nächste Fahrt: ${n?.wann ?? ''} · ${pctKm(f.naechste_fahrt.abfahrt_soc_pct, km)}`, unter: `${unter}${danach}` };
  }
  if (!plan.length) return { titel: 'Keine Abfahrt · Tippen, um Abfahrt und Reserve festzulegen', unter };
  const erste = plan[0];
  const weitere = plan.length > 1 ? ` · +${plan.length - 1} weitere` : '';
  return { titel: `Abfahrt ${wochentageText(erste.wochentage)} ${erste.abfahrt.slice(0, 5)} · ${pctKm(erste.abfahrt_soc_pct, km)}${weitere}`, unter };
}

/**
 * Der Satz unter „Zurückspeisen“. Ein Wunsch, kein Ist: was die Box tut,
 * entscheidet sie mit ihren Schutzgrenzen (MP-39); ohne Reserve speist sie
 * nie zurück (Fahrplan 2.0, Block `fahrzeug`).
 */
export function rueckspeiseSatz(m: WallboxMispel): string {
  const f = m.fahrer;
  if (m.fahrzeug === 'ohne_rueckspeisen') {
    return f.rueckspeisen === 'aus' ? 'Das Auto lädt nur.' : `„${RUECKSPEISEN_WORT[f.rueckspeisen]}“ gilt wieder, sobald ein Auto mit Rückspeise-Funktion ansteckt.`;
  }
  if (f.rueckspeisen === 'aus') return 'Das Auto lädt nur und gibt nichts ab.';
  if (ruhtZurueckspeisen(m)) return haltSatz(m);
  if (f.reserve_pct == null) return 'Ohne Reserve gibt das Auto nichts ab. Legen Sie unter „Abfahrt und Reserve“ eine Reserve fest.';
  const nie = `nie unter ${pctKm(f.reserve_pct, f.km_je_prozent)}`;
  const wohin = f.rueckspeisen_wirksam === 'v2g' ? 'erst ans Haus, dann ins Netz' : 'ans Haus';
  const satz = f.rueckspeisen_wirksam === 'aus'
    ? 'Heute kann dieser Ladepunkt nicht zurückspeisen.'
    : `Das Auto darf Strom ${wohin} abgeben — ${nie}.`;
  const weniger = f.rueckspeisen !== f.rueckspeisen_wirksam && f.rueckspeisen_wirksam !== 'aus'
    ? ` „${RUECKSPEISEN_WORT[f.rueckspeisen]}“ trägt der Ladepunkt heute nicht.` : '';
  return satz + weniger;
}

export const RUECKSPEISEN_WORT: Record<Rueckspeisen, string> = { aus: 'Aus', v2h: 'Ins Haus', v2g: 'Haus + Netz' };

/**
 * Ruht das Zurückspeisen sichtbar? Nur wo es sonst liefe: der Fahrer will es,
 * das Auto kann es (oder es ist unbekannt), der Ladepunkt trägt es heute.
 */
export function ruhtZurueckspeisen(m: Pick<WallboxMispel, 'halt' | 'fahrzeug' | 'fahrer'>): boolean {
  return m.halt != null && m.fahrzeug !== 'ohne_rueckspeisen' && m.fahrer.rueckspeisen !== 'aus' && m.fahrer.rueckspeisen_wirksam !== 'aus';
}

/**
 * „Zurückspeisen ruht …“ (BK-41c-3 A, MP-39b): Aus, Schnell und eine Szene
 * halten es an, ebenso die dauerhafte Steuerart „sofort“. Die Wahl des Fahrers
 * bleibt gespeichert - ein Halt ist keine Änderung der Einstellung.
 */
export function haltSatz(m: Pick<WallboxMispel, 'halt' | 'szene' | 'fahrer'>): string {
  const wahl = ` Ihre Wahl „${RUECKSPEISEN_WORT[m.fahrer.rueckspeisen]}“ bleibt gespeichert.`;
  if (m.halt === 'lademodus_sofort') return `${MISPEL_ZURUECKSPEISEN_RUHT}, solange „Schnell“ gilt — mit „Smart“ plant VoltPilot es wieder.${wahl}`;
  if (m.halt === 'szene') return `${MISPEL_ZURUECKSPEISEN_RUHT}, solange die Szene „${m.szene ?? ''}“ läuft.${wahl}`;
  return `${MISPEL_ZURUECKSPEISEN_RUHT} bis dahin.${wahl}`;
}

/** Der geplante Rückspeise-Teil eines Laufs (BK-41c-1 A) - der PLAN, nicht der Auftrag an die Box und nicht die Messung. */
export interface RueckspeisePlan {
  /** Erste Viertelstunde des ersten Fensters und das Ende dieses Fensters (Raster, halboffen). */
  von: number;
  bis: number;
  /** Weitere Rückspeise-Fenster danach im selben Lauf. */
  weitere: number;
  /** Geplante Menge aller Fenster in kWh (ungerundet). */
  kwh: number;
  /** Stand des Laufs (`generatedAt`, ms); `null` = unbekannt. */
  standMs: number | null;
  /** Zurückspeisen je Viertelstunde in kW (Betrag) - die grünen Viertelstunden des Bands. */
  zurueck: (number | null)[];
}

const RUECK_SCHWELLE_KW = 0.02;

/**
 * Die Rückspeise-Viertelstunden des Fahrzeug-Eintrags (`reason_code`
 * `fahrzeug_rueckspeisen`, je −kW): das erste Fenster von–bis, die Menge und
 * der Stand. `null`, wenn der Lauf ab jetzt keine trägt.
 */
export function rueckspeisePlan(g: Pick<GeraetBild, 'fahrzeugPlan'>): RueckspeisePlan | null {
  const fp = g.fahrzeugPlan;
  if (!fp) return null;
  const fenster: [number, number][] = [];
  let kwh = 0;
  for (let t = 0; t < fp.zurueck.length; t++) {
    const kw = fp.zurueck[t];
    if (!(kw != null && kw > RUECK_SCHWELLE_KW)) continue;
    kwh += kw * 0.25;
    const letztes = fenster[fenster.length - 1];
    if (letztes && letztes[1] === t) letztes[1] = t + 1;
    else fenster.push([t, t + 1]);
  }
  if (!fenster.length) return null;
  return { von: fenster[0][0], bis: fenster[0][1], weitere: fenster.length - 1, kwh, standMs: fp.standMs, zurueck: fp.zurueck };
}

/** Plant VoltPilot für diesen Ladepunkt ein Zurückspeisen (Rückspeise-Viertelstunden im Fahrzeug-Eintrag)? */
export function plantZurueck(g: Pick<GeraetBild, 'fahrzeugPlan'>): boolean {
  return rueckspeisePlan(g) != null;
}

/** Wohin der Plan zurückspeist - die wirksame Stufe in Worten. */
export function rueckspeiseWohin(f: Pick<FahrerEinstellungen, 'rueckspeisen_wirksam'>): string {
  return f.rueckspeisen_wirksam === 'v2g' ? 'ans Haus und ins Netz' : 'ans Haus';
}

const kwhUngefaehr = (kwh: number) => `≈\u00a0${kwh >= 1 ? zahl0(kwh) : zahl1(kwh)}\u00a0kWh`;

/**
 * Die Plan-Zeile (BK-41c-1 A): „Heute 18:00–21:30 ans Haus · ≈ 9 kWh“,
 * darunter „Plan von 13:00 · nie unter 40 % · morgen 07:15 wieder 80 %“.
 */
export function planZeile(p: RueckspeisePlan, m: Pick<WallboxMispel, 'fahrer'>, r: Raster): { titel: string; unter: string } {
  const f = m.fahrer;
  const tag = p.von < TAG ? 'Heute' : 'Morgen';
  const bis = p.von < TAG && p.bis > TAG ? `morgen ${uhr(p.bis)}` : uhr(p.bis);
  const weitere = p.weitere > 0 ? ` · +${p.weitere} weitere` : '';
  const ab = naechsteAbfahrt(f, r.nowMs);
  const unter = [
    p.standMs != null ? `${MISPEL_PLAN_VON} ${uhrVon(r, p.standMs)}` : null,
    f.reserve_pct != null ? `nie unter ${zahl0(f.reserve_pct)}\u00a0%` : null,
    ab ? `${ab.wann} wieder ${zahl0(ab.socPct)}\u00a0%` : null,
  ].filter(Boolean).join(' · ');
  return { titel: `${tag} ${uhr(p.von)}–${bis} ${rueckspeiseWohin(f)}${weitere} · ${kwhUngefaehr(p.kwh)}`, unter };
}

/**
 * Was die Karte zum geplanten Zurückspeisen sagt (BK-41c-1 A, die Lagen der
 * Abstimmung): `geplant` mit Plan-Zeile und Band; `kein` - der Lauf hat das
 * Auto gerechnet (Zeilen mit 0), aber keine Rückspeise-Viertelstunde;
 * `nicht_eingeschaltet` - kein Fahrzeug-Eintrag im jüngsten Lauf. `null`, wo
 * schon der Satz zur Stufe alles sagt: „Aus“, ein Auto ohne Rückspeise-
 * Funktion, ein Ladepunkt, der es nicht trägt, ohne Reserve und angehalten.
 */
export type RueckspeiseLage =
  | { art: 'geplant'; plan: RueckspeisePlan; titel: string; unter: string }
  | { art: 'kein' | 'nicht_eingeschaltet'; satz: string };

export function rueckspeiseLage(g: Pick<GeraetBild, 'fahrzeugPlan'>, m: WallboxMispel, r: Raster): RueckspeiseLage | null {
  const f = m.fahrer;
  if (m.fahrzeug === 'ohne_rueckspeisen' || f.rueckspeisen === 'aus' || f.rueckspeisen_wirksam === 'aus' || f.reserve_pct == null || m.halt) return null;
  const plan = rueckspeisePlan(g);
  if (plan) return { art: 'geplant', plan, ...planZeile(plan, m, r) };
  if (g.fahrzeugPlan) {
    return { art: 'kein', satz: `Bis ${uhrVon(r, g.fahrzeugPlan.endeMs)} plant VoltPilot kein Zurückspeisen — es lohnt sich gerade nicht.` };
  }
  return { art: 'nicht_eingeschaltet', satz: 'An dieser Anlage plant VoltPilot das Zurückspeisen noch nicht. Ihre Wahl ist gespeichert.' };
}

/**
 * Eine Abfahrt in den Wochenplan setzen: sie ersetzt die erste; ihre Wochentage
 * fallen aus den übrigen heraus (je Wochentag höchstens eine, § 5a). Ohne
 * Wochentag bleiben nur die übrigen.
 */
export function abfahrtSetzen(plan: readonly FahrerAbfahrt[], neu: FahrerAbfahrt): FahrerAbfahrt[] {
  const tage = new Set(neu.wochentage);
  const rest = liste(plan as FahrerAbfahrt[]).slice(1)
    .map((a) => ({ ...a, wochentage: a.wochentage.filter((t) => !tage.has(t)) }))
    .filter((a) => a.wochentage.length > 0);
  return neu.wochentage.length ? [{ ...neu, wochentage: [...tage].sort((a, b) => a - b) }, ...rest] : rest;
}

/** Die ganze Anfrage für `PUT …/fahrer-einstellungen` aus dem Stand und einer Änderung (der Server ersetzt ganz). */
export function fahrerAnfrage(f: FahrerEinstellungen, aenderung: Partial<FahrerAnfrage>): FahrerAnfrage {
  return {
    rueckspeisen: f.rueckspeisen,
    reserve_pct: f.reserve_pct,
    vollzyklen_je_tag: f.vollzyklen_je_tag,
    abfahrten: liste(f.abfahrten).map((a) => ({ wochentage: [...a.wochentage], abfahrt: a.abfahrt.slice(0, 5), abfahrt_soc_pct: a.abfahrt_soc_pct })),
    naechste_fahrt: f.naechste_fahrt ? { abfahrt: f.naechste_fahrt.abfahrt.slice(0, 16), abfahrt_soc_pct: f.naechste_fahrt.abfahrt_soc_pct } : null,
    ...aenderung,
  };
}

/** Die Ansicht nach einem `PUT` in die Liste übernehmen. */
export function ladepunktErsetzt(l: LadepunktListe | null, a: LadepunktAnsicht): LadepunktListe | null {
  if (!l) return l;
  return { ...l, ladepunkte: liste(l.ladepunkte).map((x) => (x.komponente === a.komponente ? a : x)) };
}

const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

/**
 * Die Zeile mit dem Monat (BK-41 A: „November: 110 kWh ins Haus · 34 kWh ins
 * Netz“) - `null` ohne Monatslauf für diesen Ladepunkt. Mengen ohne Wert heißen
 * „offen“, nie 0; eine Summe nur, wenn der Vergleich bestimmt ist.
 */
export function ertragZeile(e: LadepunktErtraege | null | undefined, komponente: string): { titel: string; unter: string } | null {
  if (!e || !liste(e.ladepunkte).some((x) => x.komponente === komponente) || !liste(e.teile).length) return null;
  const summe = (wert: (t: LadepunktErtragTeil) => number | null) => {
    const w = e.teile.map(wert);
    return w.some((x) => x == null) ? null : w.reduce<number>((s, x) => s + (x ?? 0), 0);
  };
  const haus = summe((t) => t.ins_haus?.kwh ?? null);
  const netz = summe((t) => liste(t.mengen).find((x) => x.nr === '11')?.kwh ?? null);
  const kwh = (v: number | null) => (v == null ? 'offen' : `${zahl0(v)} kWh`);
  const monat = MONATE[Number(e.monat.slice(5, 7)) - 1] ?? e.monat;
  const zusammen = e.teile.some((t) => !t.nur_ladepunkt) ? ' · mit dem Speicher zusammen gemessen' : '';
  const v = e.vergleich;
  const geld = v?.stand === 'bestimmt' && v.summe_eur != null
    ? `${v.summe_eur > 0 ? '+' : v.summe_eur < 0 ? '−' : ''}${fEur(Math.abs(v.summe_eur))} gegenüber nur laden`
    : 'Vergleich mit „nur laden“ noch offen';
  return { titel: `${monat}: ${kwh(haus)} ins Haus · ${kwh(netz)} ins Netz`, unter: `${geld}${zusammen} · in Verlauf › Erlöse` };
}
