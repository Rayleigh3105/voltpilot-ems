import React from 'react';
import ReactDOM from 'react-dom/client';
import type { Bericht, BerichtUeberpruefung } from '../src/api';
import { bewertungFristBaustein } from '../src/bewertungFrist';
import { BewertungBaustein } from '../src/components/BewertungBaustein';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../src/index.css';

/**
 * UEMS AP-16 IP-24: der Übersichts-Baustein „Energetische Bewertung“ auf einer eigenen Bühne — die ECHTE Komponente
 * mit der ECHTEN Auswahl aus `GET /api/v1/berichte`, wie die Route sie für R10 liefert (`?fall=vorher|faellig`).
 */
const fall = new URLSearchParams(location.search).get('fall') ?? 'faellig';
const faellig = fall === 'faellig';
const ueberpruefung: BerichtUeberpruefung = {
  stand_nr: 2,
  stand_vom: '2026-11-17',
  wiedervorlage_monate: 12,
  faellig_am: '2027-11-17',
  ueberpruefung_faellig: faellig,
  faellig_seit_tagen: faellig ? 1 : null,
  abgeloest_durch: null,
  wesentliche_einsaetze: 6,
  offene_bedarfe: 1,
  verantwortliche: [
    { name: 'Martin Dörr', einsaetze: ['EE-1'] },
    { name: 'Peter Hollerbach', einsaetze: ['EE-2', 'EE-5'] },
    { name: 'Ines Kaltenbach', einsaetze: ['EE-3'] },
    { name: 'Jonas Wendt', einsaetze: ['EE-6', 'EE-7'] },
  ],
  ohne_verantwortliche: [],
};
const bewertung: Bericht = {
  kennung: 'BR-2026-0003',
  vorlage: 'energetische_bewertung',
  vorlage_fassung: 1,
  geltung_art: 'unternehmen',
  geltung_id: 'u-ahrenberg',
  geltung_name: 'Kunststoffwerk Ahrenberg',
  zeitraum_art: 'monat',
  zeitraum: '2025-11/2026-10',
  zeitraum_text: 'November 2025 bis Oktober 2026',
  zeitzone: 'Europe/Berlin',
  angelegt_von: { name: 'Ines Kaltenbach', rolle: null },
  angelegt_am: '2026-11-09T08:00:00Z',
  archiviert_am: null,
  stand_zeichen: 'berichtsstand',
  stand_text: 'Berichtsstand Nr. 2',
  neueste_nr: 2,
  entwurf_datenstand: null,
  wiedervorlage_monate: 12,
  ueberpruefung,
};
const bild = bewertungFristBaustein([bewertung]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <main style={{ maxWidth: 1200, margin: '0 auto', padding: 16 }}>
      <div className="vp-ub" data-testid="uebersicht-bausteine">
        {bild && <BewertungBaustein bild={bild} onOeffnen={() => {}} />}
      </div>
    </main>
  </React.StrictMode>,
);
