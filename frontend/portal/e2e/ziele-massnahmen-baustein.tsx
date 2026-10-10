import React from 'react';
import ReactDOM from 'react-dom/client';
import { VerbesserungUebersichtKarte } from '../src/components/VerbesserungUebersichtKarte';
import { verbesserungUebersichtBild, type VerbesserungUebersicht } from '../src/verbesserungUebersicht';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../src/index.css';

/**
 * UEMS AP-18 IP-19: der Übersichts-Baustein „Ziele und Maßnahmen“ auf einer eigenen Bühne — die ECHTE Komponente mit
 * der Antwort von `GET /api/v1/verbesserung/uebersicht`, wie die Route sie liefert (`?fall=r9|mehr|leer`): R9 am
 * 15.03.2028, ein Stand mit mehreren fälligen Vorgängen und R13 ohne Vorgang (keine Kachel).
 */
const fall = new URLSearchParams(location.search).get('fall') ?? 'r9';
const massnahme = {
  art: 'massnahme' as const,
  id: 'm-2',
  kennzeichen: 'M-2028-0002',
  titel: 'Druckluft-Leckagen orten und beseitigen',
  zustand: 'geplant',
  termin: '2028-02-29',
  faellig: 'ueberfaellig' as const,
  seit_tagen: 15,
  verantwortlich: 'Ines Kaltenbach',
  satz: 'M-2028-0002 · geplant · Termin 29.02.2028 · überfällig seit 15 Tagen · Ines Kaltenbach.',
  kennzahl_id: null,
  einsatz_id: 'ee-3',
};
const null10 = {
  auffaelligkeiten_offen: 0,
  abweichungen_offen: 0,
  abweichungen_ueberfaellig: 0,
  massnahmen_geplant: 0,
  massnahmen_ueberfaellig: 0,
  massnahmen_umgesetzt_ohne_bewertung: 0,
  energieziele_laufend: 0,
  energieziele_bewertung_faellig: 0,
  anstoesse_offen: 0,
  messbedarfe_ueberfaellig: 0,
};
const antworten: Record<string, VerbesserungUebersicht> = {
  r9: {
    abruf: '2028-03-15',
    zaehler: { ...null10, massnahmen_geplant: 1, massnahmen_ueberfaellig: 1, massnahmen_umgesetzt_ohne_bewertung: 1, energieziele_laufend: 1 },
    faellig: [massnahme],
  },
  mehr: {
    abruf: '2029-01-10',
    zaehler: {
      ...null10,
      auffaelligkeiten_offen: 1,
      abweichungen_offen: 1,
      abweichungen_ueberfaellig: 1,
      massnahmen_geplant: 2,
      massnahmen_ueberfaellig: 1,
      energieziele_laufend: 1,
      energieziele_bewertung_faellig: 1,
      messbedarfe_ueberfaellig: 1,
    },
    faellig: [
      { ...massnahme, seit_tagen: 316, satz: 'M-2028-0002 · geplant · Termin 29.02.2028 · überfällig seit 316 Tagen · Ines Kaltenbach.' },
      {
        ...massnahme,
        art: 'abweichung',
        id: 'aw-2',
        kennzeichen: 'AW-2028-0002',
        titel: 'KZ-0004 Stromeinsatz Spritzguss je kg',
        zustand: 'offen',
        termin: '2028-12-31',
        seit_tagen: 10,
        satz: 'AW-2028-0002 · offen · Termin 31.12.2028 · überfällig seit 10 Tagen · Ines Kaltenbach.',
        kennzahl_id: 'kz-4',
        einsatz_id: null,
      },
      {
        ...massnahme,
        art: 'energieziel',
        id: 'ez-1',
        kennzeichen: 'EZ-2028-0001',
        titel: 'Spritzguss: 5 % weniger Strom',
        zustand: 'offen',
        termin: '2028-12-31',
        faellig: 'bewertung_faellig',
        seit_tagen: 3,
        satz: null,
        kennzahl_id: 'kz-4',
        einsatz_id: null,
      },
    ],
  },
  leer: { abruf: '2028-03-15', zaehler: null10, faellig: [] },
};
const bild = verbesserungUebersichtBild(antworten[fall] ?? antworten.r9);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <main style={{ maxWidth: 1200, margin: '0 auto', padding: 16 }}>
      <div className="vp-ub" data-testid="uebersicht-bausteine">
        {bild && <VerbesserungUebersichtKarte bild={bild} onOeffnen={() => {}} onSprung={() => {}} />}
      </div>
    </main>
  </React.StrictMode>,
);
