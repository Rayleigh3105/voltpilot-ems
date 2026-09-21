import './rollen-fixture';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { api, type MeasurementSelectionState } from '../src/api';
import { BeobachteteRegister } from '../src/components/BeobachteteRegister';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

/**
 * E2E-Bühne „Eigenen Messwert hinzufügen" (Paket vp-uems-baukasten-messwert-groesse): die ECHTE
 * `BeobachteteRegister` einer Box, das Formular über die Brücke einer Lesung geöffnet (so wie der
 * Baukasten es nach „Lesen" tut), die Cloud als belegte `api`-Funktionen. Jede Anfrage an
 * `addCustomMeasurement` legt die Bühne in `window.__eigeneMesswerte` ab — die Spec prüft, was
 * das Formular wirklich schickt.
 */
const frage = new URLSearchParams(window.location.search);
const schaetzung = {
  enabledPointCount: 1, samplesPerMinute: 1, requestsPerMinute: 1, dutyCyclePercent: 0.7,
  softWarning: false, hardRejected: false, reasons: [], rawGbPerYear: 0.02,
  longTermGbPerYear: 0.01, totalGbPerYear: 0.03, retentionSummary: '90 Tage roh',
};
const zustand: MeasurementSelectionState = {
  deviceId: 'box-halle-1', siteId: 'an-1', desiredRevision: 3, catalogVersion: '2026.08.26.3',
  status: 'idle', statusReason: 'Keine zusätzlichen Messwerte ausgewählt.', activationNotice: '',
  disableNotice: '', selections: [], volumeEstimate: schaetzung,
};
const KLASSEN = ['live_power', 'phase_mppt_string', 'thermal_bms', 'energy_counter', 'state_event', 'identity_configuration'];
const gesendet: unknown[] = [];
(window as unknown as { __eigeneMesswerte: unknown[] }).__eigeneMesswerte = gesendet;

const ok = <T,>(wert: T) => async () => wert;
const belegt: Record<string, unknown> = {
  measurementSelection: ok(zustand),
  measurementCatalog: ok({
    catalogVersion: '2026.08.26.3', edgeMinVersion: 'unreleased', customPointActionLabel: 'Eigenen Messwert hinzufügen',
    total: 0, offset: 0, limit: 100, groups: [], semanticStatuses: [], points: [],
  }),
  // Wie die API (`MeasurementRetention.ofCustomClass`): eine unbekannte Aufbewahrungsklasse ist 400.
  customMeasurementEstimate: async (_d: string, definition: { retentionClass?: string }) => {
    if (!KLASSEN.includes(definition.retentionClass ?? '')) {
      throw new Error('Bitte eine Aufbewahrungsklasse für den eigenen Messwert wählen.');
    }
    return schaetzung;
  },
  addCustomMeasurement: async (_d: string, body: unknown) => { gesendet.push(body); return { ...zustand, desiredRevision: 4 }; },
};
const offen = api as unknown as Record<string, unknown>;
for (const [name, wert] of Object.entries(offen)) {
  if (typeof wert !== 'function') continue;
  offen[name] = belegt[name] ?? (() => Promise.reject(new Error(`E2E-Bühne: ${name} ist nicht belegt`)));
}

const bruecke = {
  label: frage.get('label') ?? 'Zähler Druckluft',
  address: '500',
  sourceKind: 'modbus_input',
  unit: frage.get('einheit') ?? 'kWh',
  scale: '0.1',
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div className="vp-content">
      <header className="vp-topbar"><div className="crumbs">AN-1 (Halle 1) › Box Halle 1</div></header>
      <main className="vp-main">
        <BeobachteteRegister deviceId="box-halle-1" familien={['modbus_generic']} bruecke={bruecke} onBrueckeVerbraucht={() => {}} />
      </main>
    </div>
  </React.StrictMode>,
);
