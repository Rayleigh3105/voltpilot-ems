import { zeitpunkt } from './adminFernwartung';
import { fmtRelative, seitDauer } from './format';

/**
 * Neue Software durch den Wartungstunnel für eine Box ohne Kundenkonto (Konzept
 * vp-update-vor-zuordnung, S1): was die Akte im Reiter „Software" über sie
 * weiß (`GET /api/v1/admin/geraete/{ref}/fernlauf`) und wie die zwei Karten
 * „Linie und Stand" und „Durch den Tunnel aufspielen" es sagen. Reine Ableitung;
 * die Akte rendert nur.
 *
 * Zwilling der Vokabulare: `docs/contracts/werkstatt-fernlauf.json`
 * (`FernlaufRegel.java`, `internal/fernlauf` im Werkstatt-Dienst).
 */

export type FernlaufZustand =
  | 'erteilt' | 'laeuft' | 'fertig' | 'zurueck' | 'unveraendert' | 'offen' | 'nicht_abgeholt';

export interface FernlaufSchritt {
  schritt: string;
  zustand: 'laeuft' | 'belegt' | 'gescheitert';
  zeit: string | null;
  zeile: string | null;
}

export interface FernlaufErgebnis {
  ergebnis: 'fertig' | 'zurueck' | 'unveraendert' | 'offen';
  grund: string | null;
  schritt: string | null;
  fassungNachher: string | null;
  belege: Record<string, string>;
  quelle: 'dienst' | 'portal';
  erfasstAm: string;
}

export interface Fernlauf {
  id: string;
  art: string;
  zustand: FernlaufZustand;
  fassungVorher: string | null;
  fassungZiel: string;
  akteurName: string | null;
  erteiltAm: string;
  begonnenAm: string | null;
  schritt: string | null;
  schrittSeit: string | null;
  schritte: FernlaufSchritt[];
  fensterEnde: string | null;
  ergebnis: FernlaufErgebnis | null;
}

export interface FernlaufGrund {
  code: string;
  text: string;
}

export interface FernlaufStand {
  edgeRef: string;
  /** Die laufende Fassung aus der letzten Zertifikatsanfrage (N2); `null` = nie gemeldet. */
  laeuft: string | null;
  /** Wann diese Anfrage kam: der letzte Programmstart. */
  laeuftGemeldetAm: string | null;
  /** Die letzte Zertifikats-Abfrage (N5): „fragt gerade". */
  fragtZuletztAm: string | null;
  neueste: string | null;
  werkstattFassung: string | null;
  werkstattAm: string | null;
  moeglich: boolean;
  gruende: FernlaufGrund[];
  haken: { tunnelVerbunden: boolean; fragtNachSchluesseln: boolean; keinKundenkonto: boolean };
  /** Die letzten Aufträge, neueste zuerst. */
  verlauf: Fernlauf[];
  stand: string;
}

/** Schritte des Dienstes in ihrer Reihenfolge, mit ihrer Gruppe der Schrittleiste (Vektor). */
export const FERNLAUF_SCHRITTE: { id: string; gruppe: string; titel: string }[] = [
  { id: 'anmelden', gruppe: 'anmelden', titel: 'Durch den Tunnel anmelden' },
  { id: 'bestand', gruppe: 'anmelden', titel: 'Stand der Box lesen' },
  { id: 'fassungen', gruppe: 'sichern', titel: 'Fassung laden, Signatur prüfen' },
  { id: 'sichern', gruppe: 'sichern', titel: 'Bisherige Fassung sichern' },
  { id: 'aufspielen', gruppe: 'aufspielen', titel: 'Neue Fassung aufspielen' },
  { id: 'neustart', gruppe: 'neustart', titel: 'Programm neu starten' },
  { id: 'meldet_sich', gruppe: 'pruefen', titel: 'Meldet sich mit der neuen Fassung' },
  { id: 'tunnel', gruppe: 'pruefen', titel: 'Tunnel steht' },
  { id: 'zurueck', gruppe: 'zurueck', titel: 'Bisherige Fassung zurückspielen' },
  { id: 'fenster_zu', gruppe: 'ende', titel: 'Fenster schließen' },
];

/** Die fünf Punkte der Schrittleiste (§4.5). */
export const FERNLAUF_GRUPPEN: { id: string; titel: string }[] = [
  { id: 'anmelden', titel: 'Anmelden' },
  { id: 'sichern', titel: 'Sichern' },
  { id: 'aufspielen', titel: 'Aufspielen' },
  { id: 'neustart', titel: 'Neustart' },
  { id: 'pruefen', titel: 'Prüfen' },
];

export const FERNLAUF_ERGEBNISSE = ['fertig', 'zurueck', 'unveraendert', 'offen'] as const;

/** „edge-light-2026.11.5" → „2026.11.5" (die Linie steht auf der Karte). */
export function fassungKurz(f: string | null | undefined): string {
  if (!f) return 'unbekannt';
  return f.replace(/^edge-light-/, '');
}

function gruppeVon(schritt: string | null): string | null {
  return FERNLAUF_SCHRITTE.find((s) => s.id === schritt)?.gruppe ?? null;
}

export type PunktZustand = 'erledigt' | 'laeuft' | 'gescheitert' | 'offen';

/** Die Schrittleiste eines Auftrags: je Gruppe erledigt, läuft, gescheitert oder noch offen. */
export function schrittleiste(f: Fernlauf): { id: string; titel: string; zustand: PunktZustand }[] {
  const belegt = new Set(f.schritte.filter((s) => s.zustand === 'belegt').map((s) => s.schritt));
  const gescheitert = new Set(f.schritte.filter((s) => s.zustand === 'gescheitert').map((s) => gruppeVon(s.schritt)));
  const aktuell = f.zustand === 'laeuft' ? gruppeVon(f.schritt) : null;
  return FERNLAUF_GRUPPEN.map((g) => {
    const schritte = FERNLAUF_SCHRITTE.filter((s) => s.gruppe === g.id).map((s) => s.id);
    let zustand: PunktZustand = 'offen';
    if (gescheitert.has(g.id)) zustand = 'gescheitert';
    else if (schritte.every((s) => belegt.has(s))) zustand = 'erledigt';
    else if (aktuell === g.id) zustand = 'laeuft';
    return { id: g.id, titel: g.titel, zustand };
  });
}

/** Eine Zeile „Linie und Stand": Wer · Wert · Satz darunter. */
export interface StandZeile {
  wer: string;
  wert: string;
  satz: string | null;
}

/**
 * Karte „Linie und Stand" einer Box ohne Kundenkonto (N2): die laufende Fassung
 * aus ihrer letzten Zertifikatsanfrage, ob sie gerade fragt (N5), die neueste
 * Fassung und der Stand der Werkstatt.
 */
export function standZeilen(s: FernlaufStand, jetzt: Date): StandZeile[] {
  const z: StandZeile[] = [
    {
      wer: 'Läuft',
      wert: s.laeuft ? fassungKurz(s.laeuft) : 'unbekannt',
      satz: s.laeuft && s.laeuftGemeldetAm
        ? `gemeldet beim Start ${zeitpunkt(s.laeuftGemeldetAm, jetzt)}`
        : 'Die Box hat noch keine Fassung gemeldet.',
    },
    { wer: 'Fragt', wert: fragtText(s.fragtZuletztAm, jetzt), satz: null },
    { wer: 'Neueste', wert: s.neueste ? fassungKurz(s.neueste) : 'keine passende', satz: null },
  ];
  if (s.werkstattFassung) {
    z.push({
      wer: 'Werkstatt',
      wert: fassungKurz(s.werkstattFassung),
      satz: s.werkstattAm ? `abgenommen ${zeitpunkt(s.werkstattAm, jetzt)}` : null,
    });
  }
  return z;
}

/** N5: „gerade nach ihrem Zertifikat" (letzte Abfrage höchstens 3 Min. her), sonst wann zuletzt. */
export function fragtText(iso: string | null, jetzt: Date): string {
  if (!iso) return 'noch nie nach ihrem Zertifikat';
  const alter = jetzt.getTime() - new Date(iso).getTime();
  if (alter <= 3 * 60_000) return `gerade nach ihrem Zertifikat (${fmtRelative(iso, jetzt)})`;
  return `zuletzt ${fmtRelative(iso, jetzt)} nach ihrem Zertifikat`;
}

/** Was die Karte „Durch den Tunnel aufspielen" zeigt. */
export type TunnelKarte =
  | { art: 'laeuft'; auftrag: Fernlauf; schrittTitel: string; seit: string }
  | { art: 'ergebnis'; auftrag: Fernlauf; ton: 'ok' | 'warn' | 'off'; titel: string; satz: string; knopf: KnopfSicht }
  | { art: 'knopf'; knopf: KnopfSicht };

export interface KnopfSicht {
  /** „Auf 2026.11.15 bringen"; `null`, wenn es nichts aufzuspielen gibt. */
  label: string | null;
  moeglich: boolean;
  /** Der erste Grund dagegen, ein Satz für den Admin. */
  grund: string | null;
}

/** Die drei Haken (§4.5), jeder nur bei einer Tatsache. */
export function haken(s: FernlaufStand): { text: string; ok: boolean }[] {
  return [
    { text: 'Tunnel verbunden', ok: s.haken.tunnelVerbunden },
    { text: 'Fragt nach Schlüsseln', ok: s.haken.fragtNachSchluesseln },
    { text: 'Kein Kundenkonto', ok: s.haken.keinKundenkonto },
  ];
}

function knopfSicht(s: FernlaufStand, nochEinmal: boolean): KnopfSicht {
  const schon = s.gruende.some((g) => g.code === 'schon_neueste' || g.code === 'keine_neueste');
  return {
    label: schon || !s.neueste ? null : nochEinmal ? 'Noch einmal' : `Auf ${fassungKurz(s.neueste)} bringen`,
    moeglich: s.moeglich,
    grund: s.moeglich ? null : s.gruende[0]?.text ?? null,
  };
}

/** Die Karte aus dem Stand: der laufende Auftrag, sonst das letzte Ergebnis mit Knopf, sonst nur der Knopf. */
export function tunnelKarte(s: FernlaufStand, jetzt: Date): TunnelKarte {
  const f = s.verlauf[0];
  if (!f) return { art: 'knopf', knopf: knopfSicht(s, false) };
  if (f.zustand === 'erteilt' || f.zustand === 'laeuft') {
    const titel = f.zustand === 'erteilt'
      ? 'Wartet auf den Werkstatt-Dienst'
      : FERNLAUF_SCHRITTE.find((x) => x.id === f.schritt)?.titel ?? 'Läuft';
    const seit = seitDauer(f.begonnenAm ?? f.erteiltAm, jetzt);
    return { art: 'laeuft', auftrag: f, schrittTitel: titel, seit: seit ? `Lauf ${seit}` : '' };
  }
  const e = f.ergebnis;
  const wann = e ? zeitpunkt(e.erfasstAm, jetzt) : '';
  const grund = e?.grund ? ` · ${e.grund}` : '';
  switch (f.zustand) {
    case 'fertig':
      return { art: 'ergebnis', auftrag: f, ton: 'ok', titel: `${fassungKurz(e?.fassungNachher ?? f.fassungZiel)} läuft`,
        satz: `Meldet sich wieder · ${wann}`, knopf: knopfSicht(s, false) };
    case 'zurueck':
      return { art: 'ergebnis', auftrag: f, ton: 'warn', titel: `Zurück auf ${fassungKurz(e?.fassungNachher ?? f.fassungVorher)}`,
        satz: `${schrittName(e?.schritt)}${grund}`, knopf: knopfSicht(s, true) };
    case 'unveraendert':
      return { art: 'ergebnis', auftrag: f, ton: 'off', titel: 'Nichts geändert', satz: `${schrittName(e?.schritt)}${grund}`,
        knopf: knopfSicht(s, true) };
    case 'nicht_abgeholt':
      return { art: 'ergebnis', auftrag: f, ton: 'off', titel: 'Nicht abgeholt',
        satz: 'Der Werkstatt-Dienst hat den Auftrag nicht abgeholt; nichts geändert.', knopf: knopfSicht(s, true) };
    default:
      return { art: 'ergebnis', auftrag: f, ton: 'warn', titel: 'Offen',
        satz: `Zuletzt ${schrittName(e?.schritt ?? f.schritt).toLowerCase()}${grund}. Was die Box jetzt fährt, zeigt ihr nächster Start.`,
        knopf: knopfSicht(s, true) };
  }
}

function schrittName(id: string | null | undefined): string {
  const s = FERNLAUF_SCHRITTE.find((x) => x.id === id);
  return s ? `Schritt „${s.titel}"` : 'Ohne Schritt';
}

/** Der Bestätigungsdialog (§4.5): Frage, Satz und Folgen. */
export function bestaetigung(ref: string, s: FernlaufStand): { titel: string; intro: string; folgen: string[] } {
  return {
    titel: `${ref} von ${fassungKurz(s.laeuft)} auf ${fassungKurz(s.neueste)} bringen?`,
    intro: 'Der Werkstatt-Dienst bekommt ein Fenster für 30 Min. Die Box startet einmal neu.',
    folgen: [
      'Vorher sichert er die bisherige Fassung; scheitert danach eine Prüfung, spielt er sie zurück.',
      'Er prüft die Signatur der Fassung, bevor er etwas ändert.',
      'Tunnel, Identität und Einstellungen der Box bleiben, wie sie sind.',
      'Das Fenster steht mit deinem Namen im Fernwartungs-Protokoll.',
    ],
  };
}

/** Eine Zeile im Verlauf: „über den Tunnel auf 2026.11.15 · fertig · Moritz". */
export function verlaufZeile(f: Fernlauf, jetzt: Date): { wann: string; text: string; ton: 'ok' | 'warn' | 'off' } {
  const wort: Record<FernlaufZustand, string> = {
    erteilt: 'wartet auf den Dienst', laeuft: 'läuft', fertig: 'fertig', zurueck: 'zurückgenommen',
    unveraendert: 'nichts geändert', offen: 'offen', nicht_abgeholt: 'nicht abgeholt',
  };
  const ton = f.zustand === 'fertig' ? 'ok' : f.zustand === 'zurueck' || f.zustand === 'offen' ? 'warn' : 'off';
  return {
    wann: zeitpunkt(f.ergebnis?.erfasstAm ?? f.erteiltAm, jetzt),
    text: `Über den Tunnel auf ${fassungKurz(f.fassungZiel)} · ${wort[f.zustand]}${f.akteurName ? ` · ${f.akteurName}` : ''}`,
    ton,
  };
}

/**
 * N5: der Satz unter „Meldet sich, wartet auf Zuordnung" (Reiter „Einrichtung"). `csrUpdatedAt` ist der letzte
 * Programmstart, nicht der Beginn des Meldens; ob sie gerade fragt, sagt die letzte Zertifikats-Abfrage.
 */
export function fragtSatz(
  p: { csrUpdatedAt: string; zuletztAbgefragtAm?: string | null; deviceInfo: string | null },
  jetzt: Date,
): string {
  const fragt = fragtText(p.zuletztAbgefragtAm ?? null, jetzt);
  return `Fragt ${fragt} · zuletzt gestartet ${zeitpunkt(p.csrUpdatedAt, jetzt)}${p.deviceInfo ? ` · ${p.deviceInfo}` : ''}.`;
}

// ── Karte „Ohne Kundenkonto" (S2: Plattform › Geräte › Updates) ─────────────
//
// `GET /api/v1/admin/geraete/ohne-kundenkonto` liefert denselben Stand wie `geraeteFernlauf`, einmal je Box ohne
// Kundenkonto mit Tunnel-Zugang - reine Ableitung, die Seite rendert nur.

/** Die Boxen, die „Aufspielen" oder „Alle aufspielen" gerade anfassen dürfen: die Vorprüfung ist erfüllt. */
export function bereitZumAufspielen(liste: FernlaufStand[]): FernlaufStand[] {
  return liste.filter((s) => s.moeglich);
}

/** Die Kopfzeile der Karte: „3 Boxen warten auf ihr Kundenkonto · 2 laufen älter als 2026.11.15". */
export function ohneKundenkontoKopf(liste: FernlaufStand[]): string {
  if (liste.length === 0) return 'Keine Box wartet gerade auf ihr Kundenkonto.';
  const satz = `${liste.length} ${liste.length === 1 ? 'Box wartet' : 'Boxen warten'} auf ihr Kundenkonto`;
  const bereit = bereitZumAufspielen(liste);
  const ziel = liste.find((s) => s.neueste)?.neueste ?? null;
  if (bereit.length === 0 || !ziel) return satz;
  return `${satz} · ${bereit.length} ${bereit.length === 1 ? 'läuft' : 'laufen'} älter als ${fassungKurz(ziel)}`;
}

export interface BrauchtDichFernlaufEintrag {
  edgeRef: string;
  titel: string;
  text: string;
  ton: 'warn' | 'off';
}

/**
 * „Braucht dich" der Karte: jede Box, deren letzter Fernlauf zurückgenommen wurde oder offen blieb - mit Grund
 * und (über `edgeRef`) dem Weg in ihre Akte. Ein Fernlauf, der nichts geändert hat (Fenster zu, inzwischen
 * verbunden) oder fertig wurde, braucht niemanden.
 */
export function brauchtDichFernlauf(liste: FernlaufStand[], jetzt: Date): BrauchtDichFernlaufEintrag[] {
  const eintraege: BrauchtDichFernlaufEintrag[] = [];
  for (const s of liste) {
    const f = s.verlauf[0];
    if (!f || (f.zustand !== 'zurueck' && f.zustand !== 'offen')) continue;
    const zeile = verlaufZeile(f, jetzt);
    eintraege.push({ edgeRef: s.edgeRef, titel: s.edgeRef, text: zeile.text, ton: zeile.ton === 'off' ? 'off' : 'warn' });
  }
  return eintraege;
}

/** Der Fortschritt von „Alle aufspielen" (§4.1: nacheinander, einer zur Zeit, Abbruch nach einer Rücknahme). */
export interface AlleAufspielenStand {
  gesamt: number;
  erledigt: number;
  aktuellRef: string | null;
  abgebrochen: { edgeRef: string; grund: string } | null;
}
