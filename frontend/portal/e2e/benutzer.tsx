import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { BenutzerPage } from '../src/pages/BenutzerPage';
import { AppShell } from '../src/shell/AppShell';
import { benutzerApi } from '../src/benutzer';
import { benutzerFixture } from '../src/test/benutzerFixtures';
import { rechteSeed } from '../src/test/rollenFixtures';
import { setSelbstauskunft } from '../src/rollen';
import { keycloak } from '../src/auth';
import { type PageId } from '../src/nav';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

const person = new URLSearchParams(location.search).get('person') ?? 'JW';
const me = rechteSeed(person).me;
setSelbstauskunft(me);
keycloak.tokenParsed = { sub: me.kennung!, name: me.name!, tenant_id: me.kundenbereich!.id };
let liste = benutzerFixture();
benutzerApi.liste = async () => liste;
declare global { interface Window { benutzerProtokollAnfragen: string[][] } }
window.benutzerProtokollAnfragen = [];
benutzerApi.protokoll = async (von, bis) => {
  window.benutzerProtokollAnfragen.push([von, bis]);
  return [{ id: 1, zeit: '2026-10-20T08:10:00Z', betroffener: liste[5].anzeigename,
  aktion: 'zuweisen', rolle: 'leser' as const, standort: 'Werk Lindach', urheber: liste[0].anzeigename, grund: null }]
    .filter(e => Date.parse(e.zeit) >= Date.parse(von) && Date.parse(e.zeit) < Date.parse(bis));
};
benutzerApi.anlegen = async a => {
  const konto = { sub: 'neu', anzeigename: `${a.vorname} ${a.nachname}`.trim() || a.username, email: a.email, zustand: 'angelegt' as const };
  liste = [...liste, { ...konto, zuweisungen: [] }];
  return { benutzer: konto, startpasswort: 'Beispiel-Startpasswort-24!' };
};
benutzerApi.startpasswort = async sub => ({ benutzer: liste.find(b => b.sub === sub)!, startpasswort: 'Neues-Beispielpasswort-24!' });
benutzerApi.sperren = async sub => { liste = liste.map(b => b.sub === sub ? { ...b, zustand: 'gesperrt', zuweisungen: [] } : b); };
benutzerApi.entfernen = async sub => { liste = liste.filter(b => b.sub !== sub); };
benutzerApi.entziehen = async id => { liste = liste.map(b => ({ ...b, zuweisungen: b.zuweisungen.filter(z => z.id !== id) })); };
benutzerApi.wechseln = async () => {};
function Ansicht() {
  const [page, setPage] = useState<PageId>('kunden-benutzer');
  return <AppShell page={page} onNavigate={setPage} isAdmin={false} showOverview={false}
    counts={{ sites: 3, devices: 0 }} tenants={[]} tenantOverride={null} onTenantChange={() => {}}>
    <BenutzerPage />
  </AppShell>;
}
ReactDOM.createRoot(document.getElementById('root')!).render(<Ansicht />);
