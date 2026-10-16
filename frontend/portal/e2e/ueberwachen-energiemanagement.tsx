// Alerting Scheibe 5 (Konzept vp-alerting-konzept-m1 §6.3/§6.4, §7 Scheibe 5 Punkt 9 "Playwright-
// Nachweis 390/1440"): die Meldungs-Center-Zusätze dieser Scheibe (Marke "eigene Überwachung",
// "Zur Kennzahl/Zum Energieziel/Zur Messstelle", CSV-Export je Periode, Entscheid 14A) und die
// Zustands-Form des Blatts "Überwachen" (Energieziel-Kurs) - dasselbe Muster wie
// `ueberwachen-periode.tsx`: Fachbausteine direkt gerendert, `fetch` gestellt.
import ReactDOM from 'react-dom/client';
import { MeldungenPage } from '../src/pages/MeldungenPage';
import { UeberwachenBlatt } from '../src/components/UeberwachenBlatt';
import { keycloak } from '../src/auth';
import './rollen-fixture'; // setzt eine Selbstauskunft mit `ueberwachung.eigene` (JW, Kundenadministrator unternehmensweit)
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../src/index.css';

Object.assign(keycloak, { token: 'e2e-token', authenticated: true, updateToken: async () => false });

const MELDUNGEN_VERLAUF = [
  {
    id: 'al-1', kennzeichen: 'AL-2029-000012', wertart: 'energieziel.kurs', schwere: 'warnung',
    anlageId: null, anlageName: null, standortId: null, ausgeloestAm: '2029-03-01T07:00:00Z',
    zustand: 'erledigt', wiederNormalAm: '2029-03-05T07:00:00Z', gesehenVon: null, gesehenAm: null,
    erledigtAm: '2029-03-05T07:00:00Z', bezugKennung: 'energieziel:ez-42',
  },
  {
    id: 'al-2', kennzeichen: 'AL-2029-000013', wertart: 'messstelle.monat_unvollstaendig', schwere: 'hinweis',
    anlageId: null, anlageName: null, standortId: null, ausgeloestAm: '2029-03-02T07:00:00Z',
    zustand: 'erledigt', wiederNormalAm: null, gesehenVon: null, gesehenAm: null,
    erledigtAm: '2029-03-06T07:00:00Z', bezugKennung: 'messstelle:ms-07',
  },
  {
    id: 'al-3', kennzeichen: 'AL-2029-000014', wertart: 'box.erreichbar', schwere: 'warnung',
    anlageId: 'an-1', anlageName: 'Halle 1', standortId: 'st-1', ausgeloestAm: '2029-03-03T07:00:00Z',
    zustand: 'erledigt', wiederNormalAm: '2029-03-03T08:00:00Z', gesehenVon: 'Ines Kaltenbach',
    gesehenAm: '2029-03-03T07:30:00Z', erledigtAm: '2029-03-03T08:00:00Z', bezugKennung: 'anlage:an-1',
  },
];

const echtesFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.origin);
  if (url.pathname === '/api/v1/meldungen' && url.searchParams.get('status') === 'verlauf') {
    return Response.json({ meldungen: MELDUNGEN_VERLAUF });
  }
  if (url.pathname === '/api/v1/meldungen' && url.searchParams.get('status') === 'jetzt') {
    return Response.json({ meldungen: [] });
  }
  if (url.pathname === '/api/v1/meldungen/verlauf.csv') {
    return new Response('kennzeichen;wertart\r\n', {
      headers: { 'Content-Type': 'text/csv;charset=UTF-8', 'Content-Disposition': 'attachment; filename=meldungen-verlauf.csv' },
    });
  }
  return echtesFetch(input, init);
};

// Beide Flächen auf EINER Seite kollidieren: das Blatt ist ein BottomSheet/Modal mit einem Scrim,
// der (unabhängig vom DOM-Wurzel-Knoten) die ganze Seite überdeckt - ein Query-Parameter wählt
// darum genau EINE Fläche, wie `ueberwachen-periode.tsx` es mit `?wertart=` schon tut.
const modus = new URLSearchParams(location.search).get('modus') ?? 'meldungen';
const root = document.createElement('div');
root.id = 'root';
document.body.appendChild(root);

if (modus === 'blatt') {
  const phone = matchMedia('(max-width: 720px)').matches;
  ReactDOM.createRoot(root).render(
    <main style={{ maxWidth: 480, margin: '0 auto', padding: 16 }}>
      <h1>Energieziel-Kurs · Montagehalle</h1>
      <UeberwachenBlatt
        offen
        isPhone={phone}
        onClose={() => {}}
        wertart="energieziel.kurs"
        bezug={{ energieziel: 'ez-42' }}
        aktuellerWert={0}
        einheit=""
        titelZusatz="Energieziel-Kurs"
        onUeberwacht={() => {}}
      />
    </main>,
  );
} else {
  ReactDOM.createRoot(root).render(<MeldungenPage />);
}
