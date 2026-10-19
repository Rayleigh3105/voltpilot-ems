import './rollen-fixture';
import ReactDOM from 'react-dom/client';
import { keycloak } from '../src/auth';
import { EinstellungenPage } from '../src/pages/EinstellungenPage';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

/**
 * Einstellungen Scheibe 1 (Konzept `vp-einstellungen-konzept-e1`) - Bühne der echten
 * `EinstellungenPage` mit gestellten Routen, wie `gemeinsame-steuerung.tsx`. Parameter:
 * `fall=voll|leer|unbestaetigt` (Anhang-A-Fälle der Bühne des Konzepts).
 */
(keycloak as unknown as { token: string; updateToken: () => Promise<boolean> }).token = 'e2e-token';
(keycloak as unknown as { updateToken: () => Promise<boolean> }).updateToken = async () => false;

const p = new URLSearchParams(location.search);
const fall = p.get('fall') ?? 'voll';

const EMAIL_VOLL = {
  ziel: 'ines.kaltenbach@ahrenberg.example',
  bestaetigt: true,
  aktiv: true,
  abSchwere: 'warnung' as const,
  zusammenfassungAktiv: true,
  zusammenfassungUhrzeit: '07:00:00',
};

let email: typeof EMAIL_VOLL | null =
  fall === 'leer' ? null : fall === 'unbestaetigt' ? { ...EMAIL_VOLL, bestaetigt: false } : EMAIL_VOLL;
let pushAbos =
  fall === 'voll' ? [{ id: 'p1', geraet: 'iPhone von Ines', aktiv: true, abSchwere: 'warnung' as const, erstelltAm: '2026-10-01T10:00:00Z' }] : [];
let webhookZiele =
  fall === 'voll'
    ? [{ id: 'w1', url: 'https://hooks.example/teams', name: 'Energieteam', aktiv: true, abSchwere: 'warnung' as const, erstelltAm: '2026-10-01T10:00:00Z' }]
    : [];
let telegramZiele =
  fall === 'voll' ? [{ id: 't1', bestaetigt: true, aktiv: true, abSchwere: 'warnung' as const, erstelltAm: '2026-10-01T10:00:00Z' }] : [];
let ruhezeitRegeln = fall === 'voll' ? { werktags: { von: '22:00', bis: '07:00' }, wochenende: 'ganz' as const } : {};
let dringendDurch = true;

const echtesFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
  const methode = (init?.method ?? 'GET').toUpperCase();
  const pfad = url.pathname;
  const json = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }));
  // 204/202 dürfen keinen Rumpf tragen (sonst wirft der `Response`-Konstruktor) - die echte api
  // sendet dort ebenfalls leer.
  const leer = (status: number) => Promise.resolve(new Response(null, { status }));

  if (pfad === '/api/v1/zustellwege/email') {
    if (methode === 'POST') {
      const { ziel } = JSON.parse(String(init?.body)) as { ziel: string };
      email = { ...EMAIL_VOLL, ziel, bestaetigt: false };
      return leer(202);
    }
    return email ? json(email) : leer(204);
  }
  if (pfad === '/api/v1/zustellwege/email/einstellungen' && methode === 'PUT') {
    const body = JSON.parse(String(init?.body));
    if (email) email = { ...email, ...body };
    return leer(204);
  }
  if (pfad === '/api/v1/zustellwege/push' && methode === 'GET') return json(pushAbos);
  if (pfad.startsWith('/api/v1/zustellwege/push/') && methode === 'PUT') {
    const id = pfad.split('/').pop();
    const body = JSON.parse(String(init?.body));
    pushAbos = pushAbos.map((a) => (a.id === id ? { ...a, ...body } : a));
    return leer(204);
  }
  if (pfad.startsWith('/api/v1/zustellwege/push/') && methode === 'DELETE') {
    const id = pfad.split('/').pop();
    pushAbos = pushAbos.filter((a) => a.id !== id);
    return leer(204);
  }
  if (pfad === '/api/v1/zustellwege/webhook' && methode === 'GET') return json(webhookZiele);
  if (pfad === '/api/v1/zustellwege/webhook' && methode === 'POST') {
    const body = JSON.parse(String(init?.body)) as { url: string; name: string };
    const neu = { id: `w${webhookZiele.length + 2}`, url: body.url, name: body.name, aktiv: true, abSchwere: 'warnung' as const, erstelltAm: new Date().toISOString() };
    webhookZiele = [...webhookZiele, neu];
    return json({ id: neu.id, geheimnis: 'ein-geheimnis' }, 201);
  }
  if (pfad.startsWith('/api/v1/zustellwege/webhook/') && methode === 'PUT') {
    const id = pfad.split('/').pop();
    const body = JSON.parse(String(init?.body));
    webhookZiele = webhookZiele.map((z) => (z.id === id ? { ...z, ...body } : z));
    return leer(204);
  }
  if (pfad.startsWith('/api/v1/zustellwege/webhook/') && methode === 'DELETE') {
    const id = pfad.split('/').pop();
    webhookZiele = webhookZiele.filter((z) => z.id !== id);
    return leer(204);
  }
  if (pfad === '/api/v1/zustellwege/telegram' && methode === 'GET') {
    return json({ verfuegbar: fall !== 'ohne-telegram', ziele: telegramZiele });
  }
  if (pfad === '/api/v1/zustellwege/telegram/verbinden' && methode === 'POST') {
    return json({ link: 'https://t.me/VoltPilotBot?start=ein-token' });
  }
  if (pfad.startsWith('/api/v1/zustellwege/telegram/') && methode === 'PUT') {
    const id = pfad.split('/').pop();
    const body = JSON.parse(String(init?.body));
    telegramZiele = telegramZiele.map((z) => (z.id === id ? { ...z, ...body } : z));
    return leer(204);
  }
  if (pfad.startsWith('/api/v1/zustellwege/telegram/') && methode === 'DELETE') {
    const id = pfad.split('/').pop();
    telegramZiele = telegramZiele.filter((z) => z.id !== id);
    return leer(204);
  }
  if (pfad === '/api/v1/ruhezeit' && methode === 'GET') {
    return json({ regeln: JSON.stringify(ruhezeitRegeln), zeitzone: 'Europe/Berlin', dringendDurch });
  }
  if (pfad === '/api/v1/ruhezeit' && methode === 'PUT') {
    const body = JSON.parse(String(init?.body)) as { regeln: string; zeitzone: string; dringendDurch: boolean };
    ruhezeitRegeln = JSON.parse(body.regeln);
    dringendDurch = body.dringendDurch;
    return leer(204);
  }
  if (pfad === '/api/v1/ruhezeit/probe' && methode === 'POST') {
    return json({ aktivBis: p.get('ruhezeitAktiv') === '1' ? '2026-10-20T06:00:00Z' : null });
  }
  return echtesFetch(input, init);
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <div className="vp-content">
    <header className="vp-topbar">
      <div className="crumbs">Ahrenberg · Einstellungen</div>
    </header>
    <main className="vp-main">
      <EinstellungenPage />
    </main>
  </div>,
);
