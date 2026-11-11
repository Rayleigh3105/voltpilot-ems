// Alerting Scheibe 4 (Konzept vp-alerting-konzept-m1 §6.3/§6.4, §7 "Playwright für Blatt mit
// Auswahl UND Lastspitze bei 390 und 1440 px"): die Perioden-Form des Blatts (`menge`/`geld`-
// Leserarten) direkt gerendert - ohne den Umweg über einen Cockpit-Knoten, der diese Leserarten
// (noch) nicht als Menü-Einstieg anbietet (nur die vier Live-Kreise und `geraet.messwert` tun das,
// §2.2/§6.3). Dasselbe Muster wie `controllerwechsel.tsx`: EIN Fachbaustein direkt gerendert.
import ReactDOM from 'react-dom/client';
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

const q = new URLSearchParams(location.search);
const wertart = q.get('wertart') ?? 'anlage.lastspitze.periode';
const phone = matchMedia('(max-width: 720px)').matches;

(window as unknown as { __ueberwachungAnfragen: unknown[] }).__ueberwachungAnfragen = [];
const echtesFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.origin);
  if (url.pathname === '/api/v1/meldungen/regeln/probelauf') {
    return Response.json({ fensterTage: 30, ausgeloest: 0, zuletzt: null, gesamtdauerS: 0 });
  }
  if (url.pathname === '/api/v1/meldungen/regeln' && (init?.method ?? 'GET').toUpperCase() === 'POST') {
    const anfrage = JSON.parse(String(init?.body ?? '{}'));
    (window as unknown as { __ueberwachungAnfragen: unknown[] }).__ueberwachungAnfragen.push(anfrage);
    return Response.json(
      { id: 'r-1', name: null, wertart: anfrage.wertart, schwere: anfrage.schwere, herkunft: 'eigen', aktiv: true },
      { status: 201 },
    );
  }
  return echtesFetch(input, init);
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <main style={{ maxWidth: 480, margin: '0 auto', padding: 16 }}>
    <h1>Lastspitze · Werk Ahrenberg</h1>
    <UeberwachenBlatt
      offen
      isPhone={phone}
      onClose={() => {}}
      wertart={wertart}
      bezug={{ anlage: 's-ahrenberg' }}
      aktuellerWert={wertart === 'anlage.lastspitze.periode' ? 165 : 820}
      einheit={wertart === 'anlage.lastspitze.periode' ? 'kW' : 'kWh'}
      titelZusatz="Lastspitze"
      onUeberwacht={() => {}}
    />
  </main>,
);
