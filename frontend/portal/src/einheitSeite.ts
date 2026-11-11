/**
 * **Wechselrichter hinter der Steuerung als Geräte** (Konzept „Ein Gerät, ein Eintrag“, Paket GE-3, Variante d1 —
 * GD-2 A vom 23.10.2026): jede Erzeugungseinheit einer Anlagensteuerung (Teil `erzeugungseinheit` mit TE-Nr.,
 * `GET …/anlagensteuerungen`) bekommt eine Zeile im Aufbau und eine eigene Seite im Geräteseiten-Rahmen
 * (`…/geraet/{ref}/as-<Entität>~te-<n>`, `geraetAdresse.einheitGeraetId`).
 *
 * Das ist DARSTELLUNG, kein neues Modell: eine Einheit hat keine eigene Komponente. Ihre Werte `erzeuger.te[n].*`
 * hängen an der Komponente der Steuerung und kommen über deren Routen — jüngste Werte (`…/werte`, EZ-6), Kurven
 * (`…/verlauf`, EZ-10, seit GE-3 mit dem Zählerstand `t_e`), Vorgaben mit `te_nr` (EZ-7) und Alarme je Einheit
 * (`einheit:<Steuerung>;te=<n>`, EZ-11). Tausch eines einzelnen Wechselrichters mit Schnitt in der Historie und
 * Einheiten nachtragen/entfernen sind GE-7 (d2) und hier bewusst nicht gelöst: die Historie hängt an der Nummer.
 *
 * Rein: kein React, kein Netz. Fehlend ist keine Null — ein Wert ohne sein Gültigkeitsbit (`t_bits` Bit 0 deckt Ist,
 * Zustand und Zählerstand, Bit 1 den Sollwert) steht als „—“; ohne Lesung „noch keine Daten“. Adresse und Zustand je
 * Einheit (der leichte Teil für Aufbau und Steuerung) stehen in `erzeugungseinheit.ts`.
 */
import type {
  Anlagensteuerung,
  AnlagensteuerungVerlauf,
  AnlagensteuerungWerte,
  EntityHistory,
  ErzeugerUrheber,
  ErzeugerVorgabe,
  Erzeugungseinheit,
  ErzeugungseinheitArt,
  NetzVermarktung,
} from './api';
import {
  bitVon,
  einheitNummer,
  einheitPunkt,
  einheitZeilen,
  kwText,
  kwZahl,
  NOCH_KEINE_DATEN,
  PUNKT,
  STRICH,
  typHinweis,
  werteJe,
  wertVon,
  type WerteJe,
} from './anlagensteuerung';
import { einheitStand, nennText, type EinheitStand } from './erzeugungseinheit';
import { fmtRelative, NBSP } from './format';
import { anlagensteuerungGeraetId } from './geraetAdresse';
import { heuteView, type HeuteKanal, type HeuteView } from './geraetHeute';
import type { GeraetTon } from './geraetSeite';
import { SCHWERE_WORT, wertartSatzname, type Meldung } from './meldungen';
import type { MiniPoint } from './miniChart';
import { geraetSeiteHash } from './nav';

const NF0 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });

// ---------------------------------------------------------------------------
// Die Seite: Kopf, Jetzt, Gerät & Verbindung
// ---------------------------------------------------------------------------

/** Eine Zeile der Seite; `href` macht den Wert zum Weg (die Steuerung). */
export interface SeitenZeile {
  label: string;
  wert: string;
  detail?: string | null;
  href?: string | null;
}

export interface EinheitSeiteView {
  stand: EinheitStand;
  kopf: {
    titel: string;
    typ: string;
    modell: string;
    zustand: { wort: string; ton: GeraetTon; detail: string | null };
  };
  /** Die große Zahl: die Ist-Leistung in kW; null ohne gültigen Wert (nie ein großes „—“). */
  ist: string | null;
  satz: string;
  satzTon: GeraetTon;
  /** Unter der Zahl: Soll und ob sie folgt, die Begrenzung der Anlage, der Direktvermarkter. */
  zeilen: string[];
  /** Gerät & Verbindung. */
  details: SeitenZeile[];
  /** „Wechselrichter“ / „Motor“ / „Einheit“ — für Sätze und Knöpfe. */
  wort: string;
}

export interface EinheitSeiteInput {
  siteId: string;
  ref: string;
  steuerung: Anlagensteuerung;
  einheit: Erzeugungseinheit;
  werte: AnlagensteuerungWerte | null;
  nv: NetzVermarktung | null;
  /** Der Name der Box, die die Steuerung liest; null = unbekannt. */
  boxName: string | null;
  now: Date;
}

const WORT: Record<ErzeugungseinheitArt, string> = { pv_wechselrichter: 'Wechselrichter', bhkw_motor: 'Motor' };

function gross(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Wer die ganze Anlage gerade begrenzt (`wirkung.quelle_p`, nur mit `s_bits` Bit 0): „der Netzbetreiber begrenzt die
 * Anlage auf 60 %“. Die Begrenzung gilt für alle Einheiten — die Steuerung verteilt sie; null = unbekannt.
 */
export function begrenzungSatz(je: WerteJe): string | null {
  if (bitVon(je, PUNKT.sBits, 0) !== true) return null;
  const quelle = wertVon(je, PUNKT.quelleP);
  const grenze = wertVon(je, PUNKT.grenze);
  const auf = grenze != null ? ` auf ${kwText(grenze)}` : '';
  switch (quelle) {
    case 0:
      return 'keine Vorgabe begrenzt die Anlage';
    case 1: {
      const p = wertVon(je, PUNKT.nbProzent);
      return `der Netzbetreiber begrenzt die Anlage${p != null ? ` auf ${NF0.format(p)}${NBSP}%` : auf}`;
    }
    case 2: {
      const soll = wertVon(je, PUNKT.dvSoll);
      return soll != null ? `der Direktvermarkter ruft ${kwText(soll)} ab` : 'der Direktvermarkter steuert die Anlage';
    }
    case 3:
      return `die Anlage regelt am Netzpunkt${auf}`;
    case 4:
      return `die Anlage ist von Hand${auf} gestellt`;
    case 5:
      return 'Not-Aus: die Anlage ist abgeschaltet';
    case 6:
      return `die Steuerung fährt einen Ersatzwert${grenze != null ? ` von ${kwText(grenze)}` : ''}`;
    default:
      return null;
  }
}

/** Die Zeile „Begrenzung“: wer begrenzt (das Wort des Bilds) und die wirksame Grenze der ganzen Anlage. */
function begrenzungZeile(je: WerteJe): string {
  if (bitVon(je, PUNKT.sBits, 0) !== true) return `Begrenzung der Anlage ${STRICH}`;
  const wer = je.get(PUNKT.quelleP)?.text ?? null;
  const grenze = wertVon(je, PUNKT.grenze);
  return [`Begrenzung der Anlage: ${wer ?? STRICH}`, grenze != null ? `Grenze ${kwText(grenze)}` : null]
    .filter(Boolean)
    .join(' · ');
}

/** Der Block der Einheit im Registerbild: Offset 28 + TE-Nr. · 10, zehn Wörter (Vertrag EZ-1 §4), ab der Basisadresse. */
export function blockImBild(steuerung: Anlagensteuerung, teNr: number): string {
  if (!steuerung.fassung) return `Einheit ${teNr}`;
  const von = steuerung.fassung.basisadresse + 28 + teNr * 10;
  return `Einheit ${teNr} · Register ${von}–${von + 9}`;
}

export function einheitSeite(i: EinheitSeiteInput): EinheitSeiteView {
  const { steuerung: s, einheit: e, werte, now } = i;
  const je = werteJe(werte);
  const stand = einheitStand(e, werte, now);
  const wort = stand.art ? WORT[stand.art] : 'Einheit';
  const diesem = stand.art === 'bhkw_motor' ? 'diesem Motor' : stand.art ? 'diesem Wechselrichter' : 'dieser Einheit';
  const diesen = stand.art === 'bhkw_motor' ? 'diesen Motor' : stand.art ? 'diesen Wechselrichter' : 'diese Einheit';
  const zeile = einheitZeilen(s, werte, i.nv, now).find((z) => z.teNr === e.te_nr) ?? null;
  const steuerungName = s.bezeichnung ?? 'Anlagensteuerung';

  let satz: string;
  let satzTon: GeraetTon = 'ok';
  if (!werte || stand.ohneDaten) {
    satz = `Von ${diesem} liegen noch keine Daten vor.`;
    satzTon = 'off';
  } else if (stand.ton === 'warn' && stand.zustandWort === 'meldet sich gerade nicht') {
    satz = `Die Steuerung liefert für ${diesen} gerade keine aktuellen Werte.`;
    satzTon = 'warn';
  } else if (stand.zustandWort === 'Werte ungültig') {
    satz = `Die Steuerung meldet die Werte von ${diesem} gerade als ungültig.`;
    satzTon = 'warn';
  } else {
    const roh = wertVon(je, einheitPunkt(e.te_nr, 't_zustand'));
    const begrenzt = roh === 3 ? begrenzungSatz(je) : null;
    satz = stand.zustand ? `${gross(stand.zustand)}${begrenzt ? ` — ${begrenzt}` : ''}.` : 'Die Steuerung meldet keinen Zustand.';
    satzTon = stand.ton;
  }

  const zeilen: string[] = [];
  if (werte && !stand.ohneDaten) {
    const folgt = zeile?.folgt === 'folgt' ? 'folgt' : zeile?.folgt === 'folgt_nicht' ? 'folgt nicht' : null;
    zeilen.push([`Soll ${kwText(stand.sollW)}`, folgt].filter(Boolean).join(' · '));
    zeilen.push(begrenzungZeile(je));
    if (zeile?.dv) zeilen.push(gross(zeile.dv.text));
  }

  const zaehler = bitVon(je, einheitPunkt(e.te_nr, 't_bits'), 0) === false ? null : wertVon(je, einheitPunkt(e.te_nr, 't_e'));
  const zaehlerAm = je.get(einheitPunkt(e.te_nr, 't_e'))?.gemessen_am ?? null;
  const details: SeitenZeile[] = [
    {
      label: 'Art',
      wert: stand.artWort,
      detail: !e.einheit_art && stand.art ? 'laut Steuerung' : null,
    },
    {
      label: 'Typ',
      wert: stand.typ ?? 'nicht erfasst',
      detail: !e.typ && e.typ_bild ? 'laut Steuerung' : typHinweis(e),
    },
    {
      label: 'Nennleistung',
      wert: nennText(stand.nenn) ?? 'nicht erfasst',
      detail: stand.nenn?.ausBild ? 'laut Steuerung' : null,
    },
    { label: 'MaStR', wert: e.registry_unit_id ?? 'nicht eingetragen' },
    {
      label: 'Zählerstand Erzeugung',
      wert: zaehler != null ? `${NF0.format(zaehler)}${NBSP}kWh` : STRICH,
      detail: zaehler != null && zaehlerAm ? `gelesen ${fmtRelative(zaehlerAm, now)}` : NOCH_KEINE_DATEN,
    },
    {
      label: 'Gelesen über',
      wert: steuerungName,
      detail: i.boxName ? `VoltPilot-Box ${i.boxName}` : null,
      href: geraetSeiteHash(i.siteId, i.ref, anlagensteuerungGeraetId(s.entity_id)),
    },
    // Mit eigener Bezeichnung nennt die Zeile die Nummer im Bild — sie bleibt, wenn man umbenennt.
    { label: 'Im Bild', wert: blockImBild(s, e.te_nr), detail: e.bezeichnung ? einheitNummer(e, je) : null },
  ];

  return {
    stand,
    kopf: {
      titel: stand.name,
      typ: stand.artWort,
      modell: stand.unter,
      zustand: { wort: stand.zustandWort, ton: stand.ton, detail: stand.zustandZeit },
    },
    ist: kwZahl(stand.istW),
    satz,
    satzTon,
    zeilen,
    details,
    wort,
  };
}

// ---------------------------------------------------------------------------
// Heute: Ist/Soll aus der Verlaufsroute, Energie aus dem Zählerstand
// ---------------------------------------------------------------------------

export interface EinheitHeute {
  view: HeuteView;
  kanal: HeuteKanal;
  /** Der Sollwert je Viertelstunde (ISO-Start → kW) — für die Ablesung neben dem Ist. */
  soll: ReadonlyMap<string, number>;
  energie: EnergieHeute;
}

export interface EnergieHeute {
  /** kWh seit der ersten Lesung des Tages; null = unbekannt (dann `grund`). */
  kwh: number | null;
  /** Die erste Lesung, wenn sie nicht in der ersten Viertelstunde lag („07:15“); null = ab Mitternacht. */
  seit: string | null;
  grund: string | null;
}

function uhr(ms: number): string {
  return new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

/** Geringer als ein Zehntel kWh (die Auflösung von `t_e`) ist kein Rücksprung, nur Rundung. */
const ZAEHLER_EPS = 0.05;

/**
 * Die Energie heute aus dem Zählerstand `t_e` (kWh) der Kurven eines Tages: letzte Lesung minus erste. Springt der
 * Zähler zurück (Neustart der Steuerung, Tausch), ist die Zahl unbekannt — nie eine geschätzte.
 */
export function energieHeute(v: AnlagensteuerungVerlauf, teNr: number): EnergieHeute {
  const kurve = v.kurven.find((k) => k.point_key === einheitPunkt(teNr, 't_e'));
  if (!kurve) return { kwh: null, seit: null, grund: 'Die Steuerung meldet keinen Zählerstand.' };
  const eimer = [...kurve.eimer].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  if (eimer.length === 0) return { kwh: null, seit: null, grund: 'Heute noch kein Zählerstand gelesen.' };
  let davor = eimer[0].min;
  for (const b of eimer) {
    if (b.min < davor - ZAEHLER_EPS || b.max > b.last + ZAEHLER_EPS) {
      return { kwh: null, seit: null, grund: 'Der Zählerstand ist heute zurückgesprungen.' };
    }
    davor = b.last;
  }
  const erste = Date.parse(eimer[0].start);
  const seit = erste - Date.parse(v.from) >= v.bucket_minutes * 60_000 ? uhr(erste) : null;
  return { kwh: Math.max(0, eimer[eimer.length - 1].last - eimer[0].min), seit, grund: null };
}

/** „312 kWh“ (Tag: ohne Stelle) mit „seit 07:15“, wenn der Tag nicht ab Mitternacht gelesen ist. */
export function energieText(e: EnergieHeute): string {
  if (e.kwh == null) return STRICH;
  return `${NF0.format(e.kwh)}${NBSP}kWh${e.seit ? ` seit ${e.seit}` : ''}`;
}

/** W → kW in den Eimern einer Kurve — dieselbe Form wie `EntityHistoryBucket`. */
function eimerKw(v: AnlagensteuerungVerlauf, key: string): EntityHistory['channels'][string] {
  const kurve = v.kurven.find((k) => k.point_key === key);
  return (kurve?.eimer ?? []).map((b) => ({
    start: b.start,
    avg: b.avg / 1000,
    min: b.min / 1000,
    max: b.max / 1000,
    last: b.last / 1000,
    n: b.n,
  }));
}

/**
 * Der Baustein „Heute“ einer Einheit: der Streifen der Ist-Leistung je Viertelstunde (dieselbe Ableitung wie jede
 * Geräteseite, `geraetHeute.heuteView`), der Sollwert in der Ablesung und die Energie heute aus `t_e`.
 */
export function einheitHeute(v: AnlagensteuerungVerlauf, geraetId: string, teNr: number, now: number): EinheitHeute {
  const ist = einheitPunkt(teNr, 't_p_ist_w');
  const kanal: HeuteKanal = { entityId: `erzeuger-${geraetId}`, channel: ist, titel: 'Ist-Leistung', einheit: 'kW', richtung: null, farbe: 'pv' };
  const history: EntityHistory = {
    range: v.range,
    from: v.from,
    to: v.to,
    bucketMinutes: v.bucket_minutes,
    channels: { [ist]: eimerKw(v, ist) },
  };
  const soll = new Map<string, number>();
  for (const b of eimerKw(v, einheitPunkt(teNr, 't_p_soll_w'))) if (b.avg != null) soll.set(new Date(b.start).toISOString(), b.avg);
  return { view: heuteView(history, kanal, now), kanal, soll, energie: energieHeute(v, teNr) };
}

/** Die Ablesung einer Viertelstunde: „12:15 · Ist 41,2 kW · Soll 53,0 kW“. */
export function einheitAblesung(p: MiniPoint, soll: ReadonlyMap<string, number>): string {
  const s = soll.get(p.key);
  const teile = [
    p.label ?? '',
    p.value == null ? 'keine Messung' : `Ist ${kwText(p.value * 1000)}`,
    s != null ? `Soll ${kwText(s * 1000)}` : null,
  ];
  return teile.filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------------
// Aktivität: Vorgaben (EZ-7) und Alarme (EZ-11) dieser Einheit
// ---------------------------------------------------------------------------

export interface AktivitaetZeile {
  key: string;
  /** „ab 10:58“, „21.10. 09:12–11:40“. */
  wann: string;
  titel: string;
  sub: string | null;
  laeuft: boolean;
  art: 'vorgabe' | 'alarm';
}

const URHEBER_WORT: Record<ErzeugerUrheber, string> = {
  netzbetreiber: 'Netzbetreiber',
  direktvermarkter: 'Direktvermarkter',
  anlage: 'Anlage selbst',
  hand: 'Hand',
  ersatzwert: 'Ersatzwert',
  schutz: 'Schutz',
};

function vorgabeWas(v: ErzeugerVorgabe): string {
  const kw = v.vorgabe_w != null ? kwText(v.vorgabe_w) : null;
  switch (v.art) {
    case 'p_begrenzung':
      return v.vorgabe_prozent != null ? `begrenzt auf ${NF0.format(v.vorgabe_prozent)}${NBSP}%` : kw ? `begrenzt auf ${kw}` : 'begrenzt';
    case 'abschaltung':
      return 'Abschaltung';
    case 'q_vorgabe':
      return `cos${NBSP}φ-Vorgabe`;
    case 'dv_aktivierung':
      return kw ? `Abruf ${kw}` : 'Abruf';
    case 'dv_stopp':
      return 'Stopp';
    case 'nicht_bereit':
      return v.gruende.length ? `nicht bereit: ${v.gruende.join(', ')}` : 'nicht bereit für den Direktvermarkter';
    case 'automatik':
      return kw ? `Netzpunkt-Regelung auf ${kw}` : 'Netzpunkt-Regelung';
    case 'ersatzwert':
      return kw ? `Ersatzwert ${kw}` : 'Ersatzwert';
    default:
      return kw ? `${v.art} ${kw}` : v.art;
  }
}

function tagUhr(iso: string, now: Date): string {
  const d = new Date(iso);
  const heute = d.toDateString() === now.toDateString();
  return heute ? uhr(d.getTime()) : `${d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })} ${uhr(d.getTime())}`;
}

/**
 * Die Vorgaben dieser Einheit und die der ganzen Anlage (`te_nr` leer — sie gelten für jede Einheit), jüngste zuerst.
 * Gelesen werden nur Vorgaben DIESER Steuerung.
 */
export function vorgabenZeilen(
  vorgaben: readonly ErzeugerVorgabe[],
  geraetId: string,
  teNr: number,
  now: Date,
  max = 5,
): AktivitaetZeile[] {
  return vorgaben
    .filter((v) => v.geraet_id === geraetId && (v.te_nr === teNr || v.te_nr == null))
    .sort((a, b) => Date.parse(b.beginn) - Date.parse(a.beginn))
    .slice(0, max)
    .map((v) => ({
      key: `v:${v.id}`,
      wann: v.ende ? `${tagUhr(v.beginn, now)}–${uhr(Date.parse(v.ende))}` : `ab ${tagUhr(v.beginn, now)}`,
      titel: `${URHEBER_WORT[v.urheber] ?? v.urheber} · ${vorgabeWas(v)}`,
      sub: [v.te_nr == null ? 'gilt für die ganze Anlage' : null, v.ende ? null : 'läuft', v.unvollstaendig ? 'unvollständig' : null]
        .filter(Boolean)
        .join(' · ') || null,
      laeuft: v.ende == null,
      art: 'vorgabe' as const,
    }));
}

/** Die Kennung eines Alarms je Einheit, wie der Server sie baut (`WerteLeser.Bezug.einheit`). */
export function einheitBezugKennung(geraetId: string, teNr: number): string {
  return `einheit:${geraetId};te=${teNr}`;
}

/** Die Meldungen dieser Einheit (EZ-11, „Fernsteuerung nicht bereit“ je Einheit), offene zuerst. */
export function alarmZeilen(meldungen: readonly Meldung[], geraetId: string, teNr: number, now: Date): AktivitaetZeile[] {
  const kennung = einheitBezugKennung(geraetId, teNr);
  return meldungen
    .filter((m) => m.bezugKennung === kennung)
    .sort((a, b) => Number(a.wiederNormalAm != null) - Number(b.wiederNormalAm != null) || b.ausgeloestAm.localeCompare(a.ausgeloestAm))
    .map((m) => ({
      key: `m:${m.id}`,
      wann: m.wiederNormalAm ? `${tagUhr(m.ausgeloestAm, now)}–${uhr(Date.parse(m.wiederNormalAm))}` : `seit ${tagUhr(m.ausgeloestAm, now)}`,
      titel: `${SCHWERE_WORT[m.schwere]} · ${wertartSatzname(m.wertart)}`,
      sub: m.wiederNormalAm ? 'wieder normal' : null,
      laeuft: m.wiederNormalAm == null,
      art: 'alarm' as const,
    }));
}
