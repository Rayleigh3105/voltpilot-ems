import { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { keycloak } from '../src/auth';
import { hashForRoute, messstelleRoute, parseMessstelleWerte, parseRoute } from '../src/nav';
import { MessstelleSeite } from '../src/pages/MessstelleSeite';
import { MessstellenPage } from '../src/pages/MessstellenPage';
import { sprungziel } from '../src/uemsOberflaechen';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

// Auth ist in der Bühne gestellt (wie die anderen E2E-Bühnen), damit `request`
// keinen Login-Umweg fährt und die per `page.route` verdrahtete Cloud erreicht.
(keycloak as unknown as { token: string; updateToken: () => Promise<boolean> }).token = 'e2e-token';
(keycloak as unknown as { updateToken: () => Promise<boolean> }).updateToken = async () => false;

/**
 * E2E-Bühne der Messstellen-Seite (UEMS AP-04 IP-8). Die echte Seite rendert gegen die per
 * `page.route` verdrahtete Cloud (Referenzunternehmen Ahrenberg, „heute“ laut Register).
 * `?id=` ist die Messstelle (MS-06 oder MS-08); geöffnet wie aus „Unternehmen › Messstellen“.
 *
 * UEMS AP-13 IP-3: `?wirt=1` stellt das Register mit seinem Wirt — die ADRESSE wählt wie in `App.tsx`
 * Register oder Seite (`#/portfolio/messstellen[/{id}]`), `periode=`/`version=` gehen an den Abschnitt
 * „Werte“. Ein Einstieg aus dem Register schreibt den Sprung (`sprungziel`), eine neue Wahl auf der
 * Seite ersetzt die Adresse ohne Verlaufseintrag.
 */
const q = new URLSearchParams(window.location.search);
const id = q.get('id') ?? '';

function Wirt() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const neu = () => setHash(window.location.hash);
    window.addEventListener('hashchange', neu);
    return () => window.removeEventListener('hashchange', neu);
  }, []);
  const route = parseRoute(hash);
  const zu = (ziel: string) => {
    window.location.hash = ziel;
  };
  return (
    <MessstellenPage
      ebene={{ art: 'unternehmen', name: 'Kunststoffwerk Ahrenberg GmbH' }}
      bereichDa
      messstelleId={route.messstelleId ?? null}
      werte={parseMessstelleWerte(hash)}
      onOeffnen={(m) => zu(hashForRoute(messstelleRoute(m)))}
      onWerte={(m, periode) => zu(sprungziel({ art: 'messstelle', id: m, periode })!.hash)}
      onWerteZeitraum={(periode) => {
        if (route.messstelleId) window.history.replaceState(null, '', sprungziel({ art: 'messstelle', id: route.messstelleId, periode })!.hash);
      }}
      onListe={() => zu('#/portfolio/messstellen')}
    />
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <main style={{ padding: 16, maxWidth: 1180, margin: '0 auto' }}>
    {q.get('wirt') ? <Wirt /> : <MessstelleSeite id={id} onListe={() => undefined} />}
  </main>,
);
