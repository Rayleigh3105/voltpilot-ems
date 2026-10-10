import type { Ort, OrtsbaumAmStichtag, OrtsbaumBereich, OrtsbaumGebaeude } from '../api';
import { werkAhrenberg, werkLindach } from './standorteFixtures';

/**
 * Antworten von `GET /api/v1/standorte/{id}/orte` für den Ortsbaum „Standort ›
 * Gebäude“ (UEMS AP-02 IP-7) — NUR aus dem Referenzunternehmen
 * `docs/contracts/v2/uems-referenzunternehmen.json` (Fassung 1.1), Momentaufnahme
 * 20.10.2026:
 *
 * - `ortsbaumAhrenberg` — ST-1 mit G-1 Halle 1 (B-1, B-2), G-2 Halle 2 (B-3 … B-5),
 *   G-3 Verwaltung; direkt am Standort MS-01, MS-02, MS-14. Messstellen je Knoten
 *   GENAU dort (am Gebäude ohne die seiner Bereiche), wie das Lesemodell zählt.
 * - `ortsbaumLindach` — ST-2 mit G-4 (B-6), G-5 (B-7); direkt am Standort MS-16.
 * - `ortsbaumLindachOhneGebaeude` — L1: Werk Lindach, bevor Gebäude angelegt sind;
 *   MS-16 hängt schon direkt am Standort.
 *
 * Nur für Tests und E2E-Bühnen, nie ins Produktionsbündel.
 */

export const ORT_IDS = {
  g1: '0e7a0000-0000-4000-8000-000000000001',
  g2: '0e7a0000-0000-4000-8000-000000000002',
  g3: '0e7a0000-0000-4000-8000-000000000003',
  g4: '0e7a0000-0000-4000-8000-000000000004',
  g5: '0e7a0000-0000-4000-8000-000000000005',
  b1: 'b0e70000-0000-4000-8000-000000000001',
  b2: 'b0e70000-0000-4000-8000-000000000002',
  b3: 'b0e70000-0000-4000-8000-000000000003',
  b4: 'b0e70000-0000-4000-8000-000000000004',
  b5: 'b0e70000-0000-4000-8000-000000000005',
  b6: 'b0e70000-0000-4000-8000-000000000006',
  b7: 'b0e70000-0000-4000-8000-000000000007',
} as const;

function bereich(
  over: Partial<OrtsbaumBereich> & Pick<OrtsbaumBereich, 'id' | 'kurzzeichen' | 'name'>,
): OrtsbaumBereich {
  return {
    nutzung: null,
    notiz: null,
    zustand: 'aktiv',
    gueltigAb: '2026-10-01',
    gueltigBis: null,
    flaecheM2: null,
    flaecheQuelle: null,
    messstellenZahl: 0,
    ...over,
  };
}

function gebaeude(
  over: Partial<OrtsbaumGebaeude> & Pick<OrtsbaumGebaeude, 'id' | 'kurzzeichen' | 'name'>,
): OrtsbaumGebaeude {
  return {
    nutzung: null,
    notiz: null,
    zustand: 'aktiv',
    gueltigAb: '2026-10-01',
    gueltigBis: null,
    flaecheM2: null,
    flaecheQuelle: null,
    messstellenZahl: 0,
    baujahr: null,
    bereiche: [],
    ...over,
  };
}

export function halle1(over: Partial<OrtsbaumGebaeude> = {}): OrtsbaumGebaeude {
  return gebaeude({
    id: ORT_IDS.g1,
    kurzzeichen: 'G-1',
    name: 'Halle 1',
    nutzung: ['produktion'],
    baujahr: 1998,
    gueltigAb: '2024-03-12',
    flaecheM2: 4200,
    flaecheQuelle: 'eigen',
    // MS-03 PV-Erzeugung Dach Halle 1, MS-09 Halle 1 + Verwaltung nicht zugeordnet
    messstellenZahl: 2,
    bereiche: [
      bereich({
        id: ORT_IDS.b1,
        kurzzeichen: 'B-1',
        name: 'Halle 1 Nord',
        nutzung: ['produktion'],
        gueltigAb: '2024-03-12',
        notiz: 'Maschinenreihe SG01–SG06',
        messstellenZahl: 1,
      }),
      bereich({
        id: ORT_IDS.b2,
        kurzzeichen: 'B-2',
        name: 'Halle 1 Süd',
        nutzung: ['technik'],
        gueltigAb: '2024-03-12',
        notiz: 'Technikraum: Druckluft, Kühlung, Box',
        messstellenZahl: 3,
      }),
    ],
    ...over,
  });
}

export function halle2(over: Partial<OrtsbaumGebaeude> = {}): OrtsbaumGebaeude {
  return gebaeude({
    id: ORT_IDS.g2,
    kurzzeichen: 'G-2',
    name: 'Halle 2',
    nutzung: ['produktion', 'montage', 'lager'],
    baujahr: 2019,
    flaecheM2: 3100,
    flaecheQuelle: 'eigen',
    notiz: '2019 zugekauft, eigener Netzanschluss NA-2',
    // MS-10 Netzbezug Halle 2, MS-15 Halle 2 nicht zugeordnet
    messstellenZahl: 2,
    bereiche: [
      bereich({
        id: ORT_IDS.b3,
        kurzzeichen: 'B-3',
        name: 'Halle 2 Montage',
        nutzung: ['montage'],
        notiz: 'Montagelinie M1',
        messstellenZahl: 1,
      }),
      bereich({
        id: ORT_IDS.b4,
        kurzzeichen: 'B-4',
        name: 'Halle 2 Spritzguss',
        nutzung: ['produktion'],
        notiz: 'Maschinenreihe SG07–SG10',
        messstellenZahl: 1,
      }),
      bereich({
        id: ORT_IDS.b5,
        kurzzeichen: 'B-5',
        name: 'Halle 2 Lager',
        nutzung: ['lager'],
        notiz: 'Lager + Allgemeinstrom',
        messstellenZahl: 1,
      }),
    ],
    ...over,
  });
}

export function verwaltung(over: Partial<OrtsbaumGebaeude> = {}): OrtsbaumGebaeude {
  return gebaeude({
    id: ORT_IDS.g3,
    kurzzeichen: 'G-3',
    name: 'Verwaltung',
    nutzung: ['buero'],
    baujahr: 2004,
    gueltigAb: '2024-03-12',
    flaecheM2: 1150,
    flaecheQuelle: 'eigen',
    // MS-05 Verwaltung gesamt, MS-21 Gas Heizung Verwaltung
    messstellenZahl: 2,
    ...over,
  });
}

export function ortsbaumAhrenberg(over: Partial<OrtsbaumAmStichtag> = {}): OrtsbaumAmStichtag {
  return {
    stichtag: '2026-10-20',
    standort: werkAhrenberg(),
    summeGebaeudeM2: 8450,
    gebaeudeOhneFlaeche: [],
    // Absichtlich NICHT nach Kurzzeichen: die Ableitung sortiert selbst.
    gebaeude: [halle2(), verwaltung(), halle1()],
    // MS-01, MS-02 (Zählerplatz), MS-14 Ladepunkt Parkplatz Halle 2
    direktAmStandort: { bereiche: [], messstellenZahl: 3 },
    ...over,
  };
}

export function ortsbaumLindach(over: Partial<OrtsbaumAmStichtag> = {}): OrtsbaumAmStichtag {
  return {
    stichtag: '2026-10-20',
    standort: werkLindach(),
    summeGebaeudeM2: 2600,
    gebaeudeOhneFlaeche: [],
    gebaeude: [
      gebaeude({
        id: ORT_IDS.g4,
        kurzzeichen: 'G-4',
        name: 'Lagerhalle Lindach',
        nutzung: ['lager', 'logistik'],
        baujahr: 2011,
        gueltigAb: '2026-10-15',
        flaecheM2: 1800,
        flaecheQuelle: 'eigen',
        messstellenZahl: 1,
        bereiche: [
          bereich({
            id: ORT_IDS.b6,
            kurzzeichen: 'B-6',
            name: 'Lager Lindach',
            nutzung: ['lager', 'logistik'],
            gueltigAb: '2026-10-15',
            notiz: 'Tore, Förderer, Beleuchtung',
          }),
        ],
      }),
      gebaeude({
        id: ORT_IDS.g5,
        kurzzeichen: 'G-5',
        name: 'Montagehalle Lindach',
        nutzung: ['montage'],
        baujahr: 2011,
        gueltigAb: '2026-10-15',
        flaecheM2: 800,
        flaecheQuelle: 'eigen',
        messstellenZahl: 1,
        bereiche: [
          bereich({
            id: ORT_IDS.b7,
            kurzzeichen: 'B-7',
            name: 'Montage Lindach',
            nutzung: ['montage'],
            gueltigAb: '2026-10-15',
            notiz: 'Montagelinie M2',
          }),
        ],
      }),
    ],
    // MS-16 Netzbezug Lindach
    direktAmStandort: { bereiche: [], messstellenZahl: 1 },
    ...over,
  };
}

/** L1: Werk Lindach ohne Gebäude und ohne Bereiche — MS-16 hängt direkt am Standort. */
export function ortsbaumLindachOhneGebaeude(): OrtsbaumAmStichtag {
  return ortsbaumLindach({
    standort: werkLindach({
      gebaeudeZahl: 0,
      bereichZahl: 0,
      flaecheM2: null,
      flaecheQuelle: null,
    }),
    summeGebaeudeM2: null,
    gebaeude: [],
  });
}

/** Die Antwort von POST/PUT — für Tests genügt ein Gebäude nach dem Schreiben. */
export function ortNachSchreiben(over: Partial<Ort> = {}): Ort {
  return {
    id: ORT_IDS.g2,
    art: 'gebaeude',
    kurzzeichen: 'G-2',
    name: 'Halle 2',
    nutzung: ['produktion', 'montage', 'lager'],
    baujahr: 2019,
    notiz: null,
    zustand: 'aktiv',
    standortId: werkAhrenberg().id,
    zuordnungen: [],
    flaechen: [],
    rueckwirkung: null,
    ...over,
  };
}
