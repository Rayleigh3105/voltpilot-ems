import {
  deviceLiveStatus,
  type Device,
  type EdgeVersion,
  type UemsDatenquelle,
} from './api';
import { fmtRelative } from './format';
import { faehigkeiten, fehlerklasse, PROTOKOLLE, type TabellenEintrag } from './uemsDatenquelle';

/** Das Lesebudget einer Box (AP-06): Anfragen und Messwerte je Minute. */
export const ANFRAGEN_GRENZE = 30;
export const MESSWERTE_GRENZE = 600;

/** Die gemeldete Last eines oder mehrerer Wege; null-Teile = nicht gemeldet. */
export interface WegLast {
  anfragen: number | null;
  messwerte: number | null;
  /** max(Anfragen/30, Messwerte/600) in Prozent; null = keine der beiden Zahlen gemeldet. */
  prozent: number | null;
  /** Wege ohne gemeldete Zahl (Kennzeichen) — nur in einer Summe. */
  ohneMeldung: string[];
}

/** Die Last über Wege: Summe der gemeldeten Zahlen; ein Weg ohne Meldung zählt nicht als Null, er wird genannt. */
export function wegLast(quellen: readonly UemsDatenquelle[]): WegLast {
  let anfragen: number | null = null;
  let messwerte: number | null = null;
  const ohneMeldung: string[] = [];
  for (const q of quellen) {
    const a = q.rueckmeldung?.anfragen_pro_minute ?? null;
    const m = q.rueckmeldung?.messwerte_pro_minute ?? null;
    if (a == null && m == null) ohneMeldung.push(q.kennzeichen);
    if (a != null) anfragen = (anfragen ?? 0) + a;
    if (m != null) messwerte = (messwerte ?? 0) + m;
  }
  const prozent = anfragen == null && messwerte == null
    ? null
    : Math.max((anfragen ?? 0) / ANFRAGEN_GRENZE, (messwerte ?? 0) / MESSWERTE_GRENZE) * 100;
  return { anfragen, messwerte, prozent, ohneMeldung };
}

/** „51 %" (Prozent ohne Stelle, AP-08 E11); eine kleine, aber gemeldete Last ist „unter 1 %", nie „0 %". */
export function lastProzent(prozent: number): string {
  if (prozent > 0 && prozent < 0.5) return 'unter 1\u00a0%';
  return `${Math.round(prozent).toLocaleString('de-DE')}\u00a0%`;
}

/** „Last 51 %". */
export function lastText(prozent: number): string {
  return `Last ${lastProzent(prozent)}`;
}

/** Die gemeldeten Zahlen einer Last: „12 von 30 Anfragen/min“, „305 von 600 Messwerten/min“ (Anbindung, GE-2). */
export function lastTeile(l: WegLast): string[] {
  return [
    l.anfragen == null ? null : `${zahl(l.anfragen)} von ${ANFRAGEN_GRENZE} Anfragen/min`,
    l.messwerte == null ? null : `${zahl(l.messwerte)} von ${MESSWERTE_GRENZE} Messwerten/min`,
  ].filter((s): s is string => s != null);
}

/** Die Last, die EINE Box trägt: alle nicht archivierten Wege, deren zuständige Box sie ist. */
export interface BoxLast {
  quellen: UemsDatenquelle[];
  last: WegLast;
  /** „Last 51 %"; „Last nicht gemeldet", wenn die Box Wege liest, aber keine Zahl meldet; null = sie liest keinen. */
  kurz: string | null;
}

/**
 * Die EINE Rechnung der Box-Last (GE-4): Box-Seite („Geräte an dieser Box", `boxGeraete`) und die Box-Zeile im
 * Aufbau (`aufbauBaum`) rufen beide diese Funktion — nie eine zweite Zählweise.
 */
export function boxLast(boxId: string, datenquellen: readonly UemsDatenquelle[] | null | undefined): BoxLast {
  const quellen = (datenquellen ?? []).filter((q) => q.archiviert_am == null && q.zustaendige_box?.id === boxId);
  const last = wegLast(quellen);
  return {
    quellen,
    last,
    kurz: last.prozent != null ? lastText(last.prozent) : quellen.length > 0 ? 'Last nicht gemeldet' : null,
  };
}

/** Runtime copy of the reviewed capability table; its vector test pins names and order. */
export const BOX_FAEHIGKEITEN: TabellenEintrag[] = [
  { code: 'data_sources', name: 'Rückmeldung je Datenquelle', ab_release: null },
  { code: 'geraetesuche', name: 'Gerätesuche', ab_release: null },
];

export interface BoxQuelleZeile {
  id: string;
  kennzeichen: string;
  name: string;
  /**
   * Die Zeile, wie sie dasteht: „DQ-3 · Unterzähler Halle 1“ — ohne eigenen Namen nur das Kennzeichen („DQ-3“;
   * der Weg steht darunter), nie „DQ-3 · DQ-3“.
   */
  titel: string;
  /** Protokoll und Adresse, dazu die Geräte-IDs dahinter („Modbus TCP · 192.168.10.31 · Geräte-IDs 1–5“). */
  weg: string;
  zustand: string;
  fehlerklasse: string | null;
  seit: string | null;
  budget: string;
  ton: 'ok' | 'warn' | 'off';
}

export interface BoxUebersichtKarte {
  id: string;
  siteId: string;
  ref: string;
  name: string;
  verbindung: string;
  verbindungDetail: string | null;
  verbindungTon: 'ok' | 'warn' | 'off';
  rolle: string;
  software: string;
  faehigkeiten: string;
  updateNoetig: boolean;
}

const zahl = (wert: number) => wert.toLocaleString('de-DE', { maximumFractionDigits: 1 });

/** Ein Zeitpunkt, wie die Box-Seite ihn nennt („23.10.2026, 11:42“); null = keiner. */
export function zeitpunkt(iso: string | null | undefined): string | null {
  if (!iso || !Number.isFinite(Date.parse(iso))) return null;
  return new Date(iso).toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function budgetAnteil(q: UemsDatenquelle): string {
  const r = q.rueckmeldung;
  const anfragen = r?.anfragen_pro_minute;
  const messwerte = r?.messwerte_pro_minute;
  if (anfragen == null && messwerte == null) return 'Budget-Anteil nicht gemeldet';
  const anteil = Math.max(
    anfragen == null ? 0 : anfragen / ANFRAGEN_GRENZE,
    messwerte == null ? 0 : messwerte / MESSWERTE_GRENZE,
  ) * 100;
  const teile = [
    anfragen == null ? null : `${zahl(anfragen)} von ${ANFRAGEN_GRENZE} Anfragen/min`,
    messwerte == null ? null : `${zahl(messwerte)} von ${MESSWERTE_GRENZE} Messwerten/min`,
  ].filter((s): s is string => s !== null);
  return `Budget-Anteil ${zahl(anteil)} % · ${teile.join(' · ')}`;
}

/** „Modbus TCP“ statt `modbus_tcp`; ein Protokoll außerhalb des Vokabulars bleibt, wie es kam. */
export function protokollName(code: string): string {
  return PROTOKOLLE.find((p) => p.code === code)?.name ?? code;
}

/** Die Geräte-IDs hinter einer Adresse: „Geräte-ID 1“, „Geräte-IDs 1–5“ (lückenlos) oder „Geräte-IDs 1, 3, 7“. */
function geraeteIds(ids: readonly number[]): string | null {
  if (ids.length === 0) return null;
  if (ids.length === 1) return `Geräte-ID ${ids[0]}`;
  const sortiert = [...ids].sort((a, b) => a - b);
  const lueckenlos = sortiert.every((n, i) => i === 0 || n === sortiert[i - 1] + 1);
  return `Geräte-IDs ${lueckenlos ? `${sortiert[0]}–${sortiert[sortiert.length - 1]}` : sortiert.join(', ')}`;
}

export function quellWeg(q: UemsDatenquelle): string {
  return [protokollName(q.protokoll), q.adresse, geraeteIds(q.geraete_ids ?? [])].filter(Boolean).join(' · ');
}

export function quellZeile(q: UemsDatenquelle): BoxQuelleZeile {
  const r = q.rueckmeldung;
  const eigenerName = q.name?.trim() && q.name.trim() !== q.kennzeichen ? q.name.trim() : null;
  const name = eigenerName ?? q.kennzeichen;
  const kopf = {
    titel: eigenerName ? `${q.kennzeichen} · ${eigenerName}` : q.kennzeichen,
    weg: quellWeg(q),
  };
  if (!r || r.zustand === 'meldet_noch_nicht_je_quelle') {
    return {
      id: q.id, kennzeichen: q.kennzeichen, name, ...kopf,
      zustand: 'Box meldet noch nicht je Quelle', fehlerklasse: null, seit: null,
      budget: budgetAnteil(q), ton: 'off',
    };
  }
  if (r.zustand === 'liefert') {
    return {
      id: q.id, kennzeichen: q.kennzeichen, name, ...kopf,
      zustand: 'Liefert Daten', fehlerklasse: null,
      seit: r.gelesen_am ? `Zuletzt gelesen ${zeitpunkt(r.gelesen_am)}` : null,
      budget: budgetAnteil(q), ton: 'ok',
    };
  }
  const klasse = r.fehlerklasse ? fehlerklasse(r.fehlerklasse, 'box') : null;
  return {
    id: q.id, kennzeichen: q.kennzeichen, name, ...kopf,
    zustand: 'Liefert keine Daten',
    fehlerklasse: klasse?.name ?? null,
    seit: r.seit ? `Seit ${zeitpunkt(r.seit)}` : null,
    budget: budgetAnteil(q), ton: 'warn',
  };
}

function faehigkeitenText(edge: EdgeVersion | undefined): { text: string; update: boolean } {
  const stand = edge?.coreVersion?.trim() || null;
  const f = faehigkeiten(
    { version: stand, release: null, supports: edge?.capabilities ?? edge?.supports ?? null },
    BOX_FAEHIGKEITEN,
    [],
  );
  return { text: f.text, update: f.faehigkeiten.some((x) => x.status === 'fehlt') };
}

/**
 * Je Box Verbindung, Rolle und Software. Was an ihr hängt, zählt der Aufbau (GE-1) — Box-Zeile „n Geräte · Last
 * p %" — und die Box-Seite („Geräte an dieser Box", `boxGeraete`); diese Karte zählt keine Datenquellen mehr.
 */
export function boxUebersicht(
  devices: readonly Device[],
  versionen: readonly EdgeVersion[],
  anlagenNamen: ReadonlyMap<string, string>,
  jetzt = new Date(),
): BoxUebersichtKarte[] {
  const version = new Map(versionen.map((v) => [v.deviceId, v]));
  return devices.map((d): BoxUebersichtKarte => {
    const status = deviceLiveStatus(d, jetzt);
    const f = faehigkeitenText(version.get(d.id));
    const anlage = anlagenNamen.get(d.siteId) ?? 'diese Anlage';
    return {
      id: d.id,
      siteId: d.siteId,
      ref: d.externalRef,
      name: d.name?.trim() || d.externalRef,
      verbindung: status === 'online' ? 'Verbunden' : status === 'stale' ? 'Meldet sich nicht' : 'Wartet auf erste Meldung',
      verbindungDetail: d.lastSeenAt ? `Letzte Meldung ${fmtRelative(d.lastSeenAt, jetzt)}` : null,
      verbindungTon: status === 'online' ? 'ok' : status === 'stale' ? 'warn' : 'off',
      rolle: d.fuehrtAnlage === true ? `Führt ${anlage}` : `Führt ${anlage} nicht`,
      software: version.get(d.id)?.coreVersion ? `Software ${version.get(d.id)!.coreVersion}` : 'Software-Stand unbekannt',
      faehigkeiten: f.text,
      updateNoetig: f.update,
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'de'));
}
