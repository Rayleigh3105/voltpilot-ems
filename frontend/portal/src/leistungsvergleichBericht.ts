/**
 * UEMS AP-17 IP-24 (S1–S5, R8): der Leistungsvergleich in der Berichte-Welt als reine Ableitung — die Kennzahl-Wahl des
 * Anlege-Dialogs, die acht Abschnitte des Abzugs (IP-21b, `bericht.schema.json` `$defs/abzug` dritter Zweig,
 * `BerichtLeistungsvergleich`), der Stand-Satz (§5.8 `leistungsvergleich_stand` / `_ohne_stand`) und der Satz einer
 * abgelehnten Datei (`422 ausgabe_fehlt`, bis IP-22).
 *
 * Hier wird nichts gerechnet und kein Urteil formuliert: `vergleich_je_periode` und `urteil` tragen die Form des
 * Vergleich-Lesers (IP-19, `bezugsbasis.md` §16) — die Fläche gibt sie über `vergleichAusAbzug` an das Bild von IP-20
 * (`vergleichBild`) und dessen Tafel weiter. Die Zahlen setzt nur `deZahl` ins deutsche Format.
 *
 * REIN: kein Netz, kein Zustand, keine Uhr.
 */
import { ApiError, type Bericht, type BerichtAbzug, type BerichtDetail, type Kennzahl } from './api';
import methodenKatalog from './bezugsbasis/bezugsbasis-methoden.json';
import { energieleistung } from './bezugsbasisAnlegen';
import {
  deZahl,
  referenzperiodeText,
  VERGLEICH_ZUM_REITER_BEZUGSBASIS,
  type BezugsbasisVergleich,
  type BezugsbasisVergleichMonat,
  type BezugsbasisVergleichZeitraum,
} from './bezugsbasisVergleich';
import { tagDeutsch } from './bezugsbasisUebersicht';
import {
  UEMS_BEZUGSBASIS,
  UEMS_ENERGIELEISTUNGSKENNZAHL,
  UEMS_FASSUNG,
  UEMS_GRUNDLAST,
  UEMS_KENNZAHL,
  UEMS_LEISTUNGSVERGLEICH,
  UEMS_PRUEFSUMME,
  UEMS_REFERENZPERIODE,
  UEMS_STATISCHER_FAKTOR,
  UEMS_TOLERANZ,
  UEMS_VERSION,
} from './glossar';
import * as B from './uemsBericht';
import { TRENNER } from './uemsErgebnis';

export const LEISTUNGSVERGLEICH = B.LEISTUNGSVERGLEICH;
export const istLeistungsvergleich = (b: Pick<Bericht, 'vorlage'>): boolean => b.vorlage === LEISTUNGSVERGLEICH;

// ------------------------------------------------------------------ Der Abzug (Vertrag 1.4, dritter Zweig)

export interface LvKopf {
  bericht: string;
  vorlage: string;
  vorlage_fassung: number;
  geltung: { art: 'standort' | 'unternehmen'; kennzeichen: string; name_zum_datenstand: string };
  unternehmen: string;
  sitz: string;
  zeitraum: { art: 'monat' | 'jahr' | 'datengrundlage'; schluessel: string; von: string; bis: string; zone: string };
  referenzperiode: { schluessel: string; bezeichnung: string };
  bezugsbasis: { kennzeichen: string; fassung: number };
  grenz_satz: string;
  kennzeichen: string[];
  datenstand: string;
  quellenverzeichnis: string[];
}

export interface LvFaktor {
  position: number;
  art: string;
  kennzeichen: string | null;
  wortlaut: string | null;
  wert: string | null;
  einheit: string | null;
  wert_gueltig_ab: string | null;
  kopie_am: string | null;
}

export interface LvQuelle {
  art: string;
  kennzeichen: string;
  name_zum_datenstand: string;
  bezug: 'unmittelbar' | 'mittelbar' | 'vergleich';
  version: number | null;
  fassung: number | null;
  erster_tag: string;
  letzter_tag: string;
}

export interface LeistungsvergleichAbzug {
  kopf: LvKopf;
  kennzahl: { id: string; kennzeichen: string; name_zum_datenstand: string; rechenform: string; einheit: string | null };
  bezugsbasis: {
    id: string;
    kennzeichen: string;
    fassung: number;
    methode: string;
    referenzperiode: string;
    datenlage: 'vollstaendig' | 'vorlaeufig';
    gilt_ab: string;
    gilt_bis: string | null;
    basiswert: string | null;
    koeffizienten: Record<string, number | string> | null;
    r2: string | null;
    streuung_prozent: string | null;
    toleranz_prozent: string;
    pruefsumme: string | null;
    freigegeben_von: string | null;
    freigegeben_rolle: string | null;
    freigegeben_am: string | null;
    beendet_zum?: string;
    beendet_grund?: string | null;
  };
  vergleich_je_periode: BezugsbasisVergleichMonat[];
  urteil: BezugsbasisVergleichZeitraum;
  grenzen_und_vorbehalte: {
    datenlage: 'vollstaendig' | 'vorlaeufig';
    toleranz_prozent: string | null;
    streuung_prozent: string | null;
    kennzeichen: string[];
    nicht_anwendbar: Array<{ periode: string; grund: string }>;
  };
  statische_faktoren: LvFaktor[];
  quellenverzeichnis: LvQuelle[];
}

/** Die Antwort trägt den Abzug roh; seine Form ist der Vertrag (`$defs/abzug`, dritter Zweig). */
export const lvAbzugAus = (a: BerichtAbzug): LeistungsvergleichAbzug => a as unknown as LeistungsvergleichAbzug;

// ------------------------------------------------------------------ Wörter

export const KENNZAHL_WAHL_TITEL = UEMS_ENERGIELEISTUNGSKENNZAHL;
export const KENNZAHL_WAHL_HINWEIS = `Nur Kennzahlen mit freigegebener ${UEMS_BEZUGSBASIS}. Der Bericht zitiert die Fassung, die am letzten Tag des Zeitraums gilt.`;
export const FEHLT_KENNZAHL = 'Wählen Sie die Kennzahl.';
/** S5 — ohne freigegebene Basis gibt es nichts zu sichern; der Satz des Konzepts und der Weg dorthin. */
export const KEINE_ENERGIELEISTUNG = `${B.SAETZE.leistungsvergleich_ohne_stand}: für diese Geltung gibt es keine Kennzahl mit freigegebener ${UEMS_BEZUGSBASIS}. ${VERGLEICH_ZUM_REITER_BEZUGSBASIS}`;
export const GELTUNG_ART_TITEL = 'Geltung';
export const ZEITRAUM_ART_TITEL = 'Art des Zeitraums';
export const ZEITRAUM_ART_WORT: Record<Bericht['zeitraum_art'], string> = { monat: 'Monat', jahr: 'Jahr', datengrundlage: 'Datengrundlage (zwölf Monate)' };
export const AUSGABE_FEHLER = 'Die Datei konnte nicht abgerufen werden.';
export const ausgabeAbgerufen = (format: 'pdf' | 'csv', nr: number): string =>
  `${format.toUpperCase()} von Stand Nr. ${nr} abgerufen — der Abruf ist protokolliert.`;

/** Die Titel der acht Abschnitte in der Folge der Vorlage (`bericht-vorlagen.json`). */
export const ABSCHNITT_TITEL: Record<string, string> = {
  kopf: 'Kopf',
  kennzahl: UEMS_KENNZAHL,
  bezugsbasis: UEMS_BEZUGSBASIS,
  vergleich_je_periode: 'Vergleich je Periode',
  urteil: 'Urteil',
  grenzen_und_vorbehalte: 'Grenzen und Vorbehalte',
  statische_faktoren: 'Statische Faktoren',
  quellenverzeichnis: 'Quellenverzeichnis',
};
export const ABSCHNITTE = Object.keys(ABSCHNITT_TITEL);

const METHODE_WORT: Record<string, string> = Object.fromEntries(
  (methodenKatalog as { methoden: { kennung: string; kundenwort: string }[] }).methoden.map((m) => [m.kennung, m.kundenwort]),
);
const DATENLAGE_WORT: Record<string, string> = { vollstaendig: 'vollständig', vorlaeufig: 'vorläufig' };
const BEZUG_WORT: Record<string, string> = { unmittelbar: 'unmittelbar', mittelbar: 'mittelbar', vergleich: 'Vergleich' };
const ART_WORT: Record<string, string> = { kennzahl: UEMS_KENNZAHL, messstelle: 'Messstelle', bezugsgroesse: 'Bezugsgröße', bezugsbasis: UEMS_BEZUGSBASIS };

/** „0.8“ → „± 0,8 %“; ohne Wert `null`. */
const prozent = (t: string | null): string | null => (t === null ? null : `± ${deZahl(t.replace(/\.0+$/, ''))} %`);
const zahl = (t: number | string | null): string | null => (t === null ? null : deZahl(String(t)));

// ------------------------------------------------------------------ Kennzahl-Wahl (Anlegen)

export interface KennzahlWahl {
  id: string;
  kennzeichen: string;
  name: string;
  /** „Bezugsbasis BB-0001, Fassung 2“ (· „vorläufig“) — die Fassung, die heute gilt. */
  basis: string;
}

/**
 * Die wählbaren Kennzahlen des Leistungsvergleichs: nur Energieleistungskennzahlen — eine laufende Bezugsbasis mit
 * `freigabe_status = freigegeben` —, nicht archiviert; am Standort nur die dieses Standorts (wie der Leser, 404 sonst).
 */
export const kennzahlWahlen = (kennzahlen: readonly Kennzahl[], geltungArt: Bericht['geltung_art'] | null, geltungId: string | null): KennzahlWahl[] =>
  // Dieselbe Regel wie das Register (IP-9 `energieleistung`, Feld `bezugsbasis` aus IP-8): nur mit freigegebener Basis.
  kennzahlen
    .filter((k) => k.archiviert_am === null && energieleistung(k) !== null)
    .filter((k) => geltungArt !== 'standort' || k.standort_id === geltungId)
    .sort((a, b) => a.kennzeichen.localeCompare(b.kennzeichen, 'de'))
    .map((k) => {
      const bb = k.bezugsbasis!;
      const teile = [`${UEMS_BEZUGSBASIS} ${bb.kennzeichen}${bb.fassung === null ? '' : `, ${UEMS_FASSUNG} ${bb.fassung}`}`];
      if (bb.vorlaeufig) teile.push('vorläufig');
      return { id: k.id, kennzeichen: k.kennzeichen, name: k.name, basis: teile.join(TRENNER) };
    });

// ------------------------------------------------------------------ Die acht Abschnitte

export interface LvZeile {
  name: string;
  wert: string;
}

/** Der Abzug in der Form des Vergleich-Lesers — damit die Tafel von IP-20 ihn unverändert zeigt. */
export const vergleichAusAbzug = (a: LeistungsvergleichAbzug): BezugsbasisVergleich => {
  const perioden = a.vergleich_je_periode.map((m) => m.periode);
  const erste = perioden[0] ?? a.kopf.zeitraum.schluessel.slice(0, 7);
  const letzte = perioden[perioden.length - 1] ?? erste;
  return {
    kennzahl: { id: a.kennzahl.id, kennzeichen: a.kennzahl.kennzeichen, name: a.kennzahl.name_zum_datenstand, einheit: a.kennzahl.einheit, einheit_anzeige: null },
    bezugsbasis: { id: a.bezugsbasis.id, kennzeichen: a.bezugsbasis.kennzeichen, beendet_zum: a.bezugsbasis.beendet_zum ?? null, beendet_grund: a.bezugsbasis.beendet_grund ?? null },
    von: erste,
    bis: letzte,
    zeitzone: a.kopf.zeitraum.zone,
    monate: a.vergleich_je_periode,
    zeitraum: a.urteil,
    staende: [],
    stand_satz: B.SAETZE.leistungsvergleich_ohne_stand,
    satz: null,
  };
};

/** Kopf (W8): Berichtsperiode und Referenzperiode der zitierten Fassung, die Basis, der Datenstand. */
export const kopfZeilen = (a: LeistungsvergleichAbzug): LvZeile[] => {
  const k = a.kopf;
  const z = B.zeitraum(k.zeitraum.art, k.zeitraum.schluessel, k.zeitraum.zone);
  return [
    { name: 'Unternehmen', wert: `${k.unternehmen}, ${k.sitz}` },
    { name: k.geltung.art === 'standort' ? 'Standort' : 'Geltung', wert: `${k.geltung.name_zum_datenstand} (${k.geltung.kennzeichen})` },
    { name: 'Berichtsperiode', wert: z.bezeichnung },
    { name: UEMS_REFERENZPERIODE, wert: k.referenzperiode.bezeichnung || referenzperiodeText(k.referenzperiode.schluessel) },
    { name: UEMS_BEZUGSBASIS, wert: `${k.bezugsbasis.kennzeichen}, ${UEMS_FASSUNG} ${k.bezugsbasis.fassung}` },
    { name: 'Vorlage', wert: `${UEMS_LEISTUNGSVERGLEICH}${TRENNER}${UEMS_FASSUNG} ${k.vorlage_fassung}` },
  ];
};

export const kennzahlZeilen = (a: LeistungsvergleichAbzug): LvZeile[] => [
  { name: 'Kennzeichen', wert: a.kennzahl.kennzeichen },
  { name: 'Name zum Datenstand', wert: a.kennzahl.name_zum_datenstand },
  ...(a.kennzahl.einheit ? [{ name: 'Einheit', wert: a.kennzahl.einheit }] : []),
];

/** Die Koeffizienten der Fassung: „Grundlast 10 523 · 0,2343 je Einheit“ — Schlüssel `a` ist die Grundlast. */
const koeffizientenText = (k: Record<string, number | string>): string =>
  Object.entries(k)
    .map(([name, wert]) => (name === 'a' ? `${UEMS_GRUNDLAST} ${zahl(wert)}` : `${name} ${zahl(wert)}`))
    .join(TRENNER);

/** Bezugsbasis (Kopie der Fassung): Methode in Kundenwort, Basiswert bzw. Koeffizienten, Streuung, Freigeber. */
export const basisZeilen = (a: LeistungsvergleichAbzug): LvZeile[] => {
  const f = a.bezugsbasis;
  const zeilen: LvZeile[] = [
    { name: UEMS_BEZUGSBASIS, wert: `${f.kennzeichen}, ${UEMS_FASSUNG} ${f.fassung}` },
    { name: 'Methode', wert: METHODE_WORT[f.methode] ?? f.methode },
    { name: UEMS_REFERENZPERIODE, wert: referenzperiodeText(f.referenzperiode) },
    { name: 'Datenlage', wert: DATENLAGE_WORT[f.datenlage] ?? f.datenlage },
    { name: 'gilt', wert: f.gilt_bis ? `${tagDeutsch(f.gilt_ab)} bis ${tagDeutsch(f.gilt_bis)}` : `seit ${tagDeutsch(f.gilt_ab)}` },
  ];
  if (f.koeffizienten) zeilen.push({ name: 'Koeffizienten', wert: koeffizientenText(f.koeffizienten) });
  else if (f.basiswert !== null) zeilen.push({ name: 'Basiswert', wert: `${deZahl(f.basiswert)}${a.kennzahl.einheit ? ` ${a.kennzahl.einheit}` : ''}` });
  if (f.r2 !== null) zeilen.push({ name: 'r²', wert: deZahl(f.r2) });
  const streuung = prozent(f.streuung_prozent);
  if (streuung) zeilen.push({ name: 'Streuung', wert: streuung });
  zeilen.push({ name: UEMS_TOLERANZ, wert: prozent(f.toleranz_prozent) ?? '—' });
  if (f.pruefsumme) zeilen.push({ name: UEMS_PRUEFSUMME, wert: f.pruefsumme });
  if (f.freigegeben_von) {
    const wer = f.freigegeben_rolle ? `${f.freigegeben_von} (${f.freigegeben_rolle})` : f.freigegeben_von;
    zeilen.push({ name: 'Freigegeben', wert: f.freigegeben_am ? `${wer} am ${tagDeutsch(f.freigegeben_am.slice(0, 10))}` : wer });
  }
  if (f.beendet_zum) zeilen.push({ name: 'Beendet', wert: `am ${tagDeutsch(f.beendet_zum)}${f.beendet_grund ? ` (${f.beendet_grund})` : ''}` });
  return zeilen;
};

/** Grenzen und Vorbehalte: Datenlage, Toleranz, Streuung, die Kennzeichen (G5) und je Periode der Grund ohne Urteil. */
export const grenzenZeilen = (a: LeistungsvergleichAbzug): LvZeile[] => {
  const g = a.grenzen_und_vorbehalte;
  const monat = new Map(a.vergleich_je_periode.map((m) => [m.periode, m]));
  return [
    { name: 'Datenlage', wert: DATENLAGE_WORT[g.datenlage] ?? g.datenlage },
    ...(g.toleranz_prozent !== null ? [{ name: UEMS_TOLERANZ, wert: prozent(g.toleranz_prozent)! }] : []),
    ...(g.streuung_prozent !== null ? [{ name: 'Streuung', wert: prozent(g.streuung_prozent)! }] : []),
    ...g.kennzeichen.map((k) => ({ name: 'Kennzeichen', wert: k })),
    // Der Grund steht als Satz des Lesers — der Abzug trägt ihn je Monat (Grund statt Zahl).
    ...g.nicht_anwendbar.map((n) => ({ name: monat.get(n.periode)?.beschriftung ?? n.periode, wert: monat.get(n.periode)?.satz ?? n.grund })),
  ];
};

/** Statische Faktoren der Fassung als Kopie (V3); ohne Faktor `[]`. */
export const faktorZeilen = (a: LeistungsvergleichAbzug): LvZeile[] =>
  [...a.statische_faktoren]
    .sort((x, y) => x.position - y.position)
    .map((f) => ({
      name: f.art === 'wortlaut' ? UEMS_STATISCHER_FAKTOR : (f.kennzeichen ?? UEMS_STATISCHER_FAKTOR),
      wert:
        f.art === 'wortlaut'
          ? (f.wortlaut ?? '—')
          : [`${zahl(f.wert) ?? '—'}${f.einheit ? ` ${f.einheit}` : ''}`, f.wert_gueltig_ab ? `ab ${tagDeutsch(f.wert_gueltig_ab)}` : null]
              .filter((x): x is string => x !== null)
              .join(TRENNER),
    }));
export const KEINE_FAKTOREN = `Die Fassung hält keinen ${UEMS_STATISCHER_FAKTOR} fest.`;

/** Quellenverzeichnis: jede Zahl mit Version, Bezugsgröße und Basis mit Fassung, mit ihren Tagen einschließlich. */
export const quellenZeilen = (a: LeistungsvergleichAbzug): Array<LvZeile & { kennzeichen: string }> =>
  a.quellenverzeichnis.map((q) => ({
    kennzeichen: q.kennzeichen,
    name: `${ART_WORT[q.art] ?? q.art} ${q.kennzeichen}`,
    wert: [
      q.name_zum_datenstand,
      q.version !== null ? `${UEMS_VERSION} ${q.version}` : q.fassung !== null ? `${UEMS_FASSUNG} ${q.fassung}` : null,
      BEZUG_WORT[q.bezug] ?? q.bezug,
      q.erster_tag === q.letzter_tag ? tagDeutsch(q.erster_tag) : `${tagDeutsch(q.erster_tag)}–${tagDeutsch(q.letzter_tag)}`,
    ]
      .filter((x): x is string => x !== null && x !== '')
      .join(TRENNER),
  }));

// ------------------------------------------------------------------ Stand (S5, §5.8)

const pruefsummeKurz = (p: string): string => p.replace(B.PRUEFSUMME_PRAEFIX, '').slice(0, 4);

/**
 * §5.8 „Stand“: „Leistungsvergleich Stromeinsatz Spritzguss je kg, Dezember 2027 · Stand Nr. 1 vom 12.01.2028 ·
 * Bezugsbasis BB-0001, Fassung 2 · Prüfsumme 4e2d…“ — am Stand. Am Entwurf ohne freigegebenen Stand „ungesichert —
 * noch kein Stand“; am Entwurf mit Stand `null` (der Verlauf nennt ihn).
 */
export const standSatz = (
  a: LeistungsvergleichAbzug,
  detail: Pick<BerichtDetail, 'staende'>,
  stand: { nr: number; freigegeben_am: string; pruefsumme: string } | null,
): string | null => {
  if (stand === null) return detail.staende.length === 0 ? B.SAETZE.leistungsvergleich_ohne_stand : null;
  const z = B.zeitraum(a.kopf.zeitraum.art, a.kopf.zeitraum.schluessel, a.kopf.zeitraum.zone);
  return B.SAETZE.leistungsvergleich_stand
    .replace('{name}', a.kennzahl.name_zum_datenstand)
    .replace('{zeitraum}', z.bezeichnung)
    .replace('{nr}', String(stand.nr))
    .replace('{datum}', tagDeutsch(tagIn(stand.freigegeben_am, a.kopf.zeitraum.zone)))
    .replace('{bezugsbasis}', a.kopf.bezugsbasis.kennzeichen)
    .replace('{fassung}', String(a.kopf.bezugsbasis.fassung))
    .replace('{pruefsumme}', pruefsummeKurz(stand.pruefsumme));
};

/** Der Kalendertag eines Zeitpunkts in der Zone des Berichts. */
const tagIn = (zeitpunkt: string, zone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(zeitpunkt));

// ------------------------------------------------------------------ PDF und CSV

/** Warum eine Datei nicht kam — der Satz der Route (bis IP-22 `422 ausgabe_fehlt`), sonst ein allgemeiner. */
export const ausgabeFehler = (e: unknown): string =>
  e instanceof ApiError && e.body !== undefined && typeof (e.body as { code?: unknown }).code === 'string' && e.message ? e.message : AUSGABE_FEHLER;

export const KENNZAHL_WAHL_LADEFEHLER = 'Die Kennzahlen konnten nicht geladen werden.';
