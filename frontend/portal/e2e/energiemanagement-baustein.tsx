import React from 'react';
import ReactDOM from 'react-dom/client';
import { EnergiemanagementBaustein } from '../src/components/EnergiemanagementBaustein';
import { UEMS_VERANTWORTUNG } from '../src/glossar';
import { energiemanagementBaustein, type Wiedervorlage, type WiedervorlageZeile } from '../src/wiedervorlage';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../src/index.css';

/**
 * UEMS AP-19 IP-21: der Übersichts-Baustein „Energiemanagement“ auf einer eigenen Bühne — die ECHTE Komponente mit der
 * Antwort von `GET /api/v1/energiemanagement/wiedervorlage`, wie die Route sie liefert (`?fall=r12|vorschau|fehler|leer`):
 * R12 am 12.02.2029 (acht fällig, eine Vorschau), nur eine Vorschau (ruhig), ein gescheiterter Kalender-Abzug und ohne
 * Frist (keine Kachel).
 */
const fall = new URLSearchParams(location.search).get('fall') ?? 'r12';
const zeile = (kennzeichen: string, faellig_am: string, tage: number, art: WiedervorlageZeile['art']): WiedervorlageZeile => ({
  art,
  kennzeichen,
  titel: `${kennzeichen} — Überprüfung`,
  faellig_am,
  tage,
  satz: tage > 0 ? `seit ${tage} Tagen fällig` : `fällig in ${-tage} Tagen`,
  verantwortlich: null,
  id: null,
  kennzahl_id: null,
});
const r12: Wiedervorlage = {
  stichtag: '2029-02-12T08:00:00+01:00',
  vorschau_tage: 30,
  faellig: [
    zeile('BB-0002', '2027-11-13', 457, 'bezugsbasis_ueberpruefung'),
    zeile('BB-0005', '2027-11-20', 450, 'bezugsbasis_ueberpruefung'),
    zeile('BB-0003', '2028-03-05', 344, 'bezugsbasis_ueberpruefung'),
    zeile('BR-2028-0001', '2028-04-03', 315, 'bericht_anstoss'),
    zeile('BB-0004', '2028-11-24', 80, 'bezugsbasis_ueberpruefung'),
    zeile('BR-2027-0001', '2028-11-24', 80, 'bewertung_ueberpruefung'),
    zeile('D-0001', '2028-12-10', 64, 'dokument_ueberpruefung'),
    zeile('D-0002', '2028-12-10', 64, 'dokument_ueberpruefung'),
  ],
  vorschau: [zeile('M-2029-0001', '2029-02-28', -16, 'massnahme_termin')],
  anzahl_faellig: 8,
  anzahl_vorschau: 1,
  nicht_in_liste: ['AU-2029-0001', 'BB-0001', 'D-0003', 'D-0004', 'F-2029-0001', 'M-2029-0002'],
  verantwortung: UEMS_VERANTWORTUNG,
};
const antworten: Record<string, Wiedervorlage> = {
  r12,
  fehler: r12,
  vorschau: { ...r12, faellig: [], anzahl_faellig: 0 },
  leer: { ...r12, faellig: [], vorschau: [], anzahl_faellig: 0, anzahl_vorschau: 0, nicht_in_liste: [] },
};
const bild = energiemanagementBaustein(antworten[fall] ?? r12);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <main style={{ maxWidth: 1200, margin: '0 auto', padding: 16 }}>
      <div className="vp-ub" data-testid="uebersicht-bausteine">
        {bild && (
          <EnergiemanagementBaustein bild={bild} onOeffnen={() => {}} onKalender={() => {}} kalenderFehler={fall === 'fehler'} />
        )}
      </div>
    </main>
  </React.StrictMode>,
);
