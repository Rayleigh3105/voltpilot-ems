import './rollen-fixture';
import ReactDOM from 'react-dom/client';
import { keycloak } from '../src/auth';
import type { UemsGemeinsameSteuerungEinrichten, UemsGemeinsameSteuerungSetzen, UemsGemeinsameSteuerungZustand } from '../src/api';
import { useGemeinsameSteuerung } from '../src/components/GemeinsameSteuerungKarte';
import type { VerlustVariante } from '../src/gemeinsameSteuerungFlaeche';
import { GemeinsameSteuerungAbschnitt } from '../src/pages/AnlageTechnik';
import { RechteStandort } from '../src/rollen';
import { ahrenbergFunktionen } from '../src/test/funktionenFixtures';
import { GS_IDS, gsBoxen, gsDatenquellen, gsEingerichtet, gsVorschlag, gsZustand, type GsLage } from '../src/test/gemeinsameSteuerungFixtures';
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
 * AP-15 IP-23 — Bühne der Karte „Gemeinsame Steuerung“ (Anlage → Technik) mit der echten Komponente. Die Routen der
 * Gemeinsamen Steuerung, `/funktionen` und `…/data-sources` stellt dieser `fetch`, mit einem kleinen Zustand, damit
 * die Folge wirklich einrichtet (PUT → Stufe S1, danach das Ergebnis aus `GET …/einrichten`). Zahlen aus der
 * Referenzdatei 1.5 (V-1 an AN-1). Parameter: `lage`, `ausfall` (verwaltung · halle1 · beide), `kwh`/`gebunden`
 * (Verlust-Zeile von E-4), `variante` (A · B), `boxen=1`, `anlage=an2` (misst nur).
 */
(keycloak as unknown as { token: string; updateToken: () => Promise<boolean> }).token = 'e2e-token';
(keycloak as unknown as { updateToken: () => Promise<boolean> }).updateToken = async () => false;

const p = new URLSearchParams(location.search);
const siteId = p.get('anlage') === 'an2' ? FIXTURE_IDS.an2 : FIXTURE_IDS.an1;
const ausfall = p.get('ausfall');
const verlust = p.has('gebunden') ? { kwh: Number(p.get('kwh') ?? 0), gebunden_s: Number(p.get('gebunden')), tage: 1 } : null;
const variante = (p.get('variante') ?? undefined) as VerlustVariante | undefined;

let lage = (p.get('lage') ?? 'nicht_eingerichtet') as GsLage;
let einrichten: UemsGemeinsameSteuerungEinrichten = lage === 'nicht_eingerichtet' ? gsVorschlag() : gsEingerichtet();
let geschrieben: UemsGemeinsameSteuerungSetzen | null = null;
(window as unknown as Record<string, unknown>).__gsGeschrieben = () => geschrieben;

const zustand = (): UemsGemeinsameSteuerungZustand => gsZustand(lage, verlust);
const echtesFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
  const methode = (init?.method ?? 'GET').toUpperCase();
  const pfad = url.pathname;
  if (pfad === '/api/v1/funktionen') return Response.json(ahrenbergFunktionen());
  if (pfad.endsWith('/data-sources')) return Response.json({ datenquellen: gsDatenquellen() });
  const gs = /^\/api\/v1\/sites\/[^/]+\/gemeinsame-steuerung(\/.*)?$/.exec(pfad);
  if (gs) {
    const rest = gs[1] ?? '';
    if (rest === '' && methode === 'GET') return Response.json(zustand());
    if (rest === '/einrichten') return Response.json(einrichten);
    if (rest === '' && methode === 'PUT') {
      if (lage === 'anteile_aktiv') return Response.json({ code: 'erst_anhalten', message: 'Erst anhalten.' }, { status: 409 });
      geschrieben = JSON.parse(String(init?.body));
      lage = 'beobachtet';
      einrichten = gsEingerichtet();
      return Response.json(zustand());
    }
    if (rest.endsWith('/rueckfall') && methode === 'PUT') {
      const kw = (JSON.parse(String(init?.body)) as { rueckfall_kw: number }).rueckfall_kw;
      einrichten = { ...einrichten, boxen: einrichten.boxen.map((b) => ({ ...b, geraete: (b.geraete ?? []).map((g) =>
        g.komponente_id === GS_IDS.k12 ? { ...g, rueckfall: 'faellt_auf_wert', rueckfall_kw: kw, rueckfall_herkunft: 'am_geraet' as const } : g) })) };
      return Response.json({});
    }
    if (rest === '/anhalten' && methode === 'POST') { lage = 'angehalten'; return Response.json(zustand()); }
    if (rest === '/fortsetzen' && methode === 'POST') { lage = 'anteile_aktiv'; return Response.json(zustand()); }
  }
  return echtesFetch(input, init);
};

const jetzt = new Date();
const boxen = gsBoxen(jetzt, {
  halle1Seit: ausfall === 'halle1' || ausfall === 'beide' ? 25 * 60 : 40,
  verwaltungSeit: ausfall === 'verwaltung' || ausfall === 'beide' ? 30 * 60 : 35,
}).map((b) => ({ ...b, siteId })).slice(0, p.get('boxen') === '1' ? 1 : 2);

function Buehne() {
  const daten = useGemeinsameSteuerung(siteId, boxen);
  return (
    <div className="vp-technik">
      {/* Die Spalte der Sprung-Navigation bleibt leer: die Karte steht in ihrer echten Breite. */}
      <div aria-hidden="true" />
      <div className="vp-technik-sections">
        <GemeinsameSteuerungAbschnitt siteId={siteId} siteDevices={boxen} daten={daten} verlustVariante={variante} />
        {!daten.sichtbar && <p data-testid="gs-ohne-karte">Keine Karte „Gemeinsame Steuerung“.</p>}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<div className="vp-content">
  <header className="vp-topbar"><div className="crumbs">Kunststoffwerk Ahrenberg · Werk Ahrenberg – Halle 1 · Technik</div></header>
  <main className="vp-main"><RechteStandort.Provider value={FIXTURE_IDS.st1}><Buehne /></RechteStandort.Provider></main>
</div>);
