import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { BenutzerPage } from '../src/pages/BenutzerPage';
import { UnterstuetzungAdmin } from '../src/pages/admin/UnterstuetzungAdmin';
import { AppShell } from '../src/shell/AppShell';
import { benutzerApi } from '../src/benutzer';
import { benutzerFixture } from '../src/test/benutzerFixtures';
import { rechteSeed } from '../src/test/rollenFixtures';
import { anfrageFixture, notfallFixture, unterstuetzungFixture } from '../src/test/unterstuetzungFixtures';
import { unterstuetzungApi } from '../src/unterstuetzung';
import { fleetApi } from '../src/admin/fleetApi';
import { setSelbstauskunft } from '../src/rollen';
import { keycloak } from '../src/auth';
import type { Unterstuetzung, UnterstuetzungGewaehren } from '../src/api';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';
const modus = new URLSearchParams(location.search).get('modus');
let me = rechteSeed().me;
let liste: Unterstuetzung[] = [modus === 'notfall' ? notfallFixture() : unterstuetzungFixture()];
let anfragen = modus === 'anfrage' ? [anfrageFixture()] : [];
if (modus === 'partner') { me = { ...me, konto: 'partner', zugang: 'unterstuetzung', rollen: ['unterstuetzer'], unternehmen_rechte: [], unternehmensweit: false, kundenbereiche: [{ id: me.kundenbereich!.id, name: me.kundenbereich!.name, umfang: 'einrichten_und_bedienen', endet: '2026-12-15T23:00:00Z' }], standorte: me.standorte.slice(0, 1) }; }
if (modus === 'leser') me = rechteSeed('IK').me;
keycloak.tokenParsed = { sub: me.kennung!, name: me.name!, tenant_id: me.kundenbereich!.id, realm_access: { roles: modus === 'admin' ? ['platform-admin'] : modus === 'partner' ? ['partner'] : [] } };
function aktuell() { me = { ...me, unterstuetzungen: modus === 'partner' ? { eigene: liste, gewaehrte: [] } : { eigene: [], gewaehrte: liste.filter(u => u.zustand === 'aktiv') } }; setSelbstauskunft(me); }
aktuell();
benutzerApi.liste = async () => benutzerFixture(); benutzerApi.protokoll = async () => [];
unterstuetzungApi.liste = async () => [...liste]; unterstuetzungApi.anfragen = async () => [...anfragen]; unterstuetzungApi.hinweise = async () => [];
unterstuetzungApi.aktualisieren = async () => aktuell();
unterstuetzungApi.ablehnen = async () => { anfragen = []; };
unterstuetzungApi.beenden = async id => { liste = liste.map(u => u.id === id ? { ...u, zustand: 'archiviert', banner: null, text: 'Beendet durch Jonas Wendlinger' } : u); aktuell(); };
unterstuetzungApi.verlaengern = async (id, bis) => { const neu = { ...liste.find(u => u.id === id)!, gueltig_bis: bis, id: 'verlaengert' }; liste = liste.map(u => u.id === id ? neu : u); aktuell(); return neu; };
declare global { interface Window { letzteGewaehrung?: UnterstuetzungGewaehren } }
unterstuetzungApi.gewaehren = async body => { window.letzteGewaehrung = body; const neu = { ...unterstuetzungFixture(), id: 'neu', startpasswort: body.anfrage_id ? null : 'Beispiel-Startpasswort-24!' }; liste = [...liste, { ...neu, startpasswort: null }]; anfragen = []; aktuell(); return neu; };
fleetApi.fleet = async () => ({ sites: [], releases: [], unterstuetzungBis: {}, unterstuetzungStandorte: me.standorte.map(s => ({ id: s.id, name: s.name, tenantId: me.kundenbereich!.id })) });
function Ansicht() {
  const [tenant, setTenant] = useState(me.kundenbereich!.id);
  return <AppShell page={modus === 'admin' ? 'mandanten' : 'kunden-benutzer'} onNavigate={() => {}} isAdmin={modus === 'admin'} showOverview={false}
    counts={{ sites: 3, devices: 0 }} tenants={[]} tenantOverride={tenant} onTenantChange={v => { setTenant(v ?? ''); }}>
    {modus === 'admin' ? <UnterstuetzungAdmin tenantId={me.kundenbereich!.id} name={me.kundenbereich!.name} /> : modus === 'partner' ? <section><h1>Werk Ahrenberg</h1><p>Sie unterstützen das Unternehmen im gewährten Umfang.</p></section> : <BenutzerPage />}
  </AppShell>;
}
ReactDOM.createRoot(document.getElementById('root')!).render(<Ansicht />);
