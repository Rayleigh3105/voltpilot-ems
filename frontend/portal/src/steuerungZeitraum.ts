/**
 * Die STEUERUNG MIT BESTAND in Worten — Kachel, Karte, „Tag für Tag“ und
 * Rechenweg (Bedienkonzept `vp-herzogau-p3-kachel-konzept` §3, Captain
 * 14.10.2026: HZ-3 A, P3-1 bis P3-4 je A).
 *
 * Vorn stehen der laufende Monat (groß) und die letzten 7 Tage (zweite Zeile);
 * die Tageszahl steht in der Karte „VoltPilots Steuerung“, mit Bestand
 * bewertet und mit einem kurzen Grund-Wort. Die alte Kalendertag-Zahl (die
 * Kassenrechnung) steht nur noch als Schritt 1 im Rechenweg.
 *
 * ⚠ **ES WIRD HIER NICHTS GERECHNET.** Jede Zahl ist ein Feld des Blocks
 *   `steuerungZeitraum` der Anlagen-Route (Regeln und Fälle:
 *   `docs/contracts/steuerung-tag-vectors.json`, Block `mit_bestand`); der
 *   Server rundet Kasse und Bestand je Tag auf den Cent, darum ergeben die
 *   Zeilen „Tag für Tag“ die Zahl vorn auf den Cent. Die einzige Rechnung
 *   dieser Datei ist die Differenz zweier gezeigter kWh im Rechenweg.
 *
 * ⚠ **Kalendertage, nie 7 × 24 h**: Daten kommen als ISO-Datum vom Server und
 *   werden nur benannt, nie aus „jetzt − i × 24 h“ gebildet (die Sommerzeit
 *   hätte sonst einen Tag doppelt oder gar nicht, Nebenbefund 3).
 *
 * ⚠ **Nie „Woche“** für die 7 Tage: die Woche im Zeitraum-Schalter bleibt die
 *   Kalenderwoche; hier heißt es „letzte 7 Tage“ oder es steht das Datum da.
 */
import type { EarningsSite, SteuerungTag, SteuerungZeitraum } from './api';
import type { RechenZeile } from './erloesEbenen';
import { NBSP } from './format';
import {
  anzeigeTonVon,
  bestandGrundWorte,
  geldWort,
  MESSLATTE_DATIV,
  MESSLATTE_KURZ,
  SPEICHER_TOTBAND,
  type SpeicherTon,
} from './speicherAussage';

/** Der Satz unter „Tag für Tag“ — dieselbe Regel wie im Rechenweg. */
export const BESTAND_FUSS =
  'Jeder Tag mit Bestand bewertet: Was am Tagesende mehr oder weniger im Speicher liegt als im ' +
  'Vergleichsspeicher, zählt zum Bezugspreis.';

/** Entlade-Wirkungsgrad √0,92 als Wort — der Server rechnet ihn, hier wird er nur genannt. */
export const ENTLADE_WIRKUNGSGRAD_WORT = `95,9${NBSP}%`;

const MONATE = [
  'Januar',
  'Februar',
  'März',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Dezember',
];
const WOCHENTAGE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

function teile(iso: string): { j: number; m: number; d: number } {
  const [j, m, d] = iso.slice(0, 10).split('-').map(Number);
  return { j, m, d };
}

/** „Mo 12.10.“ — aus dem ISO-Datum, ohne Uhr und ohne Zeitzone. */
export function tagKurz(iso: string): string {
  const { j, m, d } = teile(iso);
  const wt = WOCHENTAGE[new Date(Date.UTC(j, m - 1, d)).getUTCDay()];
  return `${wt} ${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.`;
}

/** „Oktober“. */
export function monatName(iso: string): string {
  return MONATE[teile(iso).m - 1];
}

/** „6.–12. Oktober“; über eine Monatsgrenze „28. September – 4. Oktober“. */
export function spanne(von: string, bis: string): string {
  const a = teile(von);
  const b = teile(bis);
  if (a.j === b.j && a.m === b.m) {
    return a.d === b.d ? `${a.d}.${NBSP}${MONATE[a.m - 1]}` : `${a.d}.–${b.d}.${NBSP}${MONATE[b.m - 1]}`;
  }
  return `${a.d}.${NBSP}${MONATE[a.m - 1]} – ${b.d}.${NBSP}${MONATE[b.m - 1]}`;
}

/** „08:15“ in Berliner Zeit; null ohne Zeitpunkt. */
export function uhrzeit(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  return t.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
}

function zahl(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** „+ 9,45 €“ / „− 0,29 €“ / „0,00 €“ / „—“ (nicht rechenbar, nie eine 0). */
export function bestandWort(v: number | null | undefined): string {
  const z = zahl(v);
  return z == null ? '—' : geldWort(z);
}

/** Die Grund-Wörter eines Tages, höchstens zwei, mit „ · “ verbunden; null ohne Grund. */
export function grundWorte(gruende: readonly string[] | null | undefined): string | null {
  const worte = bestandGrundWorte(gruende);
  return worte.length > 0 ? worte.join(' · ') : null;
}

function richtung(eur: number): string {
  if (Math.abs(eur) < SPEICHER_TOTBAND) return `wie ${MESSLATTE_KURZ}`;
  return eur > 0 ? `mehr als ${MESSLATTE_KURZ}` : `weniger als ${MESSLATTE_KURZ}`;
}

// ---------------------------------------------------------------------------
// Kachel „VoltPilot-Steuerung“ (Erlöse-Seite, Tagesansicht)
// ---------------------------------------------------------------------------

export interface SteuerungKachel {
  /** Der Monat mit Bestand — groß; „—“, wo er nicht rechenbar ist. */
  wert: string;
  /** Ton der großen Zahl nach der heutigen Regel (laufend Tinte, abgeschlossen grün/orange). */
  ton: SpeicherTon | 'leer';
  /** „diesen Monat · mehr als ohne smarte Steuerung“ bzw. „1.–13. Oktober · …“. */
  unter: string;
  /** Die zweite Zeile: „letzte 7 Tage + 9,45 €“ bzw. „7.–13. Oktober − 0,29 €“ — immer Tinte. */
  zweit: { label: string; wert: string } | null;
  /** Die Sätze des ⓘ. */
  info: string[];
}

/**
 * Die Kachel der Tagesansicht: groß der Monat bis zum angezeigten Tag, darunter
 * die letzten 7 abgeschlossenen Tage (P3-1 A). `laeuft` = der angezeigte Tag
 * ist heute; beim Zurückblättern stehen Daten statt „diesen Monat“ und „letzte
 * 7 Tage“.
 */
export function steuerungKachel(z: SteuerungZeitraum, laeuft: boolean): SteuerungKachel {
  const monat = zahl(z.monat.mitBestandEur);
  const wann = laeuft ? 'diesen Monat' : spanne(z.monat.von, z.monat.bis);
  const sieben = z.sieben;
  const info = [
    'Vorn steht der Monat, darunter die letzten 7 abgeschlossenen Tage — jeder Tag mit Bestand bewertet: ' +
      'Was am Tagesende mehr oder weniger im Speicher liegt als im Vergleichsspeicher, zählt zum Bezugspreis. ' +
      'So stehen ein Verkauf am Abend und der Nachkauf in der Nacht am selben Tag.',
    `Verglichen wird mit ${MESSLATTE_DATIV}: Er lädt jeden Überschuss sofort und entlädt sofort — ohne Blick auf Preise. Nicht im Ergebnis enthalten.`,
    'Die Zahl für den einzelnen Tag und wie sie entsteht steht in der Karte „VoltPilots Steuerung“.',
  ];
  return {
    wert: monat == null ? '—' : geldWort(monat),
    ton: monat == null ? 'leer' : anzeigeTonVon(monat, laeuft),
    unter: `${wann} · ${monat == null ? nichtRechenbar(z) : richtung(monat)}`,
    zweit: sieben
      ? { label: laeuft ? 'letzte 7 Tage' : spanne(sieben.von, sieben.bis), wert: bestandWort(sieben.mitBestandEur) }
      : null,
    info,
  };
}

/** Warum eine Summe fehlt: noch kein gemessener Tag — oder ein fehlender Ladestand. */
function nichtRechenbar(z: SteuerungZeitraum): string {
  return z.heute == null && z.tage.length === 0
    ? 'noch keine Viertelstunde ausgewertet'
    : 'Ladestand fehlt, nicht rechenbar';
}

// ---------------------------------------------------------------------------
// Karte „VoltPilots Steuerung“ (Detailansicht)
// ---------------------------------------------------------------------------

export interface SteuerungKarteZeile {
  label: string;
  wert: string;
  grund: string | null;
}

export interface SteuerungKarte {
  /** „Zwischenstand“ (läuft) bzw. „unter Null“ (abgeschlossen und unter null); sonst null. */
  chip: string | null;
  /** „Heute bis 08:15 + 0,01 €“ bzw. „Steuerung an diesem Tag − 2,32 €“ samt Grund-Wort. */
  tag: SteuerungKarteZeile;
  /** „Letzte 7 Tage · 6.–12. Oktober“ und „Oktober bisher“ (zurückgeblättert: die Daten). */
  anker: SteuerungKarteZeile[];
  /** „Tag für Tag“: die Tage des 7-Tage-Fensters, neuester zuerst, mit Summe und Fußzeile. */
  liste: { zeilen: SteuerungKarteZeile[]; summe: SteuerungKarteZeile; fuss: string } | null;
  /** „Wie wird das berechnet?“ — vier Schritte für den angezeigten Tag. */
  rechenweg: RechenZeile[];
}

export function steuerungKarte(z: SteuerungZeitraum, laeuft: boolean): SteuerungKarte {
  const h = z.heute;
  const mitBestand = zahl(h?.mitBestandEur);
  const bis = uhrzeit(h?.messungBis);
  const label = laeuft ? (bis ? `Heute bis ${bis}` : 'Heute') : 'Steuerung an diesem Tag';
  const tag: SteuerungKarteZeile = {
    label,
    wert: bestandWort(mitBestand),
    grund:
      h == null
        ? 'noch keine Viertelstunde ausgewertet'
        : mitBestand == null
          ? 'Ladestand fehlt — ohne ihn keine Zahl mit Bestand'
          : grundWorte(h.gruende),
  };
  const anker: SteuerungKarteZeile[] = [];
  if (z.sieben) {
    anker.push({
      label: laeuft ? `Letzte 7 Tage · ${spanne(z.sieben.von, z.sieben.bis)}` : spanne(z.sieben.von, z.sieben.bis),
      wert: bestandWort(z.sieben.mitBestandEur),
      grund: null,
    });
  }
  anker.push({
    label: laeuft ? `${monatName(z.monat.bis)} bisher` : spanne(z.monat.von, z.monat.bis),
    wert: bestandWort(z.monat.mitBestandEur),
    grund: null,
  });
  const liste =
    z.sieben && z.tage.length > 0
      ? {
          zeilen: z.tage.map((t) => ({
            label: tagKurz(t.tag),
            wert: bestandWort(t.mitBestandEur),
            grund: grundWorte(t.gruende),
          })),
          summe: {
            label: `Summe ${spanne(z.sieben.von, z.sieben.bis)}`,
            wert: bestandWort(z.sieben.mitBestandEur),
            grund: null,
          },
          fuss: BESTAND_FUSS,
        }
      : null;
  const chip = laeuft
    ? 'Zwischenstand'
    : mitBestand != null && mitBestand <= -SPEICHER_TOTBAND
      ? 'unter Null'
      : null;
  return { chip, tag, anker, liste, rechenweg: h ? rechenweg(h, z, laeuft) : [] };
}

/** „Rückstand 33,4 kWh“ / „Vorsprung 4,0 kWh“ / „0,0 kWh“. */
function stand(kwh: number): string {
  const r = Math.round(kwh * 10) / 10;
  const betrag = kwhWort(Math.abs(r));
  if (r === 0) return betrag;
  return r < 0 ? `Rückstand ${betrag}` : `Vorsprung ${betrag}`;
}

function kwhWort(kwh: number): string {
  return `${kwh.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}${NBSP}kWh`;
}

function ctWort(ct: number, stellen: number): string {
  return `${ct.toLocaleString('de-DE', { minimumFractionDigits: stellen, maximumFractionDigits: stellen })}${NBSP}ct`;
}

/** „− 4,48 € + 2,16 €“ — der zweite Summand mit seinem Vorzeichen als Rechenzeichen. */
function summe(a: number, b: number): string {
  const zweiter = geldWort(Math.abs(b));
  return `${geldWort(a)} ${b < 0 ? '−' : '+'} ${zweiter.replace(/^[+−]\s?/, '')}`;
}

/**
 * Der Rechenweg des angezeigten Tages in vier Schritten (Konzept §3, P3-3 A):
 * die Kassenrechnung (die bisherige Tageszahl), der Rückstand oder Vorsprung
 * auf den Vergleichsspeicher an beiden Tagesrändern, seine Änderung × Bewertung
 * und die Summe. Fehlt ein Ladestand, endet er nach Schritt 2 mit dem Grund.
 */
function rechenweg(h: SteuerungTag, z: SteuerungZeitraum, laeuft: boolean): RechenZeile[] {
  const zeilen: RechenZeile[] = [];
  const kasse = zahl(h.steuerungEur);
  const bis = uhrzeit(h.messungBis);
  const ende = laeuft ? (bis ?? 'jetzt') : '24:00';
  if (kasse != null) {
    zeilen.push({
      formel: `Schritt 1 · Kassenrechnung ${laeuft ? `heute bis ${ende}` : 'des Tages'} = ${geldWort(kasse)}`,
      herkunft: `Speicher gegen ${MESSLATTE_DATIV}, je Viertelstunde von 00:00 bis ${ende} – die bisherige Tageszahl`,
    });
  }
  const vs = zahl(h.vorsprungStartKwh);
  const ve = zahl(h.vorsprungEndeKwh);
  if (vs == null || ve == null) {
    zeilen.push({
      formel: `Schritt 2 · ${vs == null ? 'Ladestand um 00:00 fehlt' : `Ladestand um ${ende} fehlt`}`,
      herkunft: 'Ohne gemessenen Ladestand am Tagesrand gibt es keine Zahl mit Bestand',
    });
    return zeilen;
  }
  const delta = Math.round((ve - vs) * 10) / 10;
  zeilen.push({
    formel:
      `Schritt 2 · ${stand(vs)} um 00:00, ${stand(ve)} um ${ende} = ` +
      `${kwhWort(Math.abs(delta))} ${delta >= 0 ? 'aufgeholt' : 'zurückgefallen'}`,
    herkunft: 'Speicherinhalt gegenüber dem Vergleichsspeicher – was am Tagesrand mehr oder weniger im Speicher liegt',
  });
  const bewertung = zahl(h.bewertungCtKwh) ?? zahl(z.bewertungCtKwh);
  const bezug = zahl(h.bezugCtKwh) ?? zahl(z.bezugCtKwh);
  const bestand = zahl(h.bestandEur);
  const mitBestand = zahl(h.mitBestandEur);
  if (bewertung != null && bestand != null) {
    zeilen.push({
      formel: `Schritt 3 · ${delta < 0 ? '− ' : ''}${kwhWort(Math.abs(delta))} × ${ctWort(bewertung, 2)} = ${geldWort(bestand)}`,
      herkunft:
        bezug != null
          ? `Bezugspreis ${ctWort(bezug, 1)} × ${ENTLADE_WIRKUNGSGRAD_WORT} – so viel Strom liefert eine gespeicherte Kilowattstunde`
          : `Bezugspreis × ${ENTLADE_WIRKUNGSGRAD_WORT} – so viel Strom liefert eine gespeicherte Kilowattstunde`,
    });
  }
  if (kasse != null && bestand != null && mitBestand != null) {
    zeilen.push({
      formel: `Schritt 4 · ${laeuft ? 'Heute' : 'An diesem Tag'} mit Bestand: ${summe(kasse, bestand)} = ${geldWort(mitBestand)}`,
      herkunft: 'Verkauf und Nachkauf stehen damit am selben Tag; übrig bleibt, was die Steuerung wirklich anders gemacht hat',
    });
  }
  return zeilen;
}

// ---------------------------------------------------------------------------
// Kurzform (Cockpit-Kachel „Unterm Strich“, P3-4 A)
// ---------------------------------------------------------------------------

export interface SteuerungKurz {
  /** „Steuerung diesen Monat + 25,86 €“ (zurückgeblättert: „Steuerung 1.–13. Oktober …“). */
  zeile: string;
  /** „letzte 7 Tage + 9,45 € · heute bis 08:15 + 0,01 €“; null ohne beides. */
  zweit: string | null;
  /** Der Tooltip: wie gezählt wird. */
  titel: string;
}

/** Die Zählweise mit Bestand in zwei Zeilen — dieselben Zahlen wie Kachel und Karte der Erlöse-Seite. */
export function steuerungKurz(z: SteuerungZeitraum, laeuft: boolean): SteuerungKurz {
  const wann = laeuft ? 'diesen Monat' : spanne(z.monat.von, z.monat.bis);
  const teile: string[] = [];
  if (z.sieben) {
    teile.push(`${laeuft ? 'letzte 7 Tage' : spanne(z.sieben.von, z.sieben.bis)} ${bestandWort(z.sieben.mitBestandEur)}`);
  }
  if (z.heute) {
    const bis = uhrzeit(z.heute.messungBis);
    teile.push(
      `${laeuft ? (bis ? `heute bis ${bis}` : 'heute') : 'an diesem Tag'} ${bestandWort(z.heute.mitBestandEur)}`,
    );
  }
  return {
    zeile: `Steuerung ${wann} ${bestandWort(z.monat.mitBestandEur)}`,
    zweit: teile.length > 0 ? teile.join(' · ') : null,
    titel:
      `Gegenüber ${MESSLATTE_DATIV}, jeder Tag mit Bestand bewertet: Was am Tagesende mehr oder weniger ` +
      'im Speicher liegt als im Vergleichsspeicher, zählt zum Bezugspreis.',
  };
}

// ---------------------------------------------------------------------------
// Flotte (Übersicht, Mandanten-Route `range=day`, P3-4 A)
// ---------------------------------------------------------------------------

/** Ein ISO-Datum plus `tage` Kalendertage — Kalenderrechnung, nie 24 h auf einem Zeitpunkt. */
export function tagPlus(iso: string, tage: number): string {
  const { j, m, d } = teile(iso);
  return new Date(Date.UTC(j, m - 1, d + tage)).toISOString().slice(0, 10);
}

export interface FlotteMitBestand {
  /** false = älteres Backend (das Feld fehlt) — dann gilt die bisherige Fläche. */
  mitBestand: boolean;
  /** Σ `steuerungMonatMitBestandEur` der beitragenden Anlagen; null ohne eine. */
  monatEur: number | null;
  /** Wie viele Anlagen einen Monat mit Bestand tragen. */
  monatAnlagen: number;
  /** Σ der 7 abgeschlossenen Tage vor heute; null, wenn eine Anlage ihn nicht trägt. */
  siebenEur: number | null;
  /** Der heutige Tag mit Bestand über dieselben Anlagen; null, wenn einer fehlt. */
  heuteEur: number | null;
}

/**
 * Monat, 7 Tage und heute mit Bestand über eine Flotte — aus Feldern, die die
 * Mandanten-Route ohnehin aus ihrem Walk liefert (`steuerungMonatMitBestandEur`,
 * `dailySaved[].mitBestandEur`). Eine Summe steht nur, wenn JEDE beitragende
 * Anlage ihren Teil trägt — sonst wäre sie still unvollständig.
 */
export function flotteMitBestand(sites: readonly EarningsSite[], heuteIso: string): FlotteMitBestand {
  const mitBestand = sites.some((s) => s.steuerungMonatMitBestandEur !== undefined);
  const beitragend = sites.filter((s) => zahl(s.steuerungMonatMitBestandEur) != null);
  const von = tagPlus(heuteIso, -FENSTER_TAGE);
  const bis = tagPlus(heuteIso, -1);
  const sieben = beitragend.map((s) => fensterSumme(s, von, bis));
  const heute = beitragend.map((s) => zahl(s.dailySaved.find((d) => d.day === heuteIso)?.mitBestandEur));
  const summe = (xs: (number | null)[]) =>
    xs.length > 0 && xs.every((x) => x != null) ? r2((xs as number[]).reduce((a, b) => a + b, 0)) : null;
  return {
    mitBestand,
    monatEur: summe(beitragend.map((s) => zahl(s.steuerungMonatMitBestandEur))),
    monatAnlagen: beitragend.length,
    siebenEur: summe(sieben),
    heuteEur: summe(heute),
  };
}

const FENSTER_TAGE = 7;

/** Σ der gemessenen Tage in [von, bis]; null bei einer Lücke oder ohne Tag (Regel 5). */
function fensterSumme(s: EarningsSite, von: string, bis: string): number | null {
  const tage = s.dailySaved.filter((d) => d.day >= von && d.day <= bis);
  if (tage.length === 0) return null;
  let summe = 0;
  for (const d of tage) {
    const v = zahl(d.mitBestandEur);
    if (v == null) return null;
    summe += v;
  }
  return r2(summe);
}

/** Cent-genau, halb weg von null — die Tage kommen schon auf den Cent, das hält die Summe sauber. */
function r2(v: number): number {
  return (Math.sign(v) * Math.round(Math.abs(v) * 100 + 1e-9)) / 100;
}

