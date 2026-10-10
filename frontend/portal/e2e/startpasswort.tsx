import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { BenutzerAnlegenDialog } from '../src/components/BenutzerAnlegenDialog';
import { StartpasswortNeuVergeben } from '../src/components/StartpasswortNeuVergeben';
import { CreateUserDrawer } from '../src/pages/admin/CreateUserDrawer';
import { benutzerApi } from '../src/benutzer';
import { adminApi } from '../src/admin/adminApi';
import { setSelbstauskunft } from '../src/rollen';
import { rechteSeed } from '../src/test/rollenFixtures';
import { Button } from '../designsystem/components/core/Button';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

const me = rechteSeed().me;
setSelbstauskunft(me);
const ines = rechteSeed('IK').me;
const konto = { sub: ines.kennung!, anzeigename: ines.name!, email: 'ines@ahrenberg.example', zustand: 'angelegt' as const };
const antwort = { benutzer: konto, startpasswort: 'Beispiel-Startpasswort-24!' };
benutzerApi.anlegen = async () => antwort;
benutzerApi.startpasswort = async () => ({ ...antwort, startpasswort: 'Neues-Beispielpasswort-24!' });
adminApi.createUser = async () => antwort;

function Ansicht() {
  const [open, setOpen] = useState(false);
  const [admin, setAdmin] = useState(false);
  return <main style={{ maxWidth: 920, padding: '24px 16px', margin: '0 auto' }}>
    <p className="vp-note">{me.kundenbereich?.name} · Einstellungen</p>
    <h1>Benutzer</h1><p>{me.name} · Kundenadministrator</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
      <Button onClick={(event) => { event.currentTarget.focus(); setOpen(true); }}>Benutzer anlegen</Button>
      <StartpasswortNeuVergeben sub={konto.sub} name={konto.anzeigename} />
      <Button variant="ghost" onClick={(event) => { event.currentTarget.focus(); setAdmin(true); }}>Ersten Kundenadministrator anlegen</Button>
    </div>
    <BenutzerAnlegenDialog open={open} onClose={() => setOpen(false)}
      anlage={{ username: 'ines', email: konto.email, vorname: 'Ines', nachname: 'Kaltenbach', rolle: 'energiemanager', standorte: [] }}
      rollenname="Energiemanager" standortnamen={[]} onCreated={() => {}} />
    <CreateUserDrawer open={admin} onClose={() => setAdmin(false)}
      tenant={{ id: me.kundenbereich!.id, name: me.kundenbereich!.name, segment: 'CI' } as any} onCreated={() => {}} />
  </main>;
}
ReactDOM.createRoot(document.getElementById('root')!).render(<Ansicht />);
