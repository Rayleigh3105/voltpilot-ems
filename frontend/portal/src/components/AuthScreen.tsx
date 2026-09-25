import type { ReactNode } from 'react';
import wordmarkUrl from '../../designsystem/assets/voltpilot-wordmark.png';
import { Icon } from '../../designsystem/components/core/Icon';

/*
 * Die Buehne jeder UNANGEMELDETEN Flaeche (Login, Registrierung, Boot-Splash,
 * Sperre, abgelaufene Sitzung, Fehlerkarte). Vier Dinge, die man wissen muss:
 *
 * 1. Die WORTMARKE steht auf WEISS - wie in der Seitenleiste der App. Der
 *    `--vp-grad-hero`-Verlauf bleibt als AKZENT (der 3-px-Streifen oben und die
 *    Hub-Kachel des Motivs), genau die Rolle, die er auch im Favicon hat. Die
 *    frueheren Orbit-Ringe und die Glas-Plakette sind ERSATZLOS entfallen
 *    (Captain-Entscheid A, 23.08.2026): sie waren dekorativ, kosteten eine
 *    Dauer-Animation und legten das Logo auf einen Verlauf, auf dem es nirgends
 *    sonst steht.
 * 2. Das Motiv ist das ENERGIEFLUSS-Diagramm des Cockpits in den
 *    `--vp-flow-*`-Rollenfarben - also das Bild, das der Kunde gleich bedient,
 *    nicht ein zweites Marken-Symbol. Es ist dekorativ (`aria-hidden` am
 *    Stage-Container), die vier Fragen daneben tragen die Aussage als TEXT.
 * 3. Das QUARTETT ist die Inhaltsangabe der App - vier taegliche Fragen, kein
 *    Marketing-Claim. Es folgte der Telefon-Leiste, als die noch abgeleitet
 *    war; seit der Navigations-Runde "zwei Ebenen" traegt sie die fuenf
 *    BEREICHE (`anlageNav.bottomBarSlots`) und ist damit anlagen-abhaengig -
 *    diese Anmeldeseite kennt keine Anlage, also bleibt die Liste hier fest.
 * 4. Das Keycloak-Login-Theme (`deploy/keycloak/themes/voltpilot/login/`)
 *    traegt die GLEICHE Buehne fuer den direkten Anmelde-Weg. Es kann die
 *    Portal-Token nicht laden und fuehrt deshalb `--vpl-*`-Kopien mit
 *    Quellenangabe - wer hier Farben, Copy oder das Motiv aendert, aendert
 *    `resources/css/voltpilot.css` + `messages/messages_*.properties` mit.
 */

/** Die vier taeglichen Fragen - dieselbe Reihenfolge wie die Telefon-Leiste. */
const QUARTETT: ReadonlyArray<{ title: string; sub: string; icon: ReactNode }> = [
  {
    title: 'Cockpit',
    sub: 'was Ihre Anlage gerade tut',
    icon: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
  },
  {
    title: 'Fahrplan',
    sub: 'was Ihr Speicher heute vorhat',
    icon: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M3 10h18M8 3v4M16 3v4" />
      </>
    ),
  },
  {
    title: 'Messwerte',
    sub: 'was wirklich gemessen wurde',
    icon: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  },
  {
    title: 'Erlöse',
    sub: 'was dabei herauskommt',
    icon: (
      <>
        <path d="M17 6.5A6 6 0 0 0 8 8H5m0 4h3m-3 4h3a6 6 0 0 0 9 1.5" />
        <path d="M5 12h9" />
      </>
    ),
  },
];

/** Das Energiefluss-Motiv - dekorativ, die Aussage tragen die Texte daneben. */
function FlowMotif() {
  return (
    <svg className="vp-auth-flow" viewBox="0 0 420 372" focusable="false" aria-hidden="true">
      <defs>
        <linearGradient id="vpAuthHub" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#B8D4FF" />
          <stop offset=".5" stopColor="#7BA3F7" />
          <stop offset="1" stopColor="#5A8DE8" />
        </linearGradient>
      </defs>
      <path className="spoke" d="M210 104 V146" stroke="var(--vp-flow-pv)" />
      <path className="spoke rev" d="M176 186 H112" stroke="var(--vp-flow-batt)" />
      <path className="spoke" d="M244 186 H308" stroke="var(--vp-flow-load)" />
      <path className="spoke" d="M210 226 V276" stroke="var(--vp-flow-grid)" />
      <rect x="176" y="152" width="68" height="68" rx="16" fill="url(#vpAuthHub)" />
      <path d="M215 160 L197 189 h11 l-2 21 l18 -29 h-11 z" fill="#fff" />

      {/* Die Sonne sitzt bewusst 7 SVG-Pixel unter der Text-Baseline. Bei cy=62
          beruehrte „erzeugt" den Kreis optisch auf der Anmeldeseite. */}
      <circle cx="210" cy="70" r="30" fill="var(--vp-flow-pv-soft)" stroke="var(--vp-flow-pv)" strokeWidth="2" />
      <g stroke="var(--vp-flow-pv)" strokeWidth="2.2" strokeLinecap="round" fill="none">
        <circle cx="210" cy="70" r="6" />
        <path d="M210 56v4M210 80v4M196 70h4M220 70h4M200 60l2.8 2.8M217.2 77.2 220 80M220 60l-2.8 2.8M202.8 77.2 200 80" />
      </g>
      <text className="node-label" x="210" y="18" textAnchor="middle">Solar</text>
      <text className="node-sub" x="210" y="33" textAnchor="middle">erzeugt</text>

      <circle cx="78" cy="186" r="30" fill="var(--vp-flow-batt-soft)" stroke="var(--vp-flow-batt)" strokeWidth="2" />
      <g stroke="var(--vp-flow-batt)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none">
        <rect x="64" y="179" width="24" height="14" rx="3" />
        <path d="M91 183v6" />
        <path d="M69 183v6h6v-6" fill="var(--vp-flow-batt)" stroke="none" />
      </g>
      <text className="node-label" x="78" y="236" textAnchor="middle">Speicher</text>
      <text className="node-sub" x="78" y="251" textAnchor="middle">lädt</text>

      <circle cx="342" cy="186" r="30" fill="var(--vp-flow-load-soft)" stroke="var(--vp-flow-load)" strokeWidth="2" />
      <g stroke="var(--vp-flow-load)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none">
        <path d="M330 186l12-11 12 11" />
        <path d="M333 184v12h18v-12" />
        <path d="M339 196v-6h6v6" />
      </g>
      <text className="node-label" x="342" y="236" textAnchor="middle">Haus</text>
      <text className="node-sub" x="342" y="251" textAnchor="middle">wird versorgt</text>

      <circle cx="210" cy="310" r="30" fill="var(--vp-flow-grid-soft)" stroke="var(--vp-flow-grid)" strokeWidth="2" />
      <g stroke="var(--vp-flow-grid)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none">
        <path d="M202 322l8-24 8 24" />
        <path d="M199 309h22M201 316h18M205 303h10" />
      </g>
      <text className="node-label" x="210" y="357" textAnchor="middle">Netz</text>
      <text className="node-sub" x="210" y="370" textAnchor="middle" fontSize="11">
        Überschuss wird eingespeist
      </text>
    </svg>
  );
}

/**
 * Die Markenflaeche: Wortmarke auf Weiss, darunter das Energiefluss-Motiv und
 * die vier taeglichen Fragen. Unter 900 px (Container-Query) faellt sie auf
 * eine schmale Kopfzeile zusammen - das Formular fuehrt dann.
 */
export function BrandStage() {
  return (
    <aside className="vp-auth-brand">
      <div className="vp-auth-brandhead">
        <img className="vp-auth-wordmark" src={wordmarkUrl} alt="VoltPilot" width={640} height={152} />
      </div>
      <div className="vp-auth-stage" aria-hidden="true">
        <p className="vp-auth-kicker">Energiemanagement-Portal</p>
        <h2 className="vp-auth-claim">Ihre Anlage, auf einen Blick.</h2>
        <p className="vp-auth-claim-sub">
          Was gerade passiert, was VoltPilot für heute plant und was dabei herauskommt – an einem Ort.
        </p>
        <FlowMotif />
        <ul className="vp-auth-quartet">
          {QUARTETT.map((q) => (
            <li key={q.title}>
              <span className="vp-auth-q-ic">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  {q.icon}
                </svg>
              </span>
              <span>
                <b>{q.title}</b>
                {q.sub}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <p className="vp-auth-brandfoot">VoltPilot EMS</p>
    </aside>
  );
}

/** Zweispaltige Buehne: Marke links, die Karte rechts (gestapelt am Telefon). */
export function AuthScreen({ children }: { children: ReactNode }) {
  return (
    <div className="vp-auth">
      <div className="vp-auth-strip" aria-hidden="true" />
      <div className="vp-auth-split">
        <BrandStage />
        <main className="vp-auth-panel">
          <div className="vp-auth-card">
            <div className="vp-auth-body">{children}</div>
          </div>
          <ul className="vp-auth-quartet-line" aria-hidden="true">
            {QUARTETT.map((q) => (
              <li key={q.title}>{q.title}</li>
            ))}
          </ul>
          <p className="vp-auth-foot">VoltPilot EMS · Energiemanagement für PV, Speicher und Lasten</p>
        </main>
      </div>
    </div>
  );
}

/**
 * Vertrauenszeile: nur „Verschlüsselt · Server in Deutschland“ — zwei Tatsachen, die der Betreiber
 * bestätigt; keine Rechts- oder Konformitätsaussage (AP-20 E9; Wächter „Anmeldung“ in copy.test.ts).
 */
export function TrustRow() {
  return (
    <div className="vp-auth-trust">
      <span>
        <Icon name="lock" size={12} strokeWidth={2.4} /> Verschlüsselt
      </span>
      <span>Server in Deutschland</span>
    </div>
  );
}
