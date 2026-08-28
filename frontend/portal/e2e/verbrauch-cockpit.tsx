import React from 'react';
import ReactDOM from 'react-dom/client';
import { Card } from '../designsystem/components/core/Card';
import { AdaptiveEnergyFlow } from '../src/components/AdaptiveEnergyFlow';
import { VerbrauchDetails } from '../src/components/VerbrauchDetails';
import { LadenKachel } from '../src/components/LadenKachel';
import { flussKnoten, ladenKachel } from '../src/ladenKachel';
import { verbrauchKomposition } from '../src/verbrauchKomposition';
import type { SiteTopology } from '../src/api';
import type { ChargePoint, SiteCharging } from '../src/ladepunkte';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

/**
 * Der Chrome-Beweis der Phase 0, Teil 3: der Knoten „Laden" im Energiefluss,
 * die Aufschlüsselung MIT Heute-kWh und die Kachel - auf einer Seite, damit
 * 375/768/1440 in einem Durchgang geprüft werden können.
 */
const ent = (id: string, entityType: string, label: string) => ({
  id, entityType, typeLabel: label, label, category: 'consumer',
  health: 'ok' as const, capabilities: [],
});

const TOPO: SiteTopology = {
  schemaVersion: '1.0',
  entities: [
    ent('haus', 'house-load', 'Hausverbrauch'),
    ent('rod', 'heating-rod', 'Heizstab Warmwasser'),
    { ...ent('deye', 'battery-hybrid', 'Batteriespeicher'), category: 'storage' },
  ],
  topology: {
    schema_version: '1.0',
    nodes: [
      { role: 'pv', value_kw: 22.4, flow_active: true, direction: 'in',
        members: [{ entity_id: 'deye', label: null, primary: true, value_kw: 22.4 }] },
      { role: 'storage', value_kw: 4.2, soc_pct: 71, flow_active: true, direction: 'out',
        members: [{ entity_id: 'deye', label: 'Batteriespeicher', primary: true, value_kw: 4.2 }] },
      { role: 'consumer', value_kw: 14.1, flow_active: true, direction: 'out',
        members: [
          { entity_id: 'haus', label: 'Hausverbrauch', primary: true, value_kw: 14.1 },
          { entity_id: 'rod', label: 'Heizstab Warmwasser', primary: false, value_kw: 1.9 },
        ] },
      { role: 'grid', value_kw: 12.3, flow_active: true, direction: 'in',
        members: [{ entity_id: 'deye', label: 'Netzanschluss', primary: true, value_kw: 12.3 }] },
    ],
  },
};

const con = (id: number, over: Record<string, unknown>) => ({
  connectorId: id, status: 'Available', charging: false, powerKw: null,
  allocatedKw: null, reason: null, reasonText: null, socPct: null,
  sessionSince: null, nextTurn: null, boost: false, ...over,
});

const CHARGERS: ChargePoint[] = [
  {
    deviceId: 'd1', chargePointId: 'GARAGE', label: 'Wallbox Garage', priority: false,
    connected: true, ready: true, lastSeen: new Date().toISOString(), entityId: 'cp-garage',
    reportedAt: new Date().toISOString(),
    connectors: [
      con(1, { status: 'Charging', charging: true, powerKw: 11, allocatedKw: 11,
        sessionSince: new Date(Date.now() - 3600_000).toISOString() }) as never,
      con(2, { status: 'SuspendedEVSE', allocatedKw: 0, reason: 'budget',
        reasonText: 'Budget vergeben – wartet auf einen freien Anteil.' }) as never,
    ],
  },
  {
    deviceId: 'd1', chargePointId: 'HOF-NORD', label: 'Säule Hof Nord', priority: false,
    connected: true, ready: true, lastSeen: new Date().toISOString(), entityId: 'cp-hof',
    reportedAt: new Date().toISOString(),
    connectors: [con(1, { status: 'Finishing' }) as never],
  },
];

const charging: SiteCharging = {
  budget: {
    deviceId: 'd1', enabled: true, controlEnabled: true, gridLimitKw: 32, effLimitKw: 32,
    marginPct: 10, minPowerKw: 4.2, budgetKw: 22, allocatedKw: 11, measuredKw: 11,
    siteLoadKw: 14.1, siteGridKw: 12.3, budgetMode: 'gemessen',
    budgetNote: 'Das Budget folgt der Messung am Netzanschluss.',
    budgetBlind: false, connectorCount: 3,
  } as never,
  chargers: CHARGERS,
};

const kachel = ladenKachel({ charging, links: { uebersicht: () => '#lade', charger: () => '#cp' } })!;
const komposition = verbrauchKomposition({
  topology: TOPO,
  chargers: CHARGERS,
  consumerStatus: null,
  hausTodayKwh: 41.8,
  // Genau die Zahlen, die `verbrauchHeute` aus Register-Delta bzw.
  // Tages-Historie bildet - hier fest, damit der Beweis ohne Backend läuft.
  todayKwh: {
    'cp:GARAGE#1': 12.4,
    'cp:GARAGE#2': null,
    'cp:HOF-NORD#1': 8.1,
    'e:rod': 6.3,
  },
  ladenKachelSichtbar: false,
  links: { charger: () => '#cp', komponente: () => '#k' },
})!;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <div style={{ width: 'min(1180px, 100%)', margin: '0 auto', padding: 'clamp(12px, 3vw, 32px)', display: 'grid', gap: 16 }}>
    <Card padding="lg" radius="lg">
      <AdaptiveEnergyFlow topology={TOPO} size="hero" charging={flussKnoten(kachel)} />
    </Card>
    <Card padding="lg" radius="lg">
      <VerbrauchDetails komposition={komposition} />
    </Card>
    <LadenKachel view={kachel} />
  </div>,
);
