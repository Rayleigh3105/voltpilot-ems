import type { Device, EdgeVersion, ProbeAntwort, UemsDatenquellePruefergebnis } from './api';

/**
 * AP-05 IP-10: reine Regeln des Assistenten „WAGO-Steuerung anbinden“.
 *
 * `wago_registerbild` ist bereits das Vertragswort der WAGO-Quellenart. Die
 * Aktivierung darf genau dieses Wort erst dann in `capabilities` melden, wenn
 * der ruhende Box-Leser ausgeliefert ist. Bis dahin ist diese eine Bedingung
 * für jede Box falsch; der Portal-Bau bleibt erreichbar testbar, aber kein
 * Kunde kann ihn öffnen.
 */
export const WAGO_BOX_FAehIGKEIT = 'wago_registerbild';
export const WAGO_VORLAGE = 'certified:wago:pm494_pm495_registerbild_v1';

export function wagoAssistentSichtbar(
  geraete: readonly Device[],
  versionen: readonly EdgeVersion[],
  siteId: string,
): boolean {
  const boxen = new Set(geraete.filter((g) => g.kind === 'edge' && g.siteId === siteId).map((g) => g.id));
  return versionen.some((v) => boxen.has(v.deviceId) && v.capabilities?.includes(WAGO_BOX_FAehIGKEIT));
}

export const WAGO_BOGEN_GRUPPEN = [
  {
    code: 'A', titel: 'Die Steuerung', fragen: [
      ['A1', 'Welche Steuerung trägt die Energiekarten?'],
      ['A2', 'Welcher Firmware-Stand läuft?'],
      ['A3', 'Läuft auf der Steuerung ein Programm?'],
      ['A4', 'Gibt das Programm heute Werte per Modbus TCP heraus?'],
      ['A5', 'Gehen die Messwerte heute noch auf einem anderen Weg nach außen?'],
    ],
  },
  {
    code: 'B', titel: 'Die Energiekarten', fragen: [
      ['B1', 'Welche Klemmen stecken rechts neben der Steuerung?'],
      ['B2', 'Welche Positionen sind Energiekarten, welcher Typ, und was misst jede?'],
      ['B3', 'Welcher Stromwandler hängt an jeder Karte?'],
      ['B4', 'Rechnet die Karte selbst mit dem Wandler um?'],
      ['B5', 'Wurde Energie-Auflösung oder Anschlussart umgestellt?'],
    ],
  },
  {
    code: 'C', titel: 'Zählerstände und Verhalten', fragen: [
      ['C1', 'Wo werden heute Zählerstände geführt?'],
      ['C2', 'Was passierte beim letzten Stromausfall oder Neustart?'],
      ['C3', 'Kann jemand die Zähler zurücksetzen?'],
      ['C4', 'Gab es Netzwerkstörungen?'],
    ],
  },
  {
    code: 'D', titel: 'Netzwerk', fragen: [
      ['D1', 'Unter welcher Adresse ist die Steuerung erreichbar?'],
      ['D2', 'Hängt die VoltPilot-Box im selben Netz?'],
      ['D3', 'Wer liest die Steuerung sonst noch per Modbus TCP?'],
      ['D4', 'Ist der Modbus-Watchdog eingeschaltet?'],
    ],
  },
  {
    code: 'E', titel: 'Ansprechpartner, Unterlagen, Pilot', fragen: [
      ['E1', 'Wer betreut die Steuerung?'],
      ['E2', 'Welche Unterlagen liegen bei?'],
      ['E3', 'Wann ist ein Termin vor Ort möglich?'],
      ['E4', 'Soll VoltPilot noch andere Zähler lesen?'],
    ],
  },
] as const;

export type WagoFrage = typeof WAGO_BOGEN_GRUPPEN[number]['fragen'][number][0];
export type WagoAntworten = Record<WagoFrage, string>;

export const LEERE_WAGO_ANTWORTEN = Object.fromEntries(
  WAGO_BOGEN_GRUPPEN.flatMap((g) => g.fragen.map(([code]) => [code, ''])),
) as WagoAntworten;

export type WagoBogenErgebnis = 'belegt' | 'belegt_je_kunde' | 'nicht_unterstuetzt' | 'in_pruefung';

export interface WagoBogenUrteil {
  ergebnis: WagoBogenErgebnis;
  titel: string;
  satz: string;
  ausweg: string | null;
}

const enthaelt = (antworten: WagoAntworten, muster: RegExp) =>
  Object.values(antworten).some((wert) => muster.test(wert));

/** Die Regel aus `docs/wago/erhebungsbogen.md`, nicht eine Produktvermutung. */
export function wagoBogenAuswerten(antworten: WagoAntworten, hardwareblattBelegt = false): WagoBogenUrteil {
  if (enthaelt(antworten, /751-9301|752-8303|750-493|codesys\s*2\.3/i)
    || (enthaelt(antworten, /energiedatenmanagement/i) && !enthaelt(antworten, /registerliste/i))) {
    return {
      ergebnis: 'nicht_unterstuetzt',
      titel: 'Nicht unterstützt',
      satz: 'Diese Kombination ist nicht belegt.',
      ausweg: 'Lassen Sie das VoltPilot-Registerbild durch den Installateur einbauen oder verwenden Sie einen passenden Energiezähler.',
    };
  }
  if (hardwareblattBelegt) {
    return {
      ergebnis: 'belegt',
      titel: 'Belegt',
      satz: 'Für diese Kombination liegt ein im Pilot belegtes Hardwareblatt vor.',
      ausweg: null,
    };
  }
  if (enthaelt(antworten, /registerliste/i) || enthaelt(antworten, /750-8100|pfc\s*100/i)) {
    return {
      ergebnis: 'belegt_je_kunde',
      titel: 'Belegt je Kunde',
      satz: 'Die Registerliste wird für diese Anlage geprüft. Daraus folgt keine Zusage für andere Kunden.',
      ausweg: null,
    };
  }
  return {
    ergebnis: 'in_pruefung',
    titel: 'In Prüfung — Pilot ausstehend',
    satz: 'Die Vorlage ist noch nicht belegt. Unbekannte Angaben bleiben Prüfaufgaben.',
    ausweg: null,
  };
}

export type WagoKopfGrund = 'signatur_fremd' | 'hauptversion_fremd' | 'laenge_ungueltig' | 'wortfolge_abweichend';
export interface WagoKopf {
  signatur_ok: boolean;
  erkannt: boolean;
  grund?: WagoKopfGrund;
  hauptversion?: number;
  nebenversion?: number;
  kartenzahl?: number;
  herzschlag?: number;
  controller_kennung?: number;
}

function kopfAus(antwort: unknown): WagoKopf | null {
  const r = antwort as ProbeAntwort | null;
  const zeile = r?.results?.find((x) => (x as { wago_kopf?: unknown }).wago_kopf != null) as
    | ({ wago_kopf?: WagoKopf }) | undefined;
  return zeile?.wago_kopf ?? null;
}

export interface WagoKopfAnzeige {
  art: 'ok' | 'fehler' | 'offen';
  titel: string;
  details: string[];
  kopf: WagoKopf | null;
}

export function wagoKopfAnzeige(
  pruefung: UemsDatenquellePruefergebnis | null,
  vorherigerHerzschlag: number | null = null,
): WagoKopfAnzeige | null {
  if (!pruefung) return null;
  const kopf = kopfAus(pruefung.antwort);
  if (!kopf) {
    const texte: Record<string, string> = {
      unreachable: 'Steuerung nicht erreichbar',
      timeout: 'Die Steuerung hat nicht rechtzeitig geantwortet',
      not_supported: 'Diese Box kann den WAGO-Kopf noch nicht prüfen',
      box_meldet_sich_nicht: 'Die VoltPilot-Box meldet sich nicht',
    };
    return { art: 'fehler', titel: texte[pruefung.ergebnis] ?? pruefung.text, details: [], kopf: null };
  }
  if (!kopf.erkannt) {
    const grund: Record<WagoKopfGrund, string> = {
      signatur_fremd: 'Unter der Basisadresse steht kein VoltPilot-Registerbild.',
      hauptversion_fremd: `Registerbild-Version ${kopf.hauptversion ?? 'unbekannt'} ist fremd.`,
      laenge_ungueltig: 'Der Kopf meldet eine unzulässige Länge.',
      wortfolge_abweichend: 'Die Wortfolge passt nicht zur Angabe im Bogen.',
    };
    return {
      art: 'fehler',
      titel: 'Registerbild unbekannt',
      details: [kopf.grund ? grund[kopf.grund] : 'Der Kopf konnte nicht erkannt werden.'],
      kopf,
    };
  }
  const details: string[] = [];
  if (kopf.hauptversion != null) details.push(`Registerbild v${kopf.hauptversion}.${kopf.nebenversion ?? 0}`);
  if (kopf.kartenzahl != null) details.push(`${kopf.kartenzahl.toLocaleString('de-DE')} ${kopf.kartenzahl === 1 ? 'Energiekarte' : 'Energiekarten'}`);
  if (kopf.herzschlag != null) {
    details.push(vorherigerHerzschlag == null
      ? `Herzschlag ${kopf.herzschlag.toLocaleString('de-DE')} — für den Vergleich erneut prüfen`
      : vorherigerHerzschlag === kopf.herzschlag
        ? `Herzschlag steht bei ${kopf.herzschlag.toLocaleString('de-DE')}`
        : `Herzschlag läuft: ${vorherigerHerzschlag.toLocaleString('de-DE')} → ${kopf.herzschlag.toLocaleString('de-DE')}`);
  }
  return { art: 'ok', titel: 'Kopf erkannt', details, kopf };
}

export interface WagoKarteEntwurf {
  id: string;
  steckplatz: string;
  typ: '750-494' | '750-495';
  name: string;
  wandlerPrimaer: string;
  wandlerSekundaer: string;
  wandlerAnwendung: 'dokumentiert' | 'angewendet';
  anwenderskalierung: '' | 'ja' | 'nein';
  register35: string;
}

export function neueWagoKarte(nummer: number): WagoKarteEntwurf {
  return {
    id: `karte-${nummer}`,
    steckplatz: String(nummer),
    typ: '750-494',
    name: `Energiekarte ${nummer}`,
    wandlerPrimaer: '',
    wandlerSekundaer: '',
    wandlerAnwendung: 'dokumentiert',
    anwenderskalierung: '',
    register35: '',
  };
}

export function wagoBogenSpeicher(siteId: string): string {
  return `vp.uems.wago-assistent.${siteId}.v1`;
}

export function bogenLesen(speicher: Pick<Storage, 'getItem'> | null, siteId: string): WagoAntworten {
  try {
    const roh = speicher?.getItem(wagoBogenSpeicher(siteId));
    if (!roh) return { ...LEERE_WAGO_ANTWORTEN };
    const gelesen = JSON.parse(roh) as Partial<WagoAntworten>;
    return Object.fromEntries(Object.keys(LEERE_WAGO_ANTWORTEN).map((k) =>
      [k, typeof gelesen[k as WagoFrage] === 'string' ? gelesen[k as WagoFrage] : ''])) as WagoAntworten;
  } catch {
    return { ...LEERE_WAGO_ANTWORTEN };
  }
}

export function bogenSpeichern(speicher: Pick<Storage, 'setItem'> | null, siteId: string, antworten: WagoAntworten): boolean {
  try {
    speicher?.setItem(wagoBogenSpeicher(siteId), JSON.stringify(antworten));
    return speicher != null;
  } catch {
    return false;
  }
}
