/**
 * Berichte in Nachweisen (Konzept Nachweisen n1, Runde 2, §6.4): die reinen Ableitungen der Liste und der Seite eines
 * Berichts. Hier wird nichts gerechnet, was die Route nicht schon festhält: Stände, Anstöße und Abweichungen kommen aus
 * den Bericht-Routen, die Zahlen schreibt `berichtDialoge.vergleichZeilen` (DA1); dieses Modul sortiert, benennt und
 * kürzt sie auf die Text-Grenzen (§0.4).
 */
import type { Bericht, BerichtAbweichung, BerichtAnstoss, BerichtDetail, BerichtStandKurz } from './api';
import { vergleichZeilen, type VergleichZeile } from './berichtDialoge';
import { abzugAus, gueltigerStand } from './berichtSeite';
import type { Erklaerung } from './components/nachweisen/erklaerung';
import type { DatumTon } from './components/nachweisen/nwBild';
import type { ZeichenArt } from './components/nachweisen/NwZeichen';
import type { Stufe } from './components/nachweisen/Stufen';
import type { WertAltNeu } from './components/nachweisen/NwSchritte';
import { UEMS_BERICHTE } from './glossar';
import * as B from './uemsBericht';

export const BERICHTE_TITEL = UEMS_BERICHTE;
export const ERSTELLEN = 'Erstellen';
export const BERICHTE_LADEFEHLER = 'Die Berichte ließen sich gerade nicht laden. Ihre Daten sind nicht betroffen.';
export const WARTET = 'Wartet auf Sie';
export const GELTEN = 'Gelten';
export const ABGELOEST = 'Abgelöst';
export const ARCHIVIERT = 'Archiviert';
export const DATEN_GEAENDERT = 'Daten geändert';
export const ENTWURF = 'Entwurf';
export const ENTSCHEIDEN = 'Entscheiden';
export const FREIGEBEN = 'Freigeben';
export const PDF = 'PDF';
export const ALLE_WERTE = 'Alle Werte';
export const ALLE_AENDERUNGEN = 'Alle Änderungen';
export const NEUER_STAND_FRAGE = 'Neuen Stand freigeben?';
export const WEITER = 'Weiter';
export const ZUR_SEITE_BEWERTUNG = 'Auf der Seite Bewertung lesen';
export const ZUR_SEITE_MANAGEMENTBEWERTUNG = 'Managementbewertung öffnen';
/** Auf der Karte stehen höchstens drei Werte; der Rest eine Zeile tiefer (Konzept §6.4: „drei Werte alt → neu“). */
export const KARTE_HOECHSTENS = 3;

const MANAGEMENTBEWERTUNG = 'managementbewertung';
const BEWERTUNG = 'energetische_bewertung';

/** Der Tag eines Zeitpunkts in der Zone des Berichts (`YYYY-MM-DD`) - ein UTC-Tag wäre um Mitternacht falsch. */
export function tagIn(zeitpunkt: string | null | undefined, zone: string): string | null {
  if (!zeitpunkt) return null;
  const ms = Date.parse(zeitpunkt);
  if (Number.isNaN(ms)) return null;
  return new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
}

/** „12.11.2026“. */
export function tagText(zeitpunkt: string | null | undefined, zone: string): string | null {
  const t = tagIn(zeitpunkt, zone);
  return t ? `${t.slice(8, 10)}.${t.slice(5, 7)}.${t.slice(0, 4)}` : null;
}

/** „12.11.2026, 10:05“. */
export function zeitText(zeitpunkt: string | null | undefined, zone: string): string | null {
  const t = tagText(zeitpunkt, zone);
  if (!t || !zeitpunkt) return null;
  const uhr = new Intl.DateTimeFormat('de-DE', { timeZone: zone, hour: '2-digit', minute: '2-digit' }).format(Date.parse(zeitpunkt));
  return `${t}, ${uhr}`;
}

/**
 * Der Name eines Berichts nach seiner Vorlage (Entscheid 15, C6/B10): „Monatsbericht Oktober 2026“ mit dem Ort darunter,
 * „Energetische Bewertung“ mit dem Zeitraum darunter, „Managementbewertung 2028“, „Leistungsvergleich Dezember 2027“.
 */
export function berichtName(b: Pick<Bericht, 'vorlage' | 'zeitraum_art' | 'zeitraum_text' | 'geltung_art' | 'geltung_name'>): { titel: string; unter: string | null } {
  const wort = B.titelwort(b.vorlage, b.zeitraum_art);
  if (b.vorlage === BEWERTUNG) return { titel: wort, unter: b.zeitraum_text };
  return { titel: `${wort} ${b.zeitraum_text}`, unter: b.geltung_art === 'standort' ? b.geltung_name : null };
}

/** Wohin eine Zeile führt: Bewertung und Managementbewertung haben ihre eigene Seite (Entscheid 15, C9). */
export type BerichtZiel = 'bericht' | 'bewertung' | 'managementbewertung';

export interface BerichtZeile {
  kennung: string;
  titel: string;
  unter: string | null;
  datum: { wort: string; tag: string | null; ton: DatumTon } | null;
  verb: string | null;
  ziel: BerichtZiel;
  /** Der gültige Stand für „PDF“ in der Zeile; ohne Stand kein PDF. */
  pdfNr: number | null;
  /** Am Rechner rechts: „Stand 2“ bzw. „Entwurf“. */
  stand: string;
}

export interface BerichteBild {
  wartet: BerichtZeile[];
  gelten: BerichtZeile[];
  abgeloest: BerichtZeile[];
  archiviert: BerichtZeile[];
  /** Entscheid 3: gezählt wird, was gilt, und was auf eine Entscheidung wartet - nie das Ganze. */
  zaehler: { gelten: number; wartet: number };
}

const abgeloest = (b: Bericht): boolean => b.vorlage === BEWERTUNG && !!b.ueberpruefung?.abgeloest_durch;
const wartet = (b: Bericht): boolean => b.stand_zeichen === 'revision_noetig' || b.neueste_nr === null;

function zeile(b: Bericht): BerichtZeile {
  const name = berichtName(b);
  const ziel: BerichtZiel = b.vorlage === MANAGEMENTBEWERTUNG ? 'managementbewertung' : b.vorlage === BEWERTUNG && !abgeloest(b) ? 'bewertung' : 'bericht';
  const stand = b.neueste_nr === null ? ENTWURF : `Stand ${b.neueste_nr}`;
  if (b.stand_zeichen === 'revision_noetig') {
    return { kennung: b.kennung, titel: name.titel, unter: DATEN_GEAENDERT, datum: { wort: 'seit', tag: tagIn(b.anstoss_seit, b.zeitzone), ton: 'ueber' }, verb: ENTSCHEIDEN, ziel, pdfNr: b.neueste_nr, stand };
  }
  if (b.neueste_nr === null) {
    return { kennung: b.kennung, titel: name.titel, unter: name.unter ?? ENTWURF, datum: { wort: 'seit', tag: tagIn(b.angelegt_am, b.zeitzone), ton: 'bald' }, verb: FREIGEBEN, ziel, pdfNr: null, stand };
  }
  return { kennung: b.kennung, titel: name.titel, unter: name.unter, datum: { wort: 'frei', tag: tagIn(b.freigegeben_am, b.zeitzone), ton: 'plan' }, verb: null, ziel, pdfNr: b.neueste_nr, stand };
}

const neuesteZuerst = (a: Bericht, b: Bericht) => (b.freigegeben_am ?? b.angelegt_am).localeCompare(a.freigegeben_am ?? a.angelegt_am);

/**
 * Die Liste (§6.4): erst, was auf eine Entscheidung wartet (am längsten zuerst), dann was gilt (zuletzt freigegeben
 * zuerst); abgelöste Bewertungen und archivierte Berichte je als eine Zeile mit Zahl.
 */
export function berichteBild(liste: readonly Bericht[]): BerichteBild {
  const offen = liste.filter((b) => b.archiviert_am === null);
  const w = offen.filter(wartet).sort((a, b) => (a.anstoss_seit ?? a.angelegt_am).localeCompare(b.anstoss_seit ?? b.angelegt_am));
  const g = offen.filter((b) => !wartet(b) && !abgeloest(b)).sort(neuesteZuerst);
  const a = offen.filter((b) => !wartet(b) && abgeloest(b)).sort(neuesteZuerst);
  const arch = liste.filter((b) => b.archiviert_am !== null).sort(neuesteZuerst);
  return {
    wartet: w.map(zeile),
    gelten: g.map(zeile),
    abgeloest: a.map(zeile),
    archiviert: arch.map(zeile),
    zaehler: { gelten: offen.filter((b) => b.neueste_nr !== null && !abgeloest(b)).length, wartet: w.length },
  };
}

export const geltenWort = (n: number): string => (n === 1 ? 'gilt' : 'gelten');
export const wartetWort = (n: number, aufSie: boolean): string => `${n === 1 ? 'wartet' : 'warten'}${aufSie ? ' auf Sie' : ''}`;

/** Der i-Knopf am Titel „Berichte“: was ein freigegebener Stand ist (Erklären auf Antippen). */
export function berichteErklaerung(liste: readonly Bericht[]): Erklaerung {
  const beispiel = liste.find((b) => b.neueste_nr !== null && b.archiviert_am === null && b.vorlage !== BEWERTUNG && b.vorlage !== MANAGEMENTBEWERTUNG);
  return {
    frage: 'Was ist ein freigegebener Stand?',
    klartext: 'Ein Bericht fasst Ihre Messwerte für einen Zeitraum zusammen. Freigegeben ist er ein Stand, der sich nie mehr ändert.',
    beiIhnen: beispiel ? `${berichtName(beispiel).titel}: Stand ${beispiel.neueste_nr}.` : null,
    nichtVerwechseln: 'Ändern sich danach Daten, entsteht kein neuer Stand von selbst - Sie entscheiden.',
  };
}

// ------------------------------------------------------------------ Seite eines Berichts

export type SeitenStatus = { zeichen: ZeichenArt; text: string; sub: string | null; warn: boolean };

/** Die offenen Anstöße am gültigen Stand - gebündelt eine Entscheidung (Entscheid 16). */
export function offeneAnstoesse(d: BerichtDetail): BerichtAnstoss[] {
  const g = gueltigerStand(d.staende);
  return g ? d.anstoesse.filter((a) => a.zustand === 'offen' && a.nr === g.nr) : [];
}

/**
 * Die Status-Zeile (§6.4): „● Stand 2 gilt · Daten unverändert“; nach einer Korrektur „● Daten geändert · Stand 1 gilt
 * noch“ im Warnton; ohne Stand „◎ Entwurf“. Am angezeigten älteren Stand „Stand 1 · überholt“.
 */
export function seitenStatus(d: BerichtDetail, gezeigtNr: number | null): SeitenStatus {
  const b = d.bericht;
  const g = gueltigerStand(d.staende);
  if (b.archiviert_am !== null) return { zeichen: 'offen', text: 'archiviert', sub: g ? `· Stand ${g.nr} bleibt lesbar` : null, warn: false };
  if (!g) return { zeichen: 'entwurf', text: ENTWURF, sub: null, warn: false };
  if (gezeigtNr !== null && gezeigtNr !== g.nr) return { zeichen: 'offen', text: `Stand ${gezeigtNr}`, sub: '· überholt', warn: false };
  if (offeneAnstoesse(d).length > 0) return { zeichen: 'ueber', text: DATEN_GEAENDERT, sub: `· Stand ${g.nr} gilt noch`, warn: true };
  if (b.stand_zeichen === 'anstoss_verworfen') return { zeichen: 'festgehalten', text: `Stand ${g.nr} gilt`, sub: '· Änderung nicht übernommen', warn: false };
  return { zeichen: 'festgehalten', text: `Stand ${g.nr} gilt`, sub: '· Daten unverändert', warn: false };
}

/**
 * Die Stufen (§6.4): „Entwurf · Stand 1 · Stand 2“ mit Tag; wartet ein neuer Stand, steht er offen dahinter. Mehr als
 * drei Stände kürzen auf die letzten beiden - die ganze Folge steht in „Stände“.
 */
export function stufen(d: BerichtDetail): Stufe[] {
  const b = d.bericht;
  const zone = b.zeitzone;
  const staende = [...d.staende].sort((x, y) => x.nr - y.nr);
  const ohneStand = staende.length === 0;
  const raus: Stufe[] = [{ titel: ENTWURF, datum: tagText(b.angelegt_am, zone), zustand: ohneStand ? 'an' : 'done' }];
  const gezeigt = staende.length > 3 ? staende.slice(-2) : staende;
  for (const s of gezeigt) raus.push({ titel: `Stand ${s.nr}`, datum: tagText(s.freigegeben_am, zone), zustand: 'done' });
  if (ohneStand) raus.push({ titel: 'Stand 1', datum: null, zustand: 'offen' });
  else if (offeneAnstoesse(d).length > 0) raus.push({ titel: `Stand ${staende[staende.length - 1].nr + 1}`, datum: null, zustand: 'an' });
  return raus;
}

/** Die ältere Fassung eines Stands: der Stand, den er ersetzt hat. */
export const vorigerStand = (d: BerichtDetail, nr: number): BerichtStandKurz | null => d.staende.find((s) => s.ersetzt_durch_nr === nr) ?? null;

const ZAHL_UND_EINHEIT = /^([−-]?[\d.]+(?:,\d+)?)[  ](.+)$/;

/** „6.100 kWh“ → „6.100“ und „kWh“: die Einheit steht in der Zeile einmal (§6.4: „6.100 → 6.040 kWh“). */
function teile(text: string): { zahl: string; einheit: string | null } {
  const m = ZAHL_UND_EINHEIT.exec(text);
  return m ? { zahl: m[1], einheit: m[2] } : { zahl: text, einheit: null };
}

/**
 * Werte alt → neu (Entscheid 16: nur Zahlen, ohne Version und Anlass): aus den Zeilen des Vergleichs. Eine Zeile ohne
 * Namen trägt ihr Kennzeichen; Einheiten, die sich unterscheiden, bleiben an der Zahl.
 */
export function werteAltNeu(zeilen: readonly VergleichZeile[]): WertAltNeu[] {
  return zeilen.map((z) => {
    const alt = teile(z.vorher);
    const neu = teile(z.nachher);
    const gleich = alt.einheit !== null && alt.einheit === neu.einheit;
    const einheit = gleich ? alt.einheit : (neu.einheit ?? alt.einheit);
    return {
      name: z.name ?? z.quelle,
      alt: z.vorher === B.OHNE_ZAHL ? null : gleich || alt.einheit === null ? alt.zahl : z.vorher,
      neu: z.nachher === B.OHNE_ZAHL ? null : gleich || neu.einheit === null ? neu.zahl : z.nachher,
      einheit: gleich || (alt.einheit === null) !== (neu.einheit === null) ? einheit : null,
    };
  });
}

/** Die Werte zwischen zwei Abzügen (Stand gegen Stand, R1-Zwilling) als Zeilen wie im Vergleich der Route. */
export function standVergleich(alt: Record<string, unknown>, neu: Record<string, unknown>): VergleichZeile[] {
  return vergleichZeilen(B.abweichungen(alt as Parameters<typeof B.abweichungen>[0], neu as Parameters<typeof B.abweichungen>[1]) as BerichtAbweichung[], abzugAus(neu), abzugAus(alt));
}

/**
 * Der Grund einer Änderung: die Korrektur, die den Anstoß gab, mit ihrem Warum aus dem Qualitäts-Abschnitt („Ablesung
 * korrigiert“). `kurz` hat höchstens vier Wörter für die Fußnote, `ganz` steht im Blatt.
 */
export function aenderungsGrund(
  anstoss: Pick<BerichtAnstoss, 'anlass_kennung' | 'anlass_text' | 'erkannt_am'> | null,
  abzug: Record<string, unknown> | null,
  zone: string,
): { kurz: string; ganz: string; wer: string | null } | null {
  if (!anstoss) return null;
  const korrekturen = (abzug ? abzugAus(abzug).qualitaet.korrekturen : undefined) ?? [];
  const k = korrekturen.find((x) => x.kennung === anstoss.anlass_kennung) ?? null;
  const warum = k?.warum?.trim() || null;
  const quelle = warum ?? anstoss.anlass_text;
  const woerter = quelle.replace(/[.!?]$/, '').split(/\s+/);
  return {
    kurz: woerter.length <= 4 ? woerter.join(' ') : `${woerter.slice(0, 4).join(' ')} …`,
    ganz: warum ? `${anstoss.anlass_text}: ${warum}` : anstoss.anlass_text,
    wer: k ? `${k.wer}, ${zeitText(k.freigegeben, zone) ?? ''}`.replace(/, $/, '') : `erkannt ${zeitText(anstoss.erkannt_am, zone) ?? ''}`.trim(),
  };
}

/** „Stand 3 freigeben“ / „Stand 2 behalten“ - die zwei Antworten nach einer Korrektur (Entscheid 16). */
export const jaAntwort = (nr: number): string => `Ja, Stand ${nr} freigeben`;
export const neinAntwort = (nr: number): string => `Nein, Stand ${nr} behalten`;

/** Bewertung und Managementbewertung zeigen ihre Abschnitte auf ihrer eigenen Seite (Entscheid 15). */
export const eigeneSeite = (b: Pick<Bericht, 'vorlage' | 'ueberpruefung'>): BerichtZiel =>
  b.vorlage === MANAGEMENTBEWERTUNG ? 'managementbewertung' : b.vorlage === BEWERTUNG && !b.ueberpruefung?.abgeloest_durch ? 'bewertung' : 'bericht';
