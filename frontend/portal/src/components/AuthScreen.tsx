import { useState, type ReactNode } from 'react';
import wordmarkUrl from '../../designsystem/assets/voltpilot-wordmark.png';
import { Icon } from '../../designsystem/components/core/Icon';
import { UEMS_KENNZAHLEN } from '../glossarEinstieg';

/*
 * Die Buehne jeder UNANGEMELDETEN Flaeche (Login, Registrierung, Boot-Splash,
 * Sperre, abgelaufene Sitzung, Fehlerkarte). Seit dem Login-Konzept vom
 * 30.09.2026 (Variante C „Kacheln“, am Telefon C3) zeigt sie die Flaechen des
 * Portals als Kacheln. Fuenf Dinge, die man wissen muss:
 *
 * 1. Die WORTMARKE steht auf WEISS - wie in der Seitenleiste der App. Der
 *    `--vp-grad-hero`-Verlauf bleibt Akzent (3-px-Streifen, Hub-Kachel im
 *    Cockpit). Orbit und Glas-Plakette bleiben entfallen (Captain-Entscheid A,
 *    23.08.2026).
 * 2. Die Kacheln sind die INHALTSANGABE des Portals, keine Anlage: die Namen
 *    folgen der echten Navigation (Test), die Seite traegt KEINE Zahl. Die
 *    Mini-Bilder sind Formen, keine Werte. Laden und Waermepumpe sind
 *    VERBRAUCH und tragen dessen Farbe.
 * 3. EINE Uhr, EIN Schalter: die Kacheln blenden EINMAL gestaffelt ein, danach
 *    wandert ein Lichtpunkt alle 2 s weiter (EIN Keyframe `vp-auth-hl`, je
 *    Kachel versetzt); die Laufpunkte im Cockpit fahren das Ruhetempo 1,8 s.
 *    Der Knopf haelt beides an (WCAG 2.2.2) und merkt sich das im Browser -
 *    unter demselben Schluessel wie das Keycloak-Thema. `prefers-reduced-motion`
 *    haelt sie im EINEN Block am Ende von index.css an. Am Telefon steht EINE
 *    ruhige Kachel unter der Karte; dort bewegt sich nichts.
 * 4. Das Motiv ist DEKORATIV (`aria-hidden`); der Knopf ist es nicht und steht
 *    deshalb ausserhalb der versteckten Teile.
 * 5. Das Keycloak-Login-Theme (`deploy/keycloak/themes/voltpilot/login/`)
 *    traegt die GLEICHE Buehne fuer den direkten Anmelde-Weg. Es kann die
 *    Portal-Token nicht laden und fuehrt `--vpl-*`-Kopien. Die Texte stehen
 *    hier in `ANMELDE_TEXT` unter den Schluesseln des Themas; der Test prueft,
 *    dass `messages_de.properties` wortgleich bleibt.
 */

/** Die Texte der Anmelde-Buehne - wortgleich mit `messages_de.properties` des Keycloak-Themas. */
export const ANMELDE_TEXT = {
  vpLoginHint: 'Melden Sie sich mit Ihrem VoltPilot-Konto an.',
  vpKicker: 'Energiemanagement-Portal',
  vpClaim: 'Vom Energiefluss bis zum Bericht.',
  vpClaimSub:
    'Ein Portal für Ihre Anlage, Ihre Standorte und Ihre VoltPilot-Box – Sie sehen nur, was Ihre Anlage wirklich hat.',
  vpFootnote:
    'Ein Bereich ohne Inhalt erscheint nicht: Ohne Speicher gibt es keinen Fahrplan, ohne Standorte keine Kennzahlen.',
  vpTileCockpit: 'Cockpit',
  vpTileCockpitSub: 'Energiefluss, Autarkie und Warnungen – live',
  vpTileHistory: 'Verlauf',
  vpTileHistorySub: 'Energie, Erlöse, Messwerte',
  vpTileForecast: 'Prognose',
  vpTileForecastSub: 'Sonne und Verbrauch, dazu das Wetter',
  vpTilePlan: 'Fahrplan',
  vpTilePlanSub: 'Viertelstunden-Plan, alle 15 Minuten neu',
  vpPlanCheap: 'Günstig laden',
  vpPlanSun: 'Sonne speichern',
  vpPlanCover: 'Verbrauch decken',
  vpTilePrices: 'Preise',
  vpTilePricesSub: 'Börsenpreis oder Festpreis',
  vpTileControl: 'Steuerung',
  vpTileControlSub: 'Speicher, Laden, Wärme – mit Regeln',
  vpTileRevenue: 'Erlöse',
  vpTileRevenueSub: 'Gerechnet mit dem Preis des Plans',
  vpTileKpis: UEMS_KENNZAHLEN,
  vpTileKpisSub: 'Energie je Bezugsgröße',
  vpTileReports: 'Berichte',
  vpTileReportsSub: 'Stände festhalten, prüfen und freigeben',
  vpTileSites: 'Standorte',
  vpTileSitesSub: 'Gebäude, Messstellen, Boxen',
  vpOneTile: 'Alles an einem Ort',
  vpOneTileSub: 'Cockpit, Fahrplan, Erlöse, Kennzahlen und Berichte',
  vpMotionPause: 'Bewegung anhalten',
  vpMotionPlay: 'Bewegung fortsetzen',
} as const;

const T = ANMELDE_TEXT;

/** Derselbe Schluessel wie `js/stage-motion.js` im Keycloak-Thema: EINE Wahl fuer beide Buehnen. */
export const BEWEGUNG_KEY = 'vp.login.bewegung';

function bewegungGemerktAus(): boolean {
  try {
    return window.localStorage.getItem(BEWEGUNG_KEY) === 'aus';
  } catch {
    // Privates Fenster, gesperrte Website-Daten: dann laeuft die Buehne eben.
    return false;
  }
}

function merkeBewegung(aus: boolean): void {
  try {
    if (aus) window.localStorage.setItem(BEWEGUNG_KEY, 'aus');
    else window.localStorage.removeItem(BEWEGUNG_KEY);
  } catch {
    // Ohne Speicher gilt die Wahl nur fuer diese Seite.
  }
}

type Bewegung = { still: boolean; umschalten: () => void };

/** Der Knopf, der die Buehne anhaelt - das Wort sagt, was der Klick tut. */
function BewegungKnopf({ still, umschalten }: Bewegung) {
  return (
    <button type="button" className="vp-auth-motion" onClick={umschalten}>
      <span className="vp-auth-motion-ic" aria-hidden="true" />
      <span>{still ? T.vpMotionPlay : T.vpMotionPause}</span>
    </button>
  );
}

/** Die Symbole der Kacheln - dieselben Pfade wie im Keycloak-Thema (24er-Raster). */
const SYMBOL = {
  cockpit: (
    <>
      <rect width="7" height="9" x="3" y="3" rx="1" />
      <rect width="7" height="5" x="14" y="3" rx="1" />
      <rect width="7" height="9" x="14" y="12" rx="1" />
      <rect width="7" height="5" x="3" y="16" rx="1" />
    </>
  ),
  verlauf: (
    <>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5M12 7v5l4 2" />
    </>
  ),
  prognose: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2" />
    </>
  ),
  fahrplan: (
    <>
      <path d="M8 2v4M16 2v4" />
      <rect width="18" height="18" x="3" y="4" rx="2" />
      <path d="M3 10h18" />
    </>
  ),
  preise: (
    <>
      <path d="M4 10h12M4 14h9" />
      <path d="M19 6a7.7 7.7 0 0 0-5.2-2A7.9 7.9 0 0 0 6 12c0 4.4 3.5 8 7.8 8 2 0 3.8-.8 5.2-2" />
    </>
  ),
  steuerung: (
    <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
  ),
  erloese: <path d="M22 7 13.5 15.5 8.5 10.5 2 17M16 7h6v6" />,
  kennzahlen: (
    <>
      <path d="M3 3v18h18" />
      <path d="M7 15l4-4 3 3 5-6" />
    </>
  ),
  berichte: (
    <>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6M9 13h6M9 17h6" />
    </>
  ),
  standorte: (
    <>
      <path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" />
      <circle cx="12" cy="10" r="3" />
    </>
  ),
} as const;

function KachelSymbol({ children }: { children: ReactNode }) {
  return (
    <span className="vp-auth-tile-ic">
      <svg viewBox="0 0 24 24" focusable="false">
        {children}
      </svg>
    </span>
  );
}

/** Cockpit: Sonne → Box → Haus. Die Laufpunkte zeigen Richtung, keine Menge. */
function MiniFluss() {
  return (
    <svg className="vp-auth-mini vp-auth-mini-flow" viewBox="0 0 300 40" focusable="false">
      <defs>
        <linearGradient id="vpAuthHub" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#B8D4FF" />
          <stop offset=".5" stopColor="#7BA3F7" />
          <stop offset="1" stopColor="#5A8DE8" />
        </linearGradient>
      </defs>
      <path className="vp-auth-mini-track" d="M34 20 H132 M168 20 H266" />
      <path className="vp-auth-fl" d="M34 20 H132" stroke="var(--vp-flow-pv)" />
      <path className="vp-auth-fl" d="M168 20 H266" stroke="var(--vp-flow-load)" />
      <g className="vp-auth-arrow">
        <path d="M80 15 L86 20 L80 25" stroke="var(--vp-flow-pv)" />
        <path d="M214 15 L220 20 L214 25" stroke="var(--vp-flow-load)" />
      </g>
      <circle cx="18" cy="20" r="15" fill="var(--vp-flow-pv-soft)" stroke="var(--vp-flow-pv)" strokeWidth="2" />
      <circle cx="18" cy="20" r="4" fill="none" stroke="var(--vp-flow-pv)" strokeWidth="2" />
      <rect x="132" y="2" width="36" height="36" rx="10" fill="url(#vpAuthHub)" />
      <path d="M153 7 L143 23 h6 l-1 11 l10 -16 h-6 z" fill="#fff" />
      <circle cx="282" cy="20" r="15" fill="var(--vp-flow-load-soft)" stroke="var(--vp-flow-load)" strokeWidth="2" />
      <path
        d="M275 21 L282 15 L289 21 V27 H275 Z"
        fill="none"
        stroke="var(--vp-flow-load)"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MiniPlan() {
  return (
    <span className="vp-auth-mini vp-auth-mini-plan">
      <svg viewBox="0 0 300 10" preserveAspectRatio="none" focusable="false">
        <rect className="is-cheap" x="0" width="62" height="10" rx="2" />
        <rect className="is-wait" x="64" width="60" height="10" rx="2" />
        <rect className="is-sun" x="126" width="62" height="10" rx="2" />
        <rect className="is-wait" x="190" width="22" height="10" rx="2" />
        <rect className="is-cover" x="214" width="74" height="10" rx="2" />
        <rect className="is-wait" x="290" width="10" height="10" rx="2" />
      </svg>
      <span className="vp-auth-plan-legend">
        <span>{T.vpPlanCheap}</span>
        <span>{T.vpPlanSun}</span>
        <span>{T.vpPlanCover}</span>
      </span>
    </span>
  );
}

type Kachel = { titel: string; sub: string; symbol: ReactNode; breit?: boolean; bild?: ReactNode };

/** Die zehn Kacheln in der Reihenfolge des Konzepts; Cockpit und Fahrplan sind doppelt breit. */
const KACHELN: ReadonlyArray<Kachel> = [
  { titel: T.vpTileCockpit, sub: T.vpTileCockpitSub, symbol: SYMBOL.cockpit, breit: true, bild: <MiniFluss /> },
  {
    titel: T.vpTileHistory,
    sub: T.vpTileHistorySub,
    symbol: SYMBOL.verlauf,
    bild: (
      <svg className="vp-auth-mini vp-auth-mini-bars" viewBox="0 0 120 28" focusable="false">
        <path d="M0 28V12h12v16zM18 28V6h12v22zM36 28V14h12v14zM54 28V3h12v25zM72 28V9h12v19zM90 28V16h12v12zM108 28V7h12v21z" />
      </svg>
    ),
  },
  {
    titel: T.vpTileForecast,
    sub: T.vpTileForecastSub,
    symbol: SYMBOL.prognose,
    bild: (
      <svg className="vp-auth-mini vp-auth-mini-curve" viewBox="0 0 120 28" focusable="false">
        <path d="M0 27 C 30 27, 38 3, 60 3 S 90 27, 120 27 Z" />
      </svg>
    ),
  },
  { titel: T.vpTilePlan, sub: T.vpTilePlanSub, symbol: SYMBOL.fahrplan, breit: true, bild: <MiniPlan /> },
  {
    titel: T.vpTilePrices,
    sub: T.vpTilePricesSub,
    symbol: SYMBOL.preise,
    bild: (
      <svg className="vp-auth-mini vp-auth-mini-step" viewBox="0 0 120 24" focusable="false">
        <path d="M0 18 H15 V20 H30 V10 H45 V4 H60 V14 H75 V20 H90 V6 H105 V2 H120" />
      </svg>
    ),
  },
  {
    titel: T.vpTileControl,
    sub: T.vpTileControlSub,
    symbol: SYMBOL.steuerung,
    bild: (
      <span className="vp-auth-mini vp-auth-mini-toggles">
        <i className="is-on" />
        <i />
        <i className="is-on" />
      </span>
    ),
  },
  { titel: T.vpTileRevenue, sub: T.vpTileRevenueSub, symbol: SYMBOL.erloese },
  { titel: T.vpTileKpis, sub: T.vpTileKpisSub, symbol: SYMBOL.kennzahlen },
  { titel: T.vpTileReports, sub: T.vpTileReportsSub, symbol: SYMBOL.berichte },
  { titel: T.vpTileSites, sub: T.vpTileSitesSub, symbol: SYMBOL.standorte },
];

/**
 * Die Markenflaeche: Wortmarke auf Weiss, Claim und die Kacheln. Unter 900 px
 * (Container-Query) faellt sie auf eine schmale Kopfzeile zusammen - das
 * Formular fuehrt, die EINE ruhige Kachel steht dann unter der Karte ({@link AuthScreen}).
 */
export function BrandStage({ still = false, umschalten = () => {} }: Partial<Bewegung>) {
  return (
    <aside className="vp-auth-brand">
      <div className="vp-auth-brandhead">
        <img className="vp-auth-wordmark" src={wordmarkUrl} alt="VoltPilot" width={640} height={152} />
      </div>
      <div className="vp-auth-stage">
        <div className="vp-auth-intro" aria-hidden="true">
          <p className="vp-auth-kicker">{T.vpKicker}</p>
          <h2 className="vp-auth-claim">{T.vpClaim}</h2>
          <p className="vp-auth-claim-sub">{T.vpClaimSub}</p>
        </div>
        <div className="vp-auth-tiles" aria-hidden="true">
          {KACHELN.map((k, i) => (
            <div key={k.titel} className={`vp-auth-tile vp-auth-t${i}${k.breit ? ' is-wide' : ''}`}>
              <span className="vp-auth-tile-head">
                <KachelSymbol>{k.symbol}</KachelSymbol>
                <b>{k.titel}</b>
              </span>
              <span className="vp-auth-tile-sub">{k.sub}</span>
              {k.bild}
            </div>
          ))}
        </div>
        <div className="vp-auth-stage-foot">
          <p className="vp-auth-footnote" aria-hidden="true">
            {T.vpFootnote}
          </p>
          <BewegungKnopf still={still} umschalten={umschalten} />
        </div>
      </div>
    </aside>
  );
}

/** Die Telefon-Fassung (C3): EINE ruhige Kachel unter der Karte - hier bewegt sich nichts. */
function EineKachel() {
  return (
    <div className="vp-auth-onetile" aria-hidden="true">
      <KachelSymbol>{SYMBOL.cockpit}</KachelSymbol>
      <span className="vp-auth-onetile-text">
        <b>{T.vpOneTile}</b>
        <span>{T.vpOneTileSub}</span>
      </span>
    </div>
  );
}

/** Zweispaltige Buehne: Marke links, die Karte rechts (gestapelt am Telefon, die ruhige Kachel darunter). */
export function AuthScreen({ children }: { children: ReactNode }) {
  const [still, setStill] = useState(bewegungGemerktAus);
  const umschalten = () =>
    setStill((vorher) => {
      merkeBewegung(!vorher);
      return !vorher;
    });
  return (
    <div className={still ? 'vp-auth vp-auth-still' : 'vp-auth'}>
      <div className="vp-auth-strip" aria-hidden="true" />
      <div className="vp-auth-split">
        <BrandStage still={still} umschalten={umschalten} />
        <main className="vp-auth-panel">
          <div className="vp-auth-card">
            <div className="vp-auth-body">{children}</div>
          </div>
          <EineKachel />
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
