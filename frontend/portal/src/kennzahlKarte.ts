/**
 * Die Welt „Kennzahlen“ im Portal (UEMS AP-11 IP-13) als REINE Ableitung: die Karten der Liste und die
 * Kennzahl-Seite — Werte-Karte, Verlauf, Herkunft, Berechnung, Stammdaten (AP-11 §5.3 bei 375 px, §5.5).
 *
 * Hier wird NICHTS gerechnet und nichts erfunden:
 *  - Wert, Zustand, Richtung, Kennzeichen, Fassung, Version und Herkunft stehen gespeichert an der Route
 *    `GET /api/v1/kennzahlen/{id}/werte` (IP-7) — als Dezimaltext, ungerundet;
 *  - die Zahl spricht der Zwilling `uemsKennzahl.anzeige` (U4: zwei Stellen, „mindestens“ / „höchstens“), die
 *    Sätze ohne Zahl `uemsKennzahl.satz` (§5.8) mit dem Eingang der Fassung, die in der Periode galt;
 *  - „vollständig“, „Verlauf 100 %“ und „endgültig“ sind die Wörter der Tages- und Monatskarte (`uemsErgebnis`),
 *    und die Karte hat deren Form (`uemsWerteKarte.Karte`), damit `WerteKarte` sie unverändert zeichnet;
 *  - die Versionen haben die Form von `uemsWertVersionen` — `WertVersionen.tsx` zeichnet sie.
 *
 * Was die Route nicht trägt, steht hier nicht — auch wenn §5.3 es druckt: „gemessen“ und „eingegeben von … am …“
 * an einem Eingang der Herkunft kennt `kennzahlwert-herkunft` nicht (Befund, `uems-kennzahlen-portal.md`).
 *
 * REIN: kein Netz, keine Uhr — `heute` und `jetzt` kommen als Parameter.
 */

import type {
  Kennzahl,
  KennzahlFassung,
  KennzahlGeltungArt,
  KennzahlPeriodeArt,
  KennzahlWert,
  KennzahlWertEntscheidung,
  KennzahlWerte,
  KennzahlWerteHistorie,
  KennzahlwertHerkunft,
  KennzahlwertHerkunftEingang,
  MessstelleWerteEntscheidung,
} from './api';
import { iso, schluesselVon, spanneVon, tagPlus } from './bezugsPeriode';
import { dez, dezVergleich } from './dez';
import {
  UEMS_BEREICH,
  UEMS_BERECHNUNG,
  UEMS_FASSUNG,
  UEMS_GEBAEUDE,
  UEMS_GELTUNGSBEREICH,
  UEMS_KENNZAHLEN,
  UEMS_KOSTENSTELLE,
  UEMS_MENGE,
  UEMS_MESSSTELLE,
  UEMS_PROZESS,
  UEMS_RECHENFORM,
  UEMS_STANDORT,
  UEMS_TEIL,
  UEMS_UNTERNEHMEN,
  UEMS_VERANTWORTLICH,
  UEMS_VERSION,
  UEMS_ZWECK,
} from './glossar';
import {
  ABDECKUNG,
  fassung as fassungWort,
  KEINE_WERTE,
  OHNE_ZAHL,
  PROZENT,
  TRENNER,
  VOLLSTAENDIG,
  zahl,
  zahlMitStellen,
} from './uemsErgebnis';
import { zeitText } from './uemsEreignis';
import {
  anzeige,
  ANZEIGE_NACHKOMMASTELLEN,
  EINHEIT_TRENNER,
  EINZAHL,
  einheitWort,
  kennzeichenPruefen,
  MONATSNAMEN,
  OBERGRENZE,
  PERIODEN_WOERTER,
  periodeText,
  satz,
  UNTERGRENZE,
  VERGLEICH_NACHKOMMASTELLEN,
} from './uemsKennzahl';
import { datumText } from './uemsOrtsbaum';
import type { Karte, Ton } from './uemsWerteKarte';
import {
  EINSTIEG_UNTER,
  entscheidung,
  FASSUNG_FEHLT,
  GILT_JETZT,
  hatHistorie,
  KEINE_HISTORIE,
  OHNE_ENTSCHEIDUNG,
  OHNE_GRUND,
  ORIGINAL,
  STATUS_VERB,
  urheberschaft,
  type Einstieg,
  type EntscheidungAnzeige,
  type HistorieAnzeige,
  type HistorieWert,
  type VersionAnzeige,
} from './uemsWertVersionen';

// ------------------------------------------------------------------ Wörter der Fläche

export const TITEL = UEMS_KENNZAHLEN;
export const LADEN = 'Kennzahlen werden geladen …';
export const LADEFEHLER = 'Die Kennzahlen konnten nicht geladen werden.';
export const WERTE_FEHLER = 'Die Werte konnten nicht geladen werden.';
export const LEER = 'Es gibt noch keine Kennzahl.';
export const NICHT_GEFUNDEN = 'Diese Kennzahl gibt es nicht (mehr).';
export const ZUR_LISTE = 'Alle Kennzahlen';
export const ARCHIVIERT = 'archiviert';
/**
 * R-A7 (AP-03 R-A6/R-A7, AP-11 §4.11): eine Kennzahl über Standorte, die der Leser nicht alle sieht — ihre
 * Existenz darf er wissen, ihre Werte nicht. Nie teilgerechnet, nie ein Name eines fremden Standorts.
 */
export const AUSSERHALB_ZUGRIFF = 'umfasst Standorte außerhalb Ihres Zugriffs';
export const KARTE_VERLAUF = 'Verlauf';
export const KARTE_HERKUNFT = 'Herkunft';
export const KARTE_BERECHNUNG = UEMS_BERECHNUNG;
export const KARTE_STAMMDATEN = 'Stammdaten';
export const FASSUNGEN_TITEL = `${UEMS_FASSUNG}en`;
export const PERIODE_WAHL = 'Periode';
export const OHNE_ZWECK = 'Kein Zweck angegeben.';
export const SEIT_BEGINN = 'seit Beginn';
export const HERKUNFT_FEHLT = 'Nicht gespeichert: ';

export const PERIODEN_NAME: Record<KennzahlPeriodeArt, string> = { tag: 'Tag', woche: 'Woche', monat: 'Monat', jahr: 'Jahr' };

export const GELTUNG_WORT: Record<KennzahlGeltungArt, string> = {
  unternehmen: UEMS_UNTERNEHMEN,
  standort: UEMS_STANDORT,
  gebaeude: UEMS_GEBAEUDE,
  bereich: UEMS_BEREICH,
  prozess: UEMS_PROZESS,
  kostenstelle: UEMS_KOSTENSTELLE,
  messstelle: UEMS_MESSSTELLE,
};

/** Was an einer Herkunft fehlen kann (`kennzahlwert-herkunft.schema.json` → `fehlt`), in Kundenwörtern. */
export const FEHLT_WORT: Record<KennzahlwertHerkunft['fehlt'][number], string> = {
  kennzahl: 'Kennzahl',
  definition_fassung: `${UEMS_FASSUNG} der ${UEMS_BERECHNUNG}`,
  berechnet_am: 'Zeitpunkt der Rechnung',
  eingaenge: 'Eingänge',
  anlass: 'Anlass',
};

/** Die Perioden in ihrer Reihenfolge — fein vor grob. */
const PERIODEN: KennzahlPeriodeArt[] = ['tag', 'woche', 'monat', 'jahr'];

/**
 * Wie viele Perioden Verlauf und Liste fragen. Die Liste zeigt den jüngsten Schritt mit einer Zeile in DIESEM Fenster —
 * eine Tages-Kennzahl ohne Wert seit dem Wochenende hat so trotzdem ihren letzten Wert, mit seinem Tag daneben.
 */
export const ANZAHL_VERLAUF: Record<KennzahlPeriodeArt, number> = { tag: 31, woche: 12, monat: 12, jahr: 5 };

const MONATE_KURZ = MONATSNAMEN.map((m) => m.slice(0, 3));

// ------------------------------------------------------------------ kleine Wörter

const zitat = (text: string): string => `„${text}“`;

const hundert = (prozent: string | null): boolean => prozent !== null && dezVergleich(dez(prozent), dez('100')) === 0;

/** Der Ton eines Zustandsworts — dieselbe Regel wie an der Tages- und Monatskarte. */
export const tonVon = (zustand: string | null): Ton => {
  if (zustand === VOLLSTAENDIG) return 'ok';
  if (zustand === null || zustand === KEINE_WERTE) return 'off';
  return 'warn';
};

/** „Verlauf 100 %“ — `null` ohne Abdeckung. */
export const abdeckungText = (prozent: string | null): string | null =>
  prozent === null ? null : ABDECKUNG + zahl(prozent, PROZENT, null);

/**
 * Die Zahl einer Kennzahl: „0,15 kWh je Stück“, „mindestens 30,83 kWh je Person“ (U4, zwei Stellen); ohne Zahl „—“.
 * Die Versionen sprechen mit den Vergleichs-Stellen („0,1488 kWh je Stück“, §5.5) — auf zwei Stellen läsen
 * Version 1 und 2 einer Korrektur gleich.
 */
export const wertText = (
  wert: string | null,
  einheit: string | null,
  richtung: string | null,
  stellen: number = ANZEIGE_NACHKOMMASTELLEN,
): string => {
  if (wert === null || einheit === null) return OHNE_ZAHL;
  if (stellen === ANZEIGE_NACHKOMMASTELLEN || einheit === PROZENT) return anzeige(dez(wert), einheit, richtung);
  const text = zahlMitStellen(wert, stellen, einheitWort(einheit));
  if (richtung === UNTERGRENZE) return satz('anzeige_untergrenze', { zahl: text });
  if (richtung === OBERGRENZE) return satz('anzeige_obergrenze', { zahl: text });
  return text;
};

/** Ein Betrag eines Eingangs so genau, wie er gespeichert ist: „6.100 kWh“, „4,9667 h“ — nie gerundet. */
export const betragText = (wert: string | null, einheit: string): string => {
  if (wert === null) return OHNE_ZAHL;
  const punkt = wert.indexOf('.');
  const stellen = punkt < 0 ? 0 : wert.length - punkt - 1;
  return zahlMitStellen(wert, stellen, einheit === PROZENT ? PROZENT : einheitWort(einheit));
};

// ------------------------------------------------------------------ Kopf und Stammdaten

export const geltungText = (k: Pick<Kennzahl, 'geltung_art' | 'geltung_name'>): string =>
  k.geltung_name ? `${GELTUNG_WORT[k.geltung_art]} ${k.geltung_name}` : GELTUNG_WORT[k.geltung_art];

export interface Kopf {
  /** „KZ-0001 · Stromeinsatz Montage je Stück — Halle 2“. */
  titel: string;
  /** „Gebäude Halle 2 · verantwortlich Ines Kaltenbach“. */
  unter: string;
  /** „archiviert“ oder `null`. */
  archiviert: string | null;
}

/** Der Kopf der Kennzahl-Seite (§5.3); `titel · unter` ist Zeichen für Zeichen der Satz des Reports. */
export const kopf = (k: Kennzahl): Kopf => ({
  titel: `${k.kennzeichen}${TRENNER}${k.name}`,
  unter: [geltungText(k), `${UEMS_VERANTWORTLICH.toLowerCase()} ${k.verantwortlich_name}`].join(TRENNER),
  archiviert: k.archiviert_am ? ARCHIVIERT : null,
});

/** Die drei Stammdaten (§4.13): Zweck · Verantwortlich · Geltungsbereich. */
export const stammdaten = (k: Kennzahl): { name: string; wert: string }[] => [
  { name: UEMS_ZWECK, wert: k.zweck ?? OHNE_ZWECK },
  { name: UEMS_VERANTWORTLICH, wert: k.verantwortlich_name },
  { name: UEMS_GELTUNGSBEREICH, wert: geltungText(k) },
];

// ------------------------------------------------------------------ Perioden

/** Der Umschalter: nur die bildbaren Perioden (P2) — und nur, wenn es wirklich eine Wahl gibt. */
export const periodenWahl = (
  k: Pick<Kennzahl, 'perioden' | 'grundperiode'>,
): { optionen: { id: KennzahlPeriodeArt; label: string }[]; vorgabe: KennzahlPeriodeArt | null } => {
  const bildbar = PERIODEN.filter((p) => k.perioden.includes(p));
  return {
    optionen: bildbar.length >= 2 ? bildbar.map((id) => ({ id, label: PERIODEN_NAME[id] })) : [],
    vorgabe: k.grundperiode !== null && bildbar.includes(k.grundperiode) ? k.grundperiode : (bildbar[0] ?? null),
  };
};

/** Der Kalendertag „heute“ in der Zeitzone des Standorts. */
export const heuteIn = (zone: string, jetzt: number): string => iso(jetzt, zone).slice(0, 10);

/** Die Anfrage an `…/werte`: die letzten `anzahl` Perioden bis zu der, in der `heute` liegt — `von`/`bis` auf Periodengrenzen. */
export const anfrage = (art: KennzahlPeriodeArt, heute: string, anzahl: number): { von: string; bis: string } => {
  const [erster, bis] = spanneVon(schluesselVon(heute, art), art);
  let von = erster;
  for (let i = 1; i < anzahl; i += 1) von = spanneVon(schluesselVon(tagPlus(von, -1), art), art)[0];
  return { von, bis };
};

/** Der jüngste Schritt, der eine Zeile hat (auch „keine Werte“ mit Grund); ohne jede Zeile der jüngste. */
export const letzterSchritt = (antwort: KennzahlWerte): KennzahlWert | null =>
  [...antwort.werte].reverse().find((w) => w.zustand !== null) ?? antwort.werte[antwort.werte.length - 1] ?? null;

// ------------------------------------------------------------------ Werte-Karte

/** Ein Eingang einer Fassung, wie `…/fassungen` ihn nennt. */
export type EingangName = KennzahlFassung['eingaenge'][number];

const mitName = (e: EingangName): string => (e.name ? `${e.kennzeichen} ${e.name}` : e.kennzeichen);

/** Die Eingänge der Fassung, mit der der Schritt gebildet wurde — `null`, wenn sie nicht bekannt ist. */
export const eingaengeDer = (fassungen: readonly KennzahlFassung[] | null, w: KennzahlWert): EingangName[] | null =>
  fassungen?.find((f) => f.nummer === w.definition_fassung)?.eingaenge ?? null;

/**
 * Der Kundensatz eines Schritts ohne Zahl (§5.8) — nur für die Gründe, für die der Vertrag einen Satz hat, und nur
 * mit dem Eingang, den er nennt. Die Gründe des Lesers (`noch_nicht_gebildet`, `version_nicht_gespeichert`) haben
 * keinen: dort steht „—“ allein.
 */
export const grundSatz = (w: KennzahlWert, art: KennzahlPeriodeArt, eingaenge: readonly EingangName[] | null): string | null => {
  const periode = periodeText(art, w.schluessel);
  const nenner = eingaenge?.find((e) => e.rolle === 'nenner');
  const zaehler = eingaenge?.find((e) => e.rolle === 'zaehler');
  switch (w.grund) {
    case 'nenner_fehlt':
      return nenner
        ? satz(nenner.art === 'bezugsgroesse' ? 'nenner_fehlt' : 'nenner_fehlt_messstelle', { periode, objekt: mitName(nenner) })
        : null;
    case 'zaehler_fehlt':
      return zaehler ? satz('zaehler_fehlt', { periode, objekt: mitName(zaehler) }) : null;
    case 'nenner_null': {
      const einheit = w.einheit?.split(EINHEIT_TRENNER)[1];
      return einheit ? satz('nenner_null', { einheit, einheit_je: EINZAHL[einheit] ?? einheit }) : null;
    }
    case 'periode_nicht_zu_ende':
      return satz('periode_nicht_zu_ende', { periode, ende: PERIODEN_WOERTER[art].ende });
    default:
      return null;
  }
};

export interface WertKarte {
  karte: Karte;
  /** „Für November 2026 fehlt der Wert der Bezugsgröße BZ-6 Gutteile Montage Halle 2.“ oder `null`. */
  grund: string | null;
}

const STRICH = (titel: string): Karte => ({
  titel,
  tagesdauer: null,
  fassung: null,
  fassungWert: null,
  zahl: OHNE_ZAHL,
  zustand: null,
  abdeckung: null,
  kennzeichen: [],
  zustandTon: 'off',
  abdeckungTon: 'off',
});

/**
 * EIN Schritt als Karte (§5.3): Kopf „Oktober 2026 · endgültig“, Zahl „0,15 kWh je Stück“, Abzeichen „vollständig“
 * und „Verlauf 100 %“, darunter die Kennzeichen wie geliefert. Ein Schritt ohne Zeile oder mit einem Kennzeichen,
 * das der Vertrag nicht kennt, wird nicht gesprochen — auch nicht seine Zahl.
 */
export const wertKarte = (antwort: KennzahlWerte, w: KennzahlWert, eingaenge: readonly EingangName[] | null): WertKarte => {
  if (w.zustand === null || kennzeichenPruefen(w.kennzeichen).length > 0) return { karte: STRICH(w.beschriftung), grund: null };
  return {
    karte: {
      titel: w.beschriftung,
      tagesdauer: null,
      fassung: fassungWort(w.fassung),
      fassungWert: w.fassung,
      zahl: wertText(w.wert, w.einheit ?? antwort.kennzahl.einheit, w.richtung),
      zustand: w.zustand,
      abdeckung: abdeckungText(w.abdeckung_prozent),
      kennzeichen: [...w.kennzeichen],
      zustandTon: tonVon(w.zustand),
      abdeckungTon: hundert(w.abdeckung_prozent) ? 'ok' : w.zustand === KEINE_WERTE ? 'off' : 'warn',
    },
    grund: grundSatz(w, antwort.periode, eingaenge),
  };
};

// ------------------------------------------------------------------ Verlauf

export interface Balken {
  schluessel: string;
  /** „Okt“ · „2026“ · „05.11.“ · „KW 45“. */
  kurz: string;
  /** „Oktober 2026“. */
  titel: string;
  /** „0,15 kWh je Stück“ oder „—“. */
  zahl: string;
  /** 0 … 1 der größten Zahl im Bild; `null` = keine Zahl, kein Balken. Nur für die Höhe, nie für einen Satz. */
  anteil: number | null;
  ton: Ton;
  zustand: string | null;
}

const kurzVon = (art: KennzahlPeriodeArt, schluessel: string): string => {
  if (art === 'monat') return MONATE_KURZ[Number(schluessel.slice(5, 7)) - 1];
  if (art === 'jahr') return schluessel;
  if (art === 'woche') return `KW ${Number(schluessel.slice(6))}`;
  return `${schluessel.slice(8, 10)}.${schluessel.slice(5, 7)}.`;
};

/**
 * Der Verlauf als Balken je Periode mit der Farbe ihres Zustands; „—“ für keine Werte. Vor dem ersten Schritt mit
 * einer Zeile bleibt nichts stehen (eine Kennzahl, die es im Januar noch nicht gab, hat keine elf leeren Monate) —
 * gibt es gar keine Zeile, steht jede Periode mit „—“.
 */
export const verlauf = (antwort: KennzahlWerte): Balken[] => {
  const erster = antwort.werte.findIndex((w) => w.zustand !== null);
  const schritte = erster < 0 ? antwort.werte : antwort.werte.slice(erster);
  const gesprochen = schritte.map((w) => w.zustand !== null && w.wert !== null && kennzeichenPruefen(w.kennzeichen).length === 0);
  const betraege = schritte.map((w, i) => (gesprochen[i] ? Math.abs(Number(w.wert)) : null));
  const groesster = Math.max(0, ...betraege.filter((b): b is number => b !== null));
  return schritte.map((w, i) => {
    const b = betraege[i];
    return {
      schluessel: w.schluessel,
      kurz: kurzVon(antwort.periode, w.schluessel),
      titel: w.beschriftung,
      zahl: gesprochen[i] ? wertText(w.wert, w.einheit ?? antwort.kennzahl.einheit, w.richtung) : OHNE_ZAHL,
      anteil: b === null ? null : groesster === 0 ? 0 : b / groesster,
      ton: tonVon(w.zustand),
      zustand: w.zustand,
    };
  });
};

// ------------------------------------------------------------------ Herkunft

export interface HerkunftAnzeige {
  /** „Menge 6.100 kWh (MS-12, vollständig, Version 1) je 41.000 Stück (BZ-6, Fassung 1)“ — bei einer Zusammenfassung leer. */
  eingaenge: string | null;
  /** Bei einer Zusammenfassung die Paare als Zeilen (K3). */
  paare: string[];
  /** „Berechnung Fassung 1 · gerechnet 01.11.2026 00:20“ (mit „Anlass …“ ab Version 2). */
  gebildet: string | null;
  /** „Nicht gespeichert: Eingänge.“ — nie eine halbe Herkunft ohne diesen Satz. */
  fehlt: string | null;
}

const eingangText = (e: KennzahlwertHerkunftEingang): string => {
  const teile = [
    e.objekt,
    // Eine wirksame Bezugsgröße ist vollständig (Q1) — gesagt wird nur, was davon abweicht.
    ...(e.art === 'bezugsgroesse' && e.zustand === VOLLSTAENDIG ? [] : [e.zustand]),
    ...(e.abdeckung_prozent !== null && !hundert(e.abdeckung_prozent) ? [abdeckungText(e.abdeckung_prozent) as string] : []),
    ...(e.version !== null ? [`${UEMS_VERSION} ${e.version}`] : []),
    ...(e.fassung !== null ? [`${UEMS_FASSUNG} ${e.fassung}`] : []),
    ...e.kennzeichen,
  ];
  return `${betragText(e.wert, e.einheit)} (${teile.join(', ')})`;
};

const paarText = (e: KennzahlwertHerkunftEingang): string => {
  const [menge, bezug] = e.einheit.split(EINHEIT_TRENNER);
  const teile = [
    `${betragText(e.zaehler, menge)} je ${betragText(e.nenner, bezug ?? '')}`.trim(),
    e.zustand,
    ...(e.version !== null ? [`${UEMS_VERSION} ${e.version}`] : []),
    ...e.kennzeichen,
  ];
  return `${e.objekt} ${wertText(e.wert, e.einheit, null)} (${teile.join(', ')})`;
};

/** Die Herkunfts-Karte eines Schritts; `null` ohne Version (K8: noch nie eine Zahl — dort sagt der Grund das Warum). */
export const herkunftAnzeige = (antwort: KennzahlWerte, w: KennzahlWert): HerkunftAnzeige | null => {
  const h = w.herkunft;
  if (h === null) return null;
  if (h.satz === null) {
    return { eingaenge: null, paare: [], gebildet: null, fehlt: `${HERKUNFT_FEHLT}${h.fehlt.map((f) => FEHLT_WORT[f]).join(', ')}.` };
  }
  const s = h.satz;
  const zaehler = s.eingaenge.find((e) => e.rolle === 'zaehler');
  const nenner = s.eingaenge.find((e) => e.rolle === 'nenner');
  const eingaenge =
    s.rechenform === 'zusammenfassung' || !zaehler || !nenner
      ? null
      : s.rechenform === 'anteil'
        ? `${UEMS_TEIL} ${eingangText(zaehler)} an Ganzem ${eingangText(nenner)}`
        : `${UEMS_MENGE} ${eingangText(zaehler)} je ${eingangText(nenner)}`;
  const gebildet = [
    `${UEMS_BERECHNUNG} ${UEMS_FASSUNG} ${s.definition_fassung}`,
    `gerechnet ${zeitText(s.berechnet_am, antwort.zeitzone)}`,
    ...(s.anlass ? [`Anlass ${s.anlass}`] : []),
  ].join(TRENNER);
  return {
    eingaenge,
    paare: s.eingaenge.filter((e) => e.rolle === 'paar').map(paarText),
    gebildet,
    fehlt: null,
  };
};

// ------------------------------------------------------------------ Berechnung

export interface FassungZeile {
  schluessel: string;
  /** „Fassung 2“. */
  titel: string;
  /** „seit 01.03.2027“ · „seit Beginn bis 28.02.2027“. */
  zeitraum: string;
  /** „rückwirkend (19 Tage)“ vom Server — nur rückwirkend. */
  abzeichen: string | null;
  /** „Menge je Bezugsgröße · MS-12 je BZ-6“. */
  berechnung: string;
  /** „eingetragen von Ines Kaltenbach · 01.10.2026 08:00“. */
  wer: string;
  /** Die Begründung in „…“ oder `null`. */
  warum: string | null;
  aufgehoben: string | null;
  gilt: boolean;
}

export interface BerechnungAnzeige {
  /** „Menge je Bezugsgröße · MS-12 je BZ-6 · Fassung 1 gilt seit Beginn“ (§5.3). */
  satz: string;
  abzeichen: string | null;
  wer: string;
  /** Der Fassungs-Verlauf, jüngste zuerst — erst ab zwei Fassungen (eine einzige steht schon im Satz). */
  fassungen: FassungZeile[];
}

const eingaengeText = (f: KennzahlFassung): string => {
  const zaehler = f.eingaenge.find((e) => e.rolle === 'zaehler');
  const nenner = f.eingaenge.find((e) => e.rolle === 'nenner');
  if (f.rechenform === 'zusammenfassung' || !zaehler || !nenner) return f.eingaenge.map((e) => e.kennzeichen).join(', ');
  return f.rechenform === 'anteil' ? `${zaehler.kennzeichen} an ${nenner.kennzeichen}` : `${zaehler.kennzeichen} je ${nenner.kennzeichen}`;
};

const zeitraumVon = (f: KennzahlFassung): string => {
  const ab = f.gueltig_ab === null ? SEIT_BEGINN : `seit ${datumText(f.gueltig_ab)}`;
  if (f.gueltig_bis === null) return ab;
  return f.gueltig_ab === null ? `${SEIT_BEGINN} bis ${datumText(f.gueltig_bis)}` : `${datumText(f.gueltig_ab)} bis ${datumText(f.gueltig_bis)}`;
};

const fassungZeile = (f: KennzahlFassung, gilt: boolean, zone: string): FassungZeile => ({
  schluessel: String(f.nummer),
  titel: `${UEMS_FASSUNG} ${f.nummer}`,
  zeitraum: zeitraumVon(f),
  abzeichen: f.abzeichen,
  berechnung: [UEMS_RECHENFORM[f.rechenform], eingaengeText(f)].join(TRENNER),
  wer: `${STATUS_VERB.wirksam} von ${f.eingetragen_von.name}${TRENNER}${zeitText(f.eingetragen_am, zone)}`,
  warum: f.begruendung ? zitat(f.begruendung) : null,
  aufgehoben: f.aufgehoben_am ? `aufgehoben am ${zeitText(f.aufgehoben_am, zone)}` : null,
  gilt,
});

/** Die Berechnung (§5.3) mit ihrem Fassungs-Verlauf; `null`, wenn keine Fassung gilt. */
export const berechnung = (k: Kennzahl, fassungen: readonly KennzahlFassung[], zone: string): BerechnungAnzeige | null => {
  const aktuell = fassungen.find((f) => f.nummer === k.fassung) ?? null;
  if (!aktuell) return null;
  const zeilen = [...fassungen].sort((a, b) => b.nummer - a.nummer).map((f) => fassungZeile(f, f.nummer === aktuell.nummer, zone));
  const eigene = zeilen.find((z) => z.gilt) as FassungZeile;
  return {
    satz: [UEMS_RECHENFORM[aktuell.rechenform], eingaengeText(aktuell), `${eigene.titel} gilt ${eigene.zeitraum}`].join(TRENNER),
    abzeichen: aktuell.abzeichen,
    wer: eigene.wer,
    fassungen: zeilen.length >= 2 ? zeilen : [],
  };
};

// ------------------------------------------------------------------ Liste

/** Was die Liste zu den Werten einer Kennzahl weiß. `ausserhalb` = die Werte-Route kennt sie für diesen Leser nicht (404). */
export type ListenWerte =
  | { art: 'laedt' }
  | { art: 'ohne_periode' }
  | { art: 'fehler' }
  | { art: 'ausserhalb' }
  | { art: 'geladen'; antwort: KennzahlWerte };

export interface ListenKarte {
  id: string;
  kennzeichen: string;
  name: string;
  /** „Gebäude Halle 2 · verantwortlich Ines Kaltenbach“. */
  unter: string;
  archiviert: string | null;
  /** Der letzte Wert „0,15 kWh je Stück“ oder „—“; `null` = keiner wird gezeigt (lädt, Fehler, R-A7). */
  zahl: string | null;
  zustand: string | null;
  zustandTon: Ton;
  /** „Oktober 2026 · endgültig“. */
  periode: string | null;
  /** Die Hinweiszeile R-A7 — ohne Wert. */
  hinweis: string | null;
  fehler: string | null;
}

/** Eine Karte der Liste: Name, letzter Wert, Zustand, Geltung, Verantwortlich — oder die Hinweiszeile R-A7 ohne Wert. */
export const listenKarte = (k: Kennzahl, werte: ListenWerte): ListenKarte => {
  const { unter, archiviert } = kopf(k);
  const basis = { id: k.id, kennzeichen: k.kennzeichen, name: k.name, unter, archiviert };
  const ohne = { zahl: null, zustand: null, zustandTon: 'off' as const, periode: null, hinweis: null, fehler: null };
  if (werte.art === 'laedt') return { ...basis, ...ohne };
  if (werte.art === 'ohne_periode') return { ...basis, ...ohne, zahl: OHNE_ZAHL };
  if (werte.art === 'fehler') return { ...basis, ...ohne, fehler: WERTE_FEHLER };
  if (werte.art === 'ausserhalb') return { ...basis, ...ohne, hinweis: AUSSERHALB_ZUGRIFF };
  const w = letzterSchritt(werte.antwort);
  if (!w) return { ...basis, ...ohne, zahl: OHNE_ZAHL };
  const { karte } = wertKarte(werte.antwort, w, null);
  return {
    ...basis,
    ...ohne,
    zahl: karte.zahl,
    zustand: karte.zustand,
    zustandTon: karte.zustandTon,
    // Ohne jede Zeile im Fenster steht „—“ allein: ein Tag daneben sähe aus wie ein fehlender Wert DIESES Tages.
    periode: karte.zustand === null ? null : [karte.titel, karte.fassung].filter((t): t is string => t !== null).join(TRENNER),
  };
};

// ------------------------------------------------------------------ Versionen (§5.5)

/** Der Einstieg „2 Versionen“ an der Karte — erst ab zwei Versionen (die Naht von AP-08 IP-18). */
export const versionenEinstieg = (w: KennzahlWert | null): Pick<Einstieg, 'text' | 'unter'> | null =>
  w !== null && hatHistorie(w.versionen) ? { text: `${w.versionen} ${UEMS_VERSION}en`, unter: EINSTIEG_UNTER } : null;

const historieWert = (h: KennzahlWerteHistorie, w: KennzahlWert): HistorieWert => {
  if (w.zustand === null) return { zahl: OHNE_ZAHL, info: null, ton: 'off' };
  const info = [w.zustand, abdeckungText(w.abdeckung_prozent)].filter((t): t is string => t !== null).join(TRENNER);
  return {
    zahl: wertText(w.wert, w.einheit ?? h.kennzahl.einheit, w.richtung, VERGLEICH_NACHKOMMASTELLEN),
    info,
    ton: tonVon(w.zustand),
  };
};

/** Die Entscheidung hinter einer Version: Korrektur und Ersatzwert wie an der Messstelle, die geänderte Berechnung mit ihrer Fassung. */
export const kennzahlEntscheidung = (e: KennzahlWertEntscheidung, zone: string): EntscheidungAnzeige => {
  if (e.vorgang !== 'berechnung') return entscheidung(e as MessstelleWerteEntscheidung, zone);
  const schluessel = `${e.kennung}|${e.fassung}`;
  const vorgang = e.fassung === null ? UEMS_BERECHNUNG : `${UEMS_BERECHNUNG} ${UEMS_FASSUNG} ${e.fassung}`;
  if (e.fehlt.includes('fassung')) return { schluessel, vorgang, fassung: null, was: null, angelegt: null, fehlt: FASSUNG_FEHLT };
  return {
    schluessel,
    vorgang,
    fassung: urheberschaft(STATUS_VERB.wirksam, e.wer, e.wann, e.warum, e.beleg, zone, OHNE_GRUND),
    was: null,
    angelegt: null,
    fehlt: null,
  };
};

/** Die Historie EINER Periode einer Kennzahl — neueste Version zuerst, in der Form, die `WertVersionen.tsx` zeichnet. */
export const kennzahlHistorie = (h: KennzahlWerteHistorie): HistorieAnzeige => {
  if (h.versionen.length === 0) return { versionen: [], leer: KEINE_HISTORIE };
  const neueste = Math.max(...h.versionen.map((v) => v.version));
  const versionen = [...h.versionen]
    .sort((a, b) => b.version - a.version)
    .map((v): VersionAnzeige => {
      const erste = v.version === 1;
      const entscheidungen = v.entscheidungen.map((e) => kennzahlEntscheidung(e, h.zeitzone));
      return {
        schluessel: String(v.version),
        titel: `${UEMS_VERSION} ${v.version}`,
        etikett: v.version === neueste ? GILT_JETZT : erste ? ORIGINAL : null,
        vorher: erste || v.wert_alt === null ? null : historieWert(h, v.wert_alt),
        danach: historieWert(h, v.wert_neu),
        gebildet: erste ? `gebildet am ${zeitText(v.gebildet_am, h.zeitzone)}` : null,
        entscheidungen,
        // Ohne gespeicherte Entscheidung sagt der Anlass, was geschah (IP-9-Belege haben noch keine) — nie erfunden.
        ohneEntscheidung: erste || entscheidungen.length > 0 ? null : v.anlass ? `Anlass ${v.anlass.beleg}` : OHNE_ENTSCHEIDUNG,
      };
    });
  return { versionen, leer: null };
};
