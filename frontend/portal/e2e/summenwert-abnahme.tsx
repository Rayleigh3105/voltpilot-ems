import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { api, type RollenKanonischerWert, type SiteTopology } from '../src/api';
import { keycloak } from '../src/auth';
import { GeraetSummenwerte } from '../src/components/GeraetSummenwerte';
import { CockpitHero } from '../src/components/CockpitHero';
import { FAELLE, ahrenbergRoh, type Fall } from './summenwert-abnahme-faelle';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

(keycloak as unknown as { token: string }).token = 'e2e-token';
(keycloak as unknown as { updateToken: () => Promise<boolean> }).updateToken = async () => false;
const fall = FAELLE[(new URLSearchParams(location.search).get('fall') ?? 'deye') as Fall];
const roles = ['pv', 'consumer', 'grid'] as const;
const lindach = fall === FAELLE.lindach;
const snapshot = { pvKw: fall.rolle === 'pv' ? fall.roh : lindach ? 0 : ahrenbergRoh.pv, loadKw: fall.rolle === 'consumer' ? fall.roh : ahrenbergRoh.verbrauch, gridKw: fall.rolle === 'grid' || lindach ? fall.roh : ahrenbergRoh.netz, socPct: null, battKw: null };
const topology: SiteTopology = { schemaVersion: '1.0', entities: [], topology: { schema_version: '1.0', nodes: [
  ...roles.filter((role) => !lindach || role !== 'pv').map((role) => ({ role, value_kw: role === 'pv' ? snapshot.pvKw : role === 'consumer' ? snapshot.loadKw : snapshot.gridKw,
    flow_active: true, direction: role === 'consumer' ? 'out' : 'in', members: [{ entity_id: role, label: role, primary: true }] })),
] } };

/** Echte Komponenten, Cloud per page.route; keine nachgezeichneten Produktflächen. */
function Fixture() {
  const [version, setVersion] = useState(0);
  const [werte, setWerte] = useState<RollenKanonischerWert[]>([]);
  useEffect(() => {
    void Promise.all(roles.map((r) => api.rollenWert('site-abnahme', r))).then(setWerte);
  }, [version]);
  return <main style={{ maxWidth: 1120, margin: '0 auto', padding: 16, display: 'grid', gap: 24 }}>
    <h1>{fall.titel}</h1>
    <section aria-label="Gerätekarte"><GeraetSummenwerte siteId="site-abnahme" deviceId="box"
      entityId={fall.register[0].entityId} entityIds={lindach ? [...new Set(fall.register.map((r) => r.entityId))] : [fall.register[0].entityId]}
      geraetName={fall.register[0].name} onZuordnungGeaendert={() => setVersion((v) => v + 1)} /></section>
    <section aria-label="Anlagen-Übersicht"><CockpitHero topology={topology} snapshot={snapshot}
      view={{ rings: [], ringsNote: null, money: null, planSentence: null }} onOpenSub={() => {}} showRail={false}
      pvRollen={werte[0]} verbrauchRollen={werte[1]} netzRollen={werte[2]} /></section>
  </main>;
}
ReactDOM.createRoot(document.getElementById('root')!).render(<Fixture />);
