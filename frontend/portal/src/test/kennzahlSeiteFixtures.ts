import type {
  api,
  Auffaelligkeit,
  Bezugsbasis,
  BezugsbasisFassung,
  Energieziel,
  Kennzahl,
  KennzahlAuswertung,
  KennzahlFassung,
  KennzahlWert,
  KennzahlWerte,
} from '../api';
import type { BezugsbasisVergleich, BezugsbasisVergleichMonat } from '../bezugsbasisVergleich';
import { periodeText } from '../uemsKennzahl';
import { vermerkDez } from './abweichungFixtures';
import { bb1Fassung, BB_IDS } from './bezugsbasisFixtures';
import { ez2028 } from './energiezielFixtures';
import { ORT_IDS } from './ortsbaumFixtures';

/**
 * Die Seite einer Kennzahl in der Welt des Konzepts (Konzept Auswerten a1 §6.5, §6.6, `daten.py`) - nur für Tests und
 * die Bühne `e2e/kennzahl-seite.html`, nie ins Produktionsbündel. Bühnen-Uhr 30.04.2029, Monat des Urteils März 2029.
 *
 * - KZ-0004 Stromeinsatz Spritzguss je kg gegen BB-0001 (Verhältnis 0,2837 kWh je kg, Fassung 2 seit 01.11.2027,
 *   vorläufig aus Oktober 2026), Messstelle Spritzguss MS-20 und Produktionsmenge BZ-1; Energieziel EZ-2029-0001 (−4 %, März
 *   bis Dezember 2029, Stand nach 1 von 10 Monaten 2,2 % mehr); eine offene Auffälligkeit zu März 2029.
 * - KZ-0024 Netzbezug je m² am Gebäude Halle 1 ohne Bezugsbasis; das Vorjahr gleich (die Demo wiederholt ihre Werte).
 *
 * Die Mengen der Auswertung (erwartet, gemessen − erwartet, zusammengezählt) rechnet hier die Bühne wie der Server -
 * Fixtures dürfen rechnen, die Seite nicht.
 */

export const SEITE_IDS = {
  kz4: BB_IDS.kz4,
  kz24: 'c0de0000-0000-4000-8000-00000000a024',
  ez2029: 'c0de0000-0000-4000-8000-0000000e2029',
  vermerk: 'c0de0000-0000-4000-8000-0000000f2903',
} as const;

const MONATE = ['2028-04', '2028-05', '2028-06', '2028-07', '2028-08', '2028-09', '2028-10', '2028-11', '2028-12', '2029-01', '2029-02', '2029-03'];
/** Messstelle Spritzguss MS-20 und Produktionsmenge BZ-1 (`daten.py`: MS['MS-20'], KG). */
const MS20 = [88200, 87260, 85850, 82580, 73950, 88200, 89860, 89350, 73700, 83220, 86140, 88740];
const KG = [300000, 303000, 294000, 279000, 255000, 300000, 312000, 306000, 249000, 285000, 291000, 306000];
const BASISWERT = 0.2837;
/** KZ-0024 Netzbezug Halle 1 je m² (`daten.py`: KZ24). */
const KZ24 = [19.8333, 19.2262, 18.619, 18.2143, 17.8095, 19.2262, 20.8452, 21.4524, 22.0595, 21.8571, 21.4524, 20.6429];

const text = (n: number, stellen = 10): string => String(Number(n.toFixed(stellen)));
const vorJahr = (periode: string): string => `${Number(periode.slice(0, 4)) - 1}${periode.slice(4)}`;
const richtung = (d: number): 'mehr' | 'weniger' | 'gleich' => (d > 0 ? 'mehr' : d < 0 ? 'weniger' : 'gleich');
const urteil = (d: number) => (d > 2 ? 'schlechter' : d < -2 ? 'besser' : 'im_rahmen') as 'schlechter' | 'besser' | 'im_rahmen';
/** Das Vorjahr eines Monats wie der Server (Operation `roh`): Wert davor, Veränderung mit einer Stelle, kein Urteil. */
function vorjahrRoh(periode: string, wert: number, davor: number): NonNullable<KennzahlAuswertung['vorjahr']> {
  const d = Number(((wert / davor - 1) * 100).toFixed(1));
  return { periode: vorJahr(periode), wert: text(davor), delta_prozent: d.toFixed(1), richtung: richtung(d) };
}

/** Die Variante der Welt: wie im Konzept (über), ein besserer März, oder vor der ersten Fassung (noch kein Vergleich). */
export type SeitenLage = 'ueber' | 'besser' | 'noch_kein_vergleich';

function gemessenJe(lage: SeitenLage): number[] {
  // „besser“: der März braucht 3,4 % weniger als erwartet (§6.13, Szenario der Referenzwelt).
  return lage === 'besser' ? [...MS20.slice(0, 11), Math.round(BASISWERT * KG[11] * 0.966)] : MS20;
}

function zeilen(lage: SeitenLage) {
  const g = gemessenJe(lage);
  return MONATE.map((periode, i) => {
    const erwartet = BASISWERT * KG[i];
    const delta = Number(((g[i] / erwartet - 1) * 100).toFixed(1));
    return { periode, gemessen: g[i], kg: KG[i], erwartet, delta, wert: g[i] / KG[i] };
  });
}

export function kz4Seite(lage: SeitenLage = 'ueber'): Kennzahl {
  const z = zeilen(lage);
  let zusammen = 0;
  const ohne = lage === 'noch_kein_vergleich';
  const monate: KennzahlAuswertung['monate'] = z.map((x, i) => {
    zusammen += x.gemessen - x.erwartet;
    return {
      periode: x.periode,
      wert: text(x.wert),
      delta_prozent: ohne ? null : x.delta.toFixed(1),
      urteil: ohne ? 'nicht_anwendbar' : urteil(x.delta),
      grund: ohne ? 'basis_fehlt' : null,
      erwartet_wert: ohne ? null : text(BASISWERT),
      abweichung: ohne ? null : text(x.gemessen - x.erwartet, 4),
      zusammen: ohne ? null : text(zusammen, 4),
      // Die Demo wiederholt ihre Werte jährlich: das Vorjahr ist der Wert der Messstelle ohne die Variante der Lage.
      vorjahr: vorjahrRoh(x.periode, x.wert, MS20[i] / KG[i]),
    };
  });
  const sg = z.reduce((s, x) => s + x.gemessen, 0);
  const se = z.reduce((s, x) => s + x.erwartet, 0);
  const dz = Number(((sg / se - 1) * 100).toFixed(1));
  const maerz = z[11];
  const februar = z[10];
  const vm = Number(((maerz.wert / februar.wert - 1) * 100).toFixed(1));
  return {
    id: SEITE_IDS.kz4,
    kennzeichen: 'KZ-0004',
    name: 'Stromeinsatz Spritzguss je kg',
    rechenform: 'quotient',
    geltung_art: 'prozess',
    geltung_id: BB_IDS.p1,
    geltung_name: 'Spritzguss',
    rechte_geltung: 'unternehmen',
    standort_id: null,
    kennung: 'kennzahl.unternehmen_definieren',
    verantwortlich_name: 'Ines Kaltenbach',
    zweck: 'Spezifischer Stromeinsatz des Spritzgusses je kg Produktion; wichtigste Kennzahl für Ziele und Maßnahmen.',
    fassung: 1,
    einheit: 'kWh/kg',
    einheit_anzeige: 'kWh je kg',
    grundperiode: 'monat',
    perioden: ['monat', 'jahr'],
    hat_werte: true,
    archiviert_am: null,
    angelegt_am: '2026-10-01T08:00:00+02:00',
    bezugsbasis: { kennzeichen: 'BB-0001', fassung: 2, freigabe_status: 'freigegeben', vorlaeufig: true },
    auswertung: {
      monat: '2029-03',
      wert: { periode: '2029-03', wert: text(maerz.wert), einheit: 'kWh/kg', zustand: 'vollständig', richtung: null },
      vorjahr: monate[11].vorjahr ?? null,
      vormonat: { periode: '2029-02', wert: text(februar.wert), delta_prozent: vm.toFixed(1), richtung: richtung(vm) },
      monate,
      vergleich: ohne
        ? { bezugsbasis: 'BB-0001', urteil: 'nicht_anwendbar', delta_prozent: null, band_prozent: null, richtung: null, grund: 'basis_fehlt', satz: 'März 2029: nicht bewertbar - für diesen Monat gilt noch keine Fassung der Bezugsbasis BB-0001.', erster_monat: '2029-05' }
        : {
            bezugsbasis: 'BB-0001',
            urteil: urteil(maerz.delta),
            delta_prozent: maerz.delta.toFixed(1),
            band_prozent: '2.0',
            richtung: richtung(maerz.delta),
            grund: null,
            satz: `März 2029: ${maerz.gemessen} kWh gemessen, ${Math.round(maerz.erwartet)} kWh erwartet bei ${maerz.kg} kg.`,
            erster_monat: null,
          },
      zeitraum: ohne
        ? null
        : { von: '2028-04', bis: '2029-03', delta_prozent: dz.toFixed(1), band_prozent: '2.0', richtung: richtung(dz), urteil: urteil(dz), grund: null, monate: '12 von 12', satz: 'April 2028 bis März 2029: …' },
      energieziel: ohne
        ? null
        : {
            id: SEITE_IDS.ez2029,
            kennzeichen: 'EZ-2029-0001',
            zielwert_prozent: '-4.0',
            zielperiode: '2029-03/2029-12',
            delta_prozent: maerz.delta.toFixed(1),
            richtung: richtung(maerz.delta),
            urteil: urteil(maerz.delta),
            monate_bewertbar: 1,
            monate_soll: 10,
          },
    },
  };
}

export function vergleichKz4(lage: SeitenLage = 'ueber'): BezugsbasisVergleich {
  const ohne = lage === 'noch_kein_vergleich';
  const monate: BezugsbasisVergleichMonat[] = zeilen(lage).map((x) => ({
    periode: x.periode,
    beschriftung: periodeText('monat', x.periode),
    roh: { gemessen: String(x.gemessen), vorher: null, delta_prozent: null, richtung: null, variable_delta_prozent: null, urteil: 'ohne_urteil' },
    bereinigt: {
      fassung: ohne ? null : { fassung: 2, methode: 'verhaeltnis', referenzperiode: '2026-10/2026-10', datenlage: 'vorlaeufig', gilt_ab: '2027-11-01', gilt_bis: null },
      gemessen: { wert: String(x.gemessen), einheit: 'kWh', version: 1, zustand: 'vollständig' },
      bedingung: ohne ? [] : [{ position: 1, quelle: 'bezugsgroesse', kennzeichen: 'BZ-1', name: 'Produktionsmenge', wert: String(x.kg), einheit: 'kg', fassung: 1, version: null, zustand: 'vollständig' }],
      erwartet: ohne ? null : text(x.erwartet, 4),
      delta_prozent: ohne ? null : x.delta.toFixed(1),
      band_prozent: ohne ? null : '2.0',
      richtung: ohne ? null : richtung(x.delta),
      urteil: ohne ? 'nicht_anwendbar' : urteil(x.delta),
      grund: ohne ? 'basis_fehlt' : null,
      kennzeichen: [],
    },
    satz: ohne
      ? `${periodeText('monat', x.periode)}: nicht bewertbar - für diesen Monat gilt noch keine Fassung der Bezugsbasis BB-0001.`
      : `${periodeText('monat', x.periode)}: ${x.gemessen} kWh gemessen, ${Math.round(x.erwartet)} kWh erwartet bei ${x.kg} kg.`,
  }));
  return {
    kennzahl: { id: SEITE_IDS.kz4, kennzeichen: 'KZ-0004', name: 'Stromeinsatz Spritzguss je kg', einheit: 'kWh/kg', einheit_anzeige: 'kWh je kg' },
    bezugsbasis: { id: BB_IDS.bb1, kennzeichen: 'BB-0001', beendet_zum: null, beendet_grund: null },
    von: MONATE[0],
    bis: MONATE[11],
    zeitzone: 'Europe/Berlin',
    monate,
    zeitraum: { fassung: 2, gemessen: null, erwartet: null, delta_prozent: null, band_prozent: null, richtung: null, urteil: 'ohne_urteil', grund: null, monate: null, kennzeichen: [], satz: '' },
    staende: [],
    stand_satz: 'ungesichert — noch kein Stand',
    satz: null,
  };
}

/** BB-0001 mit Fassung 1 (01.11.2026 bis 31.10.2027) und Fassung 2 (seit 01.11.2027), beide aus Oktober 2026. */
export function bb1Seite(lage: SeitenLage = 'ueber'): { basis: Bezugsbasis; fassungen: BezugsbasisFassung[] } {
  const ab = lage === 'noch_kein_vergleich' ? '2029-05-01' : '2027-11-01';
  const f1 = bb1Fassung('freigegeben', { gilt_bis: '2027-10-31' });
  const f2 = bb1Fassung('freigegeben', {
    fassung: 2,
    gilt_ab: ab,
    anpassungsgruende: ['referenzperiode_vervollstaendigt'],
    begruendung: 'Vergleichszeitraum vervollständigt.',
    freigabe: { name: 'Ines Kaltenbach', rolle: 'energiemanager', am: '2027-11-25T10:00:00+01:00' },
    freigegeben_am: '2027-11-25T10:00:00+01:00',
  });
  const kurz = (f: BezugsbasisFassung) => ({
    fassung: f.fassung, referenzperiode: f.referenzperiode, methode: f.methode, datenlage: f.datenlage, freigabe_status: f.freigabe_status,
    basiswert: f.basiswert, gilt_ab: f.gilt_ab, gilt_bis: f.gilt_bis ?? null, pruefsumme: f.pruefsumme,
  });
  return {
    basis: {
      id: BB_IDS.bb1,
      kennzeichen: 'BB-0001',
      kennzahl_id: SEITE_IDS.kz4,
      kennzahl: 'KZ-0004',
      zweck: null,
      verantwortlich_name: 'Ines Kaltenbach',
      beendet_zum: null,
      beendet_grund: null,
      angelegt_am: '2026-11-12T08:55:00+01:00',
      fassungen: [kurz(f1), kurz(f2)],
      anstoesse: [],
      frist: { ueberpruefung_faellig: false, faellig_am: '2030-04-30', faellig_seit_tagen: null, wiedervorlage_monate: 12, bestaetigt_am: '2029-04-30' },
    },
    fassungen: [f1, f2],
  };
}

export function ez2029(): Energieziel {
  return ez2028({
    id: SEITE_IDS.ez2029,
    kennzeichen: 'EZ-2029-0001',
    zielwert_prozent: '-4.0',
    zielperiode: '2029-03/2029-12',
    wortlaut: 'Spritzguss: 4 % weniger Strom, als die Bezugsbasis erwarten lässt - März bis Dezember 2029.',
  });
}

export function vermerkMaerz(): Auffaelligkeit {
  return vermerkDez({ id: SEITE_IDS.vermerk, periode: '2029-03', vermerkt_am: '2029-04-07T04:12:00Z', standort_id: null });
}

function wertZeile(periode: string, wert: number, zaehler: number | null, nenner: number | null, einheit: string, zaehlerMs: string, nennerBz: string, nennerEinheit: string): KennzahlWert {
  const von = `${periode}-01`;
  const tage = new Date(Date.UTC(Number(periode.slice(0, 4)), Number(periode.slice(5, 7)), 0)).getUTCDate();
  return {
    von,
    bis: `${periode}-${String(tage).padStart(2, '0')}`,
    schluessel: periode,
    beschriftung: periodeText('monat', periode),
    wert: text(wert),
    zaehler: zaehler === null ? null : String(zaehler),
    nenner: nenner === null ? null : String(nenner),
    einheit,
    zustand: 'vollständig',
    richtung: null,
    kennzeichen: ['berechnet (Kennzahl)'],
    abdeckung_prozent: '100',
    fassung: 'endgueltig',
    endgueltig_ab: `${periode}-08T00:00:00+01:00`,
    version: 1,
    definition_fassung: 1,
    berechnet_am: '2029-04-01T00:20:00+02:00',
    grund: null,
    versionen: 1,
    herkunft:
      zaehler === null || nenner === null
        ? null
        : {
            satz: {
              art: 'kennzahl', kennzahl: 'KZ-0004', rechenform: 'quotient', definition_fassung: 1,
              periode: { art: 'monat', schluessel: periode }, berechnet_am: '2029-04-01T00:20:00+02:00', version: 1, anlass: null,
              eingaenge: [
                { rolle: 'zaehler', art: 'messstelle', objekt: zaehlerMs, wert: String(zaehler), zaehler: null, nenner: null, einheit: 'kWh',
                  zustand: 'vollständig', abdeckung_prozent: '100', version: 1, fassung: null, kennzeichen: [] },
                { rolle: 'nenner', art: 'bezugsgroesse', objekt: nennerBz, wert: String(nenner), zaehler: null, nenner: null, einheit: nennerEinheit,
                  zustand: 'vollständig', abdeckung_prozent: '100', version: null, fassung: 1, kennzeichen: [] },
              ],
              ergebnis: { wert: text(wert), einheit, zustand: 'vollständig', richtung: null, grund: null, abdeckung_prozent: '100', kennzeichen: ['berechnet (Kennzahl)'] },
            },
            fehlt: [],
          },
  };
}

/** Die Monatswerte der zwölf Monate (Rechenweg und Versionen; das Vorjahr trägt die Auswertung). */
export function werteSeite(id: string, lage: SeitenLage = 'ueber'): KennzahlWerte {
  const kz4 = id === SEITE_IDS.kz4;
  const g = gemessenJe(lage);
  const werte = MONATE.map((periode, j) =>
    kz4
      ? wertZeile(periode, g[j] / KG[j], g[j], KG[j], 'kWh/kg', 'MS-20', 'BZ-1', 'kg')
      : wertZeile(periode, KZ24[j], Math.round(KZ24[j] * 4200), 4200, 'kWh/m²', 'HZ-1', 'BZ-4', 'm²'),
  );
  return {
    kennzahl: kz4
      ? { id, kennzeichen: 'KZ-0004', name: 'Stromeinsatz Spritzguss je kg', rechenform: 'quotient', einheit: 'kWh/kg', einheit_anzeige: 'kWh je kg' }
      : { id, kennzeichen: 'KZ-0024', name: 'Netzbezug je m²', rechenform: 'quotient', einheit: 'kWh/m²', einheit_anzeige: 'kWh je m²' },
    periode: 'monat',
    von: `${MONATE[0]}-01`,
    bis: '2029-03-31',
    zeitzone: 'Europe/Berlin',
    version: null,
    werte,
  };
}

export function fassungenSeite(id: string): KennzahlFassung[] {
  const kz4 = id === SEITE_IDS.kz4;
  return [
    {
      nummer: 1,
      gueltig_ab: null,
      gueltig_bis: null,
      aufgehoben_am: null,
      herkunft: 'anlage',
      rueckwirkend: false,
      abzeichen: null,
      begruendung: null,
      eingetragen_von: { name: 'Ines Kaltenbach', rolle: 'energiemanager', art: 'kunde' },
      eingetragen_am: '2026-10-01T08:00:00+02:00',
      rechenform: 'quotient',
      einheit: kz4 ? 'kWh/kg' : 'kWh/m²',
      einheit_anzeige: kz4 ? 'kWh je kg' : 'kWh je m²',
      komplement: false,
      eingaenge: kz4
        ? [
            { rolle: 'zaehler', art: 'messstelle', id: 'ms-20', kennzeichen: 'MS-20', name: 'Spritzguss' },
            { rolle: 'nenner', art: 'bezugsgroesse', id: BB_IDS.bz1, kennzeichen: 'BZ-1', name: 'Produktionsmenge' },
          ]
        : [
            { rolle: 'zaehler', art: 'messstelle', id: 'hz-1', kennzeichen: 'HZ-1', name: 'Hauptzähler Halle 1' },
            { rolle: 'nenner', art: 'bezugsgroesse', id: 'bz-4', kennzeichen: 'BZ-4', name: 'Bezugsfläche Halle 1' },
          ],
    },
  ];
}

export function kz24Seite(): Kennzahl {
  const k = kz4Seite();
  const monate: KennzahlAuswertung['monate'] = MONATE.map((periode, i) => ({
    periode, wert: text(KZ24[i]), delta_prozent: null, urteil: null, grund: null, erwartet_wert: null, abweichung: null, zusammen: null,
    vorjahr: vorjahrRoh(periode, KZ24[i], KZ24[i]),
  }));
  return {
    ...k,
    id: SEITE_IDS.kz24,
    kennzeichen: 'KZ-0024',
    name: 'Netzbezug je m²',
    geltung_art: 'gebaeude',
    geltung_id: ORT_IDS.g1,
    geltung_name: 'Halle 1',
    zweck: 'Netzbezug der Halle 1 je m² Bezugsfläche - zum Beobachten.',
    einheit: 'kWh/m²',
    einheit_anzeige: 'kWh je m²',
    bezugsbasis: null,
    auswertung: {
      monat: '2029-03',
      wert: { periode: '2029-03', wert: text(KZ24[11]), einheit: 'kWh/m²', zustand: 'vollständig', richtung: null },
      vorjahr: monate[11].vorjahr ?? null,
      vormonat: { periode: '2029-02', wert: text(KZ24[10]), delta_prozent: ((KZ24[11] / KZ24[10] - 1) * 100).toFixed(1), richtung: 'weniger' },
      monate,
      vergleich: null,
      zeitraum: null,
      energieziel: null,
    },
  };
}

/** Die Routen der Seite im Speicher: Kennzahl, Fassungen, Werte, Vergleich, Bezugsbasis, Energieziel, Auffälligkeit. */
export function seitenBuehne(lage: SeitenLage = 'ueber'): Partial<typeof api> {
  const bb = bb1Seite(lage);
  const kennzahl = (id: string) => (id === SEITE_IDS.kz24 ? kz24Seite() : kz4Seite(lage));
  return {
    kennzahl: async (id: string) => kennzahl(id),
    kennzahlFassungen: async (id: string) => ({ kennzahl: { id, kennzeichen: kennzahl(id).kennzeichen }, fassungen: fassungenSeite(id) }) as never,
    kennzahlen: async () => ({ kennzahlen: [kz4Seite(lage), kz24Seite()], ausserhalb_zugriff: null }) as never,
    kennzahlWerte: async (id: string) => werteSeite(id, lage),
    bezugsbasisVergleich: async () => vergleichKz4(lage),
    kennzahlBezugsbasen: async (id: string) => ({ bezugsbasen: id === SEITE_IDS.kz4 ? [bb.basis] : [] }) as never,
    bezugsbasisFassung: async (_k: string, _b: string, n: number) => bb.fassungen[n - 1],
    bezugsbasisUebersicht: async () => ({ faellig: [] }) as never,
    energieziele: async () => ({ energieziele: lage === 'noch_kein_vergleich' ? [] : [ez2029()] }),
    auffaelligkeiten: async () => ({
      kennzahl: { id: SEITE_IDS.kz4, kennzeichen: 'KZ-0004', name: 'Stromeinsatz Spritzguss je kg' },
      abruf: '2029-04-30',
      offen: lage === 'ueber' ? 1 : 0,
      vermerke: lage === 'ueber' ? [vermerkMaerz()] : [],
    }) as never,
  };
}
