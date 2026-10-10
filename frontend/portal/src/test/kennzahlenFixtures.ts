import type { Kennzahl } from '../api';
import { ORT_IDS } from './ortsbaumFixtures';
import { FIXTURE_IDS } from './standorteFixtures';

/**
 * Antworten von `GET /api/v1/kennzahlen` — NUR aus dem Referenzunternehmen
 * `docs/contracts/v2/uems-referenzunternehmen.json`, Block `kennzahlen`:
 * KZ-0001 (Halle 2), KZ-0002 (Montagehalle Lindach) und KZ-0003 (Unternehmen,
 * Summe ÷ Summe). Namen, Zweck, Einheit und Verantwortliche stehen dort; die
 * Kennungen und Anlage-Zeitpunkte sind gestellt. Nur für Tests und E2E-Bühnen,
 * nie ins Produktionsbündel.
 */
const UNTERNEHMEN_ID = 'c0de0000-0000-4000-8000-000000000001';

function kennzahl(over: Partial<Kennzahl> & Pick<Kennzahl, 'id' | 'kennzeichen' | 'name'>): Kennzahl {
  return {
    rechenform: 'quotient',
    geltung_art: 'gebaeude',
    geltung_id: ORT_IDS.g2,
    geltung_name: 'Halle 2',
    rechte_geltung: 'standort',
    standort_id: FIXTURE_IDS.st1,
    kennung: 'kennzahl.standort_definieren',
    verantwortlich_name: 'Ines Kaltenbach',
    zweck: null,
    fassung: 1,
    einheit: 'kWh/Stück',
    einheit_anzeige: 'kWh/Stück',
    grundperiode: 'monat',
    // K1 Regel `periode`: MS-12 (Tag) und BZ-6 (Monat) → Grundperiode Monat, dazu Jahr.
    perioden: ['monat', 'jahr'],
    hat_werte: true,
    archiviert_am: null,
    angelegt_am: '2026-10-01T08:00:00+02:00',
    ...over,
  };
}

export function ahrenbergKennzahlen(): Kennzahl[] {
  return [
    kennzahl({
      id: 'c0de0000-0000-4000-8000-00000000a001',
      kennzeichen: 'KZ-0001',
      name: 'Stromeinsatz Montage je Stück — Halle 2',
      zweck: 'Spezifischer Stromeinsatz der Montagelinie M1 je Gutteil; Basis für den Vergleich mit Lindach.',
    }),
    kennzahl({
      id: 'c0de0000-0000-4000-8000-00000000a002',
      kennzeichen: 'KZ-0002',
      name: 'Stromeinsatz Montage je Stück — Montagehalle Lindach',
      geltung_id: ORT_IDS.g5,
      geltung_name: 'Montagehalle Lindach',
      standort_id: FIXTURE_IDS.st2,
      verantwortlich_name: 'Peter Hollerbach',
      zweck: 'Spezifischer Stromeinsatz der Montagehalle Lindach je Gutteil.',
      angelegt_am: '2026-10-15T08:00:00+02:00',
    }),
    kennzahl({
      id: 'c0de0000-0000-4000-8000-00000000a003',
      kennzeichen: 'KZ-0003',
      name: 'Stromeinsatz Montage je Stück — Unternehmen',
      rechenform: 'zusammenfassung',
      geltung_art: 'unternehmen',
      geltung_id: UNTERNEHMEN_ID,
      geltung_name: 'Kunststoffwerk Ahrenberg GmbH',
      rechte_geltung: 'unternehmen',
      standort_id: null,
      kennung: 'kennzahl.unternehmen_definieren',
      zweck: 'Stromeinsatz der Montage je Gutteil über beide Gebäude, gewichtet (Summe ÷ Summe).',
      angelegt_am: '2026-10-15T09:00:00+02:00',
    }),
  ];
}
