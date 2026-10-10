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
import { messwertAlter, type SpeicherFreigabe } from '../ladepunkte';
import type { LadeparkRahmen } from '../verbraucherZone';
import { quellenAnteil, type GeraetBild, type Reihen } from './bild';
import { N } from './zeit';

export type LadeWahl = 'aus' | 'smart' | 'schnell';
export type LadeQuelle = 'sonne' | 'min' | 'speicher' | 'guenstig';

/**
 * Der Überschuss-Modus je Ladequelle - das geschlossene Vokabular der API
 * (`SteuerartProjektion.MODI`, Vertragsvektoren
 * `docs/contracts/v2/sonne-speicher-vectors.json`).
 */
export const UEBERSCHUSS_MODUS: Record<Exclude<LadeQuelle, 'guenstig'>, string> = {
  sonne: 'pausieren',
  min: 'mindestleistung',
  speicher: 'speicher',
};

/**
 * Die Karte „Sonne + Speicher“ in `optionen.quellen` (06.10.2026): keine eigene
 * Quelle, sondern `ueberschuss` mit dem Modus `speicher`. Sie trägt nur die
 * Sperre samt Grund - der Server entscheidet, ob es sie gibt.
 */
export const OPTION_SONNE_SPEICHER = 'ueberschuss_speicher';

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
  if (s.quelle === 'ueberschuss') {
    if (s.ueberschussModus === 'mindestleistung') return 'min';
    return s.ueberschussModus === 'speicher' ? 'speicher' : 'sonne';
  }
  return null;
}

/**
 * Der Satz zu jeder Stufe der Speicherfreigabe, falls die Box ihren eigenen
 * nicht mitschickt - das geschlossene Vokabular `box_modes` (ohne `aus`, das
 * die Box nie meldet) und `cloud_reasons` aus
 * `docs/contracts/v2/sonne-speicher-vectors.json`. `laden.test.ts` liest die
 * Datei und fällt um, sobald ein Wort ohne Satz dazukommt.
 */
export const FREIGABE_STUFE_TEXT: Record<string, string> = {
  frei: 'Der Speicher gibt gerade Energie für das Auto frei – nur was das Haus laut Prognose bis zur nächsten Sonne nicht braucht.',
  frei_beobachtet: 'Die Box gibt gerade Speicherenergie für das Auto frei, nur was das Haus laut Prognose bis zur nächsten Sonne nicht braucht. VoltPilot steuert den Speicher dabei nicht, sondern beobachtet ihn: Sein Wechselrichter deckt die Wallbox selbst. Kommt dabei Strom aus dem Netz, nimmt die Box die Freigabe zurück.',
  an_der_grenze: 'Der Speicher steht an seiner Untergrenze – er bleibt für das Haus, das Auto lädt nur mit Sonnenstrom.',
  kein_plan: 'Ohne aktuellen Fahrplan gibt es keine Untergrenze – das Auto lädt nur mit Sonnenstrom, wie bei „Nur Sonne“.',
  plan_handelt: 'In dieser Viertelstunde nutzt der Fahrplan den Speicher selbst (Netzbezug oder Verkauf) – der Fahrplan geht vor, das Auto lädt nur mit Sonnenstrom.',
  ladestand_unbekannt: 'Der Ladestand des Speichers ist gerade nicht gemessen. Unbekannt ist nicht leer und nicht voll – es wird nichts freigegeben, nur Sonnenstrom.',
  keine_messung: 'Ohne frische Messung am Netzanschluss und am Speicher wird nichts freigegeben – nur Sonnenstrom.',
  speicherpfad: 'Der Speicher kann die Ladung gerade nicht übernehmen – das Auto lädt nur mit Sonnenstrom.',
  bms_sperrt: 'Der Schutz des Speichers erlaubt gerade keine Entladung – nur Sonnenstrom.',
  keine_leistung: 'Der Speicher deckt gerade schon das Haus mit seiner ganzen Leistung – für das Auto bleibt nur Sonnenstrom.',
  wirkung: 'Während der Freigabe kam Strom aus dem Netz – vorerst lädt das Auto nur mit Sonnenstrom.',
  kein_ladestand: 'Der Fahrplan hat keinen gemessenen Ladestand des Speichers – ohne ihn keine Freigabe, nur Sonnenstrom.',
  speicher_gehalten: 'Eine Regel hält den Speicher – er wird nicht für das Auto freigegeben, nur Sonnenstrom.',
  prognose_veraltet: 'Die Prognose für Verbrauch oder Sonne ist veraltet oder fehlt – ohne sie keine Freigabe, nur Sonnenstrom.',
  nachtbedarf_ueber_kapazitaet: 'Laut Prognose braucht das Haus bis zur nächsten Sonne mehr, als der Speicher fasst – es wird nichts freigegeben, nur Sonnenstrom.',
  reserve_ueber_kapazitaet: 'Die eingestellte Reserve lässt im Speicher keinen Platz für eine Freigabe – nur Sonnenstrom.',
  prognose_zu_kurz: 'Die Prognose reicht noch nicht bis zur nächsten Sonne, die das Haus wieder deckt – ohne sie keine Freigabe, nur Sonnenstrom.',
};

const pct = (v: number) => `${Math.round(v * 10) / 10}`.replace('.', ',') + ' %';
const kw1 = (v: number) => `${(Math.round(v * 10) / 10).toFixed(1)}`.replace('.', ',') + ' kW';

/**
 * Die Erklärzeile unter „Sonne + Speicher“ - nur BELEGTE Zahlen.
 *
 * Die BOX hat das letzte Wort (sie hat gegen den gemessenen Ladestand
 * entschieden); ohne ihre Meldung sagt der Fahrplan, bis wohin entladen werden
 * darf - ausdrücklich als Plan, nicht als Wirkung; ohne beides steht nur, was
 * die Quelle tut. Eine Meldung, die älter als das Live-Fenster ist
 * (`messwertAlter`), gilt nicht als aktuell. `frei_beobachtet` (07.10.2026)
 * sagt dazu, dass VoltPilot den Speicher nicht steuert, sondern beobachtet -
 * die Freigabe hängt dann an der Messung und der Wirkungsprüfung.
 *
 * @param gemeldet `ChargingBudget.reportedAt` - wann die Box zuletzt gemeldet hat
 */
export function speicherZeile(
  box: SpeicherFreigabe | null | undefined,
  planGrenzePct: number | null,
  gemeldet?: string | null,
  nowMs?: number,
): string {
  if (messwertAlter({ meteredAt: gemeldet }, nowMs) === 'veraltet') {
    return 'Die letzte Meldung der Box ist älter als fünf Minuten – ob der Speicher gerade freigibt, ist nicht bekannt.'
      + (planGrenzePct != null ? ` Laut Fahrplan dürfte er jetzt bis ${pct(planGrenzePct)} entladen.` : '');
  }
  const floor = box?.floorSocPct ?? null;
  const soc = box?.socPct ?? null;
  if (box?.mode === 'frei' && box.kw != null && floor != null) {
    return `Der Speicher gibt gerade bis ${kw1(box.kw)} frei und darf bis ${pct(floor)} entladen`
      + `${soc != null ? ` (jetzt ${pct(soc)})` : ''} – darüber braucht das Haus laut Prognose bis zur nächsten Sonne nichts.`;
  }
  if (box?.mode === 'frei_beobachtet' && box.kw != null && floor != null) {
    return `Die Box gibt gerade bis ${kw1(box.kw)} aus dem Speicher frei, bis er bei ${pct(floor)} steht`
      + `${soc != null ? ` (jetzt ${pct(soc)})` : ''}. VoltPilot steuert den Speicher dabei nicht, sondern beobachtet ihn:`
      + ' Sein Wechselrichter deckt die Wallbox selbst. Kommt dabei Strom aus dem Netz, nimmt die Box die Freigabe zurück.';
  }
  if (box?.mode === 'an_der_grenze' && floor != null) {
    return `Der Speicher steht an seiner Untergrenze von ${pct(floor)} – er bleibt für das Haus, das Auto lädt nur mit Sonnenstrom.`;
  }
  if (box?.note) return box.note;
  if (box?.mode && FREIGABE_STUFE_TEXT[box.mode]) return FREIGABE_STUFE_TEXT[box.mode];
  if (planGrenzePct != null) {
    return `Laut Fahrplan darf der Speicher jetzt bis ${pct(planGrenzePct)} entladen; darüber braucht das Haus bis zur nächsten Sonne nichts. Was die Box daraus macht, meldet sie noch nicht.`;
  }
  return 'Lädt mit Sonnenstrom und gibt dazu, was der Speicher bis zur nächsten Sonne nicht braucht.';
}

/** Gibt es im Fenster [von, bis) überhaupt eine Untergrenze? (sonst kein Band) */
export function hatSpeicherGrenze(grenze: (number | null)[] | undefined, von: number, bis: number): boolean {
  if (!grenze) return false;
  for (let t = von; t < bis; t++) if (grenze[t] != null) return true;
  return false;
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
