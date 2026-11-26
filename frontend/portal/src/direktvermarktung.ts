// Direktvermarktung (Konzept vp-direktvermarktung-konzept d2, Entscheidungen E1-E6 = A): der Anschluss einer
// Anlage an einen Direktvermarkter (z. B. luox energy). Diese Datei ist der TS-Zwilling von §5.4 "Lagen des
// Anschlusses" und §7.6 "Texte und Zustände" - eine reine, import-freie Schicht (Muster `ladepunkte.ts`): jede
// Zahl und jeder Satz über die Lage des Anschlusses entsteht hier, die Seite rendert nur.
//
// Zwei Ebenen, nicht eine:
//  - `zustand` ist die CLOUD-Buchführung (`direktvermarktung.zustand`, geschlossenes Vokabular, von der API
//    gesetzt): wo der Kunde im Einrichten steht, oder ob der Anschluss endet/beendet ist.
//  - `Lage` ist die FEINERE, ABGELEITETE Anzeige, sobald ein Zugang besteht (§5.4): aus dem Zustand plus dem
//    letzten Herzschlag-Block (`stand`) - nie ein zweiter gespeicherter Zustand, immer hergeleitet.
// "Unbekannt ist keine Null" (§5.1): ohne `stand`-Zeile ist die Lage `unbekannt`, nie `getrennt`.

/** Die CLOUD-Buchführung, geschlossenes Vokabular (Server: `direktvermarktung.zustand`). */
export type DirektvermarktungZustand =
  | 'entwurf'
  | 'wartet_auf_zugang'
  | 'verbindet'
  | 'wartet_auf_partner'
  | 'verbunden'
  | 'gestoert'
  | 'endet'
  | 'beendet';

export interface DirektvermarktungPartner {
  partner: string;
  name: string;
  vertragLink: string | null;
}

export interface DirektvermarktungEintrag {
  id: string;
  partner: string;
  zustand: DirektvermarktungZustand;
  zustimmungAm: string | null;
  zustimmungVon: string | null;
  startdatum: string | null;
  ende: string | null;
  revision: number;
}

/** Der letzte Herzschlag-Block der Box (`direktvermarktung_stand`) - ohne Zeile `null` (§5.1, nie erfunden). */
export interface DirektvermarktungStandDaten {
  tunnelObenSeit: string | null;
  handshakeAm: string | null;
  gegenstelle: string | null;
  letzteAbfrageAm: string | null;
  abfragenJeMinute: number | null;
  letzteSchreibungAm: string | null;
  vorgabePct: number | null;
  lebenszeichenAm: string | null;
  einspeisungW: number | null;
  erzeugungW: number | null;
  netzbetreiberPct: number | null;
  referenzW: number | null;
}

export interface DirektvermarktungProtokollZeile {
  id: number;
  ereignis: string;
  von: string | null;
  rolle: string | null;
  am: string;
}

/** GET /api/v1/sites/{id}/direktvermarktung. */
export interface DirektvermarktungStatus {
  aktuell: DirektvermarktungEintrag | null;
  /** Nur während eines geplanten Wechsels (§6) - der Eintrag, der folgt. */
  geplant: DirektvermarktungEintrag | null;
  partner: DirektvermarktungPartner | null;
  geplanterPartner: DirektvermarktungPartner | null;
  stand: DirektvermarktungStandDaten | null;
  verlaufKurz: DirektvermarktungProtokollZeile[];
  katalog: DirektvermarktungPartner[];
  darf: boolean;
}

/** Die feine Lage einmal verbunden (§5.4 "Lagen des Anschlusses") - abgeleitet, nie gespeichert. */
export type DirektvermarktungLage =
  | 'baut_auf'
  | 'tunnel_oben'
  | 'verbunden'
  | 'vorgabe_aktiv'
  | 'abgelaufen'
  | 'tunnel_unten'
  | 'unbekannt';

/** Fristen aus §5.4/§5.6, als Minuten - der Default, solange kein Partnerprofil eine eigene Frist liefert. */
export const FRIST_TUNNEL_BAUT_AUF_MIN = 10;
export const FRIST_LUOX_FRAGT_NICHT_AB_MIN = 60;
export const FRIST_LEBENSZEICHEN_MIN = 15;
export const FRIST_TUNNEL_WEG_MIN = 3;

function minutenSeit(iso: string | null, jetzt: Date): number | null {
  if (!iso) return null;
  const dann = new Date(iso).getTime();
  if (Number.isNaN(dann)) return null;
  return (jetzt.getTime() - dann) / 60000;
}

/**
 * Die Lage, sobald ein Zugang besteht (Zustand `verbindet`/`wartet_auf_partner`/`verbunden`/`gestoert`): aus dem
 * letzten Herzschlag-Block, nie aus einer zweiten Wahrheit. Ohne jede Meldung (`stand === null`) `unbekannt` -
 * die Box kann trotzdem online sein, nur die Cloud weiß es gerade nicht (§5.6 "Box meldet sich nicht").
 */
export function lageFor(stand: DirektvermarktungStandDaten | null, jetzt: Date): DirektvermarktungLage {
  if (!stand) return 'unbekannt';
  const handshake = minutenSeit(stand.handshakeAm, jetzt);
  const letzteAbfrage = minutenSeit(stand.letzteAbfrageAm, jetzt);
  const lebenszeichen = minutenSeit(stand.lebenszeichenAm, jetzt);
  if (handshake == null) return 'baut_auf';
  if (handshake >= FRIST_TUNNEL_WEG_MIN) return 'tunnel_unten';
  if (letzteAbfrage == null) return 'tunnel_oben';
  if (lebenszeichen != null && lebenszeichen < FRIST_LEBENSZEICHEN_MIN && stand.vorgabePct != null
      && stand.vorgabePct < 100) {
    return 'vorgabe_aktiv';
  }
  if (lebenszeichen != null && lebenszeichen >= FRIST_LEBENSZEICHEN_MIN) return 'abgelaufen';
  return 'verbunden';
}

/** "luox fragt seit 60 Min. nicht ab" (§5.6) - unabhängig von der Lage, solange der Tunnel steht. */
export function partnerFragtNichtAb(stand: DirektvermarktungStandDaten | null, jetzt: Date): boolean {
  if (!stand) return false;
  const letzteAbfrage = minutenSeit(stand.letzteAbfrageAm, jetzt);
  return letzteAbfrage != null && letzteAbfrage >= FRIST_LUOX_FRAGT_NICHT_AB_MIN;
}

/** Die Farbe einer Lage/eines Zustands (§7.2 Regel 5 "Ruhig im Alltag": Begrenzen ist kein Fehler). */
export type DirektvermarktungFarbe = 'gruen' | 'bernstein' | 'rot' | 'grau';

export interface DirektvermarktungAnzeige {
  statuszeile: string;
  farbe: DirektvermarktungFarbe;
}

const TAG = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

function seitAlter(minuten: number): string {
  if (minuten < 1) return 'gerade eben';
  if (minuten < 60) return `vor ${Math.round(minuten)} Min.`;
  const stunden = Math.round(minuten / 60);
  return `vor ${stunden} Std.`;
}

/**
 * Die Statuszeile und Farbe für die Seite und die fünf Stellen im Alltag (§7.3/§7.6) - EIN Vokabular, egal wo
 * es erscheint. `partnerName` ist der Anzeigename aus dem Katalog (z. B. "luox energy").
 */
export function anzeige(eintrag: DirektvermarktungEintrag | null, partnerName: string | null,
    stand: DirektvermarktungStandDaten | null, jetzt: Date): DirektvermarktungAnzeige {
  if (!eintrag || eintrag.zustand === 'beendet') return { statuszeile: 'Nicht verbunden', farbe: 'grau' };
  if (eintrag.zustand === 'entwurf' || eintrag.zustand === 'wartet_auf_zugang') {
    return { statuszeile: `Einrichtung mit ${partnerName ?? eintrag.partner}`, farbe: 'grau' };
  }
  if (eintrag.zustand === 'endet' && eintrag.ende) {
    return { statuszeile: `Endet am ${TAG.format(new Date(eintrag.ende))}`, farbe: 'grau' };
  }
  const name = partnerName ?? eintrag.partner;
  if (partnerFragtNichtAb(stand, jetzt)) {
    return { statuszeile: `Verbunden · ${name} fragt nicht ab`, farbe: 'bernstein' };
  }
  const lage = lageFor(stand, jetzt);
  switch (lage) {
    // `stand` ist hier immer `null` (lageFor liefert `unbekannt` nur dafür) - ohne jede Meldung gibt es keinen
    // Zeitpunkt, seit dem sie fehlt (§5.1 "Unbekannt ist keine Null": kein erfundenes "seit").
    case 'unbekannt':
      return { statuszeile: 'Stand unbekannt', farbe: 'grau' };
    case 'baut_auf':
      return { statuszeile: 'Verbindung wird aufgebaut', farbe: 'grau' };
    case 'tunnel_oben':
      return { statuszeile: `Verbunden · ${name} fragt noch nicht ab`, farbe: 'grau' };
    case 'tunnel_unten': {
      const seit = stand?.handshakeAm ? seitAlter(minutenSeit(stand.handshakeAm, jetzt) ?? 0) : 'unbekannt';
      return { statuszeile: `Getrennt seit ${seit} · Box online`, farbe: 'bernstein' };
    }
    case 'abgelaufen':
      return { statuszeile: `Verbunden mit ${name} · frei`, farbe: 'gruen' };
    case 'vorgabe_aktiv':
      return { statuszeile: `Verbunden · ${name} begrenzt${stand?.vorgabePct != null ? ` auf ${stand.vorgabePct} %`
          : ''}`, farbe: 'bernstein' };
    case 'verbunden':
    default: {
      const seit = stand?.letzteAbfrageAm ? seitAlter(minutenSeit(stand.letzteAbfrageAm, jetzt) ?? 0) : null;
      return { statuszeile: `Verbunden mit ${name}${seit ? ` · ${seit}` : ''}`, farbe: 'gruen' };
    }
  }
}

/** Kundenwort statt Fachwort (§7.2 Regel 3) - die Fortschritts-Stationen des Einrichtens (§7.5 "Fortschritt"). */
export const FORTSCHRITT_STATIONEN = ['Gewählt', 'Zugestimmt', 'Zugang', 'Verbunden', 'luox prüft'] as const;

/** Welche Station erreicht ist, für die laufende Hervorhebung in `vp-weg-liste` (0..4, -1 vor der Wahl). */
export function fortschrittIndex(eintrag: DirektvermarktungEintrag | null): number {
  if (!eintrag) return -1;
  switch (eintrag.zustand) {
    case 'entwurf':
      return eintrag.zustimmungAm ? 1 : 0;
    case 'wartet_auf_zugang':
      return 2;
    case 'verbindet':
      return 3;
    case 'wartet_auf_partner':
    case 'verbunden':
    case 'gestoert':
      return 4;
    default:
      return -1;
  }
}

/**
 * Die zweite Zeile unter der Einstellungen-Zeile (§7.3 "Einstieg"), sobald verbunden: "Letzte Abfrage vor 40 s ·
 * Vorgabe 100 %" - wie die Geräteakte liest sie nur den Stand, nichts Eigenes. `null` ohne genug Daten dafür.
 */
export function einstellungszeileDetail(stand: DirektvermarktungStandDaten | null, jetzt: Date): string | null {
  if (!stand) return null;
  const abfrage = minutenSeit(stand.letzteAbfrageAm, jetzt);
  const teile: string[] = [];
  if (abfrage != null) teile.push(`Letzte Abfrage ${seitAlter(abfrage)}`);
  if (stand.vorgabePct != null) teile.push(`Vorgabe ${stand.vorgabePct} %`);
  return teile.length > 0 ? teile.join(' · ') : null;
}

export const ZUSTIMMUNG_TEXTFASSUNG_1 =
  'luox liest Einspeisung, Erzeugung, Vorgabe des Netzbetreibers und Anlagenleistung. luox darf die Erzeugung '
  + 'auf 0 bis 100 % stellen. Nicht: Speicher, Verbraucher, Ihr Netz, die Box.';

/** Die drei Zeilen "Das darf X an Ihrer Anlage" (§7, Blatt Zustimmen) - ein Icon-Name je Zeile, von der Seite gewählt. */
export const ZUSTIMMUNG_ZEILEN = [
  { icon: 'eye', text: 'Sehen, was Ihre Anlage einspeist' },
  { icon: 'sliders', text: 'Die Einspeisung begrenzen' },
  { icon: 'lock', text: 'Nichts sonst, nie ins Heimnetz' },
] as const;

// --- Verbindungsbild (§7.2 Regel 1, §7.5 "Verbindungsbild") ----------------------------------------------------

/** Wie eine Strecke des Bildes gezeichnet wird: gestrichelt (offen), pulsierend (baut auf), fest (verbunden), rot (gebrochen). */
export type VerbindungsLinie = 'offen' | 'laufend' | 'fest' | 'bruch';

export interface VerbindungsbildStand {
  /** Zeigt die Seite das Bild überhaupt? Im ruhigen Alltag (verbunden, frei oder begrenzt) tritt die große Zahl an seine Stelle. */
  zeigen: boolean;
  anlageBox: VerbindungsLinie;
  boxPartner: VerbindungsLinie;
  /** Warnzeichen am Partner-Knoten statt Haken (§7.2 Regel 6 "Unbekannt ist nicht getrennt" eingeschlossen). */
  partnerWarnung: boolean;
}

/**
 * Das Verbindungsbild aus Zustand und Lage - nie ein eigener Stand, immer hergeleitet (§5.1). Die Box ist
 * lokal bekannt (die Anlage-Box-Strecke steht fest, sobald überhaupt eingerichtet wird); nur die
 * Partner-Strecke kennt einen Bruch.
 */
export function verbindungsbild(eintrag: DirektvermarktungEintrag | null,
    stand: DirektvermarktungStandDaten | null, jetzt: Date): VerbindungsbildStand {
  if (!eintrag || eintrag.zustand === 'beendet' || eintrag.zustand === 'entwurf'
      || eintrag.zustand === 'wartet_auf_zugang') {
    return { zeigen: true, anlageBox: 'offen', boxPartner: 'offen', partnerWarnung: false };
  }
  if (eintrag.zustand === 'endet') {
    return { zeigen: false, anlageBox: 'fest', boxPartner: 'fest', partnerWarnung: false };
  }
  const lage = lageFor(stand, jetzt);
  switch (lage) {
    case 'unbekannt':
      return { zeigen: true, anlageBox: 'fest', boxPartner: 'offen', partnerWarnung: false };
    case 'baut_auf':
      return { zeigen: true, anlageBox: 'fest', boxPartner: 'laufend', partnerWarnung: false };
    case 'tunnel_oben':
      return { zeigen: true, anlageBox: 'fest', boxPartner: 'fest', partnerWarnung: false };
    case 'tunnel_unten':
      return { zeigen: true, anlageBox: 'fest', boxPartner: 'bruch', partnerWarnung: true };
    // Ruhiger Alltag (verbunden, frei oder von luox begrenzt, oder die Grenze gerade abgelaufen): die große
    // Zahl trägt die Aussage, das Bild träte nur in den Weg.
    case 'vorgabe_aktiv':
    case 'abgelaufen':
    case 'verbunden':
    default:
      return { zeigen: false, anlageBox: 'fest', boxPartner: 'fest', partnerWarnung: false };
  }
}

/**
 * "Wohin der Strom geht" (§7.5), vereinfacht auf Haus/Netz: mehr (Speicher, abgeregelt) bräuchte Felder, die der
 * Herzschlag-Block heute nicht führt - lieber zwei ehrliche Zahlen als zwei erfundene. `null` ohne beide Werte.
 */
export function wohinDerStromGeht(stand: DirektvermarktungStandDaten | null): { hausW: number; netzW: number } | null {
  if (!stand || stand.einspeisungW == null || stand.erzeugungW == null) return null;
  const netzW = Math.max(0, stand.einspeisungW);
  const hausW = Math.max(0, stand.erzeugungW - stand.einspeisungW);
  if (hausW === 0 && netzW === 0) return null;
  return { hausW, netzW };
}
