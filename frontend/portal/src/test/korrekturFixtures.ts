/** AP-08 F11/F21, Kunststoffwerk Ahrenberg. Nur E2E/Vitest: Antworten, keine Produktions-Rechnung. */
import type { ErsatzwertLuecke, ErsatzwertVorschau, KorrekturDetail, KorrekturPeriode } from '../api';
import { quellenDerMessstellenBuehne } from './messstelleQuellenFixtures';
import { MS_IDS } from './messstelleSeiteFixtures';
import { BEGRUENDUNG } from './wertVersionenFixtures';
export const LUECKE: ErsatzwertLuecke = { id: 'f1100000-0000-0000-0000-000000000001', art: 'data_gap',
  von: '2026-11-03T13:00:00Z', bis: '2026-11-04T08:30:00Z', zuwachs: 1872, einheit: 'kWh' };
export const korrekturQuellen = () => {
  const q = quellenDerMessstellenBuehne(MS_IDS.ms10, '2026-11-06T12:00:00+01:00');
  const vergleich = { ...q.quellen[0], id: 'c1100000-0000-0000-0000-000000000001', rolle: 'vergleich' as const, komponente_name: 'Netzbetreiber-Lastgang', zweck: 'Ersatz bei Ausfall' };
  q.quellen.push(vergleich); q.groessen[0].vergleich = [vergleich]; return q;
};
export function korrekturVorschau(): ErsatzwertVorschau {
  const viertel: KorrekturPeriode[] = Array.from({ length: 78 }, (_, i) => ({ periode: 'viertelstunde',
    von: new Date(Date.parse(LUECKE.von) + i * 900_000).toISOString(), bis: new Date(Date.parse(LUECKE.von) + (i + 1) * 900_000).toISOString(),
    version_alt: 1, version_neu: 2, alt: { menge: null, menge_zustand: 'keine Werte', kennzeichen: [] },
    neu: { menge: 24, menge_zustand: 'mit Ersatzwert', kennzeichen: ['Mit Ersatzwert · gleichmäßig verteilt'] } }));
  return { vieraugen: true, freigabe_noetig: true, perioden: [...viertel, { periode: 'tag', von: '2026-11-02T23:00:00Z', bis: '2026-11-03T23:00:00Z',
    version_alt: 1, version_neu: 2, alt: { menge: 1344, menge_zustand: 'unvollständig', abdeckung_prozent: 58 }, neu: { menge: 2304, menge_zustand: 'mit Ersatzwert', abdeckung_prozent: 58 } }],
    auswirkungen: { perioden: ['Tag', 'Monat', 'Jahr'], berechnete_messstellen: 'Neu berechnet: MS-15, MS-19.',
      kennzahlen: 'Abhängige Kennzahlen werden mit dem neuen Verbrauch berechnet.', berichte: 'Bericht-Entwürfe werden aktualisiert. Wochenbericht KW 45: Revision nötig; der freigegebene Stand bleibt unverändert.' } };
}
export function korrekturDetail(ersteller = false, status: KorrekturDetail['status'] = 'vorschlag'): KorrekturDetail {
  const frei = status === 'vorschlag' && !ersteller;
  return { kennung: 'K-2026-0007', art: 'ersatzwert', status, fassung: status === 'vorschlag' ? 1 : 2,
    von: LUECKE.von, bis: LUECKE.bis!, begruendung: BEGRUENDUNG, beleg: 'Protokoll zum Box-Tausch in Halle 2',
    ersatzwert_kennung: 'EW-2026-0003', methode: 'gleichmaessig_verteilen', einheit: 'kWh', messstellen: [{ kennzeichen: 'MS-10', name: 'Netzbezug Halle 2' }],
    ersteller: { name: 'Ines Kaltenbach', rolle: 'energiemanager', art: 'kunde' }, erstellt_am: '2026-11-06T10:20:00Z', vieraugen: true,
    vorschau: korrekturVorschau().perioden, auswirkungen: korrekturVorschau().auswirkungen,
    freigeben: { erlaubt: frei, grund: ersteller ? 'zweite_person_noetig' : 'status_passt_nicht' },
    ablehnen: { erlaubt: frei, grund: ersteller ? 'zweite_person_noetig' : 'status_passt_nicht' },
    zuruecknehmen: { erlaubt: status === 'freigegeben', grund: status === 'freigegeben' ? null : 'status_passt_nicht' } };
}
