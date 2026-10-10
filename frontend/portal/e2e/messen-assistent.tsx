import './rollen-fixture';
import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { steuerGeldWoerter } from '../src/anlegeNurMessen';
import { keycloak } from '../src/auth';
import { MessenAssistent } from '../src/components/MessenAssistent';
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
 * E2E-Bühne des Assistenten „Messen & Auswerten" (UEMS AP-01 IP-9a): die ECHTE
 * Fläche über einem Inhaltsrahmen der Schale, gegen die per `page.route`
 * verdrahteten Routen mit den Antworten des Referenzunternehmens Ahrenberg.
 * `?standort=<id>` ist der Standort, aus dessen Zeile der Assistent geöffnet
 * wird; der Entwurf liegt im echten Speicher des Browsers (die Spec legt ihn
 * vorher ab). Einen Einstiegsknopf gibt es hier bewusst nicht — den setzt die
 * Karte „Funktionen" (IP-8).
 *
 * `window.steuerGeldWoerterDerSeite()` prüft den ganzen lesbaren Text der Seite samt
 * Beschriftungen und Platzhaltern gegen DIESELBE Wortliste wie die Vitest-Fälle
 * (Knopf „Messanlage anlegen" → Anlege-Fluss im Modus „nur messen").
 */
const standortId = new URLSearchParams(window.location.search).get('standort');

(window as unknown as { steuerGeldWoerterDerSeite: () => string[] }).steuerGeldWoerterDerSeite = () => {
  const merkmale = [...document.body.querySelectorAll('[aria-label],[placeholder],[title],[alt]')].flatMap((el) =>
    ['aria-label', 'placeholder', 'title', 'alt'].map((a) => el.getAttribute(a) ?? ''),
  );
  return steuerGeldWoerter([document.body.textContent ?? '', ...merkmale].join('\n'));
};

function Buehne() {
  const [offen, setOffen] = useState(true);
  return (
    <div className="vp-content">
      <header className="vp-topbar">
        <div className="crumbs">Unternehmen › Übersicht</div>
      </header>
      <main className="vp-main">
        <h1>Übersicht</h1>
        {!offen && <p data-testid="assistent-geschlossen">Assistent geschlossen.</p>}
      </main>
      {offen && <MessenAssistent standortId={standortId} onClose={() => setOffen(false)} />}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Buehne />
  </React.StrictMode>,
);
