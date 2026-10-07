import type {
  Auffaelligkeit,
  Bezugsbasis,
  BezugsbasisFassung,
  BezugsbasisUrteil,
  Energieziel,
  Kennzahl,
  KennzahlAuswertung,
  KennzahlAuswertungMonat,
  KennzahlAuswertungZeitraum,
} from './api';
import { abweichungKurz, prozentText, urteilAnsicht, type UrteilTon } from './bezugsbasisUrteil';
import { dezimal, einheitJe, referenzperiodeText } from './bezugsbasisAnlegen';
import { freigeberText, wertText } from './bezugsbasisFassungen';
import type {
  BezugsbasisVergleich,
  BezugsbasisVergleichBedingung,
  BezugsbasisVergleichFassung,
  BezugsbasisVergleichMonat,
} from './bezugsbasisVergleich';
import { UEMS_BEZUGSBASIS, UEMS_ENERGIEZIEL } from './glossar';
import { grundKurz, ortText, vorjahrText, zahlUndEinheit, zielJahre, zielWert } from './kennzahlListe';
import { TRENNER, zahlMitStellen } from './uemsErgebnis';
import { einheitWort, MONATSNAMEN, periodeText } from './uemsKennzahl';

/**
 * Die Seite einer Kennzahl (Konzept Auswerten a1 §6.5, §6.12-§6.14) - REIN: aus der Auswertung des Servers
 * (`GET /api/v1/kennzahlen/{id}?mit=auswertung`), den Zeilen seines Vergleichs (`…/vergleich`), der laufenden Bezugsbasis,
 * dem offenen Energieziel und der offenen Auffälligkeit die Antwort zuerst, die Verlässlichkeit, die Kacheln, die
 * Monatsgrafik und die Monatsliste.
 *
 * Gerechnet wird hier nichts: Urteil, Abweichungen, Mengen (gemessen, erwartet, gemessen − erwartet, zusammengezählt) und
 * die Veränderungen zu Vorjahr und Vormonat kommen fertig vom Server; das Modul wählt, benennt und rundet nur zur Anzeige.
 * Ein Monat ohne Wert bleibt leer - nie 0.
 */

// ------------------------------------------------------------------ Wörter der Fläche

export const TITEL_JE_MONAT = `Je Monat gegen die ${UEMS_BEZUGSBASIS}`;
export const TITEL_JE_MONAT_OHNE = 'Je Monat';
export const ZWOELF_MONATE = '12 Monate';
export const TITEL_WERTE = 'Werte je Monat';
export const NEUESTE_ZUERST = 'neueste zuerst';
export const alleMonate = (n: number): string => `Alle ${n} Monate`;
export const TITEL_WORAUS = 'Woraus gerechnet';
export const WIE_GERECHNET = 'Wie wird gerechnet?';
export const TITEL_BEZUGSBASIS = UEMS_BEZUGSBASIS;
export const ALLE_FASSUNGEN = 'Alle Fassungen';
export const NEUE_FASSUNG = 'Neue Fassung bilden';
export const TITEL_UEBER = 'Über diese Kennzahl';
export const TITEL_ZUSAMMEN = 'Zusammengezählt';
export const ZUM_ZIEL = `Zum ${UEMS_ENERGIEZIEL}`;
export const BEZUGSBASIS_ANSEHEN = `${UEMS_BEZUGSBASIS} ansehen`;
export const BEZUGSBASIS_FESTLEGEN = `${UEMS_BEZUGSBASIS} festlegen`;
export const BEANTWORTEN = 'Beantworten';
export const KACHEL_GEMESSEN = 'Gemessen';
export const KACHEL_ERWARTET = 'Erwartet';
export const TIPP_HANDY = 'Monat antippen oder mit dem Finger über die Säulen fahren';
export const TIPP_RECHNER = 'Monat anklicken oder mit den Pfeiltasten wechseln';
export const LEGENDE_MEHR = 'mehr als erwartet';
export const LEGENDE_WENIGER = 'weniger als erwartet';
export const legendeRahmen = (band: string): string => `im Rahmen (± ${band} %)`;
export const LEGENDE_JAHR = 'dieses Jahr';
export const LEGENDE_VORJAHR = 'Vorjahr';
export const ACHSE_MEHR = 'mehr';
export const ACHSE_WENIGER = 'weniger';
export const SKALA_MEHR = 'mehr als erwartet';
export const SKALA_WENIGER = 'weniger als erwartet';
export const SKALA_MITTE = UEMS_BEZUGSBASIS;
export const SPALTEN_WERTE = ['Monat', 'Gemessen', 'Bedingung', 'Erwartet', 'Abweichung', 'Urteil'] as const;
export const SPALTEN_WERTE_OHNE = ['Monat', 'Wert', 'Vorjahr', 'Veränderung'] as const;
export const OHNE_BEZUGSBASIS_SATZ = `Noch keine ${UEMS_BEZUGSBASIS} - ohne sie vergleicht VoltPilot nur mit dem Vorjahr.`;
export const OHNE_FASSUNG_SATZ = 'Noch keine freigegebene Fassung - verglichen wird erst mit ihr.';
export const SEITE_LADEFEHLER = 'Die Kennzahl ließ sich gerade nicht laden. Ihre Daten sind nicht betroffen.';
export const VERGLEICH_LADEFEHLER = 'Der Vergleich mit der Bezugsbasis ließ sich gerade nicht laden. Ihre Daten sind nicht betroffen.';

const MONATSKUERZEL = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

const ZAHLWOERTER = ['null', 'ein', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn', 'elf', 'zwölf'];
/** „zwölf“ - Zahlen bis zwölf als Wort (Fließtext), darüber als Ziffer. */
export const zahlWort = (n: number): string => ZAHLWOERTER[n] ?? String(n);

/** „Von April 2028 bis März 2029 gibt es noch keinen Monatswert.“ - statt zwölf leerer Säulen. */
export const ohneWerteSatz = (von: string, bis: string): string => `Von ${monatLang(von)} bis ${monatLang(bis)} gibt es noch keinen Monatswert.`;

/** „März 2029“. */
export const monatLang = (periode: string): string => periodeText('monat', periode);
/** „Mär“ - unter der Säule; ganz schmal der Anfangsbuchstabe (CSS). */
export const monatKurz = (periode: string): string => MONATSKUERZEL[Number(periode.slice(5, 7)) - 1] ?? periode;
/**
 * Der Stichtag einer Seite (`JJJJ-MM-TT`): der erste Tag nach dem Monat des Urteils - so weit ist der Server (in der
 * Demo seine Bühnen-Uhr); ohne Auswertung der Tag im Browser (`ersatz`). Er sagt, ob eine Fassung „seit“ oder erst „ab“
 * einem Tag gilt.
 */
export function stichtag(monat: string | null | undefined, ersatz: string): string {
  if (!monat) return ersatz;
  const j = Number(monat.slice(0, 4));
  const m = Number(monat.slice(5, 7));
  return m === 12 ? `${j + 1}-01-01` : `${j}-${String(m + 1).padStart(2, '0')}-01`;
}

/**
 * Der Tag, an dem sich das Urteil entscheidet (`JJJJ-MM-TT`): der letzte Tag des Monats der Auswertung - die Fassung, die
 * an ihm gilt, hat das Urteil gerechnet (P4). Beginnt nach einer Überprüfung am Stichtag eine neue Fassung, gehören
 * Karte und „vorläufig“ neben dem Urteil trotzdem zur alten (Review r3). Ohne Auswertung wie {@link stichtag}.
 */
export function urteilsTag(monat: string | null | undefined, ersatz: string): string {
  if (!monat) return ersatz;
  const ende = new Date(Date.UTC(Number(monat.slice(0, 4)), Number(monat.slice(5, 7)), 0)).getUTCDate();
  return `${monat}-${String(ende).padStart(2, '0')}`;
}

/** „01.11.2027“ aus `JJJJ-MM-TT`. */
export const tagText = (tag: string): string => `${tag.slice(8, 10)}.${tag.slice(5, 7)}.${tag.slice(0, 4)}`;

// ------------------------------------------------------------------ Zahlen (nur Anzeige)

/** Ein Kennzahlwert ohne Einheit, zwei Stellen wie die Karte (U4): „20,64“. */
export const zahlKurz = (wert: string, einheit: string | null): string => zahlUndEinheit(wert, einheit).zahl ?? '';

/** Eine Menge in ganzen Einheiten (AP-08 E11, Monat): „88.740 kWh“. */
export const mengeText = (wert: string, einheit: string): string => zahlMitStellen(wert, 0, einheit);
/** Eine Bedingung: ganze Einheiten ab 100, sonst eine Stelle - „306.000 kg“, „48,5 Kd“. */
function bedingungZahl(wert: string, einheit: string): string {
  const n = Number(wert);
  return zahlMitStellen(wert, Number.isFinite(n) && Math.abs(n) >= 100 ? 0 : 1, einheit);
}

/**
 * „306.000 kg Produktionsmenge“ · zwei Einflussgrößen mit „und“; `kurz` ohne Namen („306.000 kg“). Fehlt ein Wert,
 * `null` - dann gibt es auch kein erwartet.
 */
export function bedingungSatz(bedingung: readonly BezugsbasisVergleichBedingung[], kurz = false): string | null {
  const teile = [...bedingung].sort((a, b) => a.position - b.position);
  if (teile.length === 0 || teile.some((b) => b.wert === null)) return null;
  return teile.map((b) => `${bedingungZahl(b.wert as string, b.einheit)}${kurz ? '' : ` ${b.name}`}`).join(' und ');
}

/**
 * „der Prozess Spritzguss“ · „das Gebäude Halle 1“ · „das Unternehmen“ - der Gegenstand des Antwortsatzes; `akkusativ`
 * nach „für“: „den Prozess Spritzguss“.
 */
export function ortImSatz(k: Pick<Kennzahl, 'geltung_art' | 'geltung_name'>, akkusativ = false): string {
  const artikel: Record<Kennzahl['geltung_art'], string> = {
    unternehmen: 'das',
    standort: 'der',
    gebaeude: 'das',
    bereich: 'der',
    prozess: 'der',
    kostenstelle: 'die',
    messstelle: 'die',
  };
  const art = artikel[k.geltung_art];
  return `${akkusativ && art === 'der' ? 'den' : art} ${ortText(k)}`;
}

// ------------------------------------------------------------------ Monate

/** Wie ein Monat der zwölf aussieht: Urteilsfarbe, umrissen ohne Urteil, leer ohne Abweichung. */
export type MonatArt = 'schlechter' | 'besser' | 'im_rahmen' | 'ohne_urteil' | 'leer';

export interface SeitenMonat {
  periode: string;
  lang: string;
  kurz: string;
  art: MonatArt;
  /** Die bereinigte Abweichung (Dezimaltext des Servers) - nur für die Lage der Säule. */
  delta: string | null;
  /** „+2,2 %“ - mit Vorzeichen, für Liste und Tabelle; `null` ohne Abweichung. */
  deltaZeichen: string | null;
  urteil: { wort: string; ton: UrteilTon } | null;
  /** „88.740 kWh“ / „86.812 kWh“ / „306.000 kg Produktionsmenge“ - aus der Zeile des Vergleichs. */
  gemessen: string | null;
  erwartet: string | null;
  /** Nur die Zahl von erwartet: „86.812“ (Infozeile: „statt 86.812 erwartet“). */
  erwartetZahl: string | null;
  /** Die Einheit von gemessen und erwartet (Zähler der Kennzahl): „kWh“. */
  mengeEinheit: string;
  bedingung: string | null;
  bedingungKurz: string | null;
  /** Der Kennzahlwert „0,29 kWh je kg“. */
  wert: string | null;
  /** Der Satz der Infozeile, wenn der Monat kein Urteil trägt (der Kundensatz des Servers). */
  grundSatz: string | null;
  /** Die zusammengezählte Abweichung bis hierher (Dezimaltext; nur Monate mit Urteil). */
  zusammen: string | null;
  /** Die Mengen der Zeile als Dezimaltext des Servers - nur für die Anzeige ohne Einheit. */
  mengen: { gemessen: string | null };
  /** Wie die Fassung des Monats erwartet (Zeile des Vergleichs): nur das Verhältnis rechnet „Wert mal Bedingung“. */
  methode: BezugsbasisVergleichFassung['methode'] | null;
}

/** „+2,2 %“ · „−3,4 %“ · „0,0 %“ - die Abweichung mit Vorzeichen (echtes Minus). */
export function deltaMitZeichen(delta: string): string {
  const betrag = prozentText(delta);
  if (delta.trim().startsWith('-')) return `−${betrag}`;
  return Number(delta) === 0 ? betrag : `+${betrag}`;
}

function monatArt(m: KennzahlAuswertungMonat): MonatArt {
  if (m.delta_prozent === null) return 'leer';
  return m.urteil === 'schlechter' || m.urteil === 'besser' || m.urteil === 'im_rahmen' ? m.urteil : 'ohne_urteil';
}

/** Die zwölf Monate der Seite aus der Auswertung und - mit Bezugsbasis - den Zeilen des Vergleichs. */
export function seitenMonate(k: Kennzahl, vergleich: BezugsbasisVergleich | null): SeitenMonat[] {
  const a = k.auswertung;
  if (!a) return [];
  const zeilen = new Map<string, BezugsbasisVergleichMonat>((vergleich?.monate ?? []).map((z) => [z.periode, z]));
  return a.monate.map((m) => {
    const z = zeilen.get(m.periode) ?? null;
    const b = z?.bereinigt ?? null;
    const einheit = b?.gemessen.einheit ?? '';
    const w = zahlUndEinheit(m.wert, k.einheit);
    return {
      periode: m.periode,
      lang: monatLang(m.periode),
      kurz: monatKurz(m.periode),
      art: monatArt(m),
      delta: m.delta_prozent,
      deltaZeichen: m.delta_prozent === null ? null : deltaMitZeichen(m.delta_prozent),
      urteil: urteilAnsicht(m.urteil),
      gemessen: b?.gemessen.wert ? mengeText(b.gemessen.wert, einheit) : null,
      erwartet: b?.erwartet ? mengeText(b.erwartet, einheit) : null,
      erwartetZahl: b?.erwartet ? mengeText(b.erwartet, '').trimEnd() : null,
      mengeEinheit: einheit,
      bedingung: b ? bedingungSatz(b.bedingung) : null,
      bedingungKurz: b ? bedingungSatz(b.bedingung, true) : null,
      wert: w.zahl === null ? null : [w.vor, w.zahl, w.einheit].filter(Boolean).join(' '),
      grundSatz: monatArt(m) === 'schlechter' || monatArt(m) === 'besser' || monatArt(m) === 'im_rahmen' ? null : (z?.satz ?? null),
      zusammen: m.zusammen ?? null,
      mengen: { gemessen: b?.gemessen.wert ?? null },
      methode: b?.fassung?.methode ?? null,
    };
  });
}

/** Die Infozeile über der Grafik: immer ein Monat, zuerst der jüngste; nichts legt sich über die Säulen. */
export interface Infozeile {
  monat: string;
  wert: string | null;
  statt: string | null;
  urteil: { text: string; ton: UrteilTon | 'leise' } | null;
}

export function infozeile(m: SeitenMonat, vorjahr: { wert: string | null; text: string | null } | null = null): Infozeile {
  if (m.delta !== null && m.gemessen && m.erwartet) {
    const satz = abweichungKurz(m.delta, Number(m.delta) > 0 ? 'mehr' : Number(m.delta) < 0 ? 'weniger' : 'gleich');
    return {
      monat: m.lang,
      wert: m.gemessen,
      statt: `statt ${m.erwartetZahl} erwartet`,
      urteil: m.urteil ? { text: `${satz}${TRENNER}${m.urteil.wort}`, ton: m.urteil.ton } : { text: `${satz}${TRENNER}ohne Urteil`, ton: 'leise' },
    };
  }
  // Ohne Bezugsbasis (oder vor ihrer ersten Fassung): der Wert gegen das Vorjahr, roh und ohne Farbe.
  if (vorjahr) {
    return {
      monat: m.lang,
      wert: m.wert ?? 'kein Wert',
      statt: vorjahr.wert ? `Vorjahr ${vorjahr.wert}` : 'ohne Vorjahreswert',
      urteil: vorjahr.text ? { text: vorjahr.text, ton: 'neutral' } : m.grundSatz ? { text: grundOhneMonat(m.grundSatz, m.lang), ton: 'leise' } : null,
    };
  }
  return {
    monat: m.lang,
    wert: m.wert,
    statt: null,
    urteil: { text: m.grundSatz ? grundOhneMonat(m.grundSatz, m.lang) : 'kein Wert', ton: 'leise' },
  };
}

/** Der Kundensatz des Servers beginnt mit dem Monat („März 2028: nicht bewertbar - …“); die Infozeile nennt ihn schon. */
function grundOhneMonat(satz: string, monat: string): string {
  return satz.startsWith(`${monat}: `) ? satz.slice(monat.length + 2) : satz;
}

// ------------------------------------------------------------------ Antwort zuerst

export interface Antwort {
  satz: string;
  /** Der sachliche Untertitel: Einheit · Ort · Vergleichsmaßstab. `basis` ist antippbar (punktiert). */
  formal: { vor: string; basis: string | null };
  marke: { text: string; art: 'warn' | 'ok' | 'neutral' | 'ohne' } | null;
}

/**
 * Der Antwortsatz (§6.1 Regel 1, SP4: jede Zahl mit Richtung trägt ihre Bedingung) für den Monat des Urteils:
 * „Im März 2029 brauchte der Prozess Spritzguss 2,2 % mehr Energie, als die Bezugsbasis bei 306.000 kg Produktionsmenge
 * erwarten ließ.“ Ohne Urteil nennt er den Wert; ohne Bezugsbasis den Vergleich mit dem Vorjahr (roh, ohne Urteil).
 */
export function antwort(k: Kennzahl, monate: readonly SeitenMonat[]): Antwort | null {
  const a = k.auswertung;
  if (!a) return null;
  const einheit = k.einheit_anzeige ?? (k.einheit ? einheitWort(k.einheit) : '');
  const v = a.vergleich;
  const m = monate.find((x) => x.periode === a.monat) ?? null;
  if (v) {
    const formal = { vor: [einheit, ortText(k), 'verglichen mit der'].filter(Boolean).join(TRENNER), basis: v.bezugsbasis ? `${UEMS_BEZUGSBASIS} ${v.bezugsbasis}` : UEMS_BEZUGSBASIS };
    const u = urteilAnsicht(v.urteil);
    if (m && v.delta_prozent !== null && m.bedingung && v.richtung) {
      const was =
        v.richtung === 'gleich'
          ? 'genau so viel Energie, wie'
          : `${prozentText(v.delta_prozent)} ${v.richtung === 'weniger' ? 'weniger' : 'mehr'} Energie, als`;
      return {
        satz: `Im ${m.lang} brauchte ${ortImSatz(k)} ${was} die ${UEMS_BEZUGSBASIS} bei ${m.bedingung} erwarten ließ.`,
        formal,
        marke: u ? { text: u.wort, art: u.ton === 'neutral' ? 'neutral' : u.ton } : { text: 'ohne Urteil', art: 'ohne' },
      };
    }
    return { satz: wertSatz(k, a), formal, marke: { text: grundKurz(v.grund, a.monat, v.erster_monat), art: 'ohne' } };
  }
  const vj = vorjahrText(a.vorjahr);
  return {
    satz: wertSatz(k, a, true),
    formal: { vor: [einheit, ortText(k), `ohne ${UEMS_BEZUGSBASIS}`].filter(Boolean).join(TRENNER), basis: null },
    marke: vj ? { text: vj, art: 'neutral' } : null,
  };
}

/** „Im März 2029 lag das Gebäude Halle 1 bei 20,64 kWh je m² - genauso viel wie im März 2028.“ */
function wertSatz(k: Kennzahl, a: KennzahlAuswertung, mitVorjahr = false): string {
  if (!a.wert) return `Für ${monatLang(a.monat)} gibt es noch keinen Wert.`;
  const w = zahlUndEinheit(a.wert.wert, a.wert.einheit ?? k.einheit, a.wert.richtung);
  const zahl = [w.vor, w.zahl, w.einheit].filter(Boolean).join(' ');
  const vj = mitVorjahr && a.vorjahr ? vorjahrNebensatz(a.vorjahr) : null;
  return `Im ${monatLang(a.wert.periode)} lag ${ortImSatz(k)} bei ${zahl}${vj ? ` - ${vj}` : ''}.`;
}

function vorjahrNebensatz(v: NonNullable<KennzahlAuswertung['vorjahr']>): string {
  const d = Number(v.delta_prozent);
  const im = `im ${monatLang(v.periode)}`;
  if (!Number.isFinite(d) || Math.abs(d) < 0.5) return `genauso viel wie ${im}`;
  return `${prozentText(v.delta_prozent, 0)} ${d > 0 ? 'mehr' : 'weniger'} als ${im}`;
}

// ------------------------------------------------------------------ Verlässlichkeit

export type VertrauenWeg = 'bezugsbasis' | 'festlegen' | null;

export interface Vertrauen {
  art: 'warn' | 'info';
  fett: string | null;
  satz: string;
  weg: { wort: string; ziel: VertrauenWeg } | null;
}

/**
 * Ein Satz mit Grund und Weg direkt unter der Antwort (§6.1 Regel 2): vorläufige Bezugsbasis, noch kein Vergleich, kein
 * Urteil für den Monat, Überprüfung fällig, ohne Bezugsbasis. Ohne Anlass `null` - kein Hinweis aus Gewohnheit.
 */
export function vertrauen(
  k: Kennzahl,
  lage: { basis: Bezugsbasis; fassung: BezugsbasisFassung | null } | null,
  darfFestlegen: boolean,
): Vertrauen | null {
  const a = k.auswertung;
  if (!a) return null;
  const v = a.vergleich;
  if (!v) {
    if (k.rechenform === 'anteil') return null;
    return {
      art: 'info',
      fett: null,
      satz: 'Ohne Bezugsbasis vergleicht VoltPilot nur mit dem Vorjahr - Wetter und Auslastung sind darin nicht herausgerechnet.',
      weg: darfFestlegen ? { wort: BEZUGSBASIS_FESTLEGEN, ziel: 'festlegen' } : null,
    };
  }
  const ansehen = { wort: BEZUGSBASIS_ANSEHEN, ziel: 'bezugsbasis' as const };
  if (v.grund === 'basis_fehlt' && v.erster_monat) {
    return { art: 'info', fett: null, satz: `Die ${UEMS_BEZUGSBASIS} gilt erst ab ${monatLang(v.erster_monat)}; ein Urteil gibt es, sobald dieser Monat abgeschlossen ist.`, weg: ansehen };
  }
  // Eine fällige Überprüfung ist ein Schritt für eine Person - sie steht vor „kein Urteil“, dessen Grund die Marke der
  // Antwort schon nennt (Review r3: sonst verschwände „fällig“ in jedem Monat ohne Wert).
  const frist = lage?.basis.frist ?? null;
  if (frist?.ueberpruefung_faellig && frist.faellig_am) {
    return { art: 'warn', fett: `${UEMS_BEZUGSBASIS} seit ${tagText(frist.faellig_am)} zur Überprüfung fällig.`, satz: 'Ist sie noch die richtige Messlatte?', weg: { wort: 'Bestätigen oder neu fassen', ziel: 'bezugsbasis' } };
  }
  if (v.urteil === 'ohne_urteil' || v.urteil === 'nicht_anwendbar') {
    return { art: 'warn', fett: 'Kein Urteil für diesen Monat:', satz: v.satz ? grundOhneMonat(v.satz, monatLang(a.monat)) : 'die Werte reichen nicht für einen Vergleich.', weg: ansehen };
  }
  const f = lage?.fassung ?? null;
  if (f && f.datenlage === 'vorlaeufig') {
    const monate = f.monate > 0 ? f.monate : null;
    const aus = monate === 1 ? `aus einem einzigen Monat (${referenzperiodeText(f.referenzperiode)})` : monate ? `aus ${monate} von ${f.mindest_monate} Monaten` : 'aus weniger Monaten als vorgesehen';
    return { art: 'warn', fett: 'Vorsicht beim Lesen:', satz: `Die ${UEMS_BEZUGSBASIS} stammt ${aus} und ist vorläufig.`, weg: ansehen };
  }
  return null;
}

// ------------------------------------------------------------------ Kacheln

export interface Kacheln {
  monat: string;
  zahl: string | null;
  einheit: string | null;
  marken: { text: string; art: 'warn' | 'ok' | 'neutral' | 'ohne' }[];
  /** „erwartet **0,28 kWh je kg** bei 306.000 kg“ - der erwartete Kennzahlwert und die Bedingung. */
  erwartetWert: { wert: string; bei: string | null } | null;
  /** „88.740 kWh“ mit „**1.928 kWh mehr** als erwartet“ (gemessen − erwartet des Servers). */
  gemessen: { zahl: string; einheit: string; fett: string; rest: string } | null;
  /** „86.812 kWh“ „bei 306.000 kg Produktionsmenge“. */
  erwartet: { zahl: string; einheit: string; unter: string } | null;
}

/** Die Kachel des Monats mit Urteil und Vormonat (ohne Farbe, Pfeil ab 0,5 %), dazu gemessen und erwartet in Mengen. */
export function kacheln(k: Kennzahl, monate: readonly SeitenMonat[]): Kacheln | null {
  const a = k.auswertung;
  if (!a) return null;
  const m = monate.find((x) => x.periode === a.monat) ?? null;
  const am = a.monate.find((x) => x.periode === a.monat) ?? null;
  const wert = a.wert && a.wert.periode === a.monat ? zahlUndEinheit(a.wert.wert, a.wert.einheit ?? k.einheit, a.wert.richtung) : null;
  const marken: Kacheln['marken'] = [];
  if (m?.urteil) marken.push({ text: m.urteil.wort, art: m.urteil.ton === 'neutral' ? 'neutral' : m.urteil.ton });
  // Ohne Urteil für den Monat: warum - „Vergleich ab Juni 2029“, „März 2029: außerhalb der Spanne“ (wie die Liste).
  // „noch kein Wert“ sagt die Kachel ohne Wert schon groß; die Marke wiederholte es nur.
  else if (a.vergleich && !(a.vergleich.grund === 'keine_werte' && !wert)) {
    marken.push({ text: grundKurz(a.vergleich.grund, a.monat, a.vergleich.erster_monat), art: 'ohne' });
  }
  const vm = a.vormonat ?? null;
  if (vm && wert) marken.push({ text: vormonatText(vm.delta_prozent), art: 'neutral' });
  if (!m?.urteil && !a.vergleich && a.vorjahr && wert) {
    const vj = vorjahrText(a.vorjahr);
    if (vj) marken.unshift({ text: vj, art: 'neutral' });
  }
  const ew = am?.erwartet_wert ? zahlUndEinheit(am.erwartet_wert, k.einheit) : null;
  const abw = am?.abweichung ?? null;
  const gemessenZahl = m?.mengen.gemessen ? mengeText(m.mengen.gemessen, '').trimEnd() : null;
  const abweichung = abw !== null && m ? abweichungMenge(abw, m.mengeEinheit) : null;
  return {
    monat: monatLang(a.monat),
    zahl: wert ? [wert.vor, wert.zahl].filter(Boolean).join(' ') : null,
    einheit: wert?.einheit ?? null,
    marken,
    erwartetWert: ew?.zahl ? { wert: [ew.zahl, ew.einheit].filter(Boolean).join(' '), bei: m?.bedingungKurz ?? null } : null,
    gemessen:
      m && gemessenZahl && abweichung
        ? { zahl: gemessenZahl, einheit: m.mengeEinheit, fett: abweichung.fett, rest: abweichung.rest }
        : null,
    erwartet: m?.erwartetZahl && m.bedingung ? { zahl: m.erwartetZahl, einheit: m.mengeEinheit, unter: `bei ${m.bedingung}` } : null,
  };
}

/** „▼ 2 % ggü. Vormonat“ · „unverändert ggü. Vormonat“ - roh, ohne Farbe, Pfeil ab 0,5 %. */
export function vormonatText(delta: string): string {
  const d = Number(delta);
  if (!Number.isFinite(d) || Math.abs(d) < 0.5) return 'unverändert ggü. Vormonat';
  return `${d > 0 ? '▲' : '▼'} ${prozentText(delta, 0)} ggü. Vormonat`;
}

/** „**1.928 kWh mehr** als erwartet“ · „genau wie erwartet“ - die Menge des Servers (gemessen − erwartet). */
export function abweichungMenge(abweichung: string, einheit: string): { fett: string; rest: string } {
  const n = Number(abweichung);
  if (n === 0) return { fett: 'genau', rest: ' wie erwartet' };
  return { fett: `${mengeText(abweichung.replace(/^-/, ''), einheit)} ${n > 0 ? 'mehr' : 'weniger'}`, rest: ' als erwartet' };
}

// ------------------------------------------------------------------ Grafik: Fazit und Zusammengezählt

/**
 * Das Fazit unter der Grafik: der Zeitraum ab Gültigkeit der Bezugsbasis (Σ ÷ Σ des Servers, §10.6) und wie viele seiner
 * Monate über, im Rahmen und unter der Bezugsbasis liegen. Ohne Zeitraum `null`.
 */
export function fazit(z: KennzahlAuswertungZeitraum | null | undefined, monate: readonly SeitenMonat[]): { fett: string; rest: string } | null {
  if (!z) return null;
  const spanne = `${monatLang(z.von)} bis ${monatLang(z.bis)}`;
  const drin = monate.filter((m) => m.periode >= z.von && m.periode <= z.bis);
  const zaehle = (art: MonatArt) => drin.filter((m) => m.art === art).length;
  const ueber = zaehle('schlechter');
  const rahmen = zaehle('im_rahmen');
  const besser = zaehle('besser');
  // Nur, was vorkommt: „10 von 12 Monaten über der Bezugsbasis, 2 im Rahmen“ · „6 von 6 Monaten im Rahmen“.
  const arten = [
    { n: ueber, wort: `über der ${UEMS_BEZUGSBASIS}` },
    { n: rahmen, wort: 'im Rahmen' },
    { n: besser, wort: `besser als die ${UEMS_BEZUGSBASIS}` },
  ].filter((x) => x.n > 0);
  const teile = arten.map((x, i) => (i === 0 ? `${x.n} von ${drin.length} ${drin.length === 1 ? 'Monat' : 'Monaten'} ${x.wort}` : `${x.n} ${x.wort}`));
  if (z.delta_prozent === null || z.urteil === 'nicht_anwendbar') return { fett: `${spanne}: kein Vergleich über den Zeitraum`, rest: `; ${z.satz}` };
  const delta = z.richtung === 'gleich' ? 'genau wie erwartet' : `${abweichungKurz(z.delta_prozent, z.richtung)} als erwartet`;
  return { fett: `${spanne}: ${delta}`, rest: teile.length > 0 ? `; ${teile.join(', ')}.` : '.' };
}

/**
 * Der Endwert von „Zusammengezählt“: „5.659 kWh mehr“ seit dem ersten Monat mit Urteil; `ton` ist die Farbe der Linie
 * (mehr als erwartet im Warnton, sonst grün). Unter zwei Monaten mit Urteil gibt es keine Linie. `satz` ist der Satz
 * darunter: „Seit April 2028 zusammen **29.774 kWh mehr**, als die Bezugsbasis erwarten lässt. …“ - bei genau 0 „genau
 * so viel, wie …“ (Review r3: nie „genau wie erwartet, als …“).
 */
export function zusammenEnde(
  monate: readonly SeitenMonat[],
  einheit: string,
): { seit: string; text: string; ton: 'warn' | 'ok'; satz: { vor: string; fett: string; nach: string } } | null {
  const mit = monate.filter((m) => m.zusammen !== null);
  if (mit.length < 2) return null;
  const letzter = mit[mit.length - 1].zusammen as string;
  const n = Number(letzter);
  const seit = monatLang(mit[0].periode);
  const text = n === 0 ? 'genau wie erwartet' : `${mengeText(letzter.replace(/^-/, ''), einheit)} ${n > 0 ? 'mehr' : 'weniger'}`;
  const nach =
    n === 0
      ? `, wie die ${UEMS_BEZUGSBASIS} erwarten lässt.`
      : n > 0
        ? `, als die ${UEMS_BEZUGSBASIS} erwarten lässt. Eine steigende Linie heißt: Es wird nicht effizienter.`
        : `, als die ${UEMS_BEZUGSBASIS} erwarten lässt. Eine fallende Linie heißt: Es wird effizienter.`;
  return { seit, text, ton: n > 0 ? 'warn' : 'ok', satz: { vor: `Seit ${seit} zusammen `, fett: n === 0 ? 'genau so viel' : text, nach } };
}

// ------------------------------------------------------------------ Energieziel

export interface ZielKarte {
  titel: string;
  satz: string;
  /** Der Stand der Zielperiode auf der Skala (% gegen erwartet) - `null` ohne bewertbaren Monat. */
  jetzt: string | null;
  jetztLabel: string | null;
  ziel: string;
  zielLabel: string;
  ton: 'warn' | 'ok' | 'neutral' | null;
  fuss: string;
  id: string;
}

/** Die Karte „Energieziel 2029“ mit Skala (§6.12): Zielwert, Zeitraum, Stand nach x von y Monaten, verantwortlich. */
export function zielKarte(a: KennzahlAuswertung, ziel: Energieziel | null): ZielKarte | null {
  const z = a.energieziel;
  if (!z) return null;
  const [von, bis] = z.zielperiode.split('/');
  const spanne = !von || !bis ? z.zielperiode
    : von.slice(0, 4) === bis.slice(0, 4) ? `${MONATSNAMEN[Number(von.slice(5, 7)) - 1]} bis ${monatLang(bis)}`
    : `${monatLang(von)} bis ${monatLang(bis)}`;
  const u = urteilAnsicht(z.urteil);
  const stand =
    z.monate_bewertbar === 0 || z.delta_prozent === null
      ? `Noch kein Monat bewertbar (0 von ${z.monate_soll})`
      : `Stand nach ${z.monate_bewertbar} von ${z.monate_soll} ${z.monate_soll === 1 ? 'Monat' : 'Monaten'}: ${z.richtung === 'gleich' ? 'wie erwartet' : abweichungKurz(z.delta_prozent, z.richtung)}`;
  return {
    id: z.id,
    titel: `${UEMS_ENERGIEZIEL} ${zielJahre(z)}`,
    satz: `${zielWert(z)} Energie, als die ${UEMS_BEZUGSBASIS} erwarten lässt${TRENNER}${spanne}`,
    jetzt: z.monate_bewertbar === 0 ? null : z.delta_prozent,
    jetztLabel: z.monate_bewertbar === 0 || z.delta_prozent === null ? null : `bisher ${deltaMitZeichen(z.delta_prozent)}`,
    ziel: z.zielwert_prozent,
    zielLabel: `Ziel ${z.zielwert_prozent.trim().startsWith('-') ? '−' : '+'}${prozentText(z.zielwert_prozent, 0)}`,
    ton: u ? (u.ton === 'neutral' ? 'neutral' : u.ton) : null,
    fuss: [stand, ziel ? `verantwortlich ${ziel.verantwortlich.name}` : null].filter(Boolean).join(TRENNER),
  };
}

// ------------------------------------------------------------------ Auffälligkeit

/** Die offene Auffälligkeit des Urteilsmonats (sonst die jüngste offene): „Auffälligkeit zu März 2029 · offen.“ */
export function offeneAuffaelligkeit(vermerke: readonly Auffaelligkeit[], monat: string | null): { titel: string; satz: string; id: string } | null {
  const offen = vermerke.filter((v) => v.zustand === 'offen').sort((a, b) => (a.periode < b.periode ? 1 : -1));
  const v = offen.find((x) => x.periode === monat) ?? offen[0];
  if (!v) return null;
  return {
    id: v.id,
    titel: `Auffälligkeit zu ${monatLang(v.periode)}${TRENNER}offen.`,
    satz: 'VoltPilot hat den Monat vermerkt, weil er über der Bezugsbasis liegt. Ob das eine Abweichung ist, sagt eine Person.',
  };
}

// ------------------------------------------------------------------ Woraus gerechnet

/** Womit ein Modell der Bezugsbasis erwartet - nie „mal“: es rechnet Grundlast und Steigung, keinen Wert je Einheit. */
const MODELL_WORT: Record<Exclude<BezugsbasisVergleichFassung['methode'], 'verhaeltnis'>, string> = {
  regression_eine_variable: `dem Modell der ${UEMS_BEZUGSBASIS}`,
  regression_zwei_variablen: `dem Modell der ${UEMS_BEZUGSBASIS}`,
  gradtage: `der Wetterbereinigung der ${UEMS_BEZUGSBASIS}`,
};

/**
 * Der Rechenweg des gewählten Monats in Worten (§6.5 Nr. 8): „März 2029: 88.740 kWh (Zähler Spritzguss MS-20) geteilt
 * durch 306.000 kg (Produktionsmenge BZ-1) = 0,29 kWh je kg.“ und „Erwartet: … = 86.812 kWh.“ - die Zahlen sind die des
 * Servers (Zähler und Nenner des Werts, erwartet aus dem Vergleich); hier wird nur gesetzt.
 *
 * „… aus der Bezugsbasis mal …“ nur beim Verhältnis: dort IST der erwartete Kennzahlwert der Wert der Bezugsbasis und
 * die Bedingung der Nenner. Ein Modell (eine oder zwei Einflussgrößen, Gradtage) erwartet die Menge aus seiner Formel -
 * „erwartet ÷ Nenner“ ist dort kein Wert der Bezugsbasis, und bei Gradtagen ist der Nenner nicht einmal die Einflussgröße
 * (Review r3, BB-0001 Fassung 2). Dann steht die Bedingung und woher die Erwartung kommt.
 */
export function erwartetSatz(
  m: SeitenMonat,
  erwartetWert: string | null,
  einheitKennzahl: string | null,
  nenner: { wert: string; einheit: string } | null,
): { vor: string; fett: string } | null {
  if (!m.erwartet || !m.bedingung) return null;
  if (m.methode === 'verhaeltnis' && erwartetWert && nenner) {
    // Im Rechenweg vier Stellen (wie die Versionen): mit zwei ginge die Rechnung sichtbar nicht auf.
    const je = `${zahlMitStellen(erwartetWert, 4, '').trimEnd()}${einheitKennzahl ? ` ${einheitWort(einheitKennzahl)}` : ''}`;
    return { vor: `Erwartet: ${je} aus der ${UEMS_BEZUGSBASIS} mal ${bedingungZahl(nenner.wert, nenner.einheit)} = `, fett: m.erwartet };
  }
  if (m.methode && m.methode !== 'verhaeltnis') {
    return { vor: `Erwartet bei ${m.bedingung} nach ${MODELL_WORT[m.methode]}: `, fett: m.erwartet };
  }
  return { vor: `Erwartet bei ${m.bedingung}: `, fett: m.erwartet };
}

/**
 * Der Rechenweg in Worten (K5) mit dem Monat vorn und dem Ergebnis hinten: „März 2029: 88.740 kWh (Zähler Spritzguss)
 * geteilt durch 306.000 kg (Produktionsmenge) = 0,29 kWh je kg.“ - die Stücke des Herkunftssatzes, nur umgesetzt.
 */
export function worausStuecke<T extends { text: string }>(stuecke: readonly T[], monat: string, wert: string | null): T[] {
  if (stuecke.length === 0) return [];
  const erstes = { ...stuecke[0], text: stuecke[0].text.replace(/^Gerechnet aus /, `${monat}: `) };
  const letztes = stuecke[stuecke.length - 1];
  const ende = { ...letztes, text: wert ? letztes.text.replace(/\.$/, ` = ${wert}.`) : letztes.text };
  return stuecke.length === 1 ? [{ ...erstes, text: ende.text.replace(/^Gerechnet aus /, `${monat}: `) }] : [erstes, ...stuecke.slice(1, -1), ende];
}

// ------------------------------------------------------------------ Bezugsbasis in Klartext

export interface BasisZeile {
  name: string;
  wert: string;
  leise: string | null;
}

/** Die Karte „Bezugsbasis“ (§6.5 Nr. 9): Vergleichszeitraum, Erwartung mit Band, Gilt - ohne Prüfsumme und Kürzel. */
export function basisKlartext(basis: Bezugsbasis, f: BezugsbasisFassung | null, einheit: string | null, tag: string): BasisZeile[] {
  // Das Band „im Rahmen“: die Toleranz der Fassung (U3; die Streuung eines Modells steht im Wert der Fassung).
  if (!f) return [];
  const vorlaeufig = f.datenlage === 'vorlaeufig';
  const zeilen: BasisZeile[] = [
    {
      name: 'Vergleichszeitraum',
      wert: `${referenzperiodeText(f.referenzperiode)}${f.monate > 0 ? `${TRENNER}${f.monate} von ${f.mindest_monate} Monaten` : ''}`,
      leise: vorlaeufig ? `vorläufig, bis ${zahlWort(f.mindest_monate)} Monate vorliegen` : null,
    },
    {
      name: 'Erwartung',
      // Verhältnis: der Wert allein („0,2837 kWh je kg“) - die Methode nennt die Ebene der Bezugsbasis.
      wert: f.methode === 'verhaeltnis' && f.basiswert ? `${dezimal(f.basiswert)}${einheit ? ` ${einheitJe(einheit)}` : ''}` : wertText(f, einheit),
      leise: `im Rahmen: ± ${zahlMitStellen(f.toleranz_prozent, 1, '%').replace(/,0(?=\s)/, '')}`,
    },
  ];
  const frist = basis.frist ?? null;
  const wer = freigeberText(f);
  // Die Fassung des Urteils kann am Stichtag schon abgelöst sein (Überprüfung): dann „bis …“ und wer danach gilt - nie
  // „seit“ für eine Fassung, die nicht mehr gilt.
  if (f.gilt_bis && f.gilt_bis < tag) {
    const danach = basis.fassungen
      .filter((x) => x.freigabe_status === 'freigegeben' && x.gilt_ab > (f.gilt_bis as string))
      .sort((x, y) => x.gilt_ab.localeCompare(y.gilt_ab))[0];
    zeilen.push({
      name: 'Galt',
      wert: `${tagText(f.gilt_ab)} bis ${tagText(f.gilt_bis)}${TRENNER}Fassung ${f.fassung}`,
      leise: [wer, danach ? `seit ${tagText(danach.gilt_ab)} gilt Fassung ${danach.fassung}` : null].filter(Boolean).join(TRENNER) || null,
    });
    return zeilen;
  }
  zeilen.push({
    name: 'Gilt',
    // Eine Fassung, die erst künftig gilt, heißt „ab …“ - nie „seit“ einem Tag, der noch nicht war.
    wert: `${f.gilt_ab > tag ? 'ab' : 'seit'} ${tagText(f.gilt_ab)}${TRENNER}Fassung ${f.fassung}`,
    leise: [wer, frist?.faellig_am ? `nächste Überprüfung bis ${tagText(frist.faellig_am)}` : null].filter(Boolean).join(TRENNER) || null,
  });
  return zeilen;
}

/** „Spezifischer Stromeinsatz …“ und „Gilt für den Prozess Spritzguss · verantwortlich Ines Kaltenbach · berechnet seit 01.10.2026“. */
export function ueberKennzahl(k: Kennzahl): { zweck: string | null; geltung: string } {
  return {
    zweck: k.zweck,
    geltung: [`Gilt für ${ortImSatz(k, true).replace(/^das Unternehmen$/, 'das ganze Unternehmen')}`, `verantwortlich ${k.verantwortlich_name}`, `berechnet seit ${tagText(k.angelegt_am.slice(0, 10))}`].join(TRENNER),
  };
}

/** Das Urteil, wie es die Liste und die Tabelle nennen: das Wort oder „ohne Urteil“; ohne Abweichung `null`. */
export function urteilMarke(u: BezugsbasisUrteil | null, delta: string | null): { text: string; art: 'warn' | 'ok' | 'neutral' | 'ohne' } | null {
  const a = urteilAnsicht(u);
  // „im Rahmen“ ohne „der Bezugsbasis“: in der Liste der Monate steht die Bezugsbasis schon im Titel der Karte.
  if (a) return { text: u === 'im_rahmen' ? 'im Rahmen' : a.wort, art: a.ton === 'neutral' ? 'neutral' : a.ton };
  return delta === null ? null : { text: 'ohne Urteil', art: 'ohne' };
}
