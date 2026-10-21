import type {
  AnlagensteuerungAnlegen,
  DirektvermarkterKanal,
  Einspeisemanagement,
  ErzeugungseinheitArt,
  NetzVermarktung,
  ProbeAntwort,
  UemsDatenquellePruefergebnis,
} from './api';
import { SEE_MUSTER } from './anlagensteuerung';
import type { UeberwachungAnlegenEingabe } from './ueberwachungApi';
import { vorlageSatz } from './ueberwachungSatz';
import { WERTE_KATALOG, type WerteKatalogVorlage } from './werteKatalog';
import { zahl } from './zahl';

/**
 * UEMS EZ-15 „Anlege-Schritt Steuerung verbinden“ (Konzept „Erzeuger am Wago-Modbus-Server“ §4.11, EW-14 A):
 * reine Regeln des Assistenten „Anlagensteuerung verbinden“. Die Box liest den Kopf des VoltPilot-Registerbilds
 * Erzeuger v1 über die Probe `erzeuger_kopf` (Vertrag `docs/contracts/mqtt-probe.schema.json`); hier wird nur
 * gedeutet, was sie gelesen hat - Lücke statt Null, nie ein geratener Wert.
 *
 * Die Feldnamen sind die der schlanken Fassung (§3.7): Kopf 0-11 mit `te_anzahl`, `herzschlag` (+1 je s),
 * `programmstand` (JJMM), `steuerung_id`, `anlagenart` (1 PV · 2 BHKW · 3 gemischt), `beschreibung_ab`; je
 * Einheit `t_art` (1 PV-Wechselrichter · 2 BHKW-Motor) und `t_nenn_kw`; Namen ab Register 140 (§3.10).
 */

/** Das Fähigkeitswort, das eine Box für das Erzeuger-Bild meldet (EZ-5). */
export const ERZEUGER_BOX_FAEHIGKEIT = 'erzeuger_registerbild';

/** Wie lange der Assistent zwischen den zwei Lesungen des Herzschlags wartet (er zählt +1 je Sekunde). */
export const HERZSCHLAG_ABSTAND_MS = 1500;

export type ErzeugerKopfGrund =
  | 'zu_wenig_woerter'
  | 'signatur_fremd'
  | 'version_fremd'
  | 'wortfolge_falsch'
  | 'te_anzahl_ungueltig';

export interface ErzeugerKopfEinheit {
  einheit: number;
  art?: 1 | 2;
  nenn_kw?: number;
  typ_name?: string;
}

/** Der Block `erzeuger_kopf` einer Probe-Antwort, so wie die Box ihn gelesen hat. */
export interface ErzeugerKopf {
  signatur_ok: boolean;
  erkannt: boolean;
  grund?: ErzeugerKopfGrund;
  hauptversion?: number;
  nebenversion?: number;
  te_anzahl?: number;
  herzschlag?: number;
  programmstand?: number;
  steuerung_id?: number;
  anlagenart?: number;
  beschreibung_ab?: number;
  einheiten?: ErzeugerKopfEinheit[];
  netzbetreiber_name?: string;
  direktvermarkter_name?: string;
}

/** Der gelesene Kopf aus der rohen Antwort der Prüfung - oder null, wenn die Box keinen gelesen hat. */
export function erzeugerKopfAus(pruefung: UemsDatenquellePruefergebnis | null): ErzeugerKopf | null {
  const r = pruefung?.antwort as ProbeAntwort | null | undefined;
  const zeile = r?.results?.find((x) => (x as { erzeuger_kopf?: unknown }).erzeuger_kopf != null) as
    | { erzeuger_kopf?: ErzeugerKopf } | undefined;
  const kopf = zeile?.erzeuger_kopf;
  return kopf && typeof kopf.signatur_ok === 'boolean' && typeof kopf.erkannt === 'boolean' ? kopf : null;
}

export type AnlagenartWort = 'pv' | 'bhkw' | 'gemischt';

export const ANLAGENART_TEXT: Record<AnlagenartWort, string> = {
  pv: 'PV',
  bhkw: 'BHKW',
  gemischt: 'gemischt (PV und BHKW)',
};

/** `anlagenart` des Kopfs als Wort der Cloud; ein anderer Wert ist unbekannt, nie geraten. */
export function anlagenartAus(wert: number | undefined): AnlagenartWort | null {
  return wert === 1 ? 'pv' : wert === 2 ? 'bhkw' : wert === 3 ? 'gemischt' : null;
}

/** Die Kennung der Steuerung, wie VoltPilot sie vergibt: acht Hex-Stellen („0000A1B2“). */
export function steuerungKennungText(id: number): string {
  return id.toString(16).toUpperCase().padStart(8, '0');
}

/** Wie weit der Herzschlag zwischen zwei Lesungen gelaufen ist - mit Überlauf 65535 → 0. */
export function herzschlagSchritt(vorher: number, nachher: number): number {
  return (nachher - vorher + 65536) % 65536;
}

export interface KopfUrteil {
  /** `erkannt` = weiter; `fehler` = mit Grund und Ausweg. */
  art: 'erkannt' | 'fehler';
  titel: string;
  /** Was das bedeutet und was jetzt zu tun ist; null beim erkannten Bild. */
  satz: string | null;
  /** Je gelesener Angabe eine Zeile. */
  details: string[];
  kopf: ErzeugerKopf | null;
}

const BOX_UPDATE: KopfUrteil = {
  art: 'fehler',
  titel: 'Box-Update nötig',
  satz: 'Diese VoltPilot-Box liest das VoltPilot-Registerbild Erzeuger noch nicht. Nach dem nächsten Box-Update '
    + 'meldet sie die Fähigkeit; bis dahin lässt sich die Steuerung nicht anlegen.',
  details: [],
  kopf: null,
};

/** Das Urteil, bevor die Box gefragt wird: eine Box ohne Fähigkeitswort braucht erst ein Update. */
export function boxUpdateUrteil(): KopfUrteil {
  return BOX_UPDATE;
}

const GRUND_TITEL: Record<ErzeugerKopfGrund, string> = {
  signatur_fremd: 'Bild unbekannt: andere Signatur',
  version_fremd: 'Bild unbekannt: fremde Version',
  wortfolge_falsch: 'Wortfolge falsch',
  te_anzahl_ungueltig: 'Zahl der Einheiten ungültig',
  zu_wenig_woerter: 'Bild unvollständig',
};

function grundSatz(kopf: ErzeugerKopf): string {
  switch (kopf.grund) {
    case 'signatur_fremd':
      return 'Hier steht ein anderes Registerbild (zum Beispiel ein Energiekarten-Bild) oder die Basisadresse '
        + 'stimmt nicht. Prüfen Sie Basisadresse und Funktionscode.';
    case 'version_fremd':
      return `Die Steuerung meldet Bildfassung ${kopf.hauptversion ?? 'unbekannt'}.${kopf.nebenversion ?? 0}; `
        + 'diese Box liest Fassung 1. Das SPS-Programm oder die Box muss passen.';
    case 'wortfolge_falsch':
      return 'Der Prüfwert im Kopf kommt in der anderen Wortfolge an. Stellen Sie die Wortfolge um und prüfen Sie erneut.';
    case 'te_anzahl_ungueltig':
      return 'Der Kopf nennt 0, mehr als 10 oder keine gültige Zahl von Einheiten. Das SPS-Programm muss sie setzen.';
    case 'zu_wenig_woerter':
      return 'Die Steuerung hat weniger Register geliefert, als das Bild braucht. Prüfen Sie Basisadresse und '
        + 'Funktionscode und ob das Programm alle Blöcke füllt.';
    default:
      return 'Der Kopf konnte nicht als VoltPilot-Registerbild Erzeuger gelesen werden.';
  }
}

/** Was die Box über die VERBINDUNG gesagt hat, wenn sie keinen Kopf gelesen hat. */
function verbindungsUrteil(pruefung: UemsDatenquellePruefergebnis): KopfUrteil {
  const texte: Record<string, [string, string]> = {
    unreachable: ['Steuerung nicht erreichbar',
      'Die Box erreicht die Adresse nicht. Prüfen Sie Adresse, Port und Netzlage (VLAN, Firewall).'],
    no_answer: ['Steuerung antwortet nicht', 'Die Steuerung nimmt die Verbindung an, beantwortet die Anfrage aber '
      + 'nicht. Prüfen Sie Unit-ID und ob der Modbus-Server läuft.'],
    timeout: ['Keine Antwort in der Zeit', 'Die Steuerung hat nicht rechtzeitig geantwortet. Bitte erneut prüfen.'],
    invalid_response: ['Antwort nicht lesbar', 'Die Steuerung hat geantwortet, aber nicht lesbar. Prüfen Sie '
      + 'Unit-ID, Basisadresse und Funktionscode.'],
    box_meldet_sich_nicht: ['Die VoltPilot-Box meldet sich nicht',
      'Die Box hat nicht geantwortet. Ist sie eingeschaltet und mit dem Internet verbunden?'],
  };
  if (pruefung.ergebnis === 'not_supported') return BOX_UPDATE;
  const [titel, satz] = texte[pruefung.ergebnis] ?? ['Prüfung nicht möglich', pruefung.text];
  return { art: 'fehler', titel, satz, details: [], kopf: null };
}

/**
 * Das Urteil über zwei Lesungen des Kopfs. Weiter geht es nur bei „Bild erkannt“: Signatur, Version und
 * Wortfolge stimmen (das prüft die Box), die Zahl der Einheiten ist gültig und der Herzschlag LÄUFT zwischen
 * den beiden Lesungen. Ohne zweite Lesung oder mit stehendem Herzschlag ist es ein Fehler mit Grund.
 */
export function kopfUrteil(
  erste: UemsDatenquellePruefergebnis | null,
  zweite: UemsDatenquellePruefergebnis | null,
): KopfUrteil | null {
  const letzte = zweite ?? erste;
  if (!letzte) return null;
  const kopf = erzeugerKopfAus(letzte);
  if (!kopf) return verbindungsUrteil(letzte);
  if (!kopf.erkannt) {
    return {
      art: 'fehler',
      titel: kopf.grund ? GRUND_TITEL[kopf.grund] : 'Bild nicht erkannt',
      satz: grundSatz(kopf),
      details: [],
      kopf,
    };
  }
  const details: string[] = [];
  const art = anlagenartAus(kopf.anlagenart);
  details.push(
    `VoltPilot-Registerbild Erzeuger ${kopf.hauptversion ?? 1}.${kopf.nebenversion ?? 0}`
      + (kopf.programmstand != null ? ` · Programm ${kopf.programmstand}` : ' · Programmstand nicht gelesen')
      + ` · Anlagenart ${art ? ANLAGENART_TEXT[art] : 'nicht gemeldet'}`,
  );
  const anzahl = kopf.te_anzahl;
  const einheitenText = anzahl == null ? 'Zahl der Einheiten nicht gelesen' : anzahl === 1 ? '1 Einheit' : `${anzahl} Einheiten`;
  const vorher = erzeugerKopfAus(erste)?.herzschlag;
  const nachher = kopf.herzschlag;
  let herzschlag: string;
  let laeuft = false;
  if (zweite == null || vorher == null || nachher == null) {
    herzschlag = 'Herzschlag nur einmal gelesen';
  } else {
    const schritt = herzschlagSchritt(vorher, nachher);
    laeuft = schritt > 0;
    herzschlag = laeuft ? `Herzschlag läuft (2 Lesungen, +${schritt})` : `Herzschlag steht bei ${nachher}`;
  }
  details.push(`${einheitenText} · ${herzschlag} · Wortfolge stimmt`);
  if (kopf.steuerung_id != null) {
    details.push(`Kennung der Steuerung ${steuerungKennungText(kopf.steuerung_id)} (vom Programm gesetzt)`);
  }
  if (anzahl == null || anzahl < 1 || anzahl > 10) {
    return { art: 'fehler', titel: GRUND_TITEL.te_anzahl_ungueltig, satz: grundSatz({ ...kopf, grund: 'te_anzahl_ungueltig' }), details, kopf };
  }
  if (!laeuft) {
    return {
      art: 'fehler',
      titel: zweite == null ? 'Herzschlag nicht geprüft' : 'Herzschlag steht',
      satz: zweite == null
        ? 'Der Herzschlag braucht zwei Lesungen. Bitte erneut prüfen.'
        : 'Die Steuerung antwortet, aber ihr Herzschlag (Register 6) zählt nicht weiter. Läuft das SPS-Programm? '
          + 'Der Baustein muss ihn jede Sekunde um 1 erhöhen, sonst gelten alle Werte als veraltet.',
      details,
      kopf,
    };
  }
  return { art: 'erkannt', titel: 'Bild erkannt', satz: null, details, kopf };
}

// ------------------------------------------------------------------ Einheiten

export type EinheitArtWort = ErzeugungseinheitArt;

export interface EinheitEntwurf {
  teNr: number;
  art: EinheitArtWort | null;
  /** Kam die Art aus dem Bild? Dann steht sie fest. */
  artAusBild: boolean;
  bezeichnung: string;
  typ: string;
  /** Der Typ, wie das Bild ihn nennt; null = das Bild nennt keinen. */
  typBild: string | null;
  nennKw: string;
  nennAusBild: boolean;
  /** MaStR-Nummer der Einheit (SEE + 12 Ziffern); leer = noch nicht bekannt. */
  see: string;
}

function einheitArtAus(art: number | undefined): EinheitArtWort | null {
  return art === 1 ? 'pv_wechselrichter' : art === 2 ? 'bhkw_motor' : null;
}

/** Die vorgeschlagene Anzeige einer Einheit: „Motor 1“, „Wechselrichter 2“, sonst „Einheit 3“. */
export function einheitName(teNr: number, art: EinheitArtWort | null): string {
  return art === 'bhkw_motor' ? `Motor ${teNr}` : art === 'pv_wechselrichter' ? `Wechselrichter ${teNr}` : `Einheit ${teNr}`;
}

/**
 * Je Einheit des Bilds ein Entwurf, vorbelegt aus dem Namen-Block (Typ) und den Einheiten-Blöcken (Art,
 * Nennleistung). Was das Bild nicht nennt, bleibt leer - nie geraten.
 */
export function einheitenAusKopf(kopf: ErzeugerKopf): EinheitEntwurf[] {
  const anzahl = Math.max(0, Math.min(10, kopf.te_anzahl ?? 0));
  return Array.from({ length: anzahl }, (_, i) => {
    const teNr = i + 1;
    const gelesen = kopf.einheiten?.find((e) => e.einheit === teNr);
    const art = einheitArtAus(gelesen?.art);
    const typ = gelesen?.typ_name?.trim() ? gelesen.typ_name.trim() : null;
    return {
      teNr,
      art,
      artAusBild: art != null,
      bezeichnung: einheitName(teNr, art),
      typ: typ ?? '',
      typBild: typ,
      nennKw: gelesen?.nenn_kw != null ? String(gelesen.nenn_kw) : '',
      nennAusBild: gelesen?.nenn_kw != null,
      see: '',
    };
  });
}

/** Die Fehler der Einheiten in Kundensprache - leer, wenn alles passt. */
export function einheitenFehler(einheiten: readonly EinheitEntwurf[]): string[] {
  const fehler: string[] = [];
  for (const e of einheiten) {
    if (!e.bezeichnung.trim()) fehler.push(`Einheit ${e.teNr}: Geben Sie ihr einen Namen.`);
    if (!e.art) fehler.push(`Einheit ${e.teNr}: Wählen Sie die Art.`);
    if (e.nennKw.trim()) {
      const kw = zahl(e.nennKw);
      if (kw == null || kw <= 0) fehler.push(`Einheit ${e.teNr}: Die Nennleistung ist keine Zahl größer 0.`);
    }
  }
  return fehler;
}

// ---------------------------------------------------------- Netz und Vermarktung

export interface RseStufeEntwurf {
  stufe: number;
  prozent: string;
}

/** Die übliche Belegung der vier Rundsteuer-Stufen: 100 · 60 · 30 · 0 % - nur ein Vorschlag zum Eintragen. */
export const RSE_VORSCHLAG: readonly RseStufeEntwurf[] = [
  { stufe: 1, prozent: '100' },
  { stufe: 2, prozent: '60' },
  { stufe: 3, prozent: '30' },
  { stufe: 4, prozent: '0' },
];

export interface NetzEntwurf {
  direktvermarkter: string;
  kanal: DirektvermarkterKanal | '';
  einspeisemanagement: Einspeisemanagement | '';
  prozent: string;
  stufen: RseStufeEntwurf[];
  /** Steht an der Anlage schon ein Eintrag? Dann belegt der Schritt nichts neu - er zeigt ihn. */
  gepflegt: boolean;
}

/**
 * Netz und Vermarktung vorbelegt: was an der Anlage schon gepflegt ist, bleibt (der Schritt belegt nur Leeres,
 * EZ-6 „Vorbelegung, nie Überschreiben“); sonst der Direktvermarkter aus dem Bild. Ein gelesener leerer Name heißt
 * „keiner“ - ohne Direktvermarkter gibt es auch kein Signal an die Steuerung (Weg `keiner`).
 */
export function netzAusKopf(kopf: ErzeugerKopf | null, gespeichert: NetzVermarktung | null): NetzEntwurf {
  const dvBild = kopf?.direktvermarkter_name;
  const gepflegt = !!gespeichert && (gespeichert.direktvermarkter != null || gespeichert.direktvermarkter_kanal != null
    || gespeichert.einspeisemanagement != null);
  return {
    direktvermarkter: gespeichert?.direktvermarkter ?? dvBild ?? '',
    kanal: gespeichert?.direktvermarkter_kanal ?? (dvBild === '' ? 'keiner' : ''),
    einspeisemanagement: gespeichert?.einspeisemanagement ?? '',
    prozent: gespeichert?.einspeisemanagement_prozent != null ? String(gespeichert.einspeisemanagement_prozent) : '',
    stufen: RSE_VORSCHLAG.map((s) => ({ ...s })),
    gepflegt,
  };
}

function normal(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Der Netzbetreiber steht am Netzanschluss; das Bild nennt ihn nur. Eine Abweichung ist ein Hinweis, keine
 * Schreibung - dieselbe Regel wie `AnlagensteuerungService.hinweise` (ohne Groß-/Kleinschreibung und Leerraum).
 */
export function netzbetreiberHinweis(bild: string | null | undefined, eintrag: string | null | undefined): string | null {
  if (!bild || !bild.trim()) return null;
  if (!eintrag || !eintrag.trim()) {
    return `Die Steuerung nennt den Netzbetreiber „${bild.trim()}“; am Netzanschluss ist keiner eingetragen. `
      + 'Tragen Sie ihn dort ein - hier wird nichts überschrieben.';
  }
  if (normal(bild) === normal(eintrag)) return null;
  return `Die Steuerung nennt „${bild.trim()}“, am Netzanschluss steht „${eintrag.trim()}“. Bitte klären - `
    + 'hier wird nichts überschrieben.';
}

/** Die Fehler von Netz und Vermarktung - leer, wenn alles passt. Ein gepflegter Eintrag wird nicht geprüft. */
export function netzFehler(netz: NetzEntwurf, einheiten: readonly EinheitEntwurf[]): string[] {
  const fehler: string[] = [];
  if (!netz.gepflegt) {
    if (netz.einspeisemanagement === 'statisch') {
      const p = zahl(netz.prozent);
      if (netz.prozent.trim() && (p == null || p < 0 || p > 100)) fehler.push('Die feste Grenze liegt zwischen 0 und 100 %.');
    }
    if (netz.einspeisemanagement === 'stufen') {
      for (const s of netz.stufen) {
        const p = zahl(s.prozent);
        if (s.prozent.trim() && (p == null || p < 0 || p > 100)) fehler.push(`Stufe ${s.stufe}: zwischen 0 und 100 %.`);
      }
    }
  }
  for (const e of einheiten) {
    if (e.see.trim() && !SEE_MUSTER.test(e.see.trim().toUpperCase())) {
      fehler.push(`Einheit ${e.teNr}: Die MaStR-Nummer hat die Form SEE und 12 Ziffern.`);
    }
  }
  return fehler;
}

// ----------------------------------------------------------------- Anfragen

export interface Anschluss {
  host: string;
  port: string;
  netz: string;
  unitId: string;
  basisadresse: string;
  funktionscode: '3' | '4';
  wortfolge: 'big' | 'little';
  boxId: string;
}

/** Die Vorgabe des Bilds: Port 502, Eingangsregister (FC4) ab 0, höherwertiges Wort zuerst (EW-2 A). */
export const START_ANSCHLUSS: Anschluss = {
  host: '', port: '502', netz: '', unitId: '1', basisadresse: '0', funktionscode: '4', wortfolge: 'big', boxId: '',
};

/** Der erste Fehler der Anschlussangaben in Kundensprache - oder null. */
export function anschlussFehler(a: Anschluss): string | null {
  if (!a.host.trim()) return 'Geben Sie die Adresse der Steuerung ein.';
  if (!a.boxId) return 'Für diese Anlage ist keine VoltPilot-Box angemeldet. Fügen Sie zuerst im Aufbau eine Box hinzu.';
  for (const [wert, name, min, max] of [
    [a.port, 'Port', 1, 65535],
    [a.unitId, 'Unit-ID', 0, 255],
    [a.basisadresse, 'Basisadresse', 0, 65535],
  ] as const) {
    const n = Number(wert);
    if (!/^\d+$/.test(wert.trim()) || !Number.isInteger(n) || n < min || n > max) {
      return `${name} ist keine ganze Zahl von ${min} bis ${max}.`;
    }
  }
  return null;
}

/** Der Fingerabdruck der Datenquelle: ändert er sich, wird die Entwurfs-Quelle nachgezogen. */
export function quellenSchluessel(a: Anschluss): string {
  return [a.host.trim(), Number(a.port), Number(a.unitId), a.netz.trim()].join('|');
}

function leer(text: string): string | null {
  return text.trim() ? text.trim() : null;
}

function prozentZahl(text: string): number | null {
  return text.trim() ? zahl(text) : null;
}

/** Der Anfragekörper von `POST …/anlagensteuerungen` aus den vier Schritten. */
export function anlegenAnfrage(e: {
  dataSourceId: string;
  anschluss: Anschluss;
  kopf: ErzeugerKopf;
  anlagenart: AnlagenartWort;
  bezeichnung: string;
  hersteller: string;
  typ: string;
  einheiten: readonly EinheitEntwurf[];
  netz: NetzEntwurf;
}): AnlagensteuerungAnlegen {
  const { netz } = e;
  const stufen = !netz.gepflegt && netz.einspeisemanagement === 'stufen'
    ? netz.stufen.flatMap((s) => {
      const p = prozentZahl(s.prozent);
      return p == null ? [] : [{ stufe: s.stufe, prozent: p }];
    })
    : [];
  return {
    data_source_id: e.dataSourceId,
    unit_id: Number(e.anschluss.unitId),
    bezeichnung: leer(e.bezeichnung),
    hersteller: leer(e.hersteller),
    typ: leer(e.typ),
    basisadresse: Number(e.anschluss.basisadresse),
    funktionscode: e.anschluss.funktionscode === '3' ? 3 : 4,
    wortfolge: e.anschluss.wortfolge,
    anlagenart: e.anlagenart,
    steuerung_kennung: e.kopf.steuerung_id ?? null,
    rse_stufen: stufen.length > 0 ? stufen : null,
    einheiten: e.einheiten.map((x) => ({
      te_nr: x.teNr,
      einheit_art: x.art,
      bezeichnung: leer(x.bezeichnung),
      typ: leer(x.typ),
      typ_bild: x.typBild,
      nennleistung_kw: x.nennKw.trim() ? zahl(x.nennKw) : null,
      registry_unit_id: x.see.trim() ? x.see.trim().toUpperCase() : null,
    })),
    netz_vermarktung: netz.gepflegt ? null : {
      direktvermarkter: leer(netz.direktvermarkter),
      direktvermarkter_kanal: netz.kanal || null,
      einspeisemanagement: netz.einspeisemanagement || null,
      einspeisemanagement_prozent: netz.einspeisemanagement === 'statisch' ? prozentZahl(netz.prozent) : null,
    },
  };
}

/** Die Namen, die das Bild nennt (§3.10) - null, wenn es keine trägt (`beschreibung_ab` 0 oder nicht gelesen). */
export function namenAnfrage(kopf: ErzeugerKopf): {
  netzbetreiber: string | null; direktvermarkter: string | null; einheiten: { te_nr: number; typ: string | null }[];
} | null {
  const typen = (kopf.einheiten ?? []).filter((e) => e.typ_name != null);
  if (kopf.netzbetreiber_name == null && kopf.direktvermarkter_name == null && typen.length === 0) return null;
  return {
    netzbetreiber: kopf.netzbetreiber_name ?? null,
    direktvermarkter: kopf.direktvermarkter_name ?? null,
    einheiten: typen.map((e) => ({ te_nr: e.einheit, typ: e.typ_name ?? null })),
  };
}

// ------------------------------------------------------------- Alarm-Vorschlag

/**
 * Die Alarm-Vorlagen für Erzeugeranlagen (UEMS EZ-11/EZ-11b, Konzept §4.8): die Einträge des Werte-Katalogs mit
 * `vorlage` und `nur_mit_anlagensteuerung`. Kennung = Wertart; Dauer, Ziel-Zustand, Schwere und Schwellen sind die der
 * Vorlage, der Satz ist der des Blatts „Überwachen“ (`vorlageSatz`) - eine neue Vorlage im Katalog erscheint hier
 * ohne Änderung.
 */
export interface AlarmVorlage {
  wertart: string;
  name: string;
  vorlage: WerteKatalogVorlage;
  /** Die Bedingung in einem Satz, wie das Blatt „Überwachen“ sie spricht. */
  satz: string;
  /** Wann der Vorschlag ausgeschaltet beginnt - der Grund steht dabei. */
  ausWenn?: 'kein_dv' | 'keine_fernwirktechnik';
}

const AUS_WENN: Record<string, AlarmVorlage['ausWenn']> = {
  'erzeuger.fernsteuerung_nicht_bereit': 'kein_dv',
  'erzeuger.fernwirk_verbindung_weg': 'keine_fernwirktechnik',
};

export const ERZEUGER_ALARM_VORLAGEN: readonly AlarmVorlage[] = WERTE_KATALOG.flatMap((e) =>
  e.vorlage?.nur_mit_anlagensteuerung
    ? [{
      wertart: e.wertart,
      name: e.name,
      vorlage: e.vorlage,
      satz: vorlageSatz(e.wertart, e.vorlage.dauer_s, e.vorlage.schwellen ?? {}, e.vorlage.schwere),
      ausWenn: AUS_WENN[e.wertart],
    }]
    : []);

/** Ob eine Vorlage vorgeschlagen (an) ist - und warum nicht. */
export function alarmVorschlag(v: AlarmVorlage, netz: NetzEntwurf): { an: boolean; grund: string | null } {
  if (v.ausWenn === 'kein_dv' && (netz.kanal === '' || netz.kanal === 'keiner')) {
    return { an: false, grund: 'kein Direktvermarkter-Weg eingetragen' };
  }
  if (v.ausWenn === 'keine_fernwirktechnik' && netz.einspeisemanagement !== 'fernwirk') {
    return { an: false, grund: 'kein Einspeisemanagement über Fernwirktechnik' };
  }
  return { an: true, grund: null };
}

/**
 * Die Regel einer Vorlage an der Anlage - dieselbe Bedingung wie im Blatt „Überwachen“, gemeldet an die Rolle
 * Kundenadministrator (dafür braucht es `ueberwachung.verwalten`).
 */
export function alarmAnfrage(v: AlarmVorlage, siteId: string): UeberwachungAnlegenEingabe {
  return {
    wertart: v.wertart,
    bezug: { anlage: siteId },
    bedingung: {
      art: 'zustand', ziel: [...v.vorlage.ziel], dauer_s: v.vorlage.dauer_s, erholen_s: v.vorlage.erholen_s,
      ...(v.vorlage.schwellen ?? {}),
    },
    schwere: v.vorlage.schwere,
    empfaenger: [{ rolle: 'kundenadministrator' }],
    name: v.name,
  };
}
