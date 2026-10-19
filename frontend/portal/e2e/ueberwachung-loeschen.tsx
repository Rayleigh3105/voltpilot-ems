// Abnahme-Befund aus Produktion: "wie kann ich diese denn wieder löschen also die Überwachung?" -
// der ganze Weg einer eigenen Überwachung von „Überwachung starten" (Blatt, Alerting Scheibe 2) bis
// „Löschen" (Meldungs-Center, Reiter Überwachungen) in EINER Bühne, dasselbe Fetch-Stell-Muster wie
// `ueberwachen-periode.tsx`/`ueberwachen-energiemanagement.tsx`. Die erzeugte Regel lebt nur in
// diesem Modul-Zustand (`regeln`) - kein echter Server, aber derselbe Vertrag (`UeberwachungsRegel`).
import { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { MeldungenPage } from '../src/pages/MeldungenPage';
import { UeberwachenBlatt } from '../src/components/UeberwachenBlatt';
import type { UeberwachungsRegel } from '../src/meldungenApi';
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

const regeln: UeberwachungsRegel[] = [];

const echtesFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.origin);
  const methode = (init?.method ?? 'GET').toUpperCase();

  if (url.pathname === '/api/v1/meldungen/regeln/probelauf') {
    return Response.json({ fensterTage: 30, ausgeloest: 0, zuletzt: null, gesamtdauerS: 0 });
  }
  if (url.pathname === '/api/v1/meldungen/regeln' && methode === 'POST') {
    const anfrage = JSON.parse(String(init?.body ?? '{}'));
    const neu: UeberwachungsRegel = {
      id: 'r-pv-1', name: null, wertart: anfrage.wertart, schwere: anfrage.schwere, herkunft: 'eigen',
      aktiv: true, probelaufBis: null, bezugJson: JSON.stringify(anfrage.bezug),
    };
    regeln.push(neu);
    return Response.json(neu, { status: 201 });
  }
  if (url.pathname === '/api/v1/meldungen/regeln' && methode === 'GET') {
    return Response.json({ ueberwachungen: regeln });
  }
  const regelLoeschen = url.pathname.match(/^\/api\/v1\/meldungen\/regeln\/([^/]+)$/);
  if (regelLoeschen && methode === 'DELETE') {
    const vorher = regeln.length;
    const index = regeln.findIndex((r) => r.id === decodeURIComponent(regelLoeschen[1]));
    if (index === -1) return new Response(null, { status: 404 });
    regeln.splice(index, 1);
    return new Response(null, { status: vorher > regeln.length ? 204 : 404 });
  }
  if (url.pathname === '/api/v1/meldungen' && url.searchParams.get('status')) {
    return Response.json({ meldungen: [] });
  }
  if (url.pathname === '/api/v1/meldungen/zahl') {
    return Response.json({ ungesehen: 0, dringend: false });
  }
  return echtesFetch(input, init);
};

/** Erst das Blatt (wie am Cockpit-Kreis "PV" angetippt), danach das Meldungs-Center - derselbe
 * Wechsel, den `onUeberwacht` in `EnergieBuehne.tsx` auslöst (dort: zurück zum Cockpit). */
function Fluss() {
  const [erstellt, setErstellt] = useState(false);
  const phone = matchMedia('(max-width: 720px)').matches;
  if (!erstellt) {
    return (
      <main style={{ maxWidth: 480, margin: '0 auto', padding: 16 }}>
        <h1>Erzeugung · Halle 1</h1>
        <UeberwachenBlatt
          offen
          isPhone={phone}
          onClose={() => {}}
          wertart="anlage.pv.leistung"
          bezug={{ anlage: 'an-1' }}
          aktuellerWert={12}
          einheit="kW"
          titelZusatz="Erzeugung"
          onUeberwacht={() => setErstellt(true)}
        />
      </main>
    );
  }
  return <MeldungenPage />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Fluss />);
