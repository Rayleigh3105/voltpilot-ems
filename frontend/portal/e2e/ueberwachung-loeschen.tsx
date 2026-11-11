// Der ganze Weg einer eigenen Überwachung im Meldungs-Center (Konzept b1, 20.10.2026, Entscheid E3:
// „Überwachen“ wohnt nur unter Meldungen): „+ Überwachung“ → Ort → Wert → Blatt „Überwachen“ →
// „Überwachung starten“ → die Regel steht in der Liste → „Löschen“ (Abnahme-Befund aus Produktion:
// "wie kann ich diese denn wieder löschen also die Überwachung?"). Dasselbe Fetch-Stell-Muster wie
// `ueberwachen-periode.tsx`/`ueberwachen-energiemanagement.tsx`; die Regeln leben nur in diesem
// Modul-Zustand - kein echter Server, aber derselbe Vertrag (`UeberwachungsRegel`, `Wertverweis`).
import ReactDOM from 'react-dom/client';
import { MeldungenPage } from '../src/pages/MeldungenPage';
import type { UeberwachungsRegel } from '../src/meldungenApi';
import { keycloak } from '../src/auth';
import './rollen-fixture'; // setzt eine Selbstauskunft (Vorgabe JW, Kundenadministrator unternehmensweit; `?person=` wählt eine andere)
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

Object.assign(keycloak, { token: 'e2e-token', authenticated: true, updateToken: async () => false });

const regeln: UeberwachungsRegel[] = [];
// Die Spec liest die gesendeten Anfragekörper (ein `window.fetch`-Stell erreicht `page.on('request')` nie).
(window as unknown as { __ueberwachungAnfragen: unknown[] }).__ueberwachungAnfragen = [];

const ANLAGEN = [
  { id: 'an-1', name: 'Halle 1' },
  { id: 'an-2', name: 'Werk Süd' },
];
const WERTE_HALLE = [
  { wertart: 'anlage.netz.leistung', name: 'Netzbezug', satzname: 'der Netzbezug', bedingungen: ['ueber', 'unter', 'ausserhalb', 'keine_daten'], bezugJson: '{"anlage":"an-1"}', bekannt: true, zahlenwert: 131.2, zustandswort: null, einheit: 'kW' },
  { wertart: 'anlage.pv.leistung', name: 'PV-Leistung', satzname: 'die PV-Leistung', bedingungen: ['ueber', 'unter', 'ausserhalb', 'keine_daten'], bezugJson: '{"anlage":"an-1"}', bekannt: true, zahlenwert: 12, zustandswort: null, einheit: 'kW' },
  { wertart: 'geraet.messwert', name: 'Zähler Halle · grid_power_kw', satzname: 'der Messwert', bedingungen: ['ueber', 'unter', 'ausserhalb', 'keine_daten'], bezugJson: '{"komponente":"c-1","kanal":"grid_power_kw"}', bekannt: true, zahlenwert: 4.2, zustandswort: null, einheit: 'kW' },
];

const echtesFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.origin);
  const methode = (init?.method ?? 'GET').toUpperCase();

  if (url.pathname === '/api/v1/sites') {
    return Response.json({ eintraege: ANLAGEN, teilansicht: { sichtbar: ANLAGEN.length, gesamt: ANLAGEN.length } });
  }
  if (url.pathname === '/api/v1/messstellen') {
    return Response.json({ messstellen: [{ id: 'ms-1', kennzeichen: 'MS-01', name: 'Hauptzähler', art: 'zaehler', medium: 'strom', lebenszyklus: 'aktiv', fehlt: [], notiz: null }] });
  }
  if (url.pathname === '/api/v1/kennzahlen') return Response.json({ kennzahlen: [] });
  if (url.pathname === '/api/v1/energieziele') return Response.json({ energieziele: [] });
  if (url.pathname === '/api/v1/werte') {
    return Response.json({ werte: url.searchParams.get('bezug') === 'anlage:an-1' ? WERTE_HALLE : [] });
  }
  if (url.pathname === '/api/v1/meldungen/regeln/probelauf') {
    return Response.json({ fensterTage: 30, ausgeloest: 0, zuletzt: null, gesamtdauerS: 0 });
  }
  if (url.pathname === '/api/v1/meldungen/regeln' && methode === 'POST') {
    const anfrage = JSON.parse(String(init?.body ?? '{}'));
    (window as unknown as { __ueberwachungAnfragen: unknown[] }).__ueberwachungAnfragen.push(anfrage);
    const neu: UeberwachungsRegel = {
      id: `r-${regeln.length + 1}`, name: null, wertart: anfrage.wertart, schwere: anfrage.schwere, herkunft: 'eigen',
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
    const index = regeln.findIndex((r) => r.id === decodeURIComponent(regelLoeschen[1]));
    if (index === -1) return new Response(null, { status: 404 });
    regeln.splice(index, 1);
    return new Response(null, { status: 204 });
  }
  if (url.pathname === '/api/v1/meldungen' && url.searchParams.get('status')) {
    return Response.json({ meldungen: [] });
  }
  if (url.pathname === '/api/v1/meldungen/zahl') {
    return Response.json({ ungesehen: 0, dringend: false });
  }
  return echtesFetch(input, init);
};

window.location.hash = '#/meldungen?reiter=regeln';
ReactDOM.createRoot(document.getElementById('root')!).render(<MeldungenPage />);
