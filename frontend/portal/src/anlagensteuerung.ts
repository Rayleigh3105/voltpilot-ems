/**
 * **Anlagensteuerung einer Erzeugeranlage** in den bestehenden Seiten (Konzept „Erzeuger am WAGO-Modbus-Server“,
 * Fassung 12, §4.5; Paket EZ-10, Entscheide EW-3 A und EW-16 C): wer jede Einheit gerade steuert
 * (Steuerung › Geräte), die Steuerung als Gerät mit ihren Einheiten (Geräteseite), die Stammdaten Netz und
 * Vermarktung (Anlage › Einstellungen › „Strom & Geld“) und die Kurven je Einheit (Verlauf › Messwerte).
 *
 * Die Werte sind die Punkte `erzeuger.*` der Route `…/anlagensteuerungen/{geraetId}/werte` (EZ-6), Schlüssel
 * `erzeuger.<abschnitt>.<feld>` bzw. `erzeuger.te[n].<feld>` mit n = TE-Nr. Diese Datei rechnet nur; die
 * Komponenten rendern ihr Ergebnis.
 *
 * Fehlend ist keine Null: ein Punkt ohne Wert, mit Qualität `invalid`/`device_error` oder ohne sein
 * Gültigkeitsbit (Vertrag EZ-1 §4: `t_bits` Bit 0 deckt Ist und Zustand, Bit 1 den Sollwert, `a_gueltig`
 * Bit 0 den Netzpunkt) ist `null` und steht als „—“. Ein veralteter Wert bleibt sichtbar, aber mit seinem Alter.
 * Bits werden über ihre NUMMER gelesen, nie über ein Wort - so wie der Vertrag sie festlegt.
 */
import type {
  Anlagensteuerung,
  AnlagensteuerungVerlauf,
  AnlagensteuerungWert,
  AnlagensteuerungWerte,
  DirektvermarkterKanal,
  Einspeisemanagement,
  Erzeugungseinheit,
  ErzeugungseinheitArt,
  NetzVermarktung,
} from './api';
import { fmtRelative, NBSP } from './format';
import type { Zeile } from './geraetEinstellungen';
import type { ComponentRole } from './komponenten';
import type { VerlaufGroup, VerlaufSeries } from './verlauf';

export const STRICH = '—';
export const NOCH_KEINE_DATEN = 'noch keine Daten';

const MINUS = '−';
const NF1 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const NF0 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });

/** Leistung in W → „41,2 kW“ (eine Stelle, echtes Minus); `null` → „—“. */
export function kwText(watt: number | null): string {
  if (watt == null) return STRICH;
  const kw = Math.abs(watt) < 50 ? 0 : watt / 1000;
  return `${kw < 0 ? MINUS : ''}${NF1.format(Math.abs(kw))}${NBSP}kW`;
}

/** Prozent → „60 %“ (ohne Stelle); `null` → „—“. */
export function prozentText(p: number | null): string {
  return p == null ? STRICH : `${NF0.format(p)}${NBSP}%`;
}

// ---------------------------------------------------------------------------
// Punkte und Werte
// ---------------------------------------------------------------------------

export const PUNKT = {
  anlagenart: 'erzeuger.kopf.anlagenart',
  aGueltig: 'erzeuger.a.a_gueltig',
  aAlter: 'erzeuger.a.a_alter_s',
  nvp: 'erzeuger.a.p_nvp_w',
  erzeugung: 'erzeuger.a.p_erzeugung_w',
  speicher: 'erzeuger.a.speicher_fuellstand',
  nbProzent: 'erzeuger.nb.n_p_prozent',
  dvKanal: 'erzeuger.dv.d_kanal',
  dvSoll: 'erzeuger.dv.d_soll_w',
  grenze: 'erzeuger.wirkung.p_grenze_w',
  sBits: 'erzeuger.wirkung.s_bits',
} as const;

export type EinheitFeld = 't_zustand' | 't_bits' | 't_art' | 't_nenn_kw' | 't_p_ist_w' | 't_p_soll_w' | 't_e';

/** `erzeuger.te[2].t_p_ist_w` - der Schlüssel eines Felds der Einheit `teNr`. */
export function einheitPunkt(teNr: number, feld: EinheitFeld): string {
  return `erzeuger.te[${teNr}].${feld}`;
}

/** Die Werte einer Antwort nach Schlüssel. */
export type WerteJe = ReadonlyMap<string, AnlagensteuerungWert>;

export function werteJe(w: AnlagensteuerungWerte | null | undefined): WerteJe {
  return new Map((w?.werte ?? []).map((x) => [x.point_key, x]));
}

const SCHLECHT = new Set(['invalid', 'device_error']);

/** Der Wert eines Punkts, wenn er einer ist: gelesen und nicht ungültig. */
export function wertVon(je: WerteJe, key: string): number | null {
  const w = je.get(key);
  if (!w || w.wert == null || w.zustand === 'keine_daten') return null;
  if (w.qualitaet != null && SCHLECHT.has(w.qualitaet)) return null;
  return w.wert;
}

/** Ein Bit eines Bitfelds: `null` = das Bitfeld hat keinen Wert (unbekannt, nie „aus“). */
export function bitVon(je: WerteJe, key: string, bit: number): boolean | null {
  const roh = wertVon(je, key);
  return roh == null ? null : Math.floor(roh / 2 ** bit) % 2 === 1;
}

/** Ist mindestens einer der Punkte gelesen, aber veraltet? */
function veraltet(je: WerteJe, keys: string[]): boolean {
  return keys.some((k) => je.get(k)?.zustand === 'veraltet');
}

/** Die älteste Lesung unter den veralteten Punkten (ISO) - sie sagt, wie alt das Bild der Einheit ist. */
function aeltesteVeraltete(je: WerteJe, keys: string[]): string | null {
  let alt: string | null = null;
  for (const k of keys) {
    const w = je.get(k);
    if (w?.zustand !== 'veraltet' || !w.gemessen_am) continue;
    if (alt == null || Date.parse(w.gemessen_am) < Date.parse(alt)) alt = w.gemessen_am;
  }
  return alt;
}

/** Die jüngste Lesung unter den Punkten (ISO) oder `null`. */
export function juengsteLesung(je: WerteJe, keys?: string[]): string | null {
  let best: string | null = null;
  for (const [k, w] of je) {
    if (keys && !keys.includes(k)) continue;
    if (w.gemessen_am && (best == null || Date.parse(w.gemessen_am) > Date.parse(best))) best = w.gemessen_am;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Einheiten: Namen und Wörter
// ---------------------------------------------------------------------------

export const EINHEIT_ART_WORT: Record<ErzeugungseinheitArt, string> = {
  pv_wechselrichter: 'PV-Wechselrichter',
  bhkw_motor: 'BHKW-Motor',
};

const EINHEIT_KURZ: Record<ErzeugungseinheitArt, string> = {
  pv_wechselrichter: 'Wechselrichter',
  bhkw_motor: 'Motor',
};

/** Die Art einer Einheit: aus den Stammdaten, sonst aus dem Bild (`t_art`), sonst unbekannt. */
export function einheitArt(e: Erzeugungseinheit, je?: WerteJe): ErzeugungseinheitArt | null {
  if (e.einheit_art) return e.einheit_art;
  const t = je ? wertVon(je, einheitPunkt(e.te_nr, 't_art')) : null;
  return t === 1 ? 'pv_wechselrichter' : t === 2 ? 'bhkw_motor' : null;
}

/** „Motor 1“ / „Wechselrichter 2“ / „Einheit 3“ - die Nummer im Bild, nie geraten. */
export function einheitNummer(e: Erzeugungseinheit, je?: WerteJe): string {
  const art = einheitArt(e, je);
  return `${art ? EINHEIT_KURZ[art] : 'Einheit'} ${e.te_nr}`;
}

/** Der Name in der Anzeige: die Bezeichnung, sonst die Nummer. Umbenennen ändert nur ihn. */
export function einheitName(e: Erzeugungseinheit, je?: WerteJe): string {
  return e.bezeichnung ?? einheitNummer(e, je);
}

/** Hersteller und Typ: die Anzeige, sonst der Typname aus dem Bild. */
export function einheitTyp(e: Erzeugungseinheit): string | null {
  return e.typ ?? e.typ_bild;
}

/** Die Nennleistung: aus den Stammdaten, sonst aus dem Bild (`t_nenn_kw`), mit Herkunft. */
export function einheitNenn(e: Erzeugungseinheit, je?: WerteJe): { kw: number; ausBild: boolean } | null {
  if (e.nennleistung_kw != null) return { kw: e.nennleistung_kw, ausBild: false };
  const t = je ? wertVon(je, einheitPunkt(e.te_nr, 't_nenn_kw')) : null;
  return t != null && t > 0 ? { kw: t, ausBild: true } : null;
}

export function sortiert(einheiten: readonly Erzeugungseinheit[]): Erzeugungseinheit[] {
  return [...einheiten].sort((a, b) => a.te_nr - b.te_nr);
}

const ZUSTAND_TEXT: Record<number, string> = {
  0: 'aus', 1: 'bereit', 2: 'läuft', 3: 'läuft begrenzt', 4: 'Störung', 5: 'Hand/Wartung', 6: 'Not-Aus',
};

/** `t_bits` Bit 4–9: warum eine Einheit nicht für den Direktvermarkter bereit ist (Vertrag EZ-1 §4). */
export const NICHT_BEREIT_GRUND: Record<number, string> = {
  4: 'Störung',
  5: 'Vorgabe des Netzbetreibers',
  6: 'Hand/Ort',
  7: 'Wartung',
  8: 'Gasspeicher leer',
  9: 'sonstiger Grund',
};

/** Der Zustand einer Einheit (`t_zustand`), nur mit `t_bits` Bit 0 „Werte gültig“ - sonst `null`. */
export function einheitZustand(je: WerteJe, teNr: number): string | null {
  if (bitVon(je, einheitPunkt(teNr, 't_bits'), 0) === false) return null;
  const roh = wertVon(je, einheitPunkt(teNr, 't_zustand'));
  if (roh == null) return null;
  return je.get(einheitPunkt(teNr, 't_zustand'))?.text ?? ZUSTAND_TEXT[roh] ?? null;
}

// ---------------------------------------------------------------------------
// Netzbetreiber und Direktvermarkter: Namen
// ---------------------------------------------------------------------------

/** Der Netzbetreiber: vom Netzanschluss, sonst aus dem Bild. */
export function netzbetreiberName(nv: NetzVermarktung | null | undefined): string | null {
  return nv?.netzbetreiber ?? nv?.namen_aus_bild?.netzbetreiber ?? null;
}

/** Der Direktvermarkter: die Anzeige der Stammdaten, sonst aus dem Bild. */
export function direktvermarkterName(nv: NetzVermarktung | null | undefined): string | null {
  return nv?.direktvermarkter ?? nv?.namen_aus_bild?.direktvermarkter ?? null;
}

/**
 * Hat die Anlage einen Direktvermarkter? Gemessen geht vor: der Kanal des Bilds (`d_kanal` 0 = keiner).
 * Ohne Messung zählen die Stammdaten (Kanal oder Name).
 */
export function hatDirektvermarkter(nv: NetzVermarktung | null | undefined, je: WerteJe): boolean {
  const kanal = wertVon(je, PUNKT.dvKanal);
  if (kanal != null) return kanal !== 0;
  if (nv?.direktvermarkter_kanal) return nv.direktvermarkter_kanal !== 'keiner';
  return direktvermarkterName(nv) != null;
}

/** „VoltPilot liest diese Anlage nur. Gesteuert wird sie vom Netzbetreiber … und vom Direktvermarkter …“ */
export function steuerSatz(nv: NetzVermarktung | null | undefined, je: WerteJe): string {
  const nb = netzbetreiberName(nv);
  const dv = direktvermarkterName(nv);
  const vomNb = nb ? `vom Netzbetreiber ${nb}` : 'vom Netzbetreiber';
  const vomDv = hatDirektvermarkter(nv, je) ? (dv ? ` und vom Direktvermarkter ${dv}` : ' und vom Direktvermarkter') : '';
  return `VoltPilot liest diese Anlage nur. Gesteuert wird sie ${vomNb}${vomDv}.`;
}

// ---------------------------------------------------------------------------
// (1) Steuerung › Geräte: wer steuert, je Einheit
// ---------------------------------------------------------------------------

export type Folgt = 'folgt' | 'folgt_nicht';

export interface DvBereitschaft {
  bereit: boolean;
  aktiv: boolean;
  /** Bit 4–9, nur wenn nicht bereit. */
  gruende: string[];
  text: string;
}

export interface EinheitZeile {
  teNr: number;
  name: string;
  /** „Wechselrichter 1 · Growatt MAX 125KTL3-X“ - Nummer und Typ, wenn der Name eine Bezeichnung ist. */
  unter: string;
  symbol: 'sun' | 'flame';
  istW: number | null;
  sollW: number | null;
  ist: string;
  soll: string;
  zustand: string | null;
  folgt: Folgt | null;
  dv: DvBereitschaft | null;
  /** „zuletzt vor 3 Min.“, wenn einer der Werte veraltet ist; sonst `null`. */
  veraltet: string | null;
  /** Kein einziger Wert der Einheit gelesen. */
  ohneDaten: boolean;
}

/** Folgt die Anlage der wirksamen Grenze (`s_bits` Bit 1, nur mit Bit 0 „gültig“)? `null` = unbekannt. */
export function anlageFolgt(je: WerteJe): boolean | null {
  if (bitVon(je, PUNKT.sBits, 0) !== true) return null;
  return bitVon(je, PUNKT.sBits, 1);
}

function dvBereitschaft(je: WerteJe, teNr: number): DvBereitschaft | null {
  const key = einheitPunkt(teNr, 't_bits');
  const bereit = bitVon(je, key, 2);
  if (bereit == null) return null;
  const aktiv = bitVon(je, key, 3) === true;
  if (bereit) {
    return { bereit, aktiv, gruende: [], text: aktiv ? 'vom Direktvermarkter abgerufen' : 'bereit für den Direktvermarkter' };
  }
  const gruende = Object.keys(NICHT_BEREIT_GRUND)
    .map(Number)
    .filter((b) => bitVon(je, key, b) === true)
    .map((b) => NICHT_BEREIT_GRUND[b]);
  return {
    bereit,
    aktiv,
    gruende,
    text: gruende.length
      ? `nicht bereit für den Direktvermarkter: ${gruende.join(', ')}`
      : 'nicht bereit für den Direktvermarkter (die Steuerung nennt keinen Grund)',
  };
}

/**
 * Je Einheit Soll, Ist, ob sie folgt und ob sie für den Direktvermarkter bereit ist. „Folgt“ misst die
 * Steuerung für die ganze Anlage (`s_bits`); folgt sie nicht, heißt die Einheit „folgt nicht“, deren Ist über
 * ihrem Soll liegt - nie eine geratene Einheit.
 */
export function einheitZeilen(
  s: Anlagensteuerung,
  werte: AnlagensteuerungWerte | null | undefined,
  nv: NetzVermarktung | null | undefined,
  now: Date = new Date(),
): EinheitZeile[] {
  const je = werteJe(werte);
  const plantFolgt = anlageFolgt(je);
  const mitDv = hatDirektvermarkter(nv, je);
  return sortiert(s.einheiten).map((e) => {
    const bits = einheitPunkt(e.te_nr, 't_bits');
    const istKey = einheitPunkt(e.te_nr, 't_p_ist_w');
    const sollKey = einheitPunkt(e.te_nr, 't_p_soll_w');
    const istW = bitVon(je, bits, 0) === false ? null : wertVon(je, istKey);
    const sollW = bitVon(je, bits, 1) === false ? null : wertVon(je, sollKey);
    let folgt: Folgt | null = null;
    if (plantFolgt != null && sollW != null) {
      if (plantFolgt) folgt = 'folgt';
      else if (istW != null) folgt = istW > sollW ? 'folgt_nicht' : 'folgt';
    }
    const name = einheitName(e, je);
    const typ = einheitTyp(e);
    const unter = [e.bezeichnung ? einheitNummer(e, je) : null, typ].filter(Boolean).join(' · ');
    const keys = [istKey, sollKey, bits, einheitPunkt(e.te_nr, 't_zustand')];
    const alt = aeltesteVeraltete(je, keys);
    return {
      teNr: e.te_nr,
      name,
      unter,
      symbol: einheitArt(e, je) === 'bhkw_motor' ? 'flame' : 'sun',
      istW,
      sollW,
      ist: kwText(istW),
      soll: kwText(sollW),
      zustand: einheitZustand(je, e.te_nr),
      folgt,
      dv: mitDv ? dvBereitschaft(je, e.te_nr) : null,
      veraltet: alt ? `zuletzt ${fmtRelative(alt, now)}` : null,
      ohneDaten: keys.every((k) => (je.get(k)?.zustand ?? 'keine_daten') === 'keine_daten'),
    };
  });
}

/** Die Zeile unter dem Satz: folgt die Anlage der Grenze? `null` = unbekannt, dann kein Satz. */
export function folgtSatz(je: WerteJe): string | null {
  const f = anlageFolgt(je);
  if (f == null) return null;
  return f ? 'Die Anlage folgt der wirksamen Grenze.' : 'Die Anlage folgt der wirksamen Grenze gerade nicht.';
}

// ---------------------------------------------------------------------------
// (2) Geräteseite: die Steuerung als Gerät
// ---------------------------------------------------------------------------

/**
 * Die Einheiten wie die Energiekarten: „Motor 1 · MAN E0836LE“ mit Art, Nennleistung und Zustand. Ohne Werte
 * steht „noch keine Daten“ statt eines Zustands, ein fehlender Wert als „—“.
 */
export function einheitenZeilen(einheiten: readonly Erzeugungseinheit[], werte: AnlagensteuerungWerte | null | undefined): Zeile[] {
  const je = werteJe(werte);
  const daten = werte?.stand === 'daten';
  return sortiert(einheiten).map((e) => {
    const art = einheitArt(e, je);
    const nenn = einheitNenn(e, je);
    const zustand = einheitZustand(je, e.te_nr);
    const typ = einheitTyp(e);
    const detail = [
      art ? EINHEIT_ART_WORT[art] : 'Art nicht erfasst',
      e.bezeichnung ? typ : null,
      nenn ? `${NF0.format(nenn.kw)}${NBSP}kW${nenn.ausBild ? ' laut Steuerung' : ''}` : 'Nennleistung nicht erfasst',
      daten ? (zustand ?? `Zustand ${STRICH}`) : NOCH_KEINE_DATEN,
    ].filter((x): x is string => Boolean(x));
    return {
      label: einheitNummer(e, je),
      wert: e.bezeichnung ?? typ ?? (art ? EINHEIT_ART_WORT[art] : 'Erzeugungseinheit'),
      detail: detail.join(' · '),
    };
  });
}

/** Sekunden in Worten: „3 s“, „2 min“, „1 h 5 min“. */
function sekunden(s: number): string {
  if (s < 90) return `${NF0.format(s)}${NBSP}s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min}${NBSP}min`;
  return `${Math.floor(min / 60)}${NBSP}h${min % 60 ? ` ${min % 60}${NBSP}min` : ''}`;
}

/**
 * Der Netzpunkt (`a_gueltig` Bit 0 gültig · 1 berechnet · 2 Messung tot). Ohne Messung (EW-16 C, z. B. Büttner)
 * sind alle drei Bits 0: dann „—“ und „keine Messung am Netzpunkt“, nie 0.
 */
export function netzpunktZeile(werte: AnlagensteuerungWerte | null | undefined): Zeile {
  const label = 'Netzpunkt';
  if (!werte || werte.stand !== 'daten') return { label, wert: STRICH, detail: NOCH_KEINE_DATEN };
  const je = werteJe(werte);
  const gueltig = bitVon(je, PUNKT.aGueltig, 0);
  const berechnet = bitVon(je, PUNKT.aGueltig, 1) === true;
  const tot = bitVon(je, PUNKT.aGueltig, 2) === true;
  const alter = wertVon(je, PUNKT.aAlter);
  const alt = alter != null ? `Messung ${sekunden(alter)} alt` : null;
  if (gueltig == null) return { label, wert: STRICH, detail: 'Gültigkeit unbekannt' };
  if (tot) return { label, wert: STRICH, detail: ['Messung am Netzpunkt ausgefallen', alt].filter(Boolean).join(' · ') };
  if (!gueltig && !berechnet) return { label, wert: STRICH, detail: 'keine Messung am Netzpunkt' };
  const w = gueltig ? wertVon(je, PUNKT.nvp) : null;
  const wert = w == null ? STRICH : w > 50 ? `bezieht ${kwText(w)}` : w < -50 ? `speist ${kwText(-w)} ein` : kwText(0);
  const herkunft = berechnet ? 'berechnet aus mehreren Messungen' : 'gemessen';
  const stale = veraltet(je, [PUNKT.nvp, PUNKT.aGueltig]) ? 'veraltet' : null;
  return { label, wert, detail: [herkunft, alt, stale].filter(Boolean).join(' · ') };
}

/** „Datenstand“: wann die Box zuletzt einen Wert dieser Steuerung lieferte. */
export function datenstandZeile(werte: AnlagensteuerungWerte | null | undefined, now: Date = new Date()): Zeile {
  const juengst = werte ? juengsteLesung(werteJe(werte)) : null;
  if (!juengst) return { label: 'Datenstand', wert: NOCH_KEINE_DATEN };
  const alt = Date.parse(juengst) < now.getTime() - 120_000;
  return {
    label: 'Datenstand',
    wert: fmtRelative(juengst, now),
    ...(alt ? { detail: 'veraltet - die Box liefert spätestens jede Minute einen Wert' } : {}),
  };
}

// ---------------------------------------------------------------------------
// (3) Anlage › Einstellungen › „Strom & Geld“
// ---------------------------------------------------------------------------

export const KANAL_WORT: Record<DirektvermarkterKanal, string> = {
  keiner: 'ohne Signal an die Steuerung',
  relais_ma: 'über Relais und 4–20 mA',
  modbus: 'über Modbus',
};

export const EINSPEISEMANAGEMENT_WORT: Record<Einspeisemanagement, string> = {
  statisch: 'feste Grenze',
  stufen: 'Stufen (Rundsteuerempfänger)',
  fernwirk: 'Fernwirktechnik',
};

/** Die Wahl des Einspeisemanagements - dieselben Zeilen in Anlage › Einstellungen und im Anlege-Schritt (EZ-15). */
export const EINSPEISEMANAGEMENT_OPTIONEN: { value: Einspeisemanagement; label: string; sub: string }[] = [
  { value: 'statisch', label: EINSPEISEMANAGEMENT_WORT.statisch, sub: 'Eine feste Wirkleistungsgrenze in Prozent' },
  { value: 'stufen', label: EINSPEISEMANAGEMENT_WORT.stufen, sub: 'Der Netzbetreiber schaltet Stufen, z. B. 60 % / 30 % / 0 %' },
  { value: 'fernwirk', label: EINSPEISEMANAGEMENT_WORT.fernwirk, sub: 'Vorgaben über eine Fernwirkanlage, z. B. IEC 60870-5-101' },
];

/** Die Wahl des Wegs, auf dem der Direktvermarkter seine Vorgaben schickt - wie oben an beiden Orten. */
export const KANAL_OPTIONEN: { value: DirektvermarkterKanal; label: string; sub: string }[] = [
  { value: 'relais_ma', label: 'Relais und 4–20 mA', sub: 'z. B. Poolbox mit Kontakten und Sollwert-Signal' },
  { value: 'modbus', label: 'Modbus', sub: 'Der Direktvermarkter schreibt in die Steuerung' },
  { value: 'keiner', label: 'Kein Signal an die Steuerung', sub: 'Vermarktung ohne Fernsteuerung' },
];

export function direktvermarkterWert(nv: NetzVermarktung): string {
  const name = nv.direktvermarkter ?? 'keiner erfasst';
  return nv.direktvermarkter_kanal ? `${name} · ${KANAL_WORT[nv.direktvermarkter_kanal]}` : name;
}

export function einspeisemanagementWert(nv: NetzVermarktung): string {
  if (!nv.einspeisemanagement) return 'nicht erfasst';
  const wort = EINSPEISEMANAGEMENT_WORT[nv.einspeisemanagement];
  return nv.einspeisemanagement === 'statisch' && nv.einspeisemanagement_prozent != null
    ? `${wort} ${prozentText(nv.einspeisemanagement_prozent)}`
    : wort;
}

function gleich(a: string, b: string): boolean {
  const n = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  return n(a) === n(b);
}

/** Weicht die Anzeige des Direktvermarkters vom Namen im Bild ab, sagt es ein Hinweis - nie ein Überschreiben. */
export function direktvermarkterHinweis(nv: NetzVermarktung): string | null {
  const bild = nv.namen_aus_bild?.direktvermarkter ?? null;
  if (!bild) return null;
  if (!nv.direktvermarkter) return `Die Steuerung nennt „${bild}“; hier ist keiner eingetragen.`;
  return gleich(bild, nv.direktvermarkter) ? null : `Die Steuerung nennt „${bild}“ - angezeigt wird Ihr Name.`;
}

/** Weicht der Typ der Einheit vom Typnamen im Bild ab: der Hinweis. */
export function typHinweis(e: Erzeugungseinheit): string | null {
  if (!e.typ_bild || !e.typ || gleich(e.typ, e.typ_bild)) return null;
  return `Die Steuerung nennt „${e.typ_bild}“.`;
}

export const SEE_MUSTER = /^SEE[0-9]{12}$/;

// ---------------------------------------------------------------------------
// (4) Verlauf › Messwerte: die Kurven je Einheit
// ---------------------------------------------------------------------------

/**
 * Das Präfix der synthetischen `entityId` einer Anlagensteuerung im Verlauf-Explorer - ohne Doppelpunkt, damit
 * der Deep-Link `m={entityId}:{channel}` am ersten Doppelpunkt trennt (wie `berechnet-`). Der Kanal ist der
 * Punktschlüssel (`erzeuger.te[2].t_p_ist_w`).
 */
export const ERZEUGER_PREFIX = 'erzeuger-';

export function istErzeugerZiel(entityId: string): boolean {
  return entityId.startsWith(ERZEUGER_PREFIX);
}

export function erzeugerGeraetId(entityId: string): string {
  return entityId.slice(ERZEUGER_PREFIX.length);
}

/** Der Ast einer Anlagensteuerung: je Einheit Ist und Soll, dazu Netzpunkt, Erzeugung, Gasspeicher und Vorgaben. */
export function erzeugerGruppe(s: Anlagensteuerung): VerlaufGroup {
  const entityId = ERZEUGER_PREFIX + s.geraet_id;
  const item = (channel: string, label: string, unit: string, role: ComponentRole) => ({
    entityId,
    channel,
    label,
    unit,
    role,
    raw: channel,
    producer: false,
  });
  const einheiten = sortiert(s.einheiten).flatMap((e) => [
    item(einheitPunkt(e.te_nr, 't_p_ist_w'), `${einheitName(e)} · Ist`, 'kW', 'pv' as const),
    item(einheitPunkt(e.te_nr, 't_p_soll_w'), `${einheitName(e)} · Soll`, 'kW', 'pv' as const),
  ]);
  const gas = s.fassung?.anlagenart === 'pv' ? [] : [item(PUNKT.speicher, 'Gasspeicher', '%', 'storage')];
  return {
    entityId,
    label: s.bezeichnung ?? 'Anlagensteuerung',
    rawLabel: [s.bezeichnung, s.kennzeichen].filter(Boolean).join(' · ') || 'Anlagensteuerung',
    role: 'pv',
    icon: 'cpu',
    deviceLine: [s.hersteller, s.typ].filter(Boolean).join(' ') || null,
    health: 'ok',
    measuredVia: null,
    items: [
      ...einheiten,
      item(PUNKT.erzeugung, 'Erzeugung gesamt', 'kW', 'pv'),
      item(PUNKT.nvp, 'Netzpunkt', 'kW', 'grid'),
      ...gas,
      item(PUNKT.nbProzent, 'Vorgabe Netzbetreiber', '%', 'grid'),
      item(PUNKT.dvSoll, 'Direktvermarkter · Soll', 'kW', 'grid'),
      item(PUNKT.grenze, 'Wirksame Grenze', 'kW', 'grid'),
    ],
  };
}

/** Die Chart-Reihe eines Punkts: W → kW, % bleibt; Tag als Linie, sonst Mittel mit Band. Ohne Eimer leer. */
export function seriesFromErzeugerVerlauf(v: AnlagensteuerungVerlauf, pointKey: string): VerlaufSeries {
  const kurve = v.kurven.find((k) => k.point_key === pointKey);
  const faktor = kurve?.einheit === 'W' ? 1 / 1000 : 1;
  const isDay = v.range === 'day';
  const points = (kurve?.eimer ?? []).map((b) => ({
    t: b.start,
    avg: b.avg * faktor,
    min: b.min * faktor,
    max: b.max * faktor,
    n: b.n,
  }));
  return {
    points,
    unit: kurve?.einheit === '%' ? '%' : 'kW',
    hasBand: !isDay,
    isDay,
    bars: false,
    bucketMinutes: v.bucket_minutes,
    empty: points.length === 0,
  };
}
