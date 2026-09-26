import React from 'react';
import ReactDOM from 'react-dom/client';
import { CockpitHero } from '../src/components/CockpitHero';
import type { SiteTopology } from '../src/api';
import type { FlowNode } from '../src/topology';
import { flussAusKnoten, ladenBeiBezug, ladenBeiBezugJetzt, ladenBeiBezugSeit } from '../src/ladenBeiBezug';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../src/index.css';

// K8 „Anzeige ehrlich": die Zahlen einer Wolkenkante (Box-Ring-Probe und ihr
// 30-s-Mittel, siehe TopologyAnzeigeMittelTest). `stand=vorher` ist die Anzeige
// vor K8 (Einzelprobe + Haken), `stand=nachher` die mit Mittel und Satz.
const stand = new URLSearchParams(location.search).get('stand') ?? 'nachher';
const werte = stand === 'vorher'
  ? { pv: 34.271, batt: 16.58, grid: 8.505, haus: 26.196 }
  : { pv: 37.56, batt: 22.46, grid: 4.51, haus: 19.61 };
const knoten = (role: FlowNode['role'], v: number, dir: 'in' | 'out', label: string, extra: Partial<FlowNode> = {}): FlowNode => ({
  role, value_kw: v, ...extra, flow_active: true, direction: dir, members: [{ entity_id: `${role}-0`, label, primary: true }],
});
const nodes: FlowNode[] = [
  knoten('pv', werte.pv, 'in', 'Wechselrichter'),
  knoten('storage', werte.batt, 'out', 'Speicher', { soc_pct: 35 }),
  knoten('consumer', werte.haus, 'out', 'Hausverbrauch'),
  knoten('grid', werte.grid, 'in', 'Netzzähler'),
];
const topology: SiteTopology = { schemaVersion: '1.0', entities: [], topology: { schema_version: '1.0', nodes } };
// Die Uhr ist fest: der Zustand wurde vor 20 s zum ersten Mal gesehen.
const now = Date.parse('2026-09-24T15:08:00Z');
const seit = ladenBeiBezugSeit(null, ladenBeiBezugJetzt(flussAusKnoten(nodes), true), now - 20_000);
const hinweis = stand === 'vorher' ? null : ladenBeiBezug(seit, now, { slotRole: 'pv_speichern' });
ReactDOM.createRoot(document.getElementById('root')!).render(<main style={{ maxWidth: 1120, margin: '0 auto', padding: 16 }}>
  <h1>Anlage mit Speicher</h1><p>{stand === 'vorher' ? 'Vorher: letzte Einzelprobe' : 'Nachher: 30-s-Mittel und Erklärsatz'}</p>
  <CockpitHero topology={topology} snapshot={{ pvKw: werte.pv, loadKw: werte.haus, gridKw: werte.grid, socPct: 35, socAt: null, battKw: werte.batt }}
    view={{ rings: [], ringsNote: null, money: null, planSentence: null }} onOpenSub={() => {}} showRail={false}
    controlConfirmed={hinweis == null} ladenHinweis={hinweis?.text ?? null} />
</main>);
