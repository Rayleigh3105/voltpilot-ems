import './rollen-fixture';
import ReactDOM from 'react-dom/client';
import { keycloak } from '../src/auth';
import type { UemsSprungprobeProtokoll } from '../src/api';
import { useGemeinsameSteuerung } from '../src/components/GemeinsameSteuerungKarte';
import { GemeinsameSteuerungAbschnitt } from '../src/pages/AnlageTechnik';
import { RechteStandort } from '../src/rollen';
import { gsBetreiberZustand as grundZustand, gsBlatt, gsProbe, type BlattLage } from '../src/test/betreiberblattFixtures';
import { ahrenbergFunktionen } from '../src/test/funktionenFixtures';
import { GS_IDS, gsBoxen, gsDatenquellen, gsEingerichtet } from '../src/test/gemeinsameSteuerungFixtures';
import { FIXTURE_IDS } from '../src/test/standorteFixtures';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

/**
 * AP-15 IP-24 — Bühne des Betreiber-Blatts (Anlage → Technik, unter der Kundenkarte) mit der echten Komponente und
 * der Plattform-Rolle. Die Routen stellt dieser `fetch` mit einem kleinen Zustand: Scharfschalten führt in den
 * Übergangsstand (R12: die führende Box hat quittiert, die mitsteuernde nicht), `window.__quittung()` lässt die
 * mitsteuernde Box quittieren (Zielstand, Plan je Box); eine Sprungprobe legt ein Protokoll an. Parameter: `lage`
 * (beobachtet · geprueft · anteile_aktiv · angehalten_betreiber), `proben=1` (bestandene Probe an Box Halle 1).
 * Nichts davon erreicht eine echte Anlage.
 */
(keycloak as unknown as { token: string; updateToken: () => Promise<boolean> }).token = 'e2e-token';
(keycloak as unknown as { updateToken: () => Promise<boolean> }).updateToken = async () => false;
Object.assign(keycloak, { tokenParsed: { name: 'VoltPilot Betrieb', realm_access: { roles: ['platform-admin'] } } });

type Lage = Parameters<typeof grundZustand>[0];
const p = new URLSearchParams(location.search);
let lage = (p.get('lage') ?? 'beobachtet') as Lage;
let blattLage: BlattLage = lage === 'beobachtet' || lage === 'geprueft' ? 's1' : 'aktiv';
const jetzt = new Date();
let aufgeloest = false;
function gsBetreiberZustand(l: Lage): ReturnType<typeof grundZustand> {
  const z = grundZustand(l);
  if (!p.has('aufloesen')) return z;
  if (aufgeloest) return { ...z, zustand: 'aufgeloest', mitglieder: [], aufloesen: null };
  return { ...z, zustand: 'wird_aufgeloest', stufe: null, fehlt: [], naechster_schritt: null,
    aufloesen: { bestaetigt: 0, gesamt: 1, wartet_auf: [GS_IDS.e4] },
    mitglieder: z.mitglieder?.map((m) => m.box_id !== GS_IDS.e4 ? m : {
      ...m, ausscheiden: { seit: jetzt.toISOString(), wartet_auf: 'voltpilot' },
    }),
  };
}

const proben: UemsSprungprobeProtokoll[] = p.get('proben') === '1' ? [gsProbe(GS_IDS.e1, jetzt)] : [];
(window as unknown as Record<string, unknown>).__quittung = () => { blattLage = 'aktiv'; };

const echtesFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
  const methode = (init?.method ?? 'GET').toUpperCase();
  const pfad = url.pathname;
  if (pfad === '/api/v1/funktionen') return Response.json(ahrenbergFunktionen());
  if (pfad.endsWith('/data-sources')) return Response.json({ datenquellen: gsDatenquellen() });
  const admin = /^\/api\/v1\/admin\/sites\/[^/]+\/gemeinsame-steuerung(\/.*)?$/.exec(pfad);
  if (admin) {
    const rest = admin[1] ?? '';
    if (rest === '' && methode === 'GET') {
      const blatt = gsBlatt(blattLage, jetzt, [...proben].reverse());
      // `ungeregelt=<kW>`: erklärtes Ungeregeltes hinter dem Abgang von E-4 (AP-15 Folge von IP-19)
      if (p.has('ungeregelt')) {
        blatt.boxen = blatt.boxen.map((b) => b.box_id === GS_IDS.e4
          ? { ...b, anteile: { ...b.anteile, ungeregelt_hinter_abgang_kw: Number(p.get('ungeregelt')) } } : b);
      }
      return Response.json(blatt);
    }
    if (rest.endsWith('/ausscheiden-bestaetigen')) {
      aufgeloest = true;
      return Response.json(gsBetreiberZustand(lage));
    }
    if (rest === '/scharfschalten') {
      if (lage !== 'geprueft') {
        return Response.json({ code: 'nachweis_fehlt', message: 'Nachweis fehlt.', fehlt: gsBetreiberZustand(lage).fehlt }, { status: 409 });
      }
      lage = 'anteile_aktiv';
      blattLage = 'uebergang';
      return Response.json(gsBetreiberZustand(lage));
    }
    if (rest === '/fortsetzen') { lage = 'anteile_aktiv'; return Response.json(gsBetreiberZustand(lage)); }
    if (rest === '/sprungprobe') {
      const body = JSON.parse(String(init?.body)) as { box_id: string; sprung_kw: number };
      const neu = gsProbe(body.box_id, jetzt, 'ausgeloest');
      neu.probe = { ...neu.probe, probe_id: `f1000000-0000-4000-8000-00000000000${proben.length}`, sprung_kw: body.sprung_kw, ausgeloest_am: new Date().toISOString() };
      proben.push(neu);
      return Response.json(neu.probe);
    }
  }
  const gs = /^\/api\/v1\/sites\/[^/]+\/gemeinsame-steuerung(\/.*)?$/.exec(pfad);
  if (gs) {
    const rest = gs[1] ?? '';
    if (rest === '' && methode === 'GET') return Response.json(gsBetreiberZustand(lage));
    if (rest === '/einrichten') return Response.json(gsEingerichtet());
    if (rest === '/anhalten' && methode === 'POST') { lage = 'angehalten_betreiber'; return Response.json(gsBetreiberZustand(lage)); }
  }
  return echtesFetch(input, init);
};

const boxen = gsBoxen(jetzt).map((b) => ({ ...b, siteId: FIXTURE_IDS.an1 }));

function Buehne() {
  const daten = useGemeinsameSteuerung(FIXTURE_IDS.an1, boxen);
  return (
    <div className="vp-technik">
      <div aria-hidden="true" />
      <div className="vp-technik-sections">
        <GemeinsameSteuerungAbschnitt siteId={FIXTURE_IDS.an1} siteDevices={boxen} daten={daten} />
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<div className="vp-content">
  <header className="vp-topbar"><div className="crumbs">Plattform · Kunststoffwerk Ahrenberg · Werk Ahrenberg – Halle 1 · Technik</div></header>
  <main className="vp-main"><RechteStandort.Provider value={FIXTURE_IDS.st1}><Buehne /></RechteStandort.Provider></main>
</div>);
