import type {
  Kennzahl,
  KennzahlAnfrage,
  KennzahlFassung,
  KennzahlPeriodeArt,
  KennzahlVorschau,
  KennzahlVorschauPeriode,
  KennzahlWert,
  KennzahlWerte,
  MessstellenRegister,
} from '../api';
import { schluesselVon, spanneVon, tagPlus } from '../bezugsPeriode';
import { dez } from '../dez';
import { heuteIn } from '../kennzahlKarte';
import { KEINE_WERTE } from '../uemsErgebnis';
import * as KZ from '../uemsKennzahl';
import { ahrenbergBezugsgroessen } from './kennzahlAnlegenFixtures';
import { ohneZeile, ZONE } from './kennzahlWerteFixtures';
import { ahrenbergRegister } from './messstellenRegisterFixtures';

/**
 * K17 „Berechnung ändern ab Tag“ (UEMS AP-11 IP-15) — NUR aus dem Referenzunternehmen Ahrenberg
 * (`uems-referenzunternehmen.json`, Block `kennzahlen`: KZ-0004 „Stromeinsatz Spritzguss je kg“, Prozess P-1, MS-20 je
 * BZ-1, angelegt am 03.11.2026 von Ines Kaltenbach) und `kennzahl-vectors.json` Fall K17: Fassung 2 ab 01.03.2027 mit
 * MS-24 (Spritzguss inkl. Kühlung), eingetragen am 20.03.2027 „rückwirkend (19 Tage)“. Die Zahlen: Oktober 2026 = K5
 * (88 630 ÷ 312 400), Februar 2027 = 84 900 ÷ 300 200 mit Fassung 1, März 2027 = 91 200 ÷ 320 000 bisher bzw.
 * (91 200 + 6 300) ÷ 320 000 = 97 500 ÷ 320 000 mit Fassung 2 (die Schritte von K17).
 *
 * Gestellt sind: die Kennungen, die Rechenzeitpunkte, der Zweck ohne den Verweis auf `kennzahl_beispiel`, der Name von
 * MS-24 und die Begründung der Fassung 2 (beide aus dem Titel von K17). Nur für Tests und E2E-Bühnen, nie ins
 * Produktionsbündel.
 */

export type K17Stand = 'vorher' | 'nachher';

/** `&welt=k17`: KZ-0004 mit Fassung 1 — die Bühne zum Ändern. `&welt=k17-fassung2`: nach dem Eintrag vom 20.03.2027. */
export const k17Stand = (welt: string | null): K17Stand | null => (welt === 'k17' ? 'vorher' : welt === 'k17-fassung2' ? 'nachher' : null);

export const KZ4_ID = 'c0de0000-0000-4000-8000-00000000a004';
export const MS24_ID = '3e000000-0000-4000-8000-000000000024';
export const MS24_NAME = 'Spritzguss inkl. Kühlung';
export const K17_EINGETRAGEN = '2027-03-20T09:31:00+01:00';
export const K17_BEGRUENDUNG = 'Zähler MS-24 = Spritzguss inkl. Kühlung';

const ANGELEGT = '2026-11-03T09:00:00+01:00';
const IK = { name: 'Ines Kaltenbach', rolle: 'Energiemanager', art: 'kunde' as const };
const EINHEIT = 'kWh/kg';
/** Die Kennzeichen von K17 — MS-20 und MS-24 sind berechnete Messstellen. */
const SUMME = ['berechnet (Kennzahl)', 'enthält berechnet (Summe)'];

const bz1 = () => ahrenbergBezugsgroessen().bezugsgroessen.find((b) => b.kennzeichen === 'BZ-1')!;
const ms20 = () => ahrenbergRegister().register.find((z) => z.kennzeichen === 'MS-20')!;

/** KZ-0004 aus dem Referenzunternehmen; `nachher` gilt heute Fassung 2. */
export function kz0004(stand: K17Stand): Kennzahl {
  const g = KZ.geltung('prozess', null);
  const p = KZ.periode(null, [
    { art: 'messstelle', objekt: 'MS-20', name: ms20().name, wertart: null, periode_art: 'tag' },
    { art: 'bezugsgroesse', objekt: 'BZ-1', name: bz1().name, wertart: 'periodenwert', periode_art: 'monat' },
  ]);
  return {
    id: KZ4_ID,
    kennzeichen: 'KZ-0004',
    name: 'Stromeinsatz Spritzguss je kg',
    rechenform: 'quotient',
    geltung_art: 'prozess',
    geltung_id: bz1().geltung_id,
    geltung_name: 'Spritzguss',
    rechte_geltung: g.rechte_geltung as Kennzahl['rechte_geltung'],
    standort_id: null,
    kennung: g.kennung as Kennzahl['kennung'],
    verantwortlich_name: 'Ines Kaltenbach',
    zweck: 'Stromeinsatz des Spritzgusses je kg Granulat.',
    fassung: stand === 'nachher' ? 2 : 1,
    einheit: EINHEIT,
    einheit_anzeige: EINHEIT,
    grundperiode: p.grundperiode as KennzahlPeriodeArt,
    perioden: p.perioden as KennzahlPeriodeArt[],
    hat_werte: true,
    archiviert_am: null,
    angelegt_am: ANGELEGT,
  };
}

type Eingang = KennzahlFassung['eingaenge'][number];
const eingangMs20 = (): Eingang => ({ rolle: 'zaehler', art: 'messstelle', id: ms20().id, kennzeichen: 'MS-20', name: ms20().name });
const eingangMs24 = (): Eingang => ({ rolle: 'zaehler', art: 'messstelle', id: MS24_ID, kennzeichen: 'MS-24', name: MS24_NAME });
const eingangBz1 = (): Eingang => ({ rolle: 'nenner', art: 'bezugsgroesse', id: bz1().id, kennzeichen: 'BZ-1', name: bz1().name });

/** `GET …/fassungen` von KZ-0004: Fassung 1 „gilt seit Beginn“ — und `nachher` Fassung 2 ab 01.03.2027 (K17). */
export function fassungenK17(stand: K17Stand): KennzahlFassung[] {
  const f1: KennzahlFassung = {
    nummer: 1,
    gueltig_ab: null,
    gueltig_bis: stand === 'nachher' ? '2027-02-28' : null,
    aufgehoben_am: null,
    herkunft: 'anlage',
    rueckwirkend: false,
    abzeichen: null,
    begruendung: null,
    eingetragen_von: IK,
    eingetragen_am: ANGELEGT,
    rechenform: 'quotient',
    einheit: EINHEIT,
    einheit_anzeige: 'kWh je kg',
    komplement: false,
    eingaenge: [eingangMs20(), eingangBz1()],
  };
  if (stand === 'vorher') return [f1];
  return [
    f1,
    {
      ...f1,
      nummer: 2,
      gueltig_ab: '2027-03-01',
      gueltig_bis: null,
      herkunft: 'eintrag',
      rueckwirkend: true,
      abzeichen: 'rückwirkend (19 Tage)',
      begruendung: K17_BEGRUENDUNG,
      eingetragen_am: K17_EINGETRAGEN,
      eingaenge: [eingangMs24(), eingangBz1()],
    },
  ];
}

// ------------------------------------------------------------------ Werte

const zeile = (schluessel: string, t: Partial<KennzahlWert>): KennzahlWert => ({
  ...ohneZeile('monat', schluessel),
  einheit: EINHEIT,
  zustand: 'vollständig',
  richtung: null,
  abdeckung_prozent: '100',
  kennzeichen: SUMME,
  version: 1,
  versionen: 1,
  definition_fassung: 1,
  grund: null,
  ...t,
});

const OKTOBER = zeile('2026-10', { wert: '0.2837', zaehler: '88630', nenner: '312400', fassung: 'endgueltig', berechnet_am: '2026-11-03T10:20:00+01:00' });
const FEBRUAR = zeile('2027-02', { wert: '0.2828', zaehler: '84900', nenner: '300200', fassung: 'endgueltig', berechnet_am: '2027-03-04T00:20:00+01:00' });
const MAERZ_BISHER = zeile('2027-03', { wert: '0.285', zaehler: '91200', nenner: '320000', fassung: 'vorlaeufig', berechnet_am: '2027-04-01T00:20:00+02:00' });
const MAERZ_FASSUNG2 = zeile('2027-03', {
  wert: '0.3047',
  zaehler: '97500',
  nenner: '320000',
  fassung: 'vorlaeufig',
  definition_fassung: 2,
  berechnet_am: '2027-03-20T10:20:00+01:00',
});

/** `GET …/werte` von KZ-0004 zum Zeitpunkt `jetzt` — je Periode die Zeile, die bis dahin gebildet war. */
export function k17WerteAntwort(stand: K17Stand, periode: KennzahlPeriodeArt, von: string, bis: string, jetzt: number): KennzahlWerte {
  const k = kz0004(stand);
  const zeilen = periode !== 'monat' ? [] : stand === 'vorher' ? [OKTOBER, FEBRUAR, MAERZ_BISHER] : [OKTOBER, FEBRUAR, MAERZ_FASSUNG2];
  const werte: KennzahlWert[] = [];
  for (let tag = von; tag <= bis; ) {
    const schluessel = schluesselVon(tag, periode);
    const z = zeilen.find((w) => w.schluessel === schluessel && Date.parse(w.berechnet_am as string) <= jetzt);
    werte.push(structuredClone(z ?? ohneZeile(periode, schluessel)));
    tag = tagPlus(spanneVon(schluessel, periode)[1], 1);
  }
  const kennzahl = { id: k.id, kennzeichen: k.kennzeichen, name: k.name, rechenform: k.rechenform, einheit: k.einheit, einheit_anzeige: k.einheit_anzeige };
  return { kennzahl, periode, von, bis, zeitzone: ZONE, version: null, werte };
}

// ------------------------------------------------------------------ Vorschau (neu und bisher)

const MONATSWERTE: Record<string, { wert: string; zaehler: string; nenner: string }> = {
  'MS-20|2026-10': { wert: '0.2837', zaehler: '88630', nenner: '312400' },
  'MS-20|2027-02': { wert: '0.2828', zaehler: '84900', nenner: '300200' },
  'MS-20|2027-03': { wert: '0.285', zaehler: '91200', nenner: '320000' },
  'MS-24|2027-03': { wert: '0.3047', zaehler: '97500', nenner: '320000' },
};
const BZ1_MONATE: Record<string, string> = { '2026-10': '312400', '2027-02': '300200', '2027-03': '320000' };

function vorschauPeriode(schluessel: string, zaehler: string): KennzahlVorschauPeriode {
  const [von, bis] = spanneVon(schluessel, 'monat');
  const beschriftung = KZ.periodeText('monat', schluessel);
  const basis = { periode_art: 'monat' as const, schluessel, beschriftung, von, bis, richtung: null, abdeckung_prozent: null, kennzeichen: [] as string[] };
  const w = MONATSWERTE[`${zaehler}|${schluessel}`];
  if (w) {
    return {
      ...basis,
      wert: w.wert,
      zaehler: w.zaehler,
      nenner: w.nenner,
      zustand: 'vollständig',
      grund: null,
      abdeckung_prozent: '100',
      fassung: schluessel === '2027-03' ? KZ.VORLAEUFIG : KZ.ENDGUELTIG,
      kennzeichen: SUMME,
      anzeige: KZ.anzeige(dez(w.wert), EINHEIT, null),
      kundensatz: null,
    };
  }
  const nenner = BZ1_MONATE[schluessel] ?? null;
  const objekt = zaehler === 'MS-24' ? `MS-24 ${MS24_NAME}` : `MS-20 ${ms20().name}`;
  return {
    ...basis,
    wert: null,
    zaehler: null,
    nenner,
    zustand: KEINE_WERTE,
    grund: nenner === null ? KZ.NENNER_FEHLT : KZ.ZAEHLER_FEHLT,
    fassung: null,
    anzeige: KZ.anzeige(null, EINHEIT, null),
    kundensatz:
      nenner === null
        ? KZ.satz(KZ.NENNER_FEHLT, { periode: beschriftung, objekt: `BZ-1 ${bz1().name}` })
        : KZ.satz(KZ.ZAEHLER_FEHLT, { periode: beschriftung, objekt }),
  };
}

/**
 * `POST …/vorschau` für KZ-0004 mit MS-20 oder MS-24 je BZ-1 zur Uhr `jetzt`: die letzten drei ABGESCHLOSSENEN Monate,
 * wie die Route (am 20.03.2027 also Februar, Januar, Dezember). Jede andere Anfrage: `null` — dann antwortet die Bühne
 * des Assistenten.
 */
export function k17VorschauAntwort(a: KennzahlAnfrage, jetzt: number): KennzahlVorschau | null {
  const zaehler = a.eingaenge.find((e) => e.rolle === 'zaehler')?.kennzeichen ?? null;
  const nenner = a.eingaenge.find((e) => e.rolle === 'nenner')?.kennzeichen ?? null;
  const wunsch = a.periode_art ?? null;
  if (a.rechenform !== KZ.QUOTIENT || (zaehler !== 'MS-20' && zaehler !== 'MS-24') || nenner !== 'BZ-1' || (wunsch !== null && wunsch !== 'monat')) {
    return null;
  }
  const g = KZ.geltung(a.geltung_art, null);
  const letzte: KennzahlVorschauPeriode[] = [];
  let [von] = spanneVon(schluesselVon(heuteIn(ZONE, jetzt), 'monat'), 'monat');
  for (let i = 0; i < 3; i += 1) {
    const schluessel = schluesselVon(tagPlus(von, -1), 'monat');
    [von] = spanneVon(schluessel, 'monat');
    letzte.push(vorschauPeriode(schluessel, zaehler));
  }
  return {
    befunde: [],
    rechte_geltung: g.rechte_geltung as 'standort' | 'unternehmen',
    standort_id: g.standort,
    kennung: g.kennung,
    einheit: EINHEIT,
    einheit_anzeige: EINHEIT,
    grundperiode: 'monat',
    perioden: ['monat', 'jahr'],
    periode_art: 'monat',
    letzte_perioden: letzte,
  };
}

/** Das Register mit MS-24 „Spritzguss inkl. Kühlung“ (in der Form von MS-20) — nur für die K17-Bühne. */
export function mitMs24(r: MessstellenRegister): MessstellenRegister {
  const vorlage = r.register.find((z) => z.kennzeichen === 'MS-20');
  if (!vorlage || r.register.some((z) => z.kennzeichen === 'MS-24')) return r;
  return { ...r, register: [...r.register, { ...structuredClone(vorlage), id: MS24_ID, kennzeichen: 'MS-24', name: MS24_NAME }] };
}
