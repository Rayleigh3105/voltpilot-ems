import type {
  Bezugsflaeche,
  Bezugsgroesse,
  Kennzahl,
  KennzahlAnfrage,
  KennzahlFehlerCode,
  KennzahlPeriodeArt,
  KennzahlRechenform,
  KennzahlVorschau,
  KennzahlVorschauPeriode,
  KennzahlWert,
  Kostenstelle,
  Prozess,
} from '../api';
import { schluesselVon, spanneVon, tagPlus } from '../bezugsPeriode';
import { dez } from '../dez';
import * as A from '../kennzahlAnlegen';
import { heuteIn } from '../kennzahlKarte';
import { KEINE_WERTE } from '../uemsErgebnis';
import * as KZ from '../uemsKennzahl';
import { K1_OKTOBER, K2_OKTOBER, ZONE } from './kennzahlWerteFixtures';
import { ahrenbergRegister } from './messstellenRegisterFixtures';
import { ORT_IDS } from './ortsbaumFixtures';
import { FIXTURE_IDS } from './standorteFixtures';

/**
 * Was der Assistent „Kennzahl anlegen“ (UEMS AP-11 IP-14) liest und die Vorschau antwortet — NUR aus dem
 * Referenzunternehmen `docs/contracts/v2/uems-referenzunternehmen.json` (Blöcke `bezugsgroessen`, `gebaeude[].bezugsflaechen`,
 * `prozesse`, `kostenstellen`) und den Vektoren (`kennzahl-vectors.json`: K1, K2). Kennungen und Anlage-Zeitpunkte sind
 * gestellt. Nur für Tests und E2E-Bühnen, nie ins Produktionsbündel.
 *
 * ⚠ BZ-4 „Bezugsfläche“ steht nicht unter den Bezugsgrößen: die Route liest Flächen aus der Ortsstruktur und nennt sie
 * getrennt (`bezugsflaechen`, ohne Kennzeichen einer Bezugsgröße).
 * ⚠ Die Vorschau prüft Einheit und Periode mit dem Zwilling, wie der Server mit `KennzahlRegeln`; gerechnet sind nur
 * die Oktober-Werte von K1 (MS-12 je BZ-6) und K2 (MS-18 je BZ-7). Perioden ganz vor dem Bestehen der Menge
 * (Zuordnungen ab 01.10.2026, Lindach ab 15.10.2026) tragen `vor_bestehen` wie §5.1 und K20; jede andere Periode fehlt
 * der Bezugsgröße (`nenner_fehlt`).
 */

const ANGELEGT = '2026-10-01T08:00:00+02:00';
const bzId = (n: number) => `c0de0000-0000-4000-8000-0000000b00${String(n).padStart(2, '0')}`;
const prozessId = (n: number) => `c0de0000-0000-4000-8000-0000000e00${String(n).padStart(2, '0')}`;
const kostenstelleId = (kz: string) => `c0de0000-0000-4000-8000-00000000${kz}`;

function bz(n: number, over: Omit<Bezugsgroesse, 'id' | 'kennzeichen' | 'hat_werte' | 'archiviert_am' | 'angelegt_am'>): Bezugsgroesse {
  return { id: bzId(n), kennzeichen: `BZ-${n}`, hat_werte: true, archiviert_am: null, angelegt_am: ANGELEGT, ...over };
}

const GEBAEUDE: [string, string, string][] = [
  ['G-1', ORT_IDS.g1, 'Halle 1'],
  ['G-2', ORT_IDS.g2, 'Halle 2'],
  ['G-3', ORT_IDS.g3, 'Verwaltung'],
  ['G-4', ORT_IDS.g4, 'Lagerhalle Lindach'],
  ['G-5', ORT_IDS.g5, 'Montagehalle Lindach'],
];

/** `GET /api/v1/bezugsgroessen` des Referenzunternehmens. */
export function ahrenbergBezugsgroessen(): { bezugsgroessen: Bezugsgroesse[]; bezugsflaechen: Bezugsflaeche[] } {
  const ms14 = ahrenbergRegister().register.find((z) => z.kennzeichen === 'MS-14')!;
  const periodenwert = { wertart: 'periodenwert' as const, periode_art: 'monat' as const };
  return {
    bezugsgroessen: [
      bz(1, { name: 'Produktionsmenge Spritzguss', einheit: 'kg', ...periodenwert, geltung_art: 'prozess', geltung_id: prozessId(1), geltung_name: 'Spritzguss' }),
      bz(2, { name: 'Gutteile Montage', einheit: 'Stück', ...periodenwert, geltung_art: 'prozess', geltung_id: prozessId(2), geltung_name: 'Montage' }),
      bz(3, { name: 'Betriebsstunden Spritzguss', einheit: 'h', ...periodenwert, geltung_art: 'prozess', geltung_id: prozessId(1), geltung_name: 'Spritzguss' }),
      bz(5, {
        name: 'Ladezeit Ladepunkt Halle 2', einheit: 'h', wertart: 'periodenwert', periode_art: 'tag',
        geltung_art: 'messstelle', geltung_id: ms14.id, geltung_name: ms14.name ?? 'MS-14',
      }),
      bz(6, { name: 'Gutteile Montage Halle 2', einheit: 'Stück', ...periodenwert, geltung_art: 'gebaeude', geltung_id: ORT_IDS.g2, geltung_name: 'Halle 2' }),
      bz(7, { name: 'Gutteile Montage Lindach', einheit: 'Stück', ...periodenwert, geltung_art: 'gebaeude', geltung_id: ORT_IDS.g5, geltung_name: 'Montagehalle Lindach' }),
    ],
    bezugsflaechen: GEBAEUDE.map(([kennzeichen, id, name]) => ({
      name: 'Bezugsfläche',
      wertart: 'stammdatum',
      einheit: 'm²',
      herkunft_art: 'stammdatum_ap02',
      geltung_art: 'gebaeude',
      geltung_id: id,
      geltung_kennzeichen: kennzeichen,
      geltung_name: name,
      schreibbar: false,
      pflegen: 'Flächen pflegen Sie am Gebäude.',
    })),
  };
}

const PROZESSE: [number, string][] = [[1, 'Spritzguss'], [2, 'Montage'], [3, 'Druckluft'], [4, 'Kühlung'], [5, 'Logistik'], [6, 'Verwaltung']];

export function ahrenbergProzesse(): Prozess[] {
  return PROZESSE.map(([n, name]) => ({
    id: prozessId(n), kennzeichen: `P-${n}`, name, eltern: null, gueltig_ab: '2026-10-01', gueltig_bis: null, angelegt_am: ANGELEGT,
  }));
}

const KOSTENSTELLEN: [string, string][] = [
  ['4100', 'Spritzguss'], ['4200', 'Montage'], ['4300', 'Logistik'], ['9000', 'Infrastruktur (Druckluft, Kühlung, PV)'],
  ['9010', 'Druckluft'], ['9020', 'Kühlung'], ['9100', 'Verwaltung'],
];

export function ahrenbergKostenstellen(): Kostenstelle[] {
  return KOSTENSTELLEN.map(([kennzeichen, name]) => ({
    id: kostenstelleId(kennzeichen), kennzeichen, name, gueltig_ab: '2026-10-01', gueltig_bis: null, angelegt_am: ANGELEGT,
  }));
}

/** Der Standort eines Geltungsobjekts, soweit die Bühne ihn braucht (Gebäude, Standorte, Messstellen). */
function standortVon(art: string, id: string): string | null {
  if (art === 'standort') return id;
  if (art === 'messstelle') return ahrenbergRegister().register.find((z) => z.id === id)?.ort.standort_id ?? null;
  const g = GEBAEUDE.find(([, gid]) => gid === id);
  if (!g) return null;
  return ['G-4', 'G-5'].includes(g[0]) ? FIXTURE_IDS.st2 : FIXTURE_IDS.st1;
}

const OKTOBER: Record<string, KennzahlWert> = { 'MS-12|BZ-6': K1_OKTOBER, 'MS-18|BZ-7': K2_OKTOBER };
const BESTEHT_AB: Record<string, string> = { 'MS-18': '2026-10-15' };
const BEGINN = '2026-10-01';

function letzte(art: KennzahlPeriodeArt, heute: string, zahl: number): string[] {
  const aus: string[] = [];
  let [von] = spanneVon(schluesselVon(heute, art), art);
  for (let i = 0; i < zahl; i++) {
    const schluessel = schluesselVon(tagPlus(von, -1), art);
    aus.push(schluessel);
    [von] = spanneVon(schluessel, art);
  }
  return aus;
}

function periode(art: KennzahlPeriodeArt, schluessel: string, menge: string | null, bezug: string | null, bezugName: string, einheit: string): KennzahlVorschauPeriode {
  const [von, bis] = spanneVon(schluessel, art);
  const beschriftung = KZ.periodeText(art, schluessel);
  const ohne = { periode_art: art, schluessel, beschriftung, von, bis, wert: null, zaehler: null, nenner: null, richtung: null, abdeckung_prozent: null, fassung: null, kennzeichen: [] };
  const k = art === 'monat' ? OKTOBER[`${menge}|${bezug}`] : undefined;
  if (k && k.schluessel === schluessel && k.wert !== null) {
    return {
      ...ohne, wert: k.wert, zaehler: k.zaehler, nenner: k.nenner, zustand: k.zustand as string, richtung: k.richtung, grund: null,
      abdeckung_prozent: k.abdeckung_prozent, fassung: KZ.ENDGUELTIG, kennzeichen: k.kennzeichen, anzeige: KZ.anzeige(dez(k.wert), einheit, k.richtung), kundensatz: null,
    };
  }
  if (bis < (BESTEHT_AB[menge ?? ''] ?? BEGINN)) {
    return { ...ohne, zustand: KEINE_WERTE, grund: KZ.VOR_BESTEHEN, anzeige: KZ.anzeige(null, einheit, null), kundensatz: null };
  }
  return {
    ...ohne, zustand: KEINE_WERTE, grund: KZ.NENNER_FEHLT, anzeige: KZ.anzeige(null, einheit, null),
    kundensatz: KZ.satz(KZ.NENNER_FEHLT, { periode: beschriftung, objekt: `${bezug} ${bezugName}` }),
  };
}

const befund = (code: string, message: string): KennzahlVorschau => ({
  befunde: [{ code: code as KennzahlFehlerCode, message, fakten: {} }],
  rechte_geltung: null, standort_id: null, kennung: null, einheit: null, einheit_anzeige: null, grundperiode: null, perioden: [], periode_art: null,
  letzte_perioden: [],
});

/** `POST /api/v1/kennzahlen/vorschau` zur Uhr `jetzt` — schreibt nichts, wie die Route. */
export function kennzahlVorschauAntwort(a: KennzahlAnfrage, jetzt: number): KennzahlVorschau {
  if (a.rechenform === KZ.ZUSAMMENFASSUNG) return befund('anfrage_ungueltig', 'In der Bühne nicht gestellt.');
  const register = ahrenbergRegister().register;
  const { bezugsgroessen } = ahrenbergBezugsgroessen();
  const kz = (rolle: string) => a.eingaenge.find((e) => e.rolle === rolle)?.kennzeichen ?? null;
  const zeile = (k: string | null) => register.find((z) => z.kennzeichen === k) ?? null;
  const menge = zeile(kz('zaehler'));
  const bezugZeile = a.rechenform === KZ.ANTEIL ? zeile(kz('nenner')) : null;
  const bg = bezugsgroessen.find((b) => b.kennzeichen === kz('nenner')) ?? null;
  const mengeSeite: A.Seite | null = menge ? { art: 'messstelle', zeile: menge } : null;
  const bezugSeite: A.Seite | null = bezugZeile ? { art: 'messstelle', zeile: bezugZeile } : bg ? { art: 'bezugsgroesse', bg } : null;
  if (mengeSeite === null || bezugSeite === null) {
    const fehlt = mengeSeite === null ? { art: KZ.MESSSTELLE, objekt: kz('zaehler') ?? '' } : { art: KZ.BEZUGSGROESSE, objekt: kz('nenner') ?? '' };
    return befund(KZ.EINGANG_UNBEKANNT, KZ.satz(KZ.EINGANG_UNBEKANNT, fehlt));
  }
  const p = A.pruefeBerechnung(a.rechenform as KennzahlRechenform, mengeSeite, bezugSeite, a.periode_art ?? null)!;
  if (p.fehler) return befund(p.fehler, p.satz ?? '');
  const g = KZ.geltung(a.geltung_art, standortVon(a.geltung_art, a.geltung_id));
  if (g.fehler) return befund(g.fehler, g.kundensatz ?? '');
  const art = (a.periode_art ?? p.grundperiode) as KennzahlPeriodeArt;
  const einheit = p.einheit as string;
  const bezugName = bg?.name ?? bezugZeile?.name ?? '';
  return {
    befunde: [],
    rechte_geltung: g.rechte_geltung as 'standort' | 'unternehmen',
    standort_id: g.standort,
    kennung: g.kennung,
    einheit,
    einheit_anzeige: p.einheitAnzeige,
    grundperiode: p.grundperiode,
    perioden: p.perioden,
    periode_art: art,
    letzte_perioden: art === 'woche'
      ? []
      : letzte(art, heuteIn(ZONE, jetzt), 3).map((s) => periode(art, s, menge?.kennzeichen ?? null, kz('nenner'), bezugName, einheit)),
  };
}

/** Das nächste freie Kennzeichen nach der höchsten belegten Nummer (IP-5). */
export const naechstesKennzeichen = (belegt: readonly string[]): string =>
  `KZ-${String(Math.max(0, ...belegt.map((k) => Number(k.slice(3)))) + 1).padStart(4, '0')}`;

/** `POST /api/v1/kennzahlen` — Fassung 1 „gilt seit Beginn“, noch ohne Werte. */
export function angelegteKennzahl(a: KennzahlAnfrage, kennzeichen: string, geltungName: string | null, jetzt: number, aufrufer: string): Kennzahl {
  const v = kennzahlVorschauAntwort(a, jetzt);
  return {
    id: `c0de0000-0000-4000-8000-0000000c${kennzeichen.slice(3)}`,
    kennzeichen,
    name: a.name,
    rechenform: a.rechenform as KennzahlRechenform,
    geltung_art: a.geltung_art,
    geltung_id: a.geltung_id,
    geltung_name: geltungName,
    rechte_geltung: v.rechte_geltung ?? 'unternehmen',
    standort_id: v.standort_id,
    kennung: (v.kennung ?? 'kennzahl.unternehmen_definieren') as Kennzahl['kennung'],
    verantwortlich_name: a.verantwortlich_name ?? aufrufer,
    zweck: a.zweck ?? null,
    fassung: 1,
    einheit: v.einheit,
    einheit_anzeige: v.einheit_anzeige,
    grundperiode: v.grundperiode,
    perioden: v.perioden,
    hat_werte: false,
    archiviert_am: null,
    angelegt_am: new Date(jetzt).toISOString(),
  };
}
