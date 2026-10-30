/**
 * „Geräte suchen" im Portal (Konzept `vp-portal-geraetesuche-konzept`, Bericht §2–§4, Captain 30.10.2026: DP-1 C,
 * DP-2 bis DP-7 A): was das Such-Modal, die Box-Karte und der Aufbau aus einer Antwort der Routen zeigen
 * (`geraetesuche.ts`, OpenAPI-Tag `geraetesuche`). Rein: kein React, kein Abruf - die Komponenten
 * `components/Geraetesuche*.tsx` rendern nur, was hier entsteht.
 *
 * Was hier hält:
 * - **Gleichheit sagt allein der Server** (`abgleich`, nie über dieselbe Adresse). Das Portal benennt nur, was er
 *   abgeglichen hat; eine neue Adresse ist ein Vorschlag, den ein Tipp übernimmt (DP-7 A), nie still.
 * - **Unbekannt ist keine Null**: fehlende Restzeit, Zahl oder Adresse heißt „nicht gemeldet", nie 0.
 * - **DP-3 A**: Telefone, Rechner und Unbekanntes nur als Zahl; Netz-Technik nur mit Art, nie mit einem Namen.
 * - **Erkennung als Wort**, Farbe verstärkt nur (Hausregel `GeraetSeite.css`).
 */
import {
  GERAETESUCHE_ERKENNER,
  type Geraetesuche,
  type GeraetesucheArt,
  type GeraetesucheErkennung,
  type GeraetesucheFehler,
  type GeraetesucheFund,
  type GeraetesucheGruppeWort,
  type GeraetesucheSchritt,
  type GeraetesucheUrheber,
  type GeraetesucheVerlaufEintrag,
  type GeraetesucheWeitere,
  type GeraetesucheZustand,
  type GeraetesucheLadesaeuleKlopftAn,
} from './geraetesuche';
import { felder, type ComponentTemplate } from './komponentenAssistent';

/** Solange eine Suche läuft, fragt das Portal so oft ab (Vertrag §7) - danach nicht mehr. */
export const GERAETESUCHE_POLL_MS = 2_000;

/** Ohne Herzschlag seit so langer Zeit ist eine Box offline (dieselbe Grenze wie `ONLINE_WINDOW_MS`). */
export const BOX_OFFLINE_NACH_MS = 5 * 60 * 1000;

/** Die Überschriften der sechs Gruppen, in der festen Reihenfolge der Antwort (Bericht §4). */
export const GRUPPEN_TITEL: Record<GeraetesucheGruppeWort, string> = {
  braucht_hilfe: 'Braucht Ihre Hilfe',
  bereit: 'Bereit zum Übernehmen',
  nicht_anbindbar: 'Erkannt, mit dieser Box noch nicht anbindbar',
  vielleicht: 'Vielleicht ein Energie-Gerät',
  schon_eingerichtet: 'Schon eingerichtet',
  weitere: 'Weitere Geräte im Heimnetz',
};

/** Die drei Schritte im Klartext; „Heimnetz ansehen" deckt die zwei ersten Schritte der Box. */
export const SUCH_SCHRITTE: readonly { titel: string; woerter: readonly GeraetesucheSchritt[] }[] = [
  { titel: 'Heimnetz ansehen', woerter: ['netze_bestimmen', 'nachbarn_finden'] },
  { titel: 'Geräte ansprechen', woerter: ['geraete_ansprechen'] },
  { titel: 'Geräte erkennen', woerter: ['geraete_erkennen'] },
];

/** Wartet die Suche noch auf die Box oder kommen Zwischenstände - dann fragt das Portal weiter ab. */
export function laeuftNoch(zustand: GeraetesucheZustand): boolean {
  return zustand === 'wartet' || zustand === 'laeuft';
}

const ERKENNUNG_WORT: Record<GeraetesucheErkennung, string> = {
  sicher: 'sicher erkannt',
  wahrscheinlich: 'wahrscheinlich',
  unbekannt: 'nur erreichbar',
};

/** Die Erkennung als Wort (Bericht §4 „Erkennung in Worten"); der Ton verstärkt nur. */
export function erkennungWort(e: GeraetesucheErkennung): { wort: string; ton: 'ok' | 'warn' | 'off' } {
  return { wort: ERKENNUNG_WORT[e], ton: e === 'sicher' ? 'ok' : e === 'wahrscheinlich' ? 'warn' : 'off' };
}

// ─────────────────────────────────────────────────────────────────────── Fortschritt

export interface SuchFortschritt {
  /** 0 bis 2: der Schritt im Klartext; 0 auch, solange die Box noch nicht gemeldet hat. */
  schritt: number;
  /** Die drei Schritte mit ihrem Zustand für die Schrittleiste. */
  schritte: { titel: string; zustand: 'fertig' | 'aktiv' | 'offen'; zeile: string | null }[];
  /** 0 bis 1 über alle drei Schritte; null = noch nichts gemeldet. */
  anteil: number | null;
  /** „Noch etwa 15 Sekunden" - die Restzeit als Text; ohne Schätzung der Box sagt er das. */
  rest: string;
  /** „Schritt 2 von 3 · Geräte ansprechen". */
  schrittSatz: string;
}

function schrittIndex(s: GeraetesucheSchritt | null): number {
  const i = SUCH_SCHRITTE.findIndex((x) => s !== null && x.woerter.includes(s));
  return i < 0 ? 0 : i;
}

/** „Noch etwa 15 Sekunden" - auf 5 s gerundet, ab 90 s in Minuten; ohne Schätzung der Box kein Zahlwort. */
export function restText(restSekunden: number | null): string {
  if (restSekunden === null) return 'Restzeit wird noch geschätzt';
  if (restSekunden <= 5) return 'Gleich fertig';
  if (restSekunden < 90) return `Noch etwa ${Math.max(5, Math.round(restSekunden / 5) * 5)} Sekunden`;
  return `Noch etwa ${Math.round(restSekunden / 60)} Minuten`;
}

export function fortschritt(s: Geraetesuche): SuchFortschritt {
  const gemeldet = s.zustand !== 'wartet' && s.schritt !== null;
  const i = gemeldet ? schrittIndex(s.schritt) : 0;
  const teil = s.erledigt !== null && s.gesamt !== null && s.gesamt > 0 ? Math.min(1, s.erledigt / s.gesamt) : 0.5;
  const zeile = (k: number): string | null => {
    if (k === 0) {
      const netze = s.netze.filter((n) => n.erreichbar);
      if (netze.length === 0) return null;
      return netze.map((n) => `${n.rolle === 'kundennetz' ? 'Heimnetz' : 'Netz der Box'} ${n.netz}`).join(' · ');
    }
    if (k === i && s.erledigt !== null && s.gesamt !== null) {
      return k === 1 ? `${s.erledigt} von ${s.gesamt} Adressen geprüft` : `${s.erledigt} von ${s.gesamt} Geräten erkannt`;
    }
    return k === 1 ? 'Wer antwortet?' : 'Hersteller, Modell, Seriennummer';
  };
  return {
    schritt: i,
    schritte: SUCH_SCHRITTE.map((x, k) => ({
      titel: x.titel,
      zustand: !gemeldet ? (k === 0 ? 'aktiv' : 'offen') : k < i ? 'fertig' : k === i ? 'aktiv' : 'offen',
      zeile: zeile(k),
    })),
    anteil: gemeldet ? Math.min(1, (i + teil) / SUCH_SCHRITTE.length) : null,
    rest: gemeldet ? restText(s.restSekunden) : 'Ihre Box beginnt gleich',
    schrittSatz: `Schritt ${i + 1} von ${SUCH_SCHRITTE.length} · ${SUCH_SCHRITTE[i].titel}`,
  };
}

// ─────────────────────────────────────────────────────────────────────── Ein Fund in Worten

const HERSTELLER: Record<string, string> = {
  deye: 'Deye', shelly: 'Shelly', 'go-e': 'go-e', goe: 'go-e', avm: 'AVM', fronius: 'Fronius', kaco: 'KACO',
  aiswei: 'AISWEI', kostal: 'KOSTAL', huawei: 'Huawei', sma: 'SMA', victron: 'Victron', opendtu: 'OpenDTU',
  ahoy: 'AhoyDTU', ebyte: 'eByte', wago: 'WAGO', 'tp-link': 'TP-Link', tplink: 'TP-Link', solarman: 'Solarman',
};

export const ART_WORT: Record<GeraetesucheArt, string> = {
  wechselrichter: 'Wechselrichter',
  wallbox: 'Wallbox',
  schaltaktor: 'Schalter',
  zaehler: 'Zähler',
  io_modul: 'I/O-Modul',
  sps: 'Steuerung (SPS)',
  dtu: 'Gateway für Mikro-Wechselrichter',
  modbus_geraet: 'Modbus-Gerät',
  router: 'Router',
  zugangspunkt: 'WLAN-Zugangspunkt',
};

const FAMILIE: Record<string, string> = {
  hybrid_3p: 'Hybrid, 3-phasig',
  hybrid_1p: 'Hybrid, 1-phasig',
  string: 'String',
  micro: 'Mikro',
};

/** Der Hersteller, wie der Kunde ihn schreibt; ein unbekannter bleibt, wie die Box ihn meldet. */
export function herstellerName(h: string | null): string | null {
  if (!h || !h.trim()) return null;
  return HERSTELLER[h.trim().toLowerCase()] ?? h.trim();
}

/** „Deye Hybrid-Wechselrichter", „Shelly SPSW-003XE16EU", „Modbus-Gerät" - ohne erfundenen Modellnamen. */
export function fundTitel(f: GeraetesucheFund): string {
  const h = herstellerName(f.hersteller);
  if (f.modell && f.modell.trim()) return h && !f.modell.toLowerCase().startsWith(h.toLowerCase()) ? `${h} ${f.modell.trim()}` : f.modell.trim();
  if (h && f.art === 'wechselrichter' && f.familie?.startsWith('hybrid')) return `${h} Hybrid-Wechselrichter`;
  return h ? `${h} ${ART_WORT[f.art]}` : ART_WORT[f.art];
}

/** „Hybrid, 3-phasig, Hochvolt" - was die Box über die Bauart weiß; null, wenn sie nichts sagt. */
export function bauart(f: GeraetesucheFund): string | null {
  const teile = [
    f.familie ? FAMILIE[f.familie] ?? null : null,
    f.spannung === 'hv' ? 'Hochvolt' : f.spannung === 'lv' ? 'Niedervolt' : null,
  ].filter((t): t is string => Boolean(t));
  return teile.length ? teile.join(', ') : null;
}

/** „3 Schaltausgänge" bzw. das Wort der Art. */
export function artText(f: GeraetesucheFund): string {
  if (f.art === 'schaltaktor' && f.kanaele !== null && f.kanaele > 0) {
    return f.kanaele === 1 ? '1 Schaltausgang' : `${f.kanaele} Schaltausgänge`;
  }
  return ART_WORT[f.art];
}

/** Die Adresse aus der Verbindung: „192.168.178.34" bzw. mit Port; null, wenn die Box keine nennt. */
export function fundAdresse(f: Pick<GeraetesucheFund, 'verbindung'>, mitPort = false): string | null {
  const ip = typeof f.verbindung.ip === 'string' && f.verbindung.ip.trim() ? f.verbindung.ip.trim() : null;
  if (!ip) return null;
  const port = typeof f.verbindung.port === 'number' ? f.verbindung.port : null;
  return mitPort && port !== null ? `${ip}:${port}` : ip;
}

/** Die graue Zeile unter dem Namen: Art und Adresse (Handy) bzw. Art und Bauart (Tabelle am Rechner). */
export function fundZeile(f: GeraetesucheFund, mitAdresse: boolean): string {
  const teile = [artText(f), mitAdresse ? fundAdresse(f) : bauart(f)];
  return teile.filter((t): t is string => Boolean(t)).join(' · ');
}

/** Woran erkannt: bekannte Merkmale in Worten; ein unbekanntes Wort der Box bleibt sichtbar, nie verschluckt. */
const MERKMAL_SATZ: Record<string, string> = {
  v5_kopf_seriennummer: 'Der Datenlogger nennt seine Seriennummer im Antwortkopf (Solarman V5).',
  deye_seriennummer_0x0003: 'Seriennummer des Wechselrichters aus den Registern 0x0003–0x0007.',
  shelly_gen2_antwort: 'Der Shelly nennt auf /shelly Modell, Generation und Firmware.',
  goe_api_v2_sse: 'Die Wallbox nennt ihre Seriennummer über die lokale API v2.',
  modbus_port_offen: 'Der Modbus-Port ist offen, aber das Gerät nennt keine Kennung.',
  seitentitel: 'Titel der Weboberfläche des Geräts.',
  ssdp_fboxdesc: 'Gerätebeschreibung, die das Gerät im Netz anbietet (SSDP).',
  auth_en: 'Die Weboberfläche verlangt eine Anmeldung.',
  solar_api_version: 'Die Fronius Solar API antwortet mit ihrer Version.',
  solar_api_inverter_info: 'Die Fronius Solar API nennt ihre Wechselrichter.',
  sma_modbus_unit_3: 'Modbus antwortet an der SMA-Geräteadresse 3.',
  sma_seriennummer_30057: 'Seriennummer aus dem SMA-Register 30057.',
  ebyte_modelltabelle_0x0c80: 'Modelltabelle des Moduls ab Register 0x0C80.',
  laufender_leser: 'Ihre Box liest dieses Gerät schon.',
};

export function merkmalText(code: string): { text: string; roh: boolean } {
  const bekannt = MERKMAL_SATZ[code];
  if (bekannt) return { text: bekannt, roh: false };
  const typ = /^deye_typ_0x([0-9a-f]{1,4})$/i.exec(code);
  if (typ) return { text: `Typregister 0x0000 meldet 0x${typ[1].toUpperCase().padStart(4, '0')}.`, roh: false };
  return { text: code, roh: true };
}

// ─────────────────────────────────────────────────────────────────────── Was ein Fund anbietet

export type FundAktion =
  /** In den Anlege-Fluss; `bestaetigen` = nur wahrscheinlich erkannt, der Kunde bestätigt vorher. */
  | { art: 'uebernehmen'; bestaetigen: boolean }
  /** DP-7 A: dieselbe Komponente bekommt die neue Adresse - ein Tipp, Test, neue Fassung. */
  | { art: 'adresse'; komponente: { id: string; name: string }; neu: string; bisher: string | null }
  /** „Modbus-Gerät selbst beschreiben" mit vorbelegter Adresse. */
  | { art: 'selbst' }
  | { art: 'keine' };

/**
 * Was ein Fund in seiner Gruppe anbietet. `portalVerwaltet` false (Geräte werden an der Box gepflegt): suchen ja,
 * übernehmen nein (Bericht §4 „Übernehmen", letzter Punkt).
 */
export function fundAktion(f: GeraetesucheFund, gruppe: GeraetesucheGruppeWort, portalVerwaltet: boolean): FundAktion {
  if (!portalVerwaltet || gruppe === 'schon_eingerichtet' || gruppe === 'weitere' || gruppe === 'nicht_anbindbar') {
    return { art: 'keine' };
  }
  if (f.abgleich === 'adresse_geaendert' && f.komponente) {
    const neu = fundAdresse(f, true);
    return neu ? { art: 'adresse', komponente: f.komponente, neu, bisher: f.bekannteAdresse } : { art: 'keine' };
  }
  if (f.hindernis !== null) return { art: 'keine' };
  if (f.anbindung === 'selbst_beschreiben') return { art: 'selbst' };
  if (f.anbindung === 'uebernehmen' && f.vorlagen.length > 0 && f.erkennung !== 'unbekannt') {
    return { art: 'uebernehmen', bestaetigen: f.erkennung === 'wahrscheinlich' };
  }
  return { art: 'keine' };
}

/** Der eine Satz, warum ein Fund Hilfe braucht oder nicht anbindbar ist; null = keiner nötig. */
export function fundHinweis(f: GeraetesucheFund): string | null {
  if (f.abgleich === 'adresse_geaendert') {
    const alt = f.bekannteAdresse ? `Bisher ${f.bekannteAdresse}. ` : '';
    return `${alt}Gleiche Seriennummer – es ist dasselbe Gerät. Tipp: feste IP im Router.`;
  }
  if (f.abgleich === 'anderes_geraet_an_bekannter_adresse') {
    const name = f.komponente ? `„${f.komponente.name}“` : 'Ihr eingerichtetes Gerät';
    return `An dieser Adresse antwortet ein anderes Gerät als ${name}. Wurde das Gerät getauscht?`;
  }
  if (f.abgleich === 'adresse_bekannt_kennung_offen') {
    return f.komponente
      ? `An dieser Adresse ist „${f.komponente.name}“ eingerichtet; ob es dasselbe Gerät ist, lässt sich ohne Seriennummer nicht belegen.`
      : 'An dieser Adresse ist schon ein Gerät eingerichtet.';
  }
  if (f.hindernis === 'geschuetzt') {
    return 'Passwortschutz ist an. Schalten Sie ihn in der App des Geräts aus und suchen Sie erneut – VoltPilot meldet sich nie an.';
  }
  if (f.hindernis === 'lokale_api_aus') {
    return 'Die lokale Schnittstelle ist aus. Schalten Sie in der go-e-App „HTTP API v2“ ein und suchen Sie erneut.';
  }
  if (f.anbindung === 'nicht_mit_dieser_box') return 'Diese Box liest es noch nicht; andere VoltPilot-Boxen schon.';
  if (f.anbindung === 'kein_leseweg') return 'Erkannt, aber VoltPilot kann es noch nicht lesen.';
  if (f.liestBoxSchon) return 'Ihre Box liest dieses Gerät schon.';
  return null;
}

/** Der Zustand eines eingerichteten Fundes in einem Wort („liefert Daten"), den der Wirt aus seiner Komponente kennt. */
export function eingerichtetZeile(f: GeraetesucheFund, zustand: string | null): string {
  return [zustand, fundAdresse(f)].filter((t): t is string => Boolean(t)).join(' · ');
}

// ─────────────────────────────────────────────────────────────────────── Übernehmen

export type UebernahmeWeg =
  | { art: 'direkt'; template: ComponentTemplate }
  /** Mehrere passende Modelle (Deye: die Leistung steht nicht im Gerät) - der Kunde wählt vom Typenschild. */
  | { art: 'modell'; templates: ComponentTemplate[] }
  /** Ein Schalter mit mehreren Ausgängen: je Ausgang eine Komponente (`channel` 0, 1, 2). */
  | { art: 'ausgang'; template: ComponentTemplate; kanaele: number }
  /** Die Vorlagen des Fundes kennt dieser Katalog nicht (älterer Stand) - nur „von Hand". */
  | { art: 'unbekannt' };

export function uebernahmeWeg(f: GeraetesucheFund, templates: readonly ComponentTemplate[]): UebernahmeWeg {
  const passend = templates
    .filter((t) => f.vorlagen.includes(t.templateRef) && !t.supersededBy)
    .sort((a, b) => (a.ratedKw ?? Infinity) - (b.ratedKw ?? Infinity) || a.modelLabel.localeCompare(b.modelLabel, 'de'));
  if (passend.length === 0) return { art: 'unbekannt' };
  if (passend.length > 1) return { art: 'modell', templates: passend };
  const t = passend[0];
  if (felder(t).some((x) => x.key === 'channel') && f.kanaele !== null && f.kanaele > 1) {
    return { art: 'ausgang', template: t, kanaele: f.kanaele };
  }
  return { art: 'direkt', template: t };
}

/**
 * Die Verbindung aus der Suche in den Schlüsseln DIESER Vorlage (`AnlegenFlow.startVerbindung`). Der Vertrag nennt die
 * Modbus-Adresse `unit_id`; die Solarman-Vorlagen fragen sie als `mb_slave_id`. Eine Seriennummer reist als Text,
 * wie das Feld sie führt. `initialeVerbindung` nimmt danach nur Felder, die die Vorlage wirklich fragt.
 */
export function vorbelegung(
  f: GeraetesucheFund,
  template: ComponentTemplate,
  kanal: number | null = null,
): Record<string, unknown> {
  const fs = felder(template);
  const hat = (k: string) => fs.some((x) => x.key === k);
  const aus: Record<string, unknown> = { ...f.verbindung };
  delete aus.communication;
  if (aus.unit_id !== undefined && aus.unit_id !== null && !hat('unit_id') && hat('mb_slave_id')) aus.mb_slave_id = aus.unit_id;
  const serial = fs.find((x) => x.key === 'serial');
  if (serial && serial.type === 'text' && typeof aus.serial === 'number') aus.serial = String(aus.serial);
  if (kanal !== null && hat('channel')) aus.channel = kanal;
  return aus;
}

/** Was die Suche über das Gerät weiß, als ruhige Zeilen über der Modellwahl („Aus der Suche"). */
export function ausDerSuche(f: GeraetesucheFund): { titel: string; zeile: string } {
  const h = herstellerName(f.hersteller);
  const titel = [h, bauart(f)].filter(Boolean).join(' · ') || fundTitel(f);
  const zeile = [f.seriennummer ? `Seriennummer ${f.seriennummer}` : null, fundAdresse(f)]
    .filter((t): t is string => Boolean(t))
    .join(' · ');
  return { titel, zeile };
}

/** Der Schlüssel eines übernommenen Ausgangs bzw. Fundes für die Liste „Übernommen". */
export function uebernahmeSchluessel(f: Pick<GeraetesucheFund, 'schluessel'>, kanal: number | null = null): string {
  return kanal === null ? f.schluessel : `${f.schluessel}#${kanal}`;
}

/** Die Ausgänge eines Schalters, die noch niemand übernommen hat (0-basiert, wie `channel`). */
export function offeneAusgaenge(f: GeraetesucheFund, uebernommen: ReadonlySet<string>): number[] {
  const n = f.kanaele ?? 1;
  return Array.from({ length: n }, (_, k) => k).filter((k) => !uebernommen.has(uebernahmeSchluessel(f, k)));
}

// ─────────────────────────────────────────────────────────────────────── Ergebnis

/** Funde, die ein Energie-Gerät sind (alles außer Netz-Technik), über alle Gruppen. */
export function energieFunde(s: Geraetesuche): number {
  return s.gruppen.filter((g) => g.gruppe !== 'weitere').reduce((n, g) => n + g.funde.length, 0);
}

function gruppe(s: Geraetesuche, w: GeraetesucheGruppeWort): GeraetesucheFund[] {
  return s.gruppen.find((g) => g.gruppe === w)?.funde ?? [];
}

const zahl = (n: number, eins: string, viele: string) => `${n} ${n === 1 ? eins : viele}`;

/** Ist ein Fund (bzw. jeder seiner Ausgänge) in dieser Sitzung übernommen. */
export function istUebernommen(f: GeraetesucheFund, uebernommen: ReadonlySet<string>): boolean {
  if (uebernommen.has(f.schluessel)) return true;
  return f.art === 'schaltaktor' && (f.kanaele ?? 0) > 1 && offeneAusgaenge(f, uebernommen).length === 0;
}

/** Die Überschrift des Ergebnisses: „2 Geräte gefunden", „1 neues Gerät, 1 Hinweis", „Noch 1 Gerät". */
export function ergebnisTitel(s: Geraetesuche, uebernommen: ReadonlySet<string>): string {
  const offen = gruppe(s, 'bereit').filter((f) => !istUebernommen(f, uebernommen)).length;
  const hilfe = gruppe(s, 'braucht_hilfe').filter((f) => !istUebernommen(f, uebernommen)).length;
  const schon = uebernommen.size > 0;
  if (hilfe > 0) {
    return offen > 0 ? `${zahl(offen, 'neues Gerät', 'neue Geräte')}, ${zahl(hilfe, 'Hinweis', 'Hinweise')}` : zahl(hilfe, 'Hinweis', 'Hinweise');
  }
  if (offen > 0) return schon ? `Noch ${zahl(offen, 'Gerät', 'Geräte')}` : `${zahl(offen, 'Gerät', 'Geräte')} gefunden`;
  if (schon) return 'Alles übernommen';
  if (gruppe(s, 'nicht_anbindbar').length + gruppe(s, 'vielleicht').length > 0) return 'Keine Geräte zum Übernehmen';
  if (gruppe(s, 'schon_eingerichtet').length > 0) return 'Keine neuen Geräte';
  return 'Keine Energie-Geräte gefunden';
}

/** Nichts gefunden (m7): kein Energie-Gerät und keine Ladesäule, die anklopft. */
export function nichtsGefunden(s: Geraetesuche): boolean {
  return !laeuftNoch(s.zustand) && energieFunde(s) === 0 && (s.ladesaeulenKlopfenAn?.length ?? 0) === 0;
}

/** Netz-Technik und Geräte von Personen (DP-3 A: nur als Zahl). */
export function weitere(s: Geraetesuche): { anzahl: number | null; zeile: string | null } {
  const technik = gruppe(s, 'weitere');
  const w: GeraetesucheWeitere = s.weitere;
  const zahlen = [w.telefonTablet, w.rechner, w.unbekannt];
  const gezaehlt = technik.length > 0 || zahlen.some((z) => z !== null);
  const anzahl = gezaehlt ? technik.length + zahlen.reduce<number>((n, z) => n + (z ?? 0), 0) : null;
  const arten = [...new Set(technik.map((f) => ART_WORT[f.art]))];
  const teile = [
    ...arten,
    w.telefonTablet ? zahl(w.telefonTablet, 'Telefon oder Tablet', 'Telefone oder Tablets') : null,
    w.rechner ? zahl(w.rechner, 'Rechner', 'Rechner') : null,
    w.unbekannt ? zahl(w.unbekannt, 'unbekanntes Gerät', 'unbekannte Geräte') : null,
  ].filter((t): t is string => Boolean(t));
  return { anzahl, zeile: teile.length ? teile.join(', ') : null };
}

/** „3 weitere Geräte" - ohne Zählung der Box kein Zahlwort. */
export function weitereTitel(anzahl: number | null): string {
  if (anzahl === null) return 'Weitere Geräte nicht gezählt';
  return anzahl === 1 ? '1 weiteres Gerät' : `${anzahl} weitere Geräte`;
}

/** Die vier Prüffragen, wenn kein Energie-Gerät gefunden wurde (m7) - mit den Netzen, in denen gesucht wurde. */
export function nichtsGefundenFragen(s: Geraetesuche): { frage: string; antwort: string; icon: 'plug' | 'wifi' | 'cpu' | 'search' }[] {
  const netze = s.netze.filter((n) => n.erreichbar).map((n) => n.netz);
  const fragen: { frage: string; antwort: string; icon: 'plug' | 'wifi' | 'cpu' | 'search' }[] = [
    { frage: 'Gerät aus?', antwort: 'Manche Datenlogger schlafen nachts, wenn keine Sonne scheint.', icon: 'plug' },
    {
      frage: 'Anderes Netz?',
      antwort: netze.length
        ? `Gesucht wurde in ${netze.join(' und ')}. Hängt das Gerät in einem anderen Netz, findet die Box es nicht.`
        : 'Ihre Box hat kein Netz gemeldet, in dem sie suchen konnte.',
      icon: 'wifi',
    },
    {
      frage: 'Schnittstelle aus?',
      antwort: 'SMA, Fronius, KOSTAL, Huawei: Modbus TCP am Gerät einschalten. go-e: HTTP API v2 in der App einschalten.',
      icon: 'cpu',
    },
  ];
  const fehlend = nichtGesucht(s);
  if (fehlend.length > 0) {
    fragen.push({ frage: 'Nicht gesucht?', antwort: `Diese Box sucht noch nicht nach: ${fehlend.join(', ')}.`, icon: 'search' });
  }
  return fragen;
}

const ERKENNER_NAME: Partial<Record<(typeof GERAETESUCHE_ERKENNER)[number], string>> = {
  solarman: 'Deye/Solarman', shelly: 'Shelly', goe: 'go-e', sunspec: 'SunSpec', fronius_solar_api: 'Fronius',
  kaco_aiswei: 'KACO/AISWEI', kostal: 'KOSTAL', huawei: 'Huawei', sma: 'SMA', victron: 'Victron',
  opendtu_ahoy: 'OpenDTU/AhoyDTU', ebyte: 'eByte', wago: 'WAGO',
};

/** Hersteller, nach denen die Box NICHT gesucht hat („nicht gesucht", nie „nichts da"); leer ohne Ergebnis. */
export function nichtGesucht(s: Geraetesuche): string[] {
  if (s.erkenner === null) return [];
  const lief = new Set(s.erkenner);
  return (Object.keys(ERKENNER_NAME) as (keyof typeof ERKENNER_NAME)[])
    .filter((e) => !lief.has(e))
    .map((e) => ERKENNER_NAME[e] as string);
}

// ─────────────────────────────────────────────────────────────────────── Zeit und Person

const ZONE = 'Europe/Berlin';
const tagSchluessel = (d: Date) => new Intl.DateTimeFormat('de-DE', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

/** „09:12" in der Zone des Portals. */
export function uhrzeit(iso: string): string {
  return new Intl.DateTimeFormat('de-DE', { timeZone: ZONE, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

/** „Heute, 09:12", „Gestern, 16:40", „28.10., 11:03". */
export function wann(iso: string, jetzt: Date): string {
  const d = new Date(iso);
  const gestern = new Date(jetzt.getTime() - 86_400_000);
  if (tagSchluessel(d) === tagSchluessel(jetzt)) return `Heute, ${uhrzeit(iso)}`;
  if (tagSchluessel(d) === tagSchluessel(gestern)) return `Gestern, ${uhrzeit(iso)}`;
  const tag = new Intl.DateTimeFormat('de-DE', { timeZone: ZONE, day: '2-digit', month: '2-digit' }).format(d);
  return `${tag}, ${uhrzeit(iso)}`;
}

/** „Sie" für die eigene Person, sonst der Name mit der Art der Unterstützung („Anna Weber (VoltPilot-Service)"). */
export function wer(u: GeraetesucheUrheber, ichName: string | null): string {
  const name = u.name?.trim() || 'Unbekannt';
  if (ichName && name === ichName.trim()) return 'Sie';
  const art = u.art === 'voltpilot' ? 'VoltPilot-Service' : u.art === 'unterstuetzung' ? 'Unterstützung' : u.art === 'notfall' ? 'Notfallzugang' : null;
  return art ? `${name} (${art})` : name;
}

/** „38 s", „1 min 12 s"; null = die Box hat keine Dauer gemeldet. */
export function dauerText(ms: number | null): string | null {
  if (ms === null) return null;
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

// ─────────────────────────────────────────────────────────────────────── Zustände

export type Ton = 'info' | 'warn' | 'fehler';

/** Der eine Satz zu einer beendeten Suche, die nicht `fertig` ist; null bei `fertig` und solange sie läuft. */
export function endHinweis(s: Geraetesuche): { ton: Ton; satz: string } | null {
  const mitFunden = energieFunde(s) > 0 ? ' Was bis dahin gefunden war, steht unten.' : '';
  switch (s.zustand) {
    case 'abgebrochen':
      if (s.grund === 'neustart') return { ton: 'warn', satz: `Ihre Box hat während der Suche neu gestartet.${mitFunden}` };
      if (s.grund === 'zeitlimit') return { ton: 'info', satz: `Die Suche hat nach 3 Minuten aufgehört.${mitFunden}` };
      return { ton: 'info', satz: `Die Suche wurde abgebrochen.${mitFunden}` };
    case 'abgelehnt':
      return { ton: 'warn', satz: ABGELEHNT[s.grund ?? ''] ?? 'Ihre Box hat die Suche nicht begonnen.' };
    case 'fehlgeschlagen':
      return { ton: 'fehler', satz: 'Die Suche ist auf Ihrer Box fehlgeschlagen. Bitte suchen Sie erneut; tritt es wieder auf, hilft der VoltPilot-Service.' };
    case 'keine_antwort':
      return { ton: 'warn', satz: `Ihre Box hat die Suche nicht zu Ende gemeldet.${mitFunden}` };
    default:
      return null;
  }
}

const ABGELEHNT: Record<string, string> = {
  laeuft_schon: 'Auf dieser Box läuft schon eine Suche.',
  zu_oft: 'Bitte einen Moment warten. Je Box sind 6 Suchen pro Stunde möglich.',
  abgelaufen: 'Der Auftrag kam zu spät bei Ihrer Box an. Bitte suchen Sie erneut.',
  lan_host_fehlt:
    'Ihre Box weiß nicht, in welchem Heimnetz sie steht. Bei einer Box auf einem eigenen Rechner muss bei der Einrichtung seine Adresse im Heimnetz eingetragen sein – fragen Sie Ihren Installateur.',
  kein_privates_netz: 'Ihre Box hängt in keinem privaten Heimnetz – dort sucht sie aus Sicherheitsgründen nicht.',
};

/** Der Satz zu einer Ablehnung beim Starten (Körper der 409/429); `laeuft_schon` öffnet stattdessen die laufende. */
export function startFehlerSatz(f: GeraetesucheFehler | null, zuletzt: string | null = null): string {
  switch (f?.code) {
    case 'box_offline':
      return boxOfflineSatz(f.zuletztGesehen ?? zuletzt);
    case 'nicht_unterstuetzt':
      return 'Update nötig für: Gerätesuche';
    case 'zu_oft':
      return `${ABGELEHNT.zu_oft}${f.wiederAb ? ` Ab ${uhrzeit(f.wiederAb)} geht es wieder.` : ''}`;
    case 'laeuft_schon':
      return ABGELEHNT.laeuft_schon;
    case 'nicht_gefunden':
      return 'Diese Box gehört nicht (mehr) zu dieser Anlage.';
    default:
      return f?.message?.trim() || 'Die Suche ließ sich nicht starten. Bitte versuchen Sie es erneut.';
  }
}

export function boxOfflineSatz(zuletzt: string | null): string {
  const wannZuletzt = zuletzt ? ` (zuletzt ${uhrzeit(zuletzt)})` : '';
  return `Ihre Box meldet sich gerade nicht${wannZuletzt}. Gesucht wird auf der Box selbst – sobald sie wieder verbunden ist, geht es.`;
}

// ─────────────────────────────────────────────────────────────────────── Der Knopf

export type KnopfLage =
  | { art: 'bereit' }
  | { art: 'offline'; satz: string }
  | { art: 'update'; satz: string }
  | { art: 'laeuft'; satz: string; suchId: string };

/**
 * Warum „Geräte suchen" gerade nicht geht - der Knopf erklärt es, statt zu verschwinden (m8). Eine laufende Suche
 * lässt sich mitansehen; eine Box ohne Herzschlag seit 5 min ist offline; eine Box, deren Fähigkeiten bekannt sind
 * und `geraetesuche` nicht tragen, braucht ein Update. Unbekannte Fähigkeiten (`null`) sperren nicht: dann urteilt der
 * Server (409 `nicht_unterstuetzt`).
 */
export function knopfLage(input: {
  lastSeenAt: string | null | undefined;
  /** Die gemeldeten Fähigkeiten der Box; null = unbekannt. */
  faehigkeiten: readonly string[] | null;
  laufend: GeraetesucheVerlaufEintrag | null;
  ichName: string | null;
  jetzt: number;
}): KnopfLage {
  const { laufend, jetzt } = input;
  if (laufend && laeuftNoch(laufend.zustand)) {
    const seit = Math.max(0, Math.round((jetzt - new Date(laufend.gestartetAm).getTime()) / 1000));
    const seitText = seit < 60 ? `seit ${seit} s` : `seit ${Math.floor(seit / 60)} min`;
    return { art: 'laeuft', satz: `Suche läuft · ${seitText} · gestartet von ${wer(laufend.gestartetVon, input.ichName)}`, suchId: laufend.suchId };
  }
  const gesehen = input.lastSeenAt ? new Date(input.lastSeenAt).getTime() : NaN;
  if (!Number.isFinite(gesehen) || jetzt - gesehen > BOX_OFFLINE_NACH_MS) {
    return { art: 'offline', satz: boxOfflineSatz(Number.isFinite(gesehen) ? (input.lastSeenAt as string) : null) };
  }
  if (input.faehigkeiten !== null && !input.faehigkeiten.includes('geraetesuche')) {
    return { art: 'update', satz: 'Update nötig für: Gerätesuche' };
  }
  return { art: 'bereit' };
}

// ─────────────────────────────────────────────────────────────────────── Verlauf

/** Ergebnis einer Suche in einem Wort für die Zeile „Letzte Suchen" (m10). */
export function verlaufErgebnis(e: GeraetesucheVerlaufEintrag): string {
  switch (e.zustand) {
    case 'wartet':
    case 'laeuft':
      return 'läuft';
    case 'abgebrochen':
      return 'abgebrochen';
    case 'abgelehnt':
      return 'nicht begonnen';
    case 'fehlgeschlagen':
      return 'fehlgeschlagen';
    case 'keine_antwort':
      return 'nicht zu Ende gemeldet';
    default: {
      const z = e.zaehler;
      if (z.bereit > 0) return zahl(z.bereit, 'neues Gerät', 'neue Geräte');
      if (z.braucht_hilfe > 0) return zahl(z.braucht_hilfe, 'Hinweis', 'Hinweise');
      const energie = z.nicht_anbindbar + z.vielleicht + z.schon_eingerichtet;
      return energie > 0 ? 'nichts Neues' : 'keine Energie-Geräte';
    }
  }
}

export function verlaufZeile(
  e: GeraetesucheVerlaufEintrag,
  ichName: string | null,
  jetzt: Date,
): { titel: string; zeile: string; rechts: string } {
  return {
    titel: wann(e.gestartetAm, jetzt),
    zeile: `${wer(e.gestartetVon, ichName)} · ${verlaufErgebnis(e)}`,
    rechts: dauerText(e.dauerMs) ?? (laeuftNoch(e.zustand) ? 'läuft' : '–'),
  };
}

/** „Letzte Suche heute 09:12 · 2 Energie-Geräte, 1 davon noch nicht übernommen" für die Box-Karte (d1). */
export function letzteSucheSatz(e: GeraetesucheVerlaufEintrag, jetzt: Date): string {
  const z = e.zaehler;
  const energie = z.braucht_hilfe + z.bereit + z.nicht_anbindbar + z.vielleicht + z.schon_eingerichtet;
  const was = laeuftNoch(e.zustand) || e.zustand !== 'fertig'
    ? verlaufErgebnis(e)
    : energie === 0
      ? 'keine Energie-Geräte'
      : `${zahl(energie, 'Energie-Gerät', 'Energie-Geräte')}${z.bereit > 0 ? `, ${z.bereit} davon noch nicht übernommen` : ''}`;
  return `Letzte Suche ${wann(e.gestartetAm, jetzt).replace(/^Heute/, 'heute').replace(/^Gestern/, 'gestern').replace(', ', ' ')} · ${was}`;
}

// ─────────────────────────────────────────────────────────────────────── OCPP „klopft an"

/** „192.168.178.80 · 5 Versuche · zuletzt 09:10" - Kennung bleibt die Überschrift. */
export function klopftAnZeile(l: GeraetesucheLadesaeuleKlopftAn, jetzt: Date): string {
  return [l.ip, zahl(l.versuche, 'Versuch', 'Versuche'), `zuletzt ${wann(l.zuletzt, jetzt).replace(/^Heute, /, '')}`]
    .filter((t): t is string => Boolean(t))
    .join(' · ');
}

