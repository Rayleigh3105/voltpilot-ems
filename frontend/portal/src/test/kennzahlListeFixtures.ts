import type { BezugsbasisUrteil, Kennzahl, KennzahlAuswertung, KennzahlAuswertungZiel, KennzahlPeriodeArt, KennzahlWerte } from '../api';
import { ORT_IDS } from './ortsbaumFixtures';
import { FIXTURE_IDS } from './standorteFixtures';

/**
 * Antworten von `GET /api/v1/kennzahlen?mit=auswertung` (Konzept Auswerten a1, PR1) - nur für Tests und E2E-Bühnen, nie
 * ins Produktionsbündel.
 *
 * - `referenzListe()`: die Welt des Konzepts zur Bühnen-Uhr 30.04.2029 (Monat März 2029, `data/vp-auswerten-konzept-a1`
 *   §6.4): KZ-0004 über der Bezugsbasis mit Energieziel 2029, KZ-0023 über einer vorläufigen Bezugsbasis, KZ-0021 im
 *   Rahmen, drei Kennzahlen zum Beobachten und fünf archivierte. Die Abweichungen sind die des Konzepts (`daten.py`).
 * - `mitAuswertungAus()`: die Auswertung der Bühne `startansicht` aus ihren eigenen Monatswerten - ohne Bezugsbasis, so
 *   wie die Welt von 2026 sie hat.
 */

const ZWOELF_AB_APRIL_2028 = ['2028-04', '2028-05', '2028-06', '2028-07', '2028-08', '2028-09', '2028-10', '2028-11',
  '2028-12', '2029-01', '2029-02', '2029-03'];

const urteilBei = (delta: number, band = 2): BezugsbasisUrteil => (delta > band ? 'schlechter' : delta < -band ? 'besser' : 'im_rahmen');

function basis(over: Partial<Kennzahl> & Pick<Kennzahl, 'id' | 'kennzeichen' | 'name'>): Kennzahl {
  return {
    rechenform: 'quotient',
    geltung_art: 'prozess',
    geltung_id: 'c0de0000-0000-4000-8000-0000000b0001',
    geltung_name: 'Spritzguss',
    rechte_geltung: 'unternehmen',
    standort_id: null,
    kennung: 'kennzahl.unternehmen_definieren',
    verantwortlich_name: 'Ines Kaltenbach',
    zweck: null,
    fassung: 1,
    einheit: 'kWh/kg',
    einheit_anzeige: 'kWh je kg',
    grundperiode: 'monat',
    perioden: ['monat', 'jahr'],
    hat_werte: true,
    archiviert_am: null,
    angelegt_am: '2026-10-01T08:00:00+02:00',
    bezugsbasis: null,
    ...over,
  };
}

function mitVergleich(
  werte: readonly number[],
  deltas: readonly number[],
  einheit: string,
  bezugsbasis: string,
  ziel: KennzahlAuswertungZiel | null = null,
): KennzahlAuswertung {
  const letzter = deltas[deltas.length - 1];
  const urteil = urteilBei(letzter);
  const text = Math.abs(letzter).toFixed(1);
  return {
    monat: '2029-03',
    wert: { periode: '2029-03', wert: String(werte[werte.length - 1]), einheit, zustand: 'vollständig', richtung: null },
    vorjahr: null,
    monate: ZWOELF_AB_APRIL_2028.map((periode, i) => ({
      periode,
      wert: String(werte[i]),
      delta_prozent: deltas[i].toFixed(1),
      urteil: urteilBei(deltas[i]),
      grund: null,
    })),
    vergleich: {
      bezugsbasis,
      urteil,
      delta_prozent: letzter.toFixed(1),
      band_prozent: '2.0',
      richtung: letzter > 0 ? 'mehr' : letzter < 0 ? 'weniger' : 'gleich',
      grund: null,
      satz: `März 2029: ${text} % ${letzter >= 0 ? 'mehr' : 'weniger'} als die Bezugsbasis erwarten lässt.`,
      erster_monat: null,
    },
    energieziel: ziel,
  };
}

function zumBeobachten(werte: readonly number[], einheit: string, vorjahr: number): KennzahlAuswertung {
  const letzter = werte[werte.length - 1];
  const delta = ((letzter - vorjahr) / vorjahr) * 100;
  return {
    monat: '2029-03',
    wert: { periode: '2029-03', wert: String(letzter), einheit, zustand: 'vollständig', richtung: null },
    vorjahr: {
      periode: '2028-03',
      wert: String(vorjahr),
      delta_prozent: delta.toFixed(1),
      richtung: delta > 0 ? 'mehr' : delta < 0 ? 'weniger' : 'gleich',
    },
    monate: ZWOELF_AB_APRIL_2028.map((periode, i) => ({ periode, wert: String(werte[i]), delta_prozent: null, urteil: null, grund: null })),
    vergleich: null,
    energieziel: null,
  };
}

export const REFERENZ = {
  kz4: 'c0de0000-0000-4000-8000-00000000a004',
  kz21: 'c0de0000-0000-4000-8000-00000000a021',
  kz22: 'c0de0000-0000-4000-8000-00000000a022',
  kz23: 'c0de0000-0000-4000-8000-00000000a023',
  kz24: 'c0de0000-0000-4000-8000-00000000a024',
  kz25: 'c0de0000-0000-4000-8000-00000000a025',
  ez2029: 'c0de0000-0000-4000-8000-0000000e2029',
} as const;

/** Die Abweichungen des Konzepts (`daten.py`: D4 gegen BB-0001, D23 gegen BB-0007), April 2028 bis März 2029. */
const D4 = [3.6, 1.5, 2.9, 4.3, 2.2, 3.6, 1.5, 2.9, 4.3, 2.9, 4.3, 2.2];
const D23 = [10.2, 12.5, 14.3, 12.3, 2.9, 13.7, 6.8, 3.2, -17.2, -5.7, -0.5, 6.5];
const KZ4 = [0.294, 0.288, 0.292, 0.296, 0.29, 0.294, 0.288, 0.292, 0.296, 0.292, 0.296, 0.29];
const KZ24 = [19.8333, 19.2262, 18.619, 18.2143, 17.8095, 19.2262, 20.8452, 21.4524, 22.0595, 21.8571, 21.4524, 20.6429];
const KZ25 = [8.9231, 11.1667, 23.6667, 57.0, 40.3333, 12.5556, 9.0833, 8.25, 7.9615, 7.8929, 8.0417, 8.25];

/** Die Welt des Konzepts (§6.4) zum 30.04.2029: drei Kennzahlen mit Bezugsbasis, drei zum Beobachten, fünf archiviert. */
export function referenzListe(): Kennzahl[] {
  const ziel: KennzahlAuswertungZiel = {
    id: REFERENZ.ez2029,
    kennzeichen: 'EZ-2029-0001',
    zielwert_prozent: '-4.0',
    zielperiode: '2029-03/2029-12',
    delta_prozent: '2.2',
    richtung: 'mehr',
    urteil: 'schlechter',
    monate_bewertbar: 1,
    monate_soll: 10,
  };
  const archiviert = (nr: string, name: string): Kennzahl =>
    basis({
      id: `c0de0000-0000-4000-8000-00000000a0${nr.slice(-2)}`,
      kennzeichen: `KZ-00${nr}`,
      name,
      geltung_art: 'gebaeude',
      geltung_id: ORT_IDS.g2,
      geltung_name: 'Halle 2',
      rechte_geltung: 'standort',
      standort_id: FIXTURE_IDS.st1,
      kennung: 'kennzahl.standort_definieren',
      archiviert_am: '2026-11-30T09:00:00+01:00',
    });
  return [
    archiviert('01', 'Stromeinsatz Montage je Stück'),
    archiviert('02', 'Stromeinsatz Montage Lindach'),
    archiviert('03', 'Stromeinsatz Montage je Stück - Unternehmen (alt)'),
    basis({
      id: REFERENZ.kz4,
      kennzeichen: 'KZ-0004',
      name: 'Stromeinsatz Spritzguss je kg',
      bezugsbasis: { kennzeichen: 'BB-0001', fassung: 2, freigabe_status: 'freigegeben', vorlaeufig: false },
      auswertung: mitVergleich(KZ4, D4, 'kWh/kg', 'BB-0001', ziel),
    }),
    archiviert('05', 'Netzbezug je m² (alt)'),
    archiviert('06', 'Gasbezug Verwaltung je Gradtag (alt)'),
    basis({
      id: REFERENZ.kz21,
      kennzeichen: 'KZ-0021',
      name: 'Stromeinsatz Montage je Stück',
      geltung_name: 'Montage',
      einheit: 'kWh/Stück',
      einheit_anzeige: 'kWh je Stück',
      bezugsbasis: { kennzeichen: 'BB-0006', fassung: 1, freigabe_status: 'freigegeben', vorlaeufig: false },
      auswertung: mitVergleich(Array(12).fill(2.13), Array(12).fill(0), 'kWh/Stück', 'BB-0006'),
    }),
    basis({
      id: REFERENZ.kz22,
      kennzeichen: 'KZ-0022',
      name: 'Stromeinsatz Montage je Stück - Verwaltung',
      geltung_art: 'gebaeude',
      geltung_id: ORT_IDS.g3,
      geltung_name: 'Verwaltung',
      rechte_geltung: 'standort',
      standort_id: FIXTURE_IDS.st1,
      kennung: 'kennzahl.standort_definieren',
      einheit: 'kWh/Stück',
      einheit_anzeige: 'kWh je Stück',
      auswertung: zumBeobachten(Array(12).fill(0.3), 'kWh/Stück', 0.3),
    }),
    basis({
      id: REFERENZ.kz23,
      kennzeichen: 'KZ-0023',
      name: 'Stromeinsatz Montage je Stück - Unternehmen',
      rechenform: 'zusammenfassung',
      geltung_art: 'unternehmen',
      geltung_id: 'c0de0000-0000-4000-8000-000000000001',
      geltung_name: 'Kunststoffwerk Ahrenberg GmbH',
      einheit: 'kWh/Stück',
      einheit_anzeige: 'kWh je Stück',
      bezugsbasis: { kennzeichen: 'BB-0007', fassung: 1, freigabe_status: 'freigegeben', vorlaeufig: true },
      auswertung: mitVergleich([2.04, 2.08, 2.1, 2.07, 1.92, 2.12, 2.0, 1.94, 1.55, 1.75, 1.85, 2.18], D23, 'kWh/Stück', 'BB-0007'),
    }),
    basis({
      id: REFERENZ.kz24,
      kennzeichen: 'KZ-0024',
      name: 'Netzbezug je m²',
      geltung_art: 'gebaeude',
      geltung_id: ORT_IDS.g1,
      geltung_name: 'Halle 1',
      rechte_geltung: 'standort',
      standort_id: FIXTURE_IDS.st1,
      kennung: 'kennzahl.standort_definieren',
      einheit: 'kWh/m²',
      einheit_anzeige: 'kWh je m²',
      grundperiode: 'tag',
      perioden: ['tag', 'woche', 'monat', 'jahr'],
      auswertung: zumBeobachten(KZ24, 'kWh/m²', 20.6429),
    }),
    basis({
      id: REFERENZ.kz25,
      kennzeichen: 'KZ-0025',
      name: 'Gasbezug Verwaltung je Gradtag',
      geltung_art: 'gebaeude',
      geltung_id: ORT_IDS.g3,
      geltung_name: 'Verwaltung',
      rechte_geltung: 'standort',
      standort_id: FIXTURE_IDS.st1,
      kennung: 'kennzahl.standort_definieren',
      einheit: 'm³/Kd',
      einheit_anzeige: 'm³ je Kd',
      auswertung: zumBeobachten(KZ25, 'm³/Kd', 8.25),
    }),
  ];
}

/** Der Monat vor dem Tag `heute` (`JJJJ-MM-TT`) als `JJJJ-MM`. */
const vormonat = (heute: string): string => {
  const j = Number(heute.slice(0, 4));
  const m = Number(heute.slice(5, 7));
  return m === 1 ? `${j - 1}-12` : `${j}-${String(m - 1).padStart(2, '0')}`;
};
const monatMinus = (periode: string, n: number): string => {
  let j = Number(periode.slice(0, 4));
  let m = Number(periode.slice(5, 7)) - n;
  while (m < 1) {
    m += 12;
    j -= 1;
  }
  return `${j}-${String(m).padStart(2, '0')}`;
};

/**
 * Die Auswertung einer Kennzahl der Bühne aus ihren eigenen Monatswerten (`werte` liefert `…/werte?periode=monat`) - die
 * Welt von 2026 hat keine Bezugsbasis, also kein Urteil; ohne Monatsperiode bleibt die Kennzahl ohne Auswertung.
 */
/**
 * Die Leitkennzahl, wie der Server sie an der Liste nennt (`leitkennzahl`, `KennzahlAuswertungService.leit`) - nur für
 * Bühnen und Fixtures, das Portal leitet sie nie selbst ab: unter den Kennzahlen mit Auswertung, Energieziel und Wert das
 * kleinste Kennzeichen.
 */
export function leitkennzahlWieDerServer(liste: readonly Kennzahl[]): string | undefined {
  return liste
    .filter((k) => k.auswertung?.energieziel && k.auswertung.wert)
    .sort((a, b) => a.kennzeichen.localeCompare(b.kennzeichen))[0]?.id;
}

export function mitAuswertungAus(
  k: Kennzahl,
  heute: string,
  werte: (id: string, periode: KennzahlPeriodeArt, von: string, bis: string) => KennzahlWerte,
): Kennzahl {
  if (k.archiviert_am !== null || !k.perioden.includes('monat')) return k;
  const bis = vormonat(heute);
  const von = monatMinus(bis, 23);
  const ende = new Date(Date.UTC(Number(bis.slice(0, 4)), Number(bis.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const antwort = werte(k.id, 'monat', `${von}-01`, ende);
  const jeMonat = new Map(antwort.werte.map((w) => [w.von.slice(0, 7), w]));
  const monate = Array.from({ length: 12 }, (_, i) => monatMinus(bis, 11 - i)).map((periode) => ({
    periode,
    wert: jeMonat.get(periode)?.wert ?? null,
    delta_prozent: null,
    urteil: null,
    grund: null,
  }));
  const juengster = [...monate].reverse().find((m) => m.wert !== null);
  const w = juengster ? jeMonat.get(juengster.periode) : undefined;
  return {
    ...k,
    auswertung: {
      monat: bis,
      wert: w && w.wert !== null ? { periode: juengster!.periode, wert: w.wert, einheit: w.einheit, zustand: w.zustand, richtung: w.richtung } : null,
      vorjahr: null,
      monate,
      vergleich: null,
      energieziel: null,
    },
  };
}
