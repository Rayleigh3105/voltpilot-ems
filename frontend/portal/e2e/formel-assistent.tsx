import './rollen-fixture';
import { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { keycloak } from '../src/auth';
import { Button } from '../designsystem/components/core/Button';
import { SummenwertAssistent } from '../src/components/SummenwertAssistent';
import { SummenwertFormelDialog } from '../src/components/SummenwertFormelDialog';
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
function Fixture() {
  const [anlegen, setAnlegen] = useState(false), [aendern, setAendern] = useState(false);
  return <main style={{ padding: 24 }}><Button onClick={() => setAnlegen(true)}>Summenwert anlegen</Button>
    <Button variant="outline" onClick={() => setAendern(true)}>Formel ändern ab Tag</Button>
    <SummenwertAssistent open={anlegen} siteId="AN-1" onClose={() => setAnlegen(false)} />
    {aendern && <SummenwertFormelDialog siteId="AN-1" messstelle={{ id: 'MS-20', kennzeichen: 'MS-20', name: 'Prozess Spritzguss gesamt', art: 'berechnet', medium: 'Strom', lebenszyklus: 'eingerichtet', fehlt: [], notiz: null }} onClose={() => setAendern(false)} onGespeichert={() => {}} />}
  </main>;
}
ReactDOM.createRoot(document.getElementById('root')!).render(<Fixture />);
