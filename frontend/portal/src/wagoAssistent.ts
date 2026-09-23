import type {
  Device, EdgeVersion, ProbeAntwort, UemsDatenquellePruefergebnis, UemsWagoKarteGelesen, WagoSollLesung,
} from './api';

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

export type WagoBogenErgebnis = 'belegt' | 'belegt_je_kunde' | 'nicht_unterstuetzt' | 'in_pruefung';

export interface WagoBogenUrteil {
  ergebnis: WagoBogenErgebnis;
  titel: string;
  satz: string;
  ausweg: string | null;
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
  /** Je gelesener Karte eine Zeile — nur hinter einem erkannten Kopf, nur aus der Lesung. */
  karten: string[];
  kopf: WagoKopf | null;
}

const NICHT_GELESEN = 'nicht gelesen';

/** Eine Karte, wie die Datenquellen-Prüfung sie gelesen hat (`wago.karten`); fehlend bleibt „nicht gelesen“. */
function kartenZeile(k: UemsWagoKarteGelesen): string {
  return `Karte ${k.karte}: Steckplatz ${k.steckplatz ?? NICHT_GELESEN} · `
    + `${k.kartentyp == null ? `Kartentyp ${NICHT_GELESEN}` : `750-${k.kartentyp}`} · `
    + `Variante ${k.variante ?? NICHT_GELESEN}`;
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
    return { art: 'fehler', titel: texte[pruefung.ergebnis] ?? pruefung.text, details: [], karten: [], kopf: null };
  }
  if (!kopf.erkannt) {
    const grund: Record<WagoKopfGrund, string> = {
      signatur_fremd: 'Unter der Basisadresse steht kein VoltPilot-Registerbild.',
      hauptversion_fremd: `Registerbild-Version ${kopf.hauptversion ?? 'unbekannt'} ist fremd.`,
      laenge_ungueltig: 'Der Kopf meldet eine unzulässige Länge.',
      wortfolge_abweichend: 'Die gelesene Wortfolge passt nicht zur Verbindungsangabe.',
    };
    return {
      art: 'fehler',
      titel: 'Registerbild unbekannt',
      details: [kopf.grund ? grund[kopf.grund] : 'Der Kopf konnte nicht erkannt werden.'],
      karten: [],
      kopf,
    };
  }
  const details: string[] = [];
  if (kopf.hauptversion != null) details.push(`Registerbild v${kopf.hauptversion}.${kopf.nebenversion ?? 0}`);
  if (kopf.kartenzahl != null) details.push(`${kopf.kartenzahl.toLocaleString('de-DE')} ${kopf.kartenzahl === 1 ? 'Energiekarte' : 'Energiekarten'}`);
  if (kopf.controller_kennung != null) details.push(`Controller-Kennung ${kopf.controller_kennung}`);
  if (kopf.herzschlag != null) {
    details.push(vorherigerHerzschlag == null
      ? `Herzschlag ${kopf.herzschlag.toLocaleString('de-DE')} — für den Vergleich erneut prüfen`
      : vorherigerHerzschlag === kopf.herzschlag
        ? `Herzschlag steht bei ${kopf.herzschlag.toLocaleString('de-DE')}`
        : `Herzschlag läuft: ${vorherigerHerzschlag.toLocaleString('de-DE')} → ${kopf.herzschlag.toLocaleString('de-DE')}`);
  }
  return { art: 'ok', titel: 'Kopf erkannt', details, karten: (pruefung.wago?.karten ?? []).map(kartenZeile), kopf };
}

export interface WagoKarteEntwurf {
  id: string;
  steckplatz: number | null;
  typ: '750-493' | '750-494' | '750-495' | null;
  /** Die gelesene Variante; `null` = nicht gelesen. */
  variante: number | null;
  messaufgabe: string;
  wandlerPrimaer: string;
  wandlerSekundaer: string;
  wandlerAnwendung: 'dokumentiert' | 'angewendet';
}

export function neueWagoKarte(nummer: number): WagoKarteEntwurf {
  return {
    id: `karte-${nummer}`,
    steckplatz: null,
    typ: null,
    variante: null,
    messaufgabe: '',
    wandlerPrimaer: '',
    wandlerSekundaer: '',
    wandlerAnwendung: 'dokumentiert',
  };
}

/**
 * B05: die Karten, wie die Datenquellen-Prüfung (`op: wago_kopf`) sie in Schritt 1 gelesen hat —
 * Steckplatz, Kartentyp und Variante aus den Kennwörtern, kein zweiter Lesevorgang. Fehlendes bleibt
 * `null`; der Steckplatz ist nie die Position der Karte.
 */
export function wagoKartenAusPruefung(pruefung: UemsDatenquellePruefergebnis | null): WagoKarteEntwurf[] {
  return (pruefung?.wago?.karten ?? []).map((k) => ({
    ...neueWagoKarte(k.karte),
    steckplatz: k.steckplatz,
    typ: k.kartentyp === 493 || k.kartentyp === 494 || k.kartentyp === 495 ? `750-${k.kartentyp}` : null,
    variante: k.variante,
  }));
}

/** Regel aus `docs/wago/erhebungsbogen.md`, ausschließlich aus gelesenen Fakten. */
export function wagoUrteilAusLesung(kopf: WagoKopf | null, karten: readonly WagoKarteEntwurf[]): WagoBogenUrteil {
  if (!kopf?.erkannt) return {
    ergebnis: 'in_pruefung', titel: 'Unbekannt — Registerbild nicht erkannt',
    satz: 'Aus dem Kopf lässt sich die Kombination nicht bestimmen. Es wird keine Unterstützung angenommen.',
    ausweg: null,
  };
  if (kopf.controller_kennung === 9301 || kopf.controller_kennung === 8303 || karten.some((k) => k.typ === '750-493')) {
    return {
      ergebnis: 'nicht_unterstuetzt', titel: 'Nicht unterstützt', satz: 'Die ausgelesene Kombination ist nicht belegt.',
      ausweg: 'Verwenden Sie einen unterstützten Controller mit 750-494/750-495 oder einen passenden Energiezähler.',
    };
  }
  if (kopf.controller_kennung === 8100) return {
    ergebnis: 'belegt_je_kunde', titel: 'Belegt je Kunde',
    satz: 'Der ausgelesene PFC100 wird nur für diese Anlage geprüft. Daraus folgt keine Zusage für andere Kunden.', ausweg: null,
  };
  if (karten.length !== kopf.kartenzahl || karten.some((k) => k.steckplatz == null || k.typ == null)) return {
    ergebnis: 'in_pruefung', titel: 'Unbekannt — Lesung unvollständig',
    satz: 'Steckplatz oder Kartentyp fehlt in der Lesung. Es wird nichts angenommen.', ausweg: null,
  };
  return {
    ergebnis: 'in_pruefung', titel: 'In Prüfung — Einsatz noch nicht bestätigt',
    satz: 'Die Kombination wurde ausgelesen, ist aber noch nicht für den Einsatz bestätigt. Für 750-494 bleibt die Messwert-Tabelle unbelegt.', ausweg: null,
  };
}

export interface WagoSollAnzeige {
  titel: string;
  satz: string;
  zeilen: string[];
  abweichend: boolean;
}

/**
 * AP-05 „WAGO-Soll speichern“: was die Steuerung als Soll geliefert hat. Nur Anzeige — das Soll
 * kommt ausschließlich aus der Lesung, nie aus einem Eingabefeld. Fehlendes bleibt „nicht gelesen“.
 */
export function wagoSollAnzeige(lesung: WagoSollLesung): WagoSollAnzeige {
  const zeilen: string[] = [];
  const { controllerKennung, karten } = lesung.soll;
  zeilen.push(`Controller-Kennung ${controllerKennung === null ? 'nicht gelesen' : String(controllerKennung)}`);
  for (const k of karten) {
    zeilen.push(`Steckplatz ${k.steckplatz ?? 'unbekannt'} · ${k.typ ?? 'Kartentyp nicht gelesen'} · `
      + `Variante ${k.variante === null ? 'nicht gelesen' : String(k.variante)}`);
  }
  const titel: Record<WagoSollLesung['ergebnis'], string> = {
    gespeichert: 'Soll aus der Steuerung gespeichert',
    unveraendert: 'Soll von der Steuerung bestätigt',
    abweichung: 'Steuerung weicht vom gespeicherten Soll ab',
    nicht_gelesen: 'Soll nicht gelesen',
  };
  return { titel: titel[lesung.ergebnis], satz: lesung.satz, zeilen, abweichend: lesung.ergebnis === 'abweichung' };
}
