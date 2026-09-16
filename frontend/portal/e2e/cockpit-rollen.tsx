import React from 'react';
import ReactDOM from 'react-dom/client';
import { CockpitHero } from '../src/components/CockpitHero';
import type { RollenKanonischerWert, SiteTopology } from '../src/api';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../src/index.css';

// Ausschließlich fiktive Ahrenberg-Werte: uems-referenzunternehmen.json, MS-01/MS-03/MS-06…08.
const zustand = new URLSearchParams(location.search).get('zustand') ?? 'zugeordnet';
const rollenWert = (role: string, kw: number, namen: string[]): RollenKanonischerWert => ({
  role, wert: zustand === 'stumm' ? null : kw, einheit: 'kW',
  zuordnung_vorhanden: zustand !== 'rueckfall', unvollstaendig: zustand === 'stumm',
  stand: zustand === 'stumm' ? null : '2026-10-20T10:15:00+02:00',
  geraete: namen.map((name, i) => ({ entity_id: `${role}-${i}`, name, art: 'gesamtwert',
    wert: zustand === 'stumm' ? null : kw, liefernd: zustand !== 'stumm', grund: zustand === 'stumm' ? 'veraltet' : null })),
});
const rollen = [
  rollenWert('pv', 168.2, ['Wechselrichter Halle 1']),
  rollenWert('consumer', 213.5, ['Unterzähler Spritzguss', 'Unterzähler Druckluft', 'Unterzähler Kühlung']),
  rollenWert('grid', 312.4, ['Netzzähler Halle 1']),
];
const topology: SiteTopology = { schemaVersion: '1.0', entities: [], topology: { schema_version: '1.0', nodes: [
  { role: 'pv', value_kw: 168.2, flow_active: true, direction: 'in', members: [{ entity_id: 'pv-0', label: 'Wechselrichter Halle 1', primary: true }] },
  { role: 'consumer', value_kw: 148.6, flow_active: true, direction: 'out', members: [{ entity_id: 'consumer-0', label: 'Unterzähler Spritzguss', primary: true }] },
  { role: 'grid', value_kw: 312.4, flow_active: true, direction: 'in', members: [{ entity_id: 'grid-0', label: 'Netzzähler Halle 1', primary: true }] },
  { role: 'storage', soc_pct: 62, flow_active: false, members: [{ entity_id: 'storage-0', label: 'Speicher Halle 1', primary: true }] },
] } };
ReactDOM.createRoot(document.getElementById('root')!).render(<main style={{ maxWidth: 1120, margin: '0 auto', padding: 16 }}>
  <h1>Halle 1</h1><p>Werk Ahrenberg · Anlagen-Übersicht</p>
  <CockpitHero topology={topology} snapshot={{ pvKw: 168.2, loadKw: 148.6, gridKw: 312.4, socPct: 62, battKw: null }}
    view={{ rings: [], ringsNote: null, money: null, planSentence: null }} onOpenSub={() => {}} showRail={false}
    pvRollen={rollen[0]} verbrauchRollen={rollen[1]} netzRollen={rollen[2]} />
</main>);
