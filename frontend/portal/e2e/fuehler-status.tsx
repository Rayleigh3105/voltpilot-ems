import './rollen-fixture';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { api, ApiError, type MeasurementCatalogPoint, type MeasurementSelectionState } from '../src/api';
import { keycloak } from '../src/auth';
import { BeobachteteRegister } from '../src/components/BeobachteteRegister';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

(keycloak as unknown as { token: string; updateToken: () => Promise<boolean>; tokenParsed: unknown }).token = 'e2e-token';
(keycloak as unknown as { updateToken: () => Promise<boolean> }).updateToken = async () => false;
(keycloak as unknown as { tokenParsed: { realm_access: { roles: string[] } } }).tokenParsed =
  { realm_access: { roles: ['platform-admin'] } };

/**
 * E2E-Bühne „Fühler-Status" (firstmate-Rückfrage zu PR #1886, vp-logik-s1-fuehler):
 * zeigt, wie der Reiter "Register" eines Fühlers denselben Messpunkt VOR und NACH dem
 * Zusammenführungs-Fix darstellt. `?stand=vorher` liefert genau die Antwort, die die API
 * speichert, solange layer1s Blanko-Ablehnung ("edge_too_old") das zuletzt gespeicherte
 * Status-Dokument war (der Fehler); `?stand=nachher` (Standard) die Antwort, nachdem der
 * Fühler-Leser seinen eigenen Punkt als angenommen gemeldet hat und sie zusammengeführt
 * wurden - ein Messwert kommt bereits an. Beides ist eine fiktive Fassung der echten API-
 * Antwort (MeasurementSelectionState/MeasurementCatalogPoint), nie eine echte Cloud.
 */
const frage = new URLSearchParams(window.location.search);
const nachher = frage.get('stand') !== 'vorher';

const deviceId = '22222222-2222-2222-2222-222222222222';
const entityId = '33333333-3333-3333-3333-333333333333';
const pointKey = 'shelly.gen2plus.temperature[100].tc';

const state: MeasurementSelectionState = {
  deviceId, siteId: 'site-1', entityId,
  desiredRevision: 12, catalogVersion: '2026.10.21.1',
  status: nachher ? 'applied' : 'rejected',
  statusReason: nachher ? 'Von der VoltPilot-Box bestätigt.' : 'edge_too_old',
  activationNotice: 'Aufzeichnung startet serverseitig ab enabledAt; frühere Werte werden nicht ergänzt.',
  disableNotice: 'Eine Abwahl stoppt zukünftige Proben; bisherige Werte und Auswahlereignisse bleiben erhalten.',
  selections: [{
    pointKey, enabled: true, cadenceS: 30,
    applyStatus: nachher ? 'applied' : 'rejected',
    applyReason: nachher ? null : 'edge_too_old',
    enabledAt: '2026-11-14T11:00:00Z', disabledAt: null,
    label: 'Temperatur (Zusatzmodul)', family: 'shelly.gen2plus', group: 'temperatur', semanticStatus: 'known',
    customDefinition: null,
  }],
  volumeEstimate: {
    enabledPointCount: 1, samplesPerMinute: 2, requestsPerMinute: 2, dutyCyclePercent: 0.1,
    softWarning: false, hardRejected: false, reasons: [], rawGbPerYear: 0, longTermGbPerYear: 0,
    totalGbPerYear: 0, retentionSummary: '',
  },
};

const katalogPunkt: MeasurementCatalogPoint = {
  family: 'shelly.gen2plus', pointKey, sourceKind: 'rest_json',
  address: null, selector: '/rpc/Shelly.GetStatus#temperature:100.tC',
  widthBits: null, valueType: 'number', signed: null, endian: null, scale: { kind: 'none' },
  unit: '°C', group: 'temperatur', labelDe: 'Temperatur (Zusatzmodul)', labelSource: null,
  semanticStatus: 'known', aggregationKind: 'gauge', quantity: null, direction: null,
  defaultCadenceS: 30, minCadenceS: 30, longTermCadenceS: null, pollGroup: 'shelly:shelly.gen2plus:status',
  sourceUrl: '', sourceCommit: null, sourceRevision: null, dynamic: true, recommended: false,
  available: true, availabilityStatus: nachher ? 'read' : 'family_configured',
  availabilityReason: nachher ? 'Von diesem Gerät gelesen.'
    : 'Für die konfigurierte Anbindungsfamilie vorgesehen; noch nicht gelesen.',
  recorded: nachher, selected: true, selectedCadenceS: 30,
  lastReadAt: nachher ? new Date(Date.now() - 20_000).toISOString() : null,
  rawValue: nachher ? '24.3' : null, decodedValue: nachher ? '24.3' : null,
  quality: nachher ? 'good' : null, gap: false, droppedSamples: 0, estimatedDataPerYearBytes: 0,
};

const ok = <T,>(wert: T) => () => Promise.resolve(structuredClone(wert));
const belegt: Record<string, (...args: never[]) => Promise<unknown>> = {
  measurementSelection: ok(state),
  measurementCatalog: ok({
    catalogVersion: '2026.10.21.1', edgeMinVersion: 'unreleased',
    customPointActionLabel: 'Eigenen Messwert hinzufügen',
    total: 1, offset: 0, limit: 250, groups: [], semanticStatuses: [], points: [katalogPunkt],
  }),
  komponenteMesskanaele: ok({ messkanaele: [] }),
};
const offen = api as unknown as Record<string, unknown>;
for (const [name, wert] of Object.entries(offen)) {
  if (typeof wert !== 'function') continue;
  offen[name] = belegt[name] ?? (() => Promise.reject(new ApiError(404, `E2E-Bühne: ${name} ist nicht belegt`)));
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div className="vp-content" style={{ maxWidth: 720, margin: '24px auto', padding: '0 16px' }}>
      <h1 style={{ fontSize: '1rem', fontWeight: 600 }}>
        Fühler · Register ({nachher ? 'nachher' : 'vorher'})
      </h1>
      <BeobachteteRegister deviceId={deviceId} siteId="site-1" entityId={entityId}
        familien={['shelly.gen2plus']} geraetName="Fühler" lesbar />
    </div>
  </React.StrictMode>,
);
