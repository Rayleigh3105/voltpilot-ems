/**
 * Der BROWSER-BEWEIS des Pakets P0 (Konzept `vp-erloese-lesbar-konzept-u3`
 * §3.10, Paket-Zeile P0).
 *
 * Er zeigt GENAU das, was P0 ändert: die App-Leisten im Kleid der Variante C,
 * die Schrift, und die vier Erlöse-Blätter auf der Sechser-Skala. Die
 * Leisten-Markierung ist bewusst STATISCH mit den ECHTEN Klassennamen der
 * Schale (`vp-topbar`/`vp-sidebar`/`vp-navitem`/`vp-bereich-tabs`/
 * `vp-bottombar`) aufgebaut — P0 hat das STYLESHEET geändert, nicht die
 * Schale, und ein echter `AppShell` bräuchte hier eine angemeldete Sitzung.
 * Die Erlöse-Fläche darunter ist die echte Komponente mit ihrer Fixture.
 */
import ReactDOM from 'react-dom/client';

import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';
import '../src/components/Historie.css';
import '../src/components/Erloese.css';
import '../src/shell/Shell.css';
import '../src/components/BereichTabs.css';
import '../src/components/SpeicherBlock.css';
import '../src/components/SteuerungFormel.css';
import '../src/components/ErloesKomposition.css';

import { Icon } from '../designsystem/components/core/Icon';
import { Card } from '../designsystem/components/core/Card';

const NAV: Array<[string, string, boolean]> = [
  ['grid', 'Portfolio', false],
  ['activity', 'Cockpit', false],
  ['calendar', 'Fahrplan', false],
  ['chart', 'Verlauf', true],
  ['settings', 'Anlage', false],
];

const BEREICHE: Array<[string, boolean]> = [
  ['Übersicht', false],
  ['Messwerte', false],
  ['Erlöse', true],
];

function Leisten({ children }: { children: React.ReactNode }) {
  return (
    <div className="vp-app">
      <aside className="vp-sidebar">
        <div className="brand">
          <strong style={{ color: '#fff' }}>VoltPilot</strong>
        </div>
        <nav aria-label="Hauptnavigation">
          {NAV.map(([ic, label, aktiv]) => (
            <button key={label} className={`vp-navitem${aktiv ? ' active' : ''}`} type="button">
              <span className="ic" aria-hidden="true">
                <Icon name={ic} size={18} />
              </span>
              <span className="vp-nav-lbl">{label}</span>
            </button>
          ))}
        </nav>
      </aside>
      <div className="vp-main">
        <header className="vp-topbar">
          <div className="crumbs">
            <span className="vp-crumb-up">Meine Anlagen</span>
            <span className="vp-crumb-sep">›</span>
            <span className="here">Solarpark Dachau</span>
          </div>
          <div className="spacer" />
        </header>
        <div className="vp-bereich-tabs" role="tablist" aria-label="Bereiche">
          {BEREICHE.map(([label, aktiv]) => (
            <button
              key={label}
              role="tab"
              type="button"
              aria-selected={aktiv}
              className={`vp-bereich-tab${aktiv ? ' active' : ''}`}
            >
              {label}
            </button>
          ))}
        </div>
        <main className="vp-page">{children}</main>
        <nav
          className="vp-bottombar"
          aria-label="Bereiche der Anlage"
          style={{ ['--vp-bar-slots' as string]: String(NAV.length) } as React.CSSProperties}
        >
          {NAV.map(([ic, label, aktiv]) => (
            <button key={label} type="button" className={`vp-bottombar-item${aktiv ? ' active' : ''}`}>
              <span className="ic" aria-hidden="true">
                <Icon name={ic} size={20} />
              </span>
              <span className="lbl">{label}</span>
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
}

function Probe() {
  return (
    <div style={{ display: 'grid', gap: 16, padding: 16, maxWidth: 980 }}>
      <Card>
        <p className="vp-erg-netto">+301,46 €</p>
        <p className="vp-erg-satz">Ihr Ergebnis unterm Strich in diesem Zeitraum.</p>
        <div className="vp-ez-list">
          <div className="vp-ez-row">
            <span className="vp-ez-name">Einspeise-Erlös</span>
            <span className="vp-ez-val">+312,08 €</span>
          </div>
          <div className="vp-ez-row">
            <span className="vp-ez-name">Stromkosten</span>
            <span className="vp-ez-val vp-ez-t-minus">−10,62 €</span>
          </div>
        </div>
        <span className="vp-ez-chipwrap">
          <span className="vp-chip">Gemessen</span>
          <span className="vp-chip vp-chip--warn">Stromtarif fehlt</span>
          <span className="vp-prov vp-prov-bewertet">Bewertet</span>
        </span>
      </Card>
      <Card>
        <p className="vp-ez-hero">+301,46 €</p>
        <p className="vp-ez-satz">Dieselbe Zahl, eine Ebene tiefer.</p>
      </Card>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <Leisten>
    <Probe />
  </Leisten>,
);
