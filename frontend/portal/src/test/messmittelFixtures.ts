import type { BewertungMessabdeckung, MessmittelAngaben, MessmittelEintrag } from '../api';
import { rechteSeed } from './rollenFixtures';
import { FIXTURE_IDS } from './standorteFixtures';

/**
 * Messmittel-Angaben und Messabdeckung des Referenzunternehmens Ahrenberg (UEMS AP-16 IP-18) — abgeschrieben aus
 * `docs/contracts/v2/uems-referenzunternehmen.json` 1.6 (`messmittel_angaben`: GR-2 Eichung mit Beleg, Z-5b
 * Werksbescheinigung, GR-5 nicht erhoben, K-8.2 Wandler ohne Klasse) und AP-16 §5.3 (Oktober 2026, Datenstand
 * 30.11.2026 mit MS-23 geplant). Nur für Tests und E2E-Bühnen, nie ins Produktionsbündel.
 */
const akteur = (kuerzel: string) => {
  const { benutzer } = rechteSeed(kuerzel);
  return { sub: benutzer.kennung, name: benutzer.name, rolle: null, art: 'kunde' as const };
};

export const GR2_ID = '9b000000-0000-4000-8000-000000000002';
export const GR5_ID = '9b000000-0000-4000-8000-000000000005';

export function gr2Messmittel(): MessmittelAngaben {
  return {
    geraet_id: GR2_ID, kennzeichen: 'GR-2', einbau_kennzeichen: 'GR-2', zustand: 'erhoben',
    genauigkeitsklasse: 'B (MID, Wirkenergie)', pruefungsart: 'eichung', pruefung_am: '2023-06-14', pruefung_gueltig_bis: '2031-12-31',
    beleg: {
      bezeichnung: 'Zählerstandsmitteilung 10/2026, Netzgesellschaft Ahrental, Zählernr. 47110000001-Z1', ablage: 'beim Kunden (Netzrechnung)',
      sha256: '3b1f4d86f164c8e54eaa3a9c335975dd54dcbd68b42bbb9c7b24d2195e2a9a2e', person: akteur('IK'), zeitpunkt: '2026-11-28T09:00:00+01:00',
    },
    wandler: [], laut_hersteller: [],
  };
}

export function gr5Messmittel(): MessmittelAngaben {
  return {
    geraet_id: GR5_ID, kennzeichen: 'GR-5', einbau_kennzeichen: 'GR-5', zustand: 'nicht_erhoben',
    genauigkeitsklasse: null, pruefungsart: 'nicht_erhoben', pruefung_am: null, pruefung_gueltig_bis: null, beleg: null, wandler: [], laut_hersteller: [],
  };
}

/** Z-5b am Gerät GR-4 (Zählerwechsel 18.11.2026): Werksbescheinigung, Beleg; die Angabe hängt am Einbau. */
export function z5bMessmittel(geraetId: string): MessmittelAngaben {
  return {
    geraet_id: geraetId, kennzeichen: 'GR-4', einbau_kennzeichen: 'Z-5b', zustand: 'erhoben',
    genauigkeitsklasse: '1', pruefungsart: 'werksbescheinigung', pruefung_am: '2026-10-02', pruefung_gueltig_bis: null,
    beleg: { bezeichnung: 'Werksprüfprotokoll Seriennr. 88231', ablage: 'beim Kunden', sha256: 'c07dd7a33d2b17df6fece484ec4e08bb50c93326653576cfb1b8dd8dcf8a41f0',
      person: akteur('TB'), zeitpunkt: '2026-11-28T09:15:00+01:00' },
    wandler: [], laut_hersteller: [],
  };
}

/** Ein Einbau vor dem Eintragen — alles nicht erhoben, mit einer Stromwandler-Fassung 400/5 A ohne Klasse. */
export function leerMessmittel(geraetId: string, kennzeichen: string, einbau: string, mitWandler = false): MessmittelAngaben {
  return {
    geraet_id: geraetId, kennzeichen, einbau_kennzeichen: einbau, zustand: 'nicht_erhoben', genauigkeitsklasse: null,
    pruefungsart: 'nicht_erhoben', pruefung_am: null, pruefung_gueltig_bis: null, beleg: null,
    wandler: mitWandler ? [{ fassung: '9c000000-0000-4000-8000-000000000082', art: 'wandler_strom', wert: { primaer_a: 400, sekundaer_a: 5 },
      gueltig_ab: '2027-02-01T00:00:00+01:00', gueltig_bis: null, klasse: null, zustand: 'nicht_erhoben' }] : [],
    // IP-16 (G4): die Energiekarte 750-494 laut Katalog (`catalog/measurement-points/sources/cloud/accuracy.json`).
    laut_hersteller: mitWandler ? [{ ziel_art: 'teil', ziel: '9d000000-0000-4000-8000-000000000082', bezeichnung: 'Energiekarte K-8.2',
      hersteller: 'WAGO', modell: '750-494', zustand: 'belegt', klasse: 'Messfehler', wert: '± 0,5 %', bezug: 'Messbereichsendwert der Wirkleistung',
      fundstelle: 'Handbuch Version 1.5.0, Tabelle 16 „Messfehler“, Seite 37',
      source_url: 'https://www.wago.com/wagoweb/documentation/750/ger_manu/modules/m07500494_xxxxxxxx_0de.pdf',
      source_sha256: '7a31954179fdf075af202f085f2418b09c960678e02eb106974a0c96c80bac7f' }] : [],
  };
}

/** Die Antwort der Route auf einen PUT — wie die API: Person und Zeitpunkt des Eintragens am Beleg. */
export function messmittelNachEintrag(vorher: MessmittelAngaben, e: MessmittelEintrag, kuerzel = 'IK', zeitpunkt = '2026-11-28T09:00:00+01:00'): MessmittelAngaben {
  const erhoben = e.genauigkeitsklasse !== null || (e.pruefungsart !== null && e.pruefungsart !== 'nicht_erhoben') || e.beleg !== null;
  return {
    ...vorher, zustand: erhoben ? 'erhoben' : 'nicht_erhoben', genauigkeitsklasse: e.genauigkeitsklasse, pruefungsart: e.pruefungsart ?? 'nicht_erhoben',
    pruefung_am: e.pruefung_am, pruefung_gueltig_bis: e.pruefung_gueltig_bis,
    beleg: e.beleg ? { bezeichnung: e.beleg.bezeichnung, ablage: e.beleg.ablage, sha256: e.beleg.sha256.toLowerCase(), person: akteur(kuerzel), zeitpunkt } : null,
    wandler: vorher.wandler.map((w) => {
      const neu = e.wandler?.find((x) => x.fassung === w.fassung);
      return neu ? { ...w, klasse: neu.klasse, zustand: neu.klasse ? 'erhoben' : 'nicht_erhoben' } : w;
    }),
  };
}

const ms = (id: string, kennzeichen: string, ort: string, menge: string) => ({ id, kennzeichen, ort, menge, einheit: 'kWh' });
const msId = (n: number) => `a1000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const eeId = (n: number) => `ee000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

/** §5.3 als Antwort von `…/bewertung/messabdeckung` (Oktober 2026, Datenstand 30.11.2026). */
export function ahrenbergMessabdeckung(): BewertungMessabdeckung {
  const rest1 = { anlage_id: FIXTURE_IDS.an1, anlage: 'Halle 1', menge: '54580', anteil_prozent: '39.2' };
  const ms23 = { messstelle_id: msId(23), kennzeichen: 'MS-23', ort: 'G-1 Halle 1', keine_datenquelle_seit: '2026-11-27', messbedarf: 'MB-1' };
  const einsatz = (n: number, name: string, prozess: string, gemessen: ReturnType<typeof ms>[], menge: string | null, traeger: 'Strom' | 'Gas' = 'Strom') => ({
    id: eeId(n), kennzeichen: `EE-${n}`, name, prozess_id: prozess, traeger, einheit: traeger === 'Gas' ? 'm³' : 'kWh', menge,
    gemessen, geplant: [] as typeof ms23[], ersatz: [], ungemessen: [] as typeof rest1[],
  });
  const ee8 = { ...einsatz(8, 'Gebäudetechnik Halle 1', 'P-7', [], null), geplant: [ms23], ungemessen: [rest1] };
  return {
    von: '2026-10-01', bis: '2026-10-31', umfang_id: 'b0000000-0000-4000-8000-000000000001', umfang_fassung: 1, teilansicht: false,
    summe: {
      nenner: { wert: '185380', einheit: 'kWh', vorhanden: 3, gesamt: 3, anlagen: '3 von 3', zustand: 'vollständig' },
      gemessen_zugeordnet: '125740', abdeckung_prozent: '67.8', k8: 'unter_schwelle', ersatz: '0', ungemessen: '59640', ungemessen_prozent: '32.2',
    },
    je_einsatz: [
      einsatz(1, 'Spritzguss', 'P-1', [ms(msId(6), 'MS-06', 'B-1 Halle 1 Nord', '55100'), ms(msId(11), 'MS-11', 'B-4 Halle 2 Spritzguss', '22400')], '77500'),
      einsatz(2, 'Montage', 'P-2', [ms(msId(12), 'MS-12', 'B-3 Halle 2 Montage', '6040'), ms(msId(18), 'MS-18', 'G-5 Montagehalle Lindach', '3600')], '9640'),
      einsatz(3, 'Druckluft', 'P-3', [ms(msId(7), 'MS-07', 'B-2 Halle 1 Süd', '15900')], '15900'),
      einsatz(4, 'Kühlung', 'P-4', [ms(msId(8), 'MS-08', 'B-2 Halle 1 Süd', '6200')], '6200'),
      einsatz(5, 'Logistik', 'P-5', [ms(msId(13), 'MS-13', 'B-5 Halle 2 Lager', '3500'), ms(msId(17), 'MS-17', 'G-4 Lagerhalle Lindach', '4300')], '7800'),
      einsatz(6, 'Verwaltung', 'P-6', [ms(msId(5), 'MS-05', 'G-3 Verwaltung', '7600'), ms(msId(14), 'MS-14', 'ST-1 Außenfläche Halle 2', '1100')], '8700'),
      { ...einsatz(7, 'Heizung Verwaltung', 'P-6', [{ ...ms(msId(21), 'MS-21', 'G-3 Verwaltung', '1240'), einheit: 'm³' }], '1240', 'Gas') },
      ee8,
    ],
    je_ort: [
      { art: 'anlage', id: FIXTURE_IDS.an1, kennzeichen: 'AN-1', name: 'Halle 1', traeger: 'Strom', einheit: 'kWh',
        gemessen: [ms(msId(5), 'MS-05', 'G-3', '7600'), ms(msId(6), 'MS-06', 'G-1', '55100'), ms(msId(7), 'MS-07', 'G-1', '15900'), ms(msId(8), 'MS-08', 'G-1', '6200')],
        geplant: [ms23], ersatz: [], ungemessen: rest1 },
      { art: 'anlage', id: FIXTURE_IDS.an2, kennzeichen: 'AN-2', name: 'Halle 2', traeger: 'Strom', einheit: 'kWh',
        gemessen: [ms(msId(11), 'MS-11', 'G-2', '22400'), ms(msId(12), 'MS-12', 'G-2', '6040'), ms(msId(13), 'MS-13', 'G-2', '3500'), ms(msId(14), 'MS-14', 'G-2', '1100')],
        geplant: [], ersatz: [], ungemessen: { anlage_id: FIXTURE_IDS.an2, anlage: 'Halle 2', menge: '3860', anteil_prozent: '10.5' } },
      { art: 'anlage', id: FIXTURE_IDS.an3, kennzeichen: 'AN-3', name: 'Werk Lindach', traeger: 'Strom', einheit: 'kWh',
        gemessen: [ms(msId(17), 'MS-17', 'G-4', '4300'), ms(msId(18), 'MS-18', 'G-5', '3600')],
        geplant: [], ersatz: [], ungemessen: { anlage_id: FIXTURE_IDS.an3, anlage: 'Werk Lindach', menge: '1200', anteil_prozent: '13.2' } },
      { art: 'gebaeude', id: null, kennzeichen: 'G-3', name: 'Verwaltung', traeger: 'Gas', einheit: 'm³',
        gemessen: [{ ...ms(msId(21), 'MS-21', 'G-3', '1240'), einheit: 'm³' }], geplant: [], ersatz: [], ungemessen: null },
    ],
  };
}
