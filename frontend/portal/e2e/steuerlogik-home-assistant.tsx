import './rollen-fixture';
import React from 'react';
import ReactDOM from 'react-dom/client';
import {
  ApiError,
  type HaDatei,
  type LogikAnsicht,
  type LogikAusHomeAssistant,
  type LogikBericht,
  type LogikFassungKopf,
  type LogikGeprueft,
  type LogikQuellen,
  type Site,
} from '../src/api';
import { api } from '../src/apiVoll';
import { keycloak } from '../src/auth';
import { logikHash } from '../src/nav';
import { LogikSeite } from '../src/steuerung/logik/LogikSeite';
import wasserText from '../../../docs/contracts/v2/steuerlogik/wasser.logic.yaml?raw';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';
import '../src/steuerung/steuerung.css';

(keycloak as unknown as { token: string }).token = 'e2e-token';
(keycloak as unknown as { updateToken: () => Promise<boolean> }).updateToken = async () => false;

/**
 * E2E-Bühne „Aus Home Assistant übernehmen“ (Steuerlogik Stufe 6): die Seite „Neue Logik“ und die Seite einer Logik
 * mit dem Knopf „Aus Home Assistant“. ÜBERSETZEN, PRÜFEN UND SPEICHERN FRAGEN DEN ECHTEN LOGIK-DIENST: die Bühne
 * schickt Dateien und Zuordnung an `/dienst/home-assistant`, Texte an `/dienst/pruefe`, jeweils mit dem
 * Registry-Inhalt dieser Anlage (drei Heizstäbe an Ausgangsmengen, drei Fühler); die Spec leitet das an einen
 * laufenden `vp-logik-dienst` weiter. Alles andere der API spielt die Bühne im Speicher nach. Fiktive Daten.
 *
 * `?logik=da` öffnet eine vorhandene Logik (das Warmwasser-Beispiel des Vertrags), sonst „Neue Logik“.
 */
const q = new URLSearchParams(window.location.search);
const SITE = { id: 'site-1', name: 'Haus am Hang' } as unknown as Site;
const DA = '5e1f0c2a-7b3d-4e8f-9a1b-2c3d4e5f6a7b';

const stab = (id: string, name: string, kw: number) => ({
  entity_id: id, entity_type: 'heating-rod', label: name,
  capabilities: { actuate: [{ command: 'on_off' }, { command: 'setpoint_kw' }] }, guards: { failsafe: { behavior: 'off' } },
  driver: { brand: 'shelly', communication: 'shelly_http', connection: { ip: '192.168.1.20', port: 80, channels: [0, 1, 2], output_kw: [kw, kw, kw], stages: [1, 2, 3] } },
});
const fuehler = (id: string, name: string) => ({ entity_id: id, entity_type: 'fuehler', label: name, capabilities: {}, guards: {} });
const REGISTRY = {
  schema_version: '1.0', revision: 'r1', entities: [
    stab('2c4e6a8b-1d3f-4b5a-9c7e-0f1e2d3c4b51', 'Durchlauferhitzer Speicher 1', 3),
    stab('2c4e6a8b-1d3f-4b5a-9c7e-0f1e2d3c4b52', 'Heizstab Speicher 2', 1.5),
    stab('2c4e6a8b-1d3f-4b5a-9c7e-0f1e2d3c4b53', 'Heizstab Speicher 3', 1.5),
    fuehler('4e3d2c1b-0a9f-4e8d-9c7b-6a5f4e3d2c11', 'Fühler Speicher 1 oben'),
    fuehler('4e3d2c1b-0a9f-4e8d-9c7b-6a5f4e3d2c12', 'Speicher 2 oben'),
    fuehler('4e3d2c1b-0a9f-4e8d-9c7b-6a5f4e3d2c13', 'Speicher 3 oben'),
  ],
};

type F = LogikFassungKopf & { text: string };
const welt = {
  logiken: {} as Record<string, { name: string; fassungen: F[] }>,
  homeAssistant: [] as { dateien: string[]; zuordnung: Record<string, { wert: string }> }[],
};
(window as unknown as { welt: typeof welt }).welt = welt;

async function dienst<T>(pfad: string, body: unknown): Promise<{ status: number; b: T }> {
  const r = await fetch(`/dienst${pfad}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, b: await r.json() as T };
}

/** Der echte Logik-Dienst: `/pruefe` mit dem Text und dem Registry-Inhalt, wie die API sie schickt. */
async function dienstPruefe(text: string): Promise<LogikGeprueft> {
  const { status, b } = await dienst<{ bericht?: LogikBericht; message?: string; meldungen?: LogikGeprueft['meldungen'] }>('/pruefe', { text, registry: REGISTRY });
  if (status === 200 && b.bericht) return { lesbar: true, sperrt: !!b.bericht.sperrt, message: null, bericht: b.bericht, meldungen: b.bericht.meldungen ?? [] };
  if (status === 422) return { lesbar: false, sperrt: true, message: b.message ?? 'nicht lesbar', bericht: null, meldungen: b.meldungen ?? [] };
  throw new ApiError(503, 'Der Logik-Dienst ist nicht erreichbar.');
}

function neueFassung(logikId: string, text: string, notiz: string | null, bericht: LogikBericht | null, n: number): F {
  return {
    fassung: n, zustand: 'geprueft', contentHash: `sha256:${logikId}:${n}`, angelegtAm: new Date().toISOString(), angelegtVon: 'Jonas Wendlinger',
    rolle: 'kundenadministrator', notiz, scharfAm: null, vorgelegtAm: null, vorgelegtVon: null, bericht: bericht as LogikBericht, text,
  };
}

function logik(id: string) {
  const l = welt.logiken[id];
  if (!l) throw new ApiError(404, 'Diese Logik gibt es nicht.', { grund: 'logik_unbekannt', message: 'Diese Logik gibt es nicht.' });
  return l;
}

const belegt: Record<string, (...args: never[]) => Promise<unknown>> = {
  logikQuellen: (async (): Promise<LogikQuellen> => (await dienst<LogikQuellen>('/quellen', { registry: REGISTRY })).b) as never,
  logikHomeAssistant: (async (_s: string, dateien: HaDatei[], zuordnung: Record<string, { wert: string }>): Promise<LogikAusHomeAssistant> => {
    welt.homeAssistant.push({ dateien: dateien.map((d) => d.name), zuordnung });
    const { status, b } = await dienst<LogikAusHomeAssistant & { message?: string }>('/home-assistant', { dateien, zuordnung, registry: REGISTRY });
    if (status !== 200) throw new ApiError(422, b.message ?? 'nicht lesbar', { grund: 'home_assistant_unlesbar', message: b.message });
    return b;
  }) as never,
  logikPruefen: (async (_s: string, text: string) => dienstPruefe(text)) as never,
  logikSpeichern: (async (_s: string, text: string, notiz: string | null, logikId?: string) => {
    const g = await dienstPruefe(text);
    if (!g.lesbar || g.sperrt) throw new ApiError(422, 'Die Prüfung sperrt die Logik.', { grund: 'pruefung_sperrt', message: 'Die Prüfung sperrt die Logik.', meldungen: g.meldungen });
    const id = logikId ?? '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
    const l = welt.logiken[id] ?? (welt.logiken[id] = { name: g.bericht?.name ?? 'Logik', fassungen: [] });
    const n = (l.fassungen[0]?.fassung ?? 0) + 1;
    l.name = g.bericht?.name ?? l.name;
    l.fassungen.unshift(neueFassung(id, text, notiz, g.bericht, n));
    return { logikId: id, fassung: n, name: l.name, contentHash: `sha256:${id}:${n}`, bericht: g.bericht };
  }) as never,
  logikAnsicht: (async (_s: string, id: string): Promise<LogikAnsicht> => {
    const l = logik(id);
    return {
      logikId: id, name: l.name, darfBearbeiten: true, darfAnfragen: true, plattform: false, boxKann: true, boxKannScharf: true,
      fassungen: l.fassungen.map(({ text: _t, ...k }) => { void _t; return structuredClone(k); }), anfragen: [], einstellung: null, lauf: null,
    };
  }) as never,
  logikText: (async (_s: string, id: string, n: number) => {
    const f = logik(id).fassungen.find((x) => x.fassung === n)!;
    return { logikId: id, fassung: n, zustand: f.zustand, text: f.text, bericht: structuredClone(f.bericht) };
  }) as never,
};
const offen = api as unknown as Record<string, unknown>;
for (const [name, wert] of Object.entries(offen)) {
  if (typeof wert !== 'function') continue;
  offen[name] = belegt[name] ?? (() => Promise.reject(new ApiError(404, `E2E-Bühne: ${name} ist nicht belegt`)));
}

async function start() {
  if (q.get('logik') === 'da') {
    const text = wasserText.replace('heizstab-warmwasser', '2c4e6a8b-1d3f-4b5a-9c7e-0f1e2d3c4b52').replace('fuehler-speicher-oben', '4e3d2c1b-0a9f-4e8d-9c7b-6a5f4e3d2c12');
    welt.logiken[DA] = { name: 'Warmwasser', fassungen: [neueFassung(DA, text, null, (await dienstPruefe(text)).bericht, 1)] };
  }
  window.location.hash = logikHash(SITE.id, q.get('logik') === 'da' ? DA : 'neu', 'aufbau');
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <div style={{ maxWidth: 1180, margin: '0 auto', padding: '0 16px' }}>
        <LogikSeite site={SITE} onOpenSub={() => {}} />
      </div>
    </React.StrictMode>,
  );
}
void start();
