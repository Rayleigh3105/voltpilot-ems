/**
 * **Erzeuger am Wago-Modbus-Server** im Cockpit (Konzept „Erzeuger am WAGO-Modbus-Server“, Fassung 12,
 * §4.5; Paket EZ-8, Entscheid EW-11 A): was vom Netzbetreiber kommt, was der Direktvermarkter will und
 * was die Anlage gerade macht - in der bestehenden Struktur (Kopf, Bühne, Steuerzeile, Tagesleiste,
 * Kacheln), ohne neuen Reiter.
 *
 * Die Werte sind Messpunkte `erzeuger.*` der Anlagensteuerung (schlanke Fassung des Registerbilds,
 * EW-17 A; Bedeutung Bericht §3.7, Lesarten aus dem Vertrag EZ-1). Die Punktnamen folgen §4.2:
 * `erzeuger.<abschnitt>.<feld ohne Abschnitts-Kürzel>`, z. B. `erzeuger.nb.bits`,
 * `erzeuger.wirkung.quelle_p`, `erzeuger.te2.p_ist_w`.
 *
 * Diese Datei rechnet nur; die Komponenten rendern ihr Ergebnis. Fehlend ist keine Null: ein Wert ohne
 * Gültigkeitsbit, ohne Lesung oder mit Qualität `invalid`/`device_error` ist `null` und steht als „—“.
 * Wörter (§4.1): „Vorgabe“ für das Signal von außen, „Abruf“ beim Direktvermarkter - nie „Eingriff“,
 * das ist im Portal der Handeingriff.
 */
import type { ErzeugerJetzt, ErzeugerQualitaet, ErzeugerWechsel, ErzeugerWert } from './api';
import type { Liste } from './flussListen';
import { NBSP } from './format';
import { kw, prozent, type FlussWerte } from './leitungsplan';
import { uhrzeit, VIERTEL_MS, type Tag } from './tagesleiste';

/* ---------------------------------------------------------------- Punkte */

/** Die Punktnamen der Anlagen-Abschnitte (Kopf, Anlage, Netzbetreiber, Direktvermarkter, Wirkung). */
export const ERZEUGER_PUNKT = {
  anlagenart: 'erzeuger.kopf.anlagenart',
  teAnzahl: 'erzeuger.kopf.te_anzahl',
  aGueltig: 'erzeuger.anlage.gueltig',
  aAlterS: 'erzeuger.anlage.alter_s',
  pNvpW: 'erzeuger.anlage.p_nvp_w',
  pErzeugungW: 'erzeuger.anlage.p_erzeugung_w',
  anlageZustand: 'erzeuger.anlage.zustand',
  aBits: 'erzeuger.anlage.bits',
  speicherFuellstand: 'erzeuger.anlage.speicher_fuellstand',
  pInstalliertKw: 'erzeuger.anlage.p_installiert_kw',
  nbKanal: 'erzeuger.nb.kanal',
  nbBits: 'erzeuger.nb.bits',
  nbProzent: 'erzeuger.nb.p_vorgabe_prozent',
  nbCosphi: 'erzeuger.nb.cosphi',
  nbSeitS: 'erzeuger.nb.seit_s',
  dvKanal: 'erzeuger.dv.kanal',
  dvBits: 'erzeuger.dv.bits',
  dvSollW: 'erzeuger.dv.p_soll_w',
  dvSeitS: 'erzeuger.dv.seit_s',
  quelleP: 'erzeuger.wirkung.quelle_p',
  sBits: 'erzeuger.wirkung.bits',
  pGrenzeW: 'erzeuger.wirkung.p_grenze_w',
} as const;

/** Felder des Blocks je Einheit (`t_*` ohne Kürzel). */
export type EinheitFeld = 'zustand' | 'bits' | 'art' | 'nenn_kw' | 'p_ist_w' | 'p_soll_w';

/** Punktname eines Felds der Einheit `teNr` (1…10), z. B. `erzeuger.te2.p_ist_w`. */
export function einheitPunkt(teNr: number, feld: EinheitFeld): string {
  return `erzeuger.te${teNr}.${feld}`;
}

/** Deren Zustandswechsel zählt „Wer hat heute geregelt?“ (bis das Protokoll EZ-7/EZ-9 kommt). */
export const WECHSEL_PUNKTE = [ERZEUGER_PUNKT.quelleP, ERZEUGER_PUNKT.nbBits, ERZEUGER_PUNKT.dvBits] as const;

/* ------------------------------------------------------------- Eingabe */

export type { ErzeugerJetzt, ErzeugerQualitaet, ErzeugerWechsel, ErzeugerWert };

/* ---------------------------------------------------------------- Lage */

export type Anlagenart = 'pv' | 'bhkw' | 'gemischt';

/** Wer gerade begrenzt (`quelle_p`, schlanke Fassung §3.7). */
export type Quelle = 'keine' | 'netzbetreiber' | 'direktvermarkter' | 'netzpunkt' | 'hand' | 'not_aus' | 'ersatzwert';
const QUELLEN: Quelle[] = ['keine', 'netzbetreiber', 'direktvermarkter', 'netzpunkt', 'hand', 'not_aus', 'ersatzwert'];

export type AnlageZustand = 'aus' | 'bereit' | 'laeuft' | 'laeuft_begrenzt' | 'stoerung' | 'hand' | 'not_aus';
const ZUSTAENDE: AnlageZustand[] = ['aus', 'bereit', 'laeuft', 'laeuft_begrenzt', 'stoerung', 'hand', 'not_aus'];
export const ZUSTAND_WORT: Record<AnlageZustand, string> = {
  aus: 'aus',
  bereit: 'bereit',
  laeuft: 'läuft',
  laeuft_begrenzt: 'läuft begrenzt',
  stoerung: 'Störung',
  hand: 'Hand/Wartung',
  not_aus: 'Not-Aus',
};

/** `t_bits` Bit 4–9: Gründe für „nicht bereit“ (Vertrag EZ-1, Lesart 7). */
const NICHT_BEREIT_GRUND = ['Störung', 'Vorgabe des Netzbetreibers', 'Hand/Ort', 'Wartung', 'Gasspeicher leer', 'sonstiger Grund'];

export interface Einheit {
  teNr: number;
  art: 'pv' | 'bhkw' | null;
  /** „Motor 1“ bzw. „Wechselrichter 1“. */
  name: string;
  typName: string | null;
  nennKw: number | null;
  istKw: number | null;
  sollKw: number | null;
  zustand: AnlageZustand | null;
  dvBereit: boolean | null;
  dvAktiv: boolean | null;
  gruende: string[];
}

export interface ErzeugerLage {
  art: Anlagenart | null;
  steuerungName: string;
  netzbetreiberName: string | null;
  direktvermarkterName: string | null;
  installiertKw: number | null;
  /** Leistung am Netzpunkt, + Bezug / − Einspeisung; null = keine Messung (EW-16 C) oder tot. */
  netzKw: number | null;
  netzBerechnet: boolean;
  erzeugungKw: number | null;
  /** Verbrauch hinter dem Netzpunkt = Erzeugung + Netzpunkt; null, wenn eines fehlt. */
  hofKw: number | null;
  gasspeicherPct: number | null;
  zustand: AnlageZustand | null;
  nb: {
    /** 0 keiner · 1 feste Grenze · 2 Stufen · 3 Fernwirktechnik. */
    kanal: number | null;
    verbunden: boolean | null;
    begrenzt: boolean;
    notAus: boolean;
    prozent: number | null;
    cosphi: number | null;
    seit: number | null;
    /** Leitstelle getrennt: die Vorgabe ist nur noch gehalten. */
    gehalten: boolean;
  };
  dv: {
    /** 0 keiner · 1 Relais und mA · 2 Modbus. */
    kanal: number | null;
    abruf: boolean;
    stopp: boolean;
    bereit: boolean | null;
    sollKw: number | null;
    seit: number | null;
  };
  quelle: Quelle | null;
  folgt: boolean | null;
  grenzeKw: number | null;
  einheiten: Einheit[];
  nichtBereit: string | null;
  /** Jüngste Lesung (ms). */
  gelesenAm: number | null;
  /** Die Steuerung schweigt oder der Herzschlag steht (Qualität `stale`, Lesung älter als 2 min). */
  veraltet: boolean;
}

/** Ab diesem Alter gilt eine Lesung als veraltet: die Box liefert jeden Wert spätestens alle 60 s (EW-5). */
export const VERALTET_MS = 120_000;
/** Unter diesem Betrag am Netzpunkt fließt „nichts ins Netz“ (Nulleinspeisung). */
const NULL_KW = 1;

const bit = (x: number | null, n: number): boolean | null => (x == null ? null : ((x >> n) & 1) === 1);

export function erzeugerLage(j: ErzeugerJetzt, now: Date): ErzeugerLage {
  let juengste: number | null = null;
  let veraltet = false;
  for (const w of Object.values(j.werte)) {
    const t = w.gelesenAm ? Date.parse(w.gelesenAm) : NaN;
    if (Number.isFinite(t) && (juengste == null || t > juengste)) juengste = t;
    if (w.qualitaet === 'stale') veraltet = true;
  }
  if (juengste == null || now.getTime() - juengste > VERALTET_MS) veraltet = true;

  const roh = (key: string): ErzeugerWert | null => j.werte[key] ?? null;
  const zahl = (key: string): number | null => {
    const w = roh(key);
    if (!w || w.wert == null || !Number.isFinite(w.wert)) return null;
    if (w.qualitaet === 'invalid' || w.qualitaet === 'device_error') return null;
    return w.wert;
  };
  // Ein Gültigkeitsbit = 0 macht den Wert unbekannt, nie 0 (Lesart 5); ohne Bitfeld gilt der Wert.
  const gedeckt = (v: number | null, deckung: boolean | null) => (deckung === false ? null : v);
  const P = ERZEUGER_PUNKT;
  const seitAus = (key: string): number | null => {
    const s = zahl(key);
    const t = roh(key)?.gelesenAm;
    return s == null || !t ? null : Date.parse(t) - s * 1000;
  };
  const aufz = <T>(liste: T[], v: number | null): T | null => (v == null ? null : liste[v] ?? null);

  const aG = zahl(P.aGueltig);
  const netzW = gedeckt(zahl(P.pNvpW), bit(aG, 0));
  const erzW = gedeckt(zahl(P.pErzeugungW), bit(aG, 3));
  const netzKw = netzW == null ? null : netzW / 1000;
  const erzeugungKw = erzW == null ? null : erzW / 1000;

  const nbBits = zahl(P.nbBits);
  const nbKanal = zahl(P.nbKanal);
  const nbProzent = gedeckt(zahl(P.nbProzent), bit(nbBits, 0));
  const verbunden = bit(nbBits, 1);
  const nb = {
    kanal: nbKanal,
    verbunden,
    begrenzt: bit(nbBits, 2) === true || (nbProzent != null && nbProzent < 100),
    notAus: bit(nbBits, 3) === true,
    prozent: nbProzent,
    cosphi: bit(nbBits, 4) === true ? gedeckt(zahl(P.nbCosphi), bit(nbBits, 0)) : null,
    seit: seitAus(P.nbSeitS),
    gehalten: nbKanal === 3 && verbunden === false,
  };

  const dvBits = zahl(P.dvBits);
  const dvG = bit(dvBits, 0);
  const dvSoll = gedeckt(zahl(P.dvSollW), dvG);
  const dv = {
    kanal: zahl(P.dvKanal),
    abruf: dvG !== false && bit(dvBits, 1) === true,
    stopp: dvG !== false && bit(dvBits, 2) === true,
    bereit: dvG === false ? null : bit(dvBits, 3),
    sollKw: dvSoll == null ? null : dvSoll / 1000,
    seit: dvG === false ? null : seitAus(P.dvSeitS),
  };

  const sBits = zahl(P.sBits);
  const sG = bit(sBits, 0);
  const grenzeW = gedeckt(zahl(P.pGrenzeW), sG);

  const artZahl = zahl(P.anlagenart);
  const teAnzahl = zahl(P.teAnzahl);
  const nummern = new Set(j.einheiten.map((e) => e.teNr));
  if (teAnzahl != null) for (let n = 1; n <= Math.min(10, teAnzahl); n++) nummern.add(n);
  const einheiten: Einheit[] = [...nummern].sort((a, b) => a - b).map((teNr) => {
    const stamm = j.einheiten.find((e) => e.teNr === teNr);
    const tBits = zahl(einheitPunkt(teNr, 'bits'));
    const werteOk = bit(tBits, 0);
    const artP = zahl(einheitPunkt(teNr, 'art'));
    const art = stamm?.art ?? (artP === 1 ? 'pv' : artP === 2 ? 'bhkw' : null);
    const ist = gedeckt(zahl(einheitPunkt(teNr, 'p_ist_w')), werteOk);
    const soll = gedeckt(zahl(einheitPunkt(teNr, 'p_soll_w')), bit(tBits, 1));
    const gruende = tBits == null ? [] : NICHT_BEREIT_GRUND.filter((_, i) => bit(tBits, 4 + i) === true);
    return {
      teNr,
      art,
      name: `${art === 'pv' ? 'Wechselrichter' : art === 'bhkw' ? 'Motor' : 'Einheit'} ${teNr}`,
      typName: stamm?.typName ?? null,
      nennKw: stamm?.nennKw ?? zahl(einheitPunkt(teNr, 'nenn_kw')),
      istKw: ist == null ? null : ist / 1000,
      sollKw: soll == null ? null : soll / 1000,
      zustand: aufz(ZUSTAENDE, gedeckt(zahl(einheitPunkt(teNr, 'zustand')), werteOk)),
      dvBereit: bit(tBits, 2),
      dvAktiv: bit(tBits, 3),
      gruende,
    };
  });

  const art: Anlagenart | null =
    artZahl === 1 ? 'pv' : artZahl === 2 ? 'bhkw' : artZahl === 3 ? 'gemischt'
      : einheiten.length && einheiten.every((e) => e.art === 'bhkw') ? 'bhkw'
        : einheiten.length && einheiten.every((e) => e.art === 'pv') ? 'pv' : null;

  const zustand = aufz(ZUSTAENDE, zahl(P.anlageZustand));
  const aBits = zahl(P.aBits);
  let nichtBereit: string | null = null;
  if (zustand === 'stoerung' || bit(aBits, 2) === true) nichtBereit = 'Störung';
  else if (zustand === 'not_aus' || bit(aBits, 0) === true) nichtBereit = 'Not-Aus vor Ort';
  else if (bit(aBits, 1) === true) nichtBereit = 'NA-Schutz ausgelöst';
  else if (zustand === 'hand' || bit(aBits, 3) === true || bit(aBits, 4) === true) nichtBereit = 'Hand/Wartung';
  else if ((dv.kanal ?? 0) > 0 && dv.bereit === false) {
    const g = [...new Set(einheiten.flatMap((e) => e.gruende))];
    nichtBereit = g.length ? `dem Direktvermarkter nicht bereit gemeldet: ${g.join(', ')}` : 'dem Direktvermarkter nicht bereit gemeldet';
  }

  const installiertKw = zahl(P.pInstalliertKw);
  const hof = erzeugungKw == null || netzKw == null ? null : erzeugungKw + netzKw;
  return {
    art,
    steuerungName: j.steuerung.name,
    netzbetreiberName: j.netzbetreiber,
    direktvermarkterName: j.direktvermarkter,
    installiertKw,
    netzKw,
    netzBerechnet: bit(aG, 1) === true,
    erzeugungKw,
    // Ein Rest unter null ist eine Messabweichung zwischen zwei Lesungen, kein Verbrauch.
    hofKw: hof == null ? null : hof < -NULL_KW ? null : Math.max(0, hof),
    gasspeicherPct: art === 'pv' ? null : gedeckt(zahl(P.speicherFuellstand), bit(aG, 4)),
    zustand,
    nb,
    dv,
    quelle: sG === false ? null : aufz(QUELLEN, zahl(P.quelleP)),
    folgt: sG === false ? null : bit(sBits, 1),
    grenzeKw: grenzeW == null ? null : grenzeW / 1000,
    einheiten,
    nichtBereit,
    gelesenAm: juengste,
    veraltet,
  };
}

/* -------------------------------------------------------- Wörter, kurz */

const hatNb = (l: ErzeugerLage) => (l.nb.kanal ?? 0) > 0;
const hatDv = (l: ErzeugerLage) => (l.dv.kanal ?? 0) > 0;
/** Leistung, die die Grenze des Netzbetreibers bedeutet (% der installierten Leistung). */
export function nbKw(l: ErzeugerLage): number | null {
  return l.nb.prozent == null || l.installiertKw == null ? null : (l.nb.prozent / 100) * l.installiertKw;
}
const einheitenWort = (l: ErzeugerLage) => {
  const n = l.einheiten.length;
  if (!n) return null;
  if (l.art === 'bhkw') return n === 1 ? '1 Motor' : `${n} Motoren`;
  if (l.art === 'pv') return `${n} WR`;
  return n === 1 ? '1 Einheit' : `${n} Einheiten`;
};

/** Das Wort der eigenen Grenze (`quelle_p` 3–6) - bei Gore „Nulleinspeisung“. */
function eigenWort(l: ErzeugerLage): string | null {
  switch (l.quelle) {
    case 'netzpunkt':
      return l.netzKw != null && Math.abs(l.netzKw) < NULL_KW ? 'Nulleinspeisung' : 'Regelung am Netzpunkt';
    case 'hand':
      return 'Hand';
    case 'not_aus':
      return 'Not-Aus';
    case 'ersatzwert':
      return 'Ersatzwert';
    default:
      return null;
  }
}

/* --------------------------------------------------------- Status oben */

export interface ErzeugerStatus {
  key: 'nb' | 'dv' | 'leitstelle' | 'bereit';
  text: string;
  ton: 'tint' | 'warn';
}

/** Die Zeilen im Kopf „Status & Warnungen“ - nur, was gerade gilt. */
export function erzeugerStatus(l: ErzeugerLage): ErzeugerStatus[] {
  const z: ErzeugerStatus[] = [];
  if (l.veraltet) return z;
  if (hatNb(l) && l.nb.notAus) z.push({ key: 'nb', text: 'Netzbetreiber schaltet ab', ton: 'warn' });
  else if (hatNb(l) && l.nb.begrenzt && l.nb.prozent != null) z.push({ key: 'nb', text: `Netzbetreiber begrenzt ${prozent(l.nb.prozent)}`, ton: 'tint' });
  if (hatDv(l) && l.dv.stopp) z.push({ key: 'dv', text: 'Direktvermarkter stoppt', ton: 'tint' });
  else if (hatDv(l) && l.dv.abruf) z.push({ key: 'dv', text: 'Direktvermarkter ruft ab', ton: 'tint' });
  if (l.nb.gehalten) z.push({ key: 'leitstelle', text: 'Leitstelle getrennt', ton: 'warn' });
  if (l.nichtBereit) z.push({ key: 'bereit', text: 'Anlage nicht bereit', ton: 'warn' });
  return z;
}

/* ------------------------------------------------------- Steuerzeile */

export interface KettenGlied {
  key: 'nb' | 'dv' | 'eigen' | 'anlage';
  /** Für Vorlesen: „Netzbetreiber“, „Direktvermarkter“, „Eigene Grenze“, „Anlage“. */
  titel: string;
  /** Am Telefon „NB“/„DV“ statt des ganzen Worts (Bild Telefon 375 px); null = wie `text`. */
  kurz: string | null;
  text: string;
  ton: 'ok' | 'warn' | 'ruhig';
  /** Dieses Glied bindet gerade (`quelle_p`). */
  bindet: boolean;
}

export interface ErzeugerKette {
  glieder: KettenGlied[];
  /** Die Pille im Kopf der Zeile: wer strenger ist, sonst die Zahl der Hinweise. */
  pille: { text: string; ton: 'info' | 'warn' } | null;
  /** „Daten 3 s alt“ bzw. „zuletzt 15:32“. */
  alter: string | null;
}

/** „3 s alt“ bzw. „zuletzt 15:32“; null = noch keine Lesung. */
function alterText(l: ErzeugerLage, now: Date): string | null {
  if (l.gelesenAm == null) return null;
  if (l.veraltet) return `zuletzt ${uhrzeit(l.gelesenAm)}`;
  const s = Math.max(0, Math.round((now.getTime() - l.gelesenAm) / 1000));
  return s < 60 ? `${s}${NBSP}s alt` : `${Math.round(s / 60)}${NBSP}min alt`;
}

/** Die Soll-Kette „Netzbetreiber 60 % › Direktvermarkter 80 kW › ✓ Anlage 58,9 kW“ (EW-11 A). */
export function erzeugerKette(l: ErzeugerLage, now: Date): ErzeugerKette {
  const g: KettenGlied[] = [];
  const ruhig = l.veraltet;
  if (hatNb(l)) {
    const wert = l.nb.notAus ? 'schaltet ab' : prozent(l.nb.prozent);
    const zusatz = l.nb.gehalten ? ' (gehalten)' : '';
    g.push({
      key: 'nb',
      titel: 'Netzbetreiber',
      kurz: `NB ${wert}${zusatz}`,
      text: `Netzbetreiber ${wert}${zusatz}`,
      ton: ruhig ? 'ruhig' : l.nb.gehalten || l.nb.notAus ? 'warn' : 'ruhig',
      bindet: l.quelle === 'netzbetreiber',
    });
  }
  if (hatDv(l)) {
    const wert = l.dv.stopp ? 'Stopp' : l.dv.abruf ? kw(l.dv.sollKw) : 'kein Abruf';
    g.push({ key: 'dv', titel: 'Direktvermarkter', kurz: `DV ${wert}`, text: `Direktvermarkter ${wert}`, ton: 'ruhig', bindet: l.quelle === 'direktvermarkter' });
  }
  const eigen = eigenWort(l);
  if (eigen) {
    const wert = l.quelle === 'not_aus' ? '' : ` ${kw(l.grenzeKw)}`;
    g.push({ key: 'eigen', titel: 'Eigene Grenze', kurz: null, text: `${eigen}${wert}`, ton: l.quelle === 'not_aus' && !ruhig ? 'warn' : 'ruhig', bindet: true });
  }
  g.push({
    key: 'anlage',
    titel: 'Anlage',
    kurz: null,
    text: `Anlage ${kw(l.erzeugungKw)}`,
    ton: ruhig || l.folgt == null ? 'ruhig' : l.folgt ? 'ok' : 'warn',
    bindet: false,
  });
  const hinweise = g.filter((x) => x.ton === 'warn' && x.key !== 'anlage').length + (l.nichtBereit && !ruhig ? 1 : 0);
  let pille: ErzeugerKette['pille'] = null;
  if (hinweise > 0) pille = { text: hinweise === 1 ? '1 Hinweis' : `${hinweise} Hinweise`, ton: 'warn' };
  else if (!ruhig && l.quelle === 'netzbetreiber' && l.dv.abruf) pille = { text: 'NB strenger', ton: 'info' };
  else if (!ruhig && l.quelle === 'direktvermarkter' && l.nb.begrenzt) pille = { text: 'DV strenger', ton: 'info' };
  const alter = alterText(l, now);
  return { glieder: g, pille, alter: alter && !l.veraltet ? `Daten ${alter}` : alter };
}

/* -------------------------------------------------------- Blatt „Warum?“ */

export interface BlattZeile {
  key: KettenGlied['key'];
  titel: string;
  unter: string;
  wert: string;
  ton: 'ok' | 'warn' | 'ruhig';
  /** Punktfarbe: Netzbetreiber netz, Direktvermarkter markt, Anlage erzeugung. */
  farbe: 'netz' | 'markt' | 'erzeugung';
}

export interface ErzeugerBlatt {
  zeilen: BlattZeile[];
  /** Balken 0 … installiert: Ist, Grenze des Netzbetreibers, Sollwert des Direktvermarkters. */
  balken: { maxKw: number; istKw: number | null; nbKw: number | null; dvKw: number | null } | null;
  warum: [string, string][];
  grenze: [string, string][];
}

const KANAL_NB = ['', 'feste Grenze', 'Stufe', 'Leitstelle'];
const KANAL_DV = ['', 'Relais und 4–20 mA', 'Modbus'];
const NF3 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 3 });

/** Dauer in Worten: „2 h 42 min“, „35 min“. */
export function dauer(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min}${NBSP}min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}${NBSP}h ${m}${NBSP}min` : `${h}${NBSP}h`;
}

/** Was „Es gilt“: die wirksame Grenze und wer sie setzt. */
function esGilt(l: ErzeugerLage): string {
  const wert = kw(l.grenzeKw);
  switch (l.quelle) {
    case 'netzbetreiber':
      return l.dv.abruf ? `${wert} – der Netzbetreiber ist strenger als der Direktvermarkter` : `${wert} – die Vorgabe des Netzbetreibers`;
    case 'direktvermarkter':
      return l.nb.begrenzt ? `${wert} – der Direktvermarkter ist strenger als der Netzbetreiber` : `${wert} – der Abruf des Direktvermarkters`;
    case 'netzpunkt':
      return `${wert} – die Anlage regelt selbst am Netzpunkt${eigenWort(l) === 'Nulleinspeisung' ? ' (Nulleinspeisung)' : ''}`;
    case 'hand':
      return `${wert} – von Hand vor Ort vorgegeben`;
    case 'not_aus':
      return 'Not-Aus – die Anlage ist abgeschaltet';
    case 'ersatzwert':
      return `${wert} – Ersatzwert der Steuerung`;
    case 'keine':
      return 'keine Grenze – die Anlage darf voll erzeugen';
    default:
      return 'unbekannt – die Steuerung meldet nicht, wer begrenzt';
  }
}

export function erzeugerBlatt(l: ErzeugerLage, now: Date, heute: GeregeltZeile[] | null): ErzeugerBlatt {
  const zeilen: BlattZeile[] = [];
  const seit = (t: number | null) => (t == null ? null : `seit ${uhrzeit(t)}`);
  if (hatNb(l)) {
    const kanal = KANAL_NB[l.nb.kanal ?? 0] ?? '';
    const vorgabe = l.nb.notAus ? 'Abschaltung' : `${kanal}${kanal ? ' ' : ''}${prozent(l.nb.prozent)}`;
    const teile = [l.netzbetreiberName, vorgabe, l.nb.gehalten ? 'getrennt, Wert gehalten' : seit(l.nb.seit)];
    zeilen.push({
      key: 'nb', titel: 'Netzbetreiber', farbe: 'netz', unter: teile.filter(Boolean).join(' · '),
      // 100 % ist keine Grenze - dann steht dort keine Leistung, die nach einer aussähe.
      wert: l.nb.notAus ? kw(0) : l.nb.begrenzt ? kw(nbKw(l)) : 'keine Grenze',
      ton: l.nb.gehalten || l.nb.notAus ? 'warn' : 'ruhig',
    });
  }
  if (hatDv(l)) {
    const stand = l.dv.stopp ? 'Stopp' : l.dv.abruf ? `Abruf ${seit(l.dv.seit) ?? ''}`.trim() : 'kein Abruf';
    const bereit = l.dv.bereit == null ? null : l.dv.bereit ? 'bereit ✓' : 'nicht bereit';
    zeilen.push({
      key: 'dv', titel: 'Direktvermarkter', farbe: 'markt',
      unter: [l.direktvermarkterName, stand, bereit].filter(Boolean).join(' · '),
      wert: l.dv.abruf ? kw(l.dv.sollKw) : '—', ton: l.dv.bereit === false ? 'warn' : 'ruhig',
    });
  }
  const eigen = eigenWort(l);
  if (eigen) zeilen.push({ key: 'eigen', titel: eigen, farbe: 'erzeugung', unter: 'Grenze der Steuerung selbst', wert: l.quelle === 'not_aus' ? kw(0) : kw(l.grenzeKw), ton: 'ruhig' });
  const laufen = l.einheiten.filter((e) => e.zustand === 'laeuft' || e.zustand === 'laeuft_begrenzt').length;
  const einh = l.einheiten.length
    ? `${laufen} von ${l.einheiten.length} ${l.art === 'bhkw' ? 'Motoren' : l.art === 'pv' ? 'Wechselrichtern' : 'Einheiten'} ${laufen === 1 && l.einheiten.length === 1 ? 'läuft' : 'laufen'}`
    : null;
  const folgt = l.folgt == null ? null : l.folgt ? 'folgt ✓' : 'folgt nicht';
  zeilen.push({
    key: 'anlage', titel: 'Anlage', farbe: 'erzeugung', unter: [folgt, einh, l.nichtBereit].filter(Boolean).join(' · ') || 'ohne Zustand',
    wert: kw(l.erzeugungKw), ton: l.folgt == null ? 'ruhig' : l.folgt ? 'ok' : 'warn',
  });

  const maxKw = l.installiertKw ?? Math.max(0, ...l.einheiten.map((e) => e.nennKw ?? 0));
  const balken = maxKw > 0 ? { maxKw, istKw: l.erzeugungKw, nbKw: hatNb(l) && l.nb.begrenzt ? nbKw(l) : null, dvKw: hatDv(l) && l.dv.abruf ? l.dv.sollKw : null } : null;

  const warum: [string, string][] = [['Es gilt', esGilt(l)]];
  const quelleSeit = l.quelle === 'netzbetreiber' ? l.nb.seit : l.quelle === 'direktvermarkter' ? l.dv.seit : null;
  if (quelleSeit != null) warum.push(['Seit', `${uhrzeit(quelleSeit)} (${dauer(now.getTime() - quelleSeit)})`]);
  const alter = alterText(l, now);
  warum.push(['Daten', l.veraltet ? `veraltet, ${alter ?? 'noch keine Lesung'} · ${l.steuerungName} antwortet nicht` : `${alter ?? '—'} · ${l.steuerungName} antwortet`]);
  if (heute) {
    const wer = heute.filter((h) => h.anzahl > 0).map((h) => `${h.urheber} ${h.anzahl}×`);
    warum.push(['Heute', wer.length ? wer.join(' · ') : 'noch keine Vorgabe']);
  }

  const grenze: [string, string][] = [];
  if (l.grenzeKw != null) grenze.push(['Wirksam', `höchstens ${kw(l.grenzeKw)}`]);
  if (l.nb.cosphi != null) grenze.push(['cos φ', `${NF3.format(Math.abs(l.nb.cosphi))} ${l.nb.cosphi < 0 ? 'untererregt' : 'übererregt'} (Vorgabe des Netzbetreibers)`]);
  if (hatDv(l)) grenze.push(['Weg des DV', KANAL_DV[l.dv.kanal ?? 0] || 'unbekannt']);
  return { zeilen, balken, warum, grenze };
}

/* ---------------------------------------------------------------- Bühne */

/** Der Satz zur Vorgabe über dem Fluss. Er sagt, was gemessen ist - nie eine erfundene Ursache. */
export function erzeugerSatz(l: ErzeugerLage): string {
  if (l.veraltet) {
    return l.gelesenAm == null
      ? `Von ${l.steuerungName} liegen noch keine Werte vor.`
      : `${l.steuerungName} meldet sich nicht; die Werte sind von ${uhrzeit(l.gelesenAm)}.`;
  }
  const fluss =
    l.netzKw != null && l.netzKw < -0.05 ? ` Sie speist ${kw(l.netzKw)} ein.`
      : l.erzeugungKw != null ? ` Sie erzeugt ${kw(l.erzeugungKw)}.` : '';
  switch (l.quelle) {
    case 'netzbetreiber':
      return l.nb.notAus ? 'Der Netzbetreiber hat die Anlage abgeschaltet.' : `Der Netzbetreiber begrenzt die Anlage auf ${prozent(l.nb.prozent)}.${fluss}`;
    case 'direktvermarkter':
      return `Der Direktvermarkter ruft ${kw(l.dv.sollKw)} ab.${fluss}`;
    case 'netzpunkt':
      return eigenWort(l) === 'Nulleinspeisung'
        ? 'Die Anlage begrenzt sich selbst: Am Netzpunkt fließt nichts ins Netz.'
        : `Die Anlage regelt am Netzpunkt auf ${kw(l.grenzeKw)}.${fluss}`;
    case 'hand':
      return `Die Anlage ist von Hand auf ${kw(l.grenzeKw)} gestellt.${fluss}`;
    case 'not_aus':
      return 'Not-Aus: Die Anlage ist abgeschaltet.';
    case 'ersatzwert':
      return `Die Steuerung fährt einen Ersatzwert von ${kw(l.grenzeKw)}.${fluss}`;
    case 'keine':
      return `Keine Vorgabe begrenzt die Anlage.${fluss}`;
    default:
      return l.erzeugungKw != null ? `Die Anlage erzeugt ${kw(l.erzeugungKw)}.` : 'Für diesen Moment fehlen Messwerte der Anlagensteuerung.';
  }
}

/** Was die drei Knoten der Bühne zeigen: Erzeugung oben, Netz rechts, Hof bzw. Verbrauch unten. */
export interface ErzeugerKnoten {
  /** Symbol am Erzeugungs-Knoten: Motor für BHKW, sonst Sonne. */
  symbol: 'motor' | 'sonne';
  erzeugungZeile: string;
  lastName: 'Hof' | 'Verbrauch';
  netzZeile: string | null;
}

export function erzeugerKnoten(l: ErzeugerLage): ErzeugerKnoten {
  const e = einheitenWort(l);
  return {
    symbol: l.art === 'bhkw' ? 'motor' : 'sonne',
    erzeugungZeile: e ? `Erzeugung · ${e}` : 'Erzeugung',
    lastName: l.art === 'bhkw' ? 'Hof' : 'Verbrauch',
    netzZeile: l.netzKw == null ? 'ohne Messung' : l.netzBerechnet ? 'berechnet' : null,
  };
}

/* ---------------------------------------------- Heute: Spuren und Zählung */

interface Abschnitt { von: number; bis: number }

/** Zeiträume heute, in denen `an(wert)` gilt - aus den Wechseln eines Punkts, bis jetzt. */
export function abschnitte(wechsel: ErzeugerWechsel[] | undefined, an: (w: number) => boolean, beginn: number, now: number): Abschnitt[] {
  if (!wechsel?.length) return [];
  const liste = wechsel
    .map((w) => ({ t: Math.max(beginn, Date.parse(w.ab)), w: w.wert }))
    .filter((w) => Number.isFinite(w.t) && w.t <= now)
    .sort((a, b) => a.t - b.t);
  const out: Abschnitt[] = [];
  let offen: number | null = null;
  for (const { t, w } of liste) {
    const aktiv = w != null && an(w);
    if (aktiv && offen == null) offen = t;
    else if (!aktiv && offen != null) {
      if (t > offen) out.push({ von: offen, bis: t });
      offen = null;
    }
  }
  if (offen != null && now > offen) out.push({ von: offen, bis: now });
  return out;
}

const nbAn = (bits: number) => bit(bits, 2) === true || bit(bits, 3) === true;
const dvAn = (bits: number) => bit(bits, 1) === true;
const eigenAn = (q: number) => q === 3;

export interface GeregeltZeile {
  key: 'nb' | 'dv' | 'eigen';
  urheber: string;
  anzahl: number;
  dauerMs: number;
}

/**
 * „Wer hat heute geregelt?“: Anzahl und Dauer je Urheber seit Mitternacht, aus den Zustandswechseln von
 * `erzeuger.nb.bits` (Bit 2 begrenzt, Bit 3 Not-Aus), `erzeuger.dv.bits` (Bit 1 Abruf) und
 * `erzeuger.wirkung.quelle_p` (3 = die Anlage selbst am Netzpunkt). null = keine Wechsel geliefert.
 */
export function werHatGeregelt(j: ErzeugerJetzt, l: ErzeugerLage, beginn: number, now: number): GeregeltZeile[] | null {
  const w = j.wechselHeute;
  if (!w || !WECHSEL_PUNKTE.some((k) => w[k]?.length)) return null;
  const zeile = (key: GeregeltZeile['key'], urheber: string, a: Abschnitt[]): GeregeltZeile => ({
    key, urheber, anzahl: a.length, dauerMs: a.reduce((s, x) => s + x.bis - x.von, 0),
  });
  const z: GeregeltZeile[] = [];
  if (hatNb(l)) z.push(zeile('nb', 'Netzbetreiber', abschnitte(w[ERZEUGER_PUNKT.nbBits], nbAn, beginn, now)));
  if (hatDv(l)) z.push(zeile('dv', 'Direktvermarkter', abschnitte(w[ERZEUGER_PUNKT.dvBits], dvAn, beginn, now)));
  const eigen = abschnitte(w[ERZEUGER_PUNKT.quelleP], eigenAn, beginn, now);
  if (eigen.length || !hatDv(l)) z.push(zeile('eigen', 'Anlage selbst', eigen));
  return z;
}

export interface VorgabeSpur {
  key: GeregeltZeile['key'];
  name: string;
  /** Beschriftung an der Spur (schmal). */
  kurz: string;
  farbe: 'netz' | 'markt' | 'erzeugung';
  /** Je Viertelstunde des Tages: galt die Vorgabe in ihr (auch nur teilweise)? */
  an: boolean[];
}

/** Die Spuren der Tagesleiste: Netzbetreiber und Direktvermarkter (bzw. „Anlage selbst“), wie Börsenpreis und Speicherplan. */
export function vorgabeSpuren(j: ErzeugerJetzt, l: ErzeugerLage, viertel: { start: number }[], now: number, viertelMs: number): VorgabeSpur[] {
  if (!viertel.length) return [];
  const beginn = viertel[0].start;
  const spur = (key: VorgabeSpur['key'], name: string, kurz: string, farbe: VorgabeSpur['farbe'], a: Abschnitt[]): VorgabeSpur => ({
    key, name, kurz, farbe, an: viertel.map((v) => a.some((x) => x.von < v.start + viertelMs && x.bis > v.start)),
  });
  const w = j.wechselHeute ?? {};
  const s: VorgabeSpur[] = [];
  if (hatNb(l)) s.push(spur('nb', 'Netzbetreiber', 'Netzbetreiber', 'netz', abschnitte(w[ERZEUGER_PUNKT.nbBits], nbAn, beginn, now)));
  if (hatDv(l)) s.push(spur('dv', 'Direktvermarkter', 'Direktverm.', 'markt', abschnitte(w[ERZEUGER_PUNKT.dvBits], dvAn, beginn, now)));
  else s.push(spur('eigen', 'Anlage selbst', 'Anlage selbst', 'erzeugung', abschnitte(w[ERZEUGER_PUNKT.quelleP], eigenAn, beginn, now)));
  return s;
}

/* ----------------------------------------------------- Je Einheit, Liste */

/** Unterzeile einer Einheit: „Soll 39,6 kW · läuft“. */
export function einheitUnter(e: Einheit): string {
  const teile = [e.sollKw != null ? `Soll ${kw(e.sollKw)}` : null, e.zustand ? ZUSTAND_WORT[e.zustand] : null];
  if (e.dvBereit === false && e.gruende.length) teile.push(`nicht bereit: ${e.gruende.join(', ')}`);
  return teile.filter(Boolean).join(' · ') || 'ohne Zustand';
}

/** „Erzeugung im Detail“ unter dem Fluss und im Blatt des Erzeugungs-Knotens: je Einheit Ist, Soll, Zustand. */
export function einheitenListe(l: ErzeugerLage): Liste | null {
  if (!l.einheiten.length) return null;
  const summe = l.einheiten.reduce((s, e) => s + Math.max(0, e.istKw ?? 0), 0);
  return {
    titel: 'Erzeugung im Detail',
    summe: kw(l.erzeugungKw),
    gesamt: l.einheiten.length,
    zeilen: l.einheiten.map((e) => ({
      key: `te${e.teNr}`,
      name: e.typName ? `${e.name} · ${e.typName}` : e.name,
      sub: einheitUnter(e),
      wert: kw(e.istKw),
      zahl: e.istKw,
      anteil: e.istKw == null || summe <= 0 ? null : Math.max(0, e.istKw) / summe,
      art: e.zustand === 'aus' || e.zustand === 'stoerung' ? 'still' : 'normal',
      icon: e.art === 'pv' ? 'sun' : 'flame',
      title: e.nennKw != null ? `${e.name}: Nennleistung ${kw(e.nennKw)}` : null,
    })),
  };
}

/* ------------------------------------------------------- Bühne, gesamt */

/** Alles, was die Bühne für eine Erzeugeranlage braucht (EnergieBuehne `erzeuger`). */
export interface ErzeugerBuehne {
  /** Der Moment „jetzt“: Erzeugung, Hof, kein Speicher, Netzpunkt (+ Bezug). */
  jetzt: { werte: FlussWerte; socPct: null; hat: { pv: true; batt: false } };
  satz: string;
  knoten: ErzeugerKnoten;
  liste: Liste | null;
  vorgaben: VorgabeSpur[];
  veraltet: boolean;
}

export function erzeugerBuehne(j: ErzeugerJetzt, l: ErzeugerLage, tag: Tag | null, now: Date): ErzeugerBuehne {
  return {
    jetzt: { werte: { pv: l.erzeugungKw, load: l.hofKw, batt: 0, grid: l.netzKw }, socPct: null, hat: { pv: true, batt: false } },
    satz: erzeugerSatz(l),
    knoten: erzeugerKnoten(l),
    liste: einheitenListe(l),
    vorgaben: tag ? vorgabeSpuren(j, l, tag.viertel, now.getTime(), VIERTEL_MS) : [],
    veraltet: l.veraltet,
  };
}
