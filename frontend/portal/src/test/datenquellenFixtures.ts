import type { UemsDatenquelle, UemsDatenquelleZeitraum, UemsGeraet } from '../api';
import { FIXTURE_IDS } from './standorteFixtures';

/**
 * Die Boxen, Datenquellen und UEMS-Geräte des Referenzunternehmens „Kunststoffwerk Ahrenberg“
 * (UEMS AP-13 IP-12) — in den Formen der Routen `GET …/sites/{id}/data-sources` (AP-06 IP-3) und
 * `GET …/sites/{id}/geraete` (AP-04 IP-10).
 *
 * ⚠ Die Kennungen der Geräte sind DIESELBEN wie im Register (`messstellenRegisterFixtures.ts`,
 * `9e000000-…-{NN}`) — sonst fände die Fläche ihre Quelle nicht. Wer dort eine Kennung ändert,
 * ändert sie hier mit.
 *
 * ⚠ Jeder Name, jeder Zeitpunkt und jede Zuordnung Gerät → Datenquelle steht so in
 * `docs/contracts/v2/uems-referenzunternehmen.json`; `datenquellenFixtures.test.ts` vergleicht
 * Zeile für Zeile gegen die Datei (die Bühne darf `docs/contracts` nicht laden, deshalb stehen die
 * Werte hier und nicht als Import).
 *
 * Die Zeitachse trägt den BOX-TAUSCH vom 04.11.2026 09:38: E-2′ „Box Halle 2 (neu)“ übernimmt
 * beide Zuständigkeiten von E-2 („Box Halle 2“), und E-2 behält keine — deshalb ist es ein Tausch
 * und keine Übergabe.
 */

/** Der Augenblick, in dem E-2′ die Zuständigkeiten von E-2 übernimmt (Zeitachse der Referenz). */
export const BOX_TAUSCH = '2026-11-04T09:38:00+01:00';

/** Die erste Lesung der neuen Box — das Ende der Übergabe-Lücke. */
export const BOX_TAUSCH_ENDE = '2026-11-04T09:40:00+01:00';

const boxId = (n: number) => `8e000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const quelleId = (n: number) => `7e000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
/** Dieselbe Bildung wie im Register: `GR-7` → `…0007`. */
export const geraetId = (kz: string) => `9e000000-0000-4000-8000-0000000000${kz.slice(3).padStart(2, '0')}`;
const komponenteId = (kz: string) => `c0000000-0000-4000-8000-0000000${kz.replace(/\D/g, '').padStart(5, '0')}`;

export const BOX_IDS = { 'E-1': boxId(1), 'E-2': boxId(2), 'E-2′': boxId(3), 'E-3': boxId(4) } as const;

export const BOX_NAMEN: Record<keyof typeof BOX_IDS, string> = {
  'E-1': 'Box Halle 1',
  'E-2': 'Box Halle 2',
  'E-2′': 'Box Halle 2 (neu)',
  'E-3': 'Box Lindach',
};

const HEIMAT: Record<keyof typeof BOX_IDS, string> = {
  'E-1': FIXTURE_IDS.an1,
  'E-2': FIXTURE_IDS.an2,
  'E-2′': FIXTURE_IDS.an2,
  'E-3': FIXTURE_IDS.an3,
};

/** In Betrieb ab — Mitternacht am Standort bzw. der Augenblick des Tauschs. */
export const BOX_AB: Record<keyof typeof BOX_IDS, string> = {
  'E-1': '2024-03-12T00:00:00+01:00',
  'E-2': '2026-10-01T00:00:00+02:00',
  'E-2′': BOX_TAUSCH,
  'E-3': '2026-10-15T00:00:00+02:00',
};

const box = (kz: keyof typeof BOX_IDS) => ({ id: BOX_IDS[kz], name: BOX_NAMEN[kz], heimat_anlage: HEIMAT[kz] });

interface Def {
  kz: string;
  nr: number;
  anlage: string;
  protokoll: string;
  adresse: string;
  geraete_ids: number[];
  netz: string | null;
  kadenz_s: number;
  steuerquelle: boolean;
  /** Die Boxen dieser Quelle in ihrer Reihenfolge; ein Tausch nennt zwei. */
  boxen: (keyof typeof BOX_IDS)[];
}

/** Die sieben Datenquellen der Referenz — DQ-4 und DQ-5 gehen beim Tausch gemeinsam über. */
const DEFS: Def[] = [
  { kz: 'DQ-1', nr: 1, anlage: FIXTURE_IDS.an1, protokoll: 'modbus_tcp', adresse: '192.168.10.21', geraete_ids: [1], netz: '192.168.10.0/24', kadenz_s: 10, steuerquelle: true, boxen: ['E-1'] },
  { kz: 'DQ-2', nr: 2, anlage: FIXTURE_IDS.an1, protokoll: 'modbus_tcp', adresse: '192.168.10.30', geraete_ids: [1], netz: '192.168.10.0/24', kadenz_s: 10, steuerquelle: false, boxen: ['E-1'] },
  { kz: 'DQ-3', nr: 3, anlage: FIXTURE_IDS.an1, protokoll: 'modbus_tcp', adresse: '192.168.10.31', geraete_ids: [1, 2, 3, 4], netz: '192.168.10.0/24', kadenz_s: 60, steuerquelle: false, boxen: ['E-1'] },
  { kz: 'DQ-4', nr: 4, anlage: FIXTURE_IDS.an2, protokoll: 'modbus_tcp', adresse: '192.168.20.10', geraete_ids: [1], netz: 'VLAN 20 „Produktion“ 192.168.20.0/24', kadenz_s: 60, steuerquelle: false, boxen: ['E-2', 'E-2′'] },
  { kz: 'DQ-5', nr: 5, anlage: FIXTURE_IDS.an2, protokoll: 'ocpp', adresse: 'AHR-LP-01', geraete_ids: [], netz: 'VLAN 20 „Produktion“ 192.168.20.0/24', kadenz_s: 60, steuerquelle: false, boxen: ['E-2', 'E-2′'] },
  { kz: 'DQ-6', nr: 6, anlage: FIXTURE_IDS.an3, protokoll: 'modbus_tcp', adresse: '192.168.30.10', geraete_ids: [1], netz: '192.168.30.0/24', kadenz_s: 60, steuerquelle: false, boxen: ['E-3'] },
  { kz: 'DQ-7', nr: 7, anlage: FIXTURE_IDS.an3, protokoll: 'modbus_tcp', adresse: '192.168.30.11', geraete_ids: [1], netz: '192.168.30.0/24', kadenz_s: 10, steuerquelle: false, boxen: ['E-3'] },
];

/** Gerät → Datenquelle, wie die Referenz es führt (`geraete[].datenquelle`). */
export const GERAET_QUELLE: Record<string, string> = {
  'GR-1': 'DQ-1',
  'GR-2': 'DQ-2',
  'GR-3': 'DQ-3',
  'GR-4': 'DQ-3',
  'GR-5': 'DQ-3',
  'GR-6': 'DQ-3',
  'GR-7': 'DQ-4',
  'GR-8': 'DQ-5',
  'GR-9': 'DQ-6',
  'GR-10': 'DQ-7',
};

/** Gerät → Anlage (über die Datenquelle) und Gerät → Komponenten, wie die Referenz sie führt. */
const GERAET_KOMPONENTEN: Record<string, string[]> = {
  'GR-1': ['K-1', 'K-2'],
  'GR-2': ['K-3'],
  'GR-3': ['K-4'],
  'GR-4': ['K-5'],
  'GR-5': ['K-6'],
  'GR-6': ['K-7'],
  'GR-7': ['K-8.1', 'K-8.2', 'K-8.3', 'K-8.4', 'K-8.7'],
  'GR-8': ['K-9'],
  'GR-9': ['K-10.1', 'K-10.2'],
  'GR-10': ['K-11'],
};

/** Der Einbau, unter dem das Register das Gerät nennt (GR-7 → „C-1“). */
const EINBAU: Record<string, string> = { 'GR-7': 'C-1', 'GR-8': 'AHR-LP-01', 'GR-9': 'C-2' };

function zeitraeume(d: Def): UemsDatenquelleZeitraum[] {
  if (d.boxen.length === 1) {
    return [{ box: box(d.boxen[0]), effective_from: BOX_AB[d.boxen[0]], effective_to: null }];
  }
  const [alt, neu] = d.boxen;
  return [
    { box: box(alt), effective_from: BOX_AB[alt], effective_to: BOX_TAUSCH },
    { box: box(neu), effective_from: BOX_TAUSCH, effective_to: null },
  ];
}

function datenquelle(d: Def, jetzt: string): UemsDatenquelle {
  const zs = zeitraeume(d);
  const laufend = zs.find(
    (z) => Date.parse(z.effective_from) <= Date.parse(jetzt) && (z.effective_to === null || Date.parse(jetzt) < Date.parse(z.effective_to)),
  );
  return {
    id: quelleId(d.nr),
    kennzeichen: d.kz,
    name: null,
    anlage: d.anlage,
    protokoll: d.protokoll,
    adresse: d.adresse,
    geraete_ids: d.geraete_ids,
    netz: d.netz,
    mehrere_leser: false,
    steuerquelle: d.steuerquelle,
    vergleichsquelle: false,
    kadenz_s: d.kadenz_s,
    archiviert_am: null,
    zustaendige_box: laufend ? laufend.box : null,
    zeitraeume: zs,
  };
}

/** Die Datenquellen EINER Anlage, wie die Route sie liefert; `jetzt` bestimmt `zustaendige_box`. */
export function ahrenbergDatenquellen(anlage: string, jetzt: string): { datenquellen: UemsDatenquelle[] } {
  return { datenquellen: DEFS.filter((d) => d.anlage === anlage).map((d) => datenquelle(d, jetzt)) };
}

/** Die UEMS-Geräte EINER Anlage, wie die Route sie liefert — mit ihrer `data_source_id`. */
export function ahrenbergUemsGeraete(anlage: string): { geraete: UemsGeraet[] } {
  const quellen = new Map(DEFS.map((d) => [d.kz, d]));
  const geraete = Object.entries(GERAET_QUELLE)
    .filter(([, dq]) => quellen.get(dq)!.anlage === anlage)
    .map(([kz, dq]): UemsGeraet => ({
      id: geraetId(kz),
      kennzeichen: kz,
      einbau_kennzeichen: EINBAU[kz] ?? kz,
      ausgebaut_am: null,
      data_source_id: quelleId(quellen.get(dq)!.nr),
      komponenten: (GERAET_KOMPONENTEN[kz] ?? []).map((k) => ({
        entity_id: komponenteId(k),
        gueltig_ab: BOX_AB[quellen.get(dq)!.boxen[0]],
        gueltig_bis: null,
      })),
    }));
  return { geraete };
}
