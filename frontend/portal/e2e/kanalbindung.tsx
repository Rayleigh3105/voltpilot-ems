import './rollen-fixture';
import ReactDOM from 'react-dom/client';
import { api, type BezugsKanalAnfrage, type BezugsKanalbindung } from '../src/api';
import { RechteStandort } from '../src/rollen';
import { BezugsgroessenPage } from '../src/pages/BezugsgroessenPage';
import { ahrenbergBezugsgroessen, ahrenbergProzesse, ahrenbergKostenstellen } from '../src/test/kennzahlAnlegenFixtures';
import { ahrenbergUnternehmen, ahrenbergHeute, FIXTURE_IDS } from '../src/test/standorteFixtures';
import { ortsbaumAhrenberg, ortsbaumLindach } from '../src/test/ortsbaumFixtures';
import { ahrenbergRegister } from '../src/test/messstellenRegisterFixtures';
import { bezugswert } from '../src/test/werteEingabeFixtures';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';
const params = new URLSearchParams(location.search);
const temperatur = !params.has('zustand');
// Annahme: zusätzlicher Außentemperatur-Kanal am Standort; keine Referenzmessung.
const bezug = { ...ahrenbergBezugsgroessen().bezugsgroessen.find(b => b.kennzeichen === 'BZ-2')!,
  kennzeichen: temperatur ? 'BZ-0008' : 'BZ-5',
  name: temperatur ? 'Gradtage Werk Ahrenberg (Annahme)' : 'Ladezeit Ladepunkt Halle 2',
  einheit: temperatur ? 'Kd' : 'h', geltung_art: 'standort', geltung_id: FIXTURE_IDS.st1, geltung_name: 'Werk Ahrenberg' };
const kanal = { entity_id: 'temperatur-annahme', komponente: temperatur ? 'Außenfühler (Annahme)' : 'K-9', kanal: temperatur ? 'aussentemperatur' : 'OCPP-Status', name: temperatur ? 'Außentemperatur' : 'OCPP-Status', wertart: temperatur ? 'gauge' : 'state', einheit: temperatur ? '°C' : null, erste_messung: '2026-10-01T00:00:00Z', liefert: !params.has('ohne-daten'), zustaende: temperatur ? [] : ['Available', 'Charging'] };
const bindungen: BezugsKanalbindung[] = [];
const posts: unknown[] = []; Object.assign(window, { kanalAufrufe: posts });
Object.assign(api, {
  bezugsgroessen: async () => ({ bezugsgroessen: [bezug], bezugsflaechen: [] }),
  unternehmen: async () => ahrenbergUnternehmen(), standorte: async () => ahrenbergHeute(),
  standortOrte: async (id: string) => id === FIXTURE_IDS.st1 ? ortsbaumAhrenberg() : ortsbaumLindach(),
  prozesse: async () => ({ prozesse: ahrenbergProzesse() }), kostenstellen: async () => ({ kostenstellen: ahrenbergKostenstellen() }),
  messstellenRegister: async () => ahrenbergRegister(),
  bezugsKanaele: async () => [kanal], kanalbindungen: async () => structuredClone(bindungen),
  kanalBinden: async (id: string, body: BezugsKanalAnfrage) => { posts.push(body); const b = { ...body, id: 'bindung-1', wertart: kanal.wertart, bis: null }; bindungen.push(b); return b; },
  kanalBeenden: async (id: string, bindung: string, bis: string) => { posts.push({ bis }); const b = bindungen.find(b => b.id === bindung)!; b.bis = bis; return b; },
  bezugsgroesseWerte: async () => { const w = bezugswert('12'); w.periode_von = '2026-11-01'; w.periode_bis = '2026-11-30'; w.fassungen[0].eingetragen_am = '2026-12-01T00:00:00Z'; w.fassungen[0].urheber = { ...w.fassungen[0].urheber, name: 'Ableitung', art: 'voltpilot' }; w.fassungen[0].herkunft.art = 'messkanal'; w.fassungen[0].kanal = { entity_id: kanal.entity_id, kanal: kanal.name, regel: 'Gradtage G22/17', zustand: 'unvollständig', abdeckung_prozent: 83.3, vorlaeufig: true }; return { werte: [w] }; },
});
ReactDOM.createRoot(document.getElementById('root')!).render(<main style={{ maxWidth: 1100, margin: '0 auto', padding: 16 }}><RechteStandort.Provider value={FIXTURE_IDS.st1}><BezugsgroessenPage /></RechteStandort.Provider></main>);
