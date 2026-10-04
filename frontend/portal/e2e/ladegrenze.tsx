import ReactDOM from 'react-dom/client';
import App from '../src/App';
import { api, type ChargingConfig, type Netzanschluss } from '../src/api';
import { site } from './help-fixtures';
import { installSteuerungFixtures } from './steuerung-fixtures';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

/**
 * Die Ladegrenze (AP-01 IP-13) im Rahmen-Blatt von Steuerung › Laden: die echte Seite auf der Steuerungs-Bühne,
 * dazu der Netzanschluss der Anlage und der Rahmen mit Grundlast und Hausreserve. `?fall=` wählt gebunden,
 * ungebunden (Übergang) oder eine schon gespeicherte Grenze über der vereinbarten Leistung.
 */
installSteuerungFixtures();

const fall = new URLSearchParams(location.search).get('fall');
const standort = { id: 'st-ladegrenze', kurzzeichen: 'ST-1' };
const config: ChargingConfig = {
  gridLimitKw: fall === 'zuhoch' ? 220 : 180,
  priorityChargePointIds: ['CP-WERKSTATT'],
  chargePoints: [],
  surplusPolicy: 'nur_sonne',
  storagePriority: 'speicher_vor_auto',
  frame: { houseReserveKw: 30, maxHouseLoadKw: 96.5, rotationMinutes: 15 },
};
const na2: Netzanschluss = {
  id: 'na-2', kennzeichen: 'NA-2', name: 'Netzanschluss Halle 2', standort, malo: null, netzbetreiber: null,
  anschluss_kva: 250, vereinbart_kw: '200', messung: 'RLM', gueltig_ab: '2024-03-12', gueltig_bis: null,
  hinweise: [], angelegt_am: '2024-03-12T00:00:00Z',
  anlagen: [{ id: 'b-2', anlage: { id: site.id, name: site.name }, gueltig_ab: '2024-03-12', gueltig_bis: null }],
};
// Was das Blatt an `PUT /charging-frame` schickt - die Spec liest es.
const gesendet: unknown[] = [];
(window as unknown as { ladegrenzeGesendet: unknown[] }).ladegrenzeGesendet = gesendet;

Object.assign(api, {
  chargingConfig: async () => structuredClone(config),
  siteDetail: async () => ({ ...site, standort }),
  netzanschluesse: async () => ({
    standort, stichtag: null, kennzeichen_vorschlag: 'NA-3', netzanschluesse: fall === 'ungebunden' ? [] : [na2],
  }),
  saveCustomerChargingFrame: async (_s: string, body: { gridLimitKw: number }) => {
    gesendet.push(body);
    return { ...structuredClone(config), gridLimitKw: body.gridLimitKw };
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(<App initialAuth />);
