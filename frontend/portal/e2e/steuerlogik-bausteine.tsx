import './rollen-fixture';
import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import {
  ApiError,
  type BausteinEingesetzt,
  type BausteinFuellung,
  type BausteinKopf,
  type BausteinListe,
  type LogikAnsicht,
  type LogikBericht,
  type LogikFassungKopf,
  type LogikListe,
  type Site,
  type SteuerlogikSchritt,
} from '../src/api';
import { api } from '../src/apiVoll';
import { keycloak } from '../src/auth';
import { Ic } from '../src/steuerung/Ic';
import { BausteineAbschnitt } from '../src/steuerung/logik/BausteineAbschnitt';
import { LogikSeite } from '../src/steuerung/logik/LogikSeite';
import { LogikenAbschnitt } from '../src/steuerung/logik/LogikenAbschnitt';
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
 * E2E-Bühne „Bausteine“ (Steuerlogik Stufe 5): der Reiter „Regeln“ mit den Bausteinen unter „Neue Regel“, das Blatt
 * eines Bausteins und danach die Seite der entstandenen Logik (Stufe 4), wo sie mitläuft. DIE SPRACHE RECHNET DER
 * ECHTE LOGIK-DIENST: Liste, Füllen, Prüfen und „So verhält sie sich“ gehen an `/dienst/**`, die Spec leitet das an
 * einen laufenden `vp-logik-dienst` weiter. Die Bausteine sind die des Vertrags
 * (`docs/contracts/v2/steuerlogik/bausteine/`), die Anlage ein Registry-Inhalt wie ihn die Box bekommt. Alles andere
 * der API spielt die Bühne mit einem kleinen Zustand im Speicher nach. Fiktive Daten.
 *
 * `?person=JW` (Vorgabe) ist Kundenadministrator, `?person=TB` der Unterstützer eines Fachbetriebs (Partner-Konto),
 * `?person=MD` bedienberechtigt; `?fachbetrieb=1` legt einen Baustein des Fachbetriebs in die Sammlung.
 */
const q = new URLSearchParams(window.location.search);
const person = q.get('person') ?? 'JW';
const SITE = { id: 'site-1', name: 'Haus am Hang' } as unknown as Site;
const STAB_WW = '7b0c2f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const STAB_PUFFER = '2c4e6a8b-1d3f-4b5a-9c7e-0f1e2d3c4b5a';
const FUEHLER_WW = '3d2c1b0a-9f8e-4d7c-8b6a-5f4e3d2c1b0a';
const FUEHLER_PUFFER = '4e3d2c1b-0a9f-4e8d-9c7b-6a5f4e3d2c1b';
const POOL = '5f4e3d2c-1b0a-4f9e-8d7c-6b5a4f3e2d1c';
const WP = 'a7e3c1d2-4b5f-4a6e-9c8d-7e6f5a4b3c2d';

/** Der Registry-Inhalt der Anlage, wie die Box ihn bekommt: zwei Heizstäbe, zwei Fühler, eine Pumpe, eine Wärmepumpe. */
const stab = (id: string, label: string, ip: string) => ({
  entity_id: id, entity_type: 'heating-rod', label,
  capabilities: { actuate: [{ command: 'on_off' }, { command: 'setpoint_kw' }] }, guards: { failsafe: { behavior: 'off' } },
  driver: { brand: 'shelly', communication: 'shelly_http', connection: { ip, port: 80, channels: [0, 1, 2], output_kw: [2, 2, 2], stages: [1, 2, 3] } },
});
const REGISTRY = {
  schema_version: '1.0', revision: 'r1', site_id: SITE.id,
  entities: [
    stab(STAB_WW, 'Heizstab Warmwasser', '192.168.1.20'),
    stab(STAB_PUFFER, 'Heizstab Puffer', '192.168.1.21'),
    { entity_id: FUEHLER_WW, entity_type: 'fuehler', label: 'Warmwasser oben', capabilities: {}, guards: {} },
    { entity_id: FUEHLER_PUFFER, entity_type: 'fuehler', label: 'Puffer oben', capabilities: {}, guards: {} },
    { entity_id: POOL, entity_type: 'switchable-load', label: 'Poolpumpe', capabilities: { actuate: [{ command: 'on_off' }] }, guards: {} },
    { entity_id: WP, entity_type: 'heat-pump-sgready', label: 'Wärmepumpe', capabilities: { actuate: [{ command: 'on_off' }] }, guards: {} },
  ],
};

/** Die Bausteine des Vertrags, Datei für Datei; die Kennung ist der Dateiname. */
const VERTRAG = Object.entries(import.meta.glob('../../../docs/contracts/v2/steuerlogik/bausteine/*.block.yaml', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>).map(([pfad, text]) => ({ id: pfad.replace(/^.*\//, '').replace('.block.yaml', ''), text }));

type F = LogikFassungKopf & { text: string };
const welt = {
  /** Gespeicherte Bausteine (Fachbetrieb). */
  bausteine: [] as { id: string; text: string; von: string; eigen: boolean }[],
  logikId: null as string | null,
  logikName: '',
  fassungen: [] as F[],
  protokoll: [] as SteuerlogikSchritt[],
  laufFassung: null as number | null,
};
const aufgerufen: string[] = [];
(window as unknown as { welt: typeof welt; aufgerufen: string[] }).welt = welt;
(window as unknown as { aufgerufen: string[] }).aufgerufen = aufgerufen;

const jetzt = () => new Date().toISOString();
const ich = person === 'TB' ? { von: 'Thomas Brunner', rolle: 'unterstuetzer' }
  : person === 'MD' ? { von: 'Murat Demirci', rolle: 'bedienberechtigt' } : { von: 'Jonas Wendlinger', rolle: 'kundenadministrator' };
const darfBearbeiten = person !== 'MD';

async function dienst<T>(pfad: string, body: unknown): Promise<T> {
  const r = await fetch(`/dienst${pfad}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const b = await r.json();
  if (r.status === 200) return b as T;
  if (r.status === 422) throw new ApiError(422, (b as { message?: string }).message ?? 'abgelehnt', { grund: 'baustein_unlesbar', ...b });
  throw new ApiError(503, 'Der Logik-Dienst ist nicht erreichbar.');
}

function text(id: string): string {
  const t = VERTRAG.find((v) => v.id === id)?.text ?? welt.bausteine.find((b) => b.id === id)?.text;
  if (!t) throw new ApiError(404, 'Diesen Baustein gibt es nicht.', { grund: 'baustein_unbekannt' });
  return t;
}

function ansicht(): LogikAnsicht {
  return {
    logikId: welt.logikId ?? 'neu', name: welt.logikName, darfBearbeiten, darfAnfragen: true, plattform: false,
    darfBausteinSpeichern: person === 'TB', boxKann: true, boxKannScharf: true,
    fassungen: welt.fassungen.map(({ text: _t, ...k }) => { void _t; return structuredClone(k); }),
    anfragen: [], einstellung: { stand: 0, werte: {} },
    lauf: welt.laufFassung ? { box: 'box-1', fassung: welt.laufFassung, contentHash: 'sha256:x', zustand: 'mitlaufend', seit: jetzt(), rueckmeldung: null, gemeldetAm: jetzt() } : null,
  };
}

const belegt: Record<string, (...args: never[]) => Promise<unknown>> = {
  bausteinListe: (async (): Promise<BausteinListe> => {
    aufgerufen.push('bausteine');
    const alle = [...VERTRAG, ...welt.bausteine];
    const r = await dienst<{ bausteine: Omit<BausteinKopf, 'herkunft' | 'von' | 'eigen'>[] }>('/bausteine', { bausteine: alle.map(({ id, text: t }) => ({ id, text: t })), registry: REGISTRY });
    return {
      darfEinsetzen: darfBearbeiten, darfSpeichern: person === 'TB',
      bausteine: r.bausteine.map((k) => {
        const g = welt.bausteine.find((b) => b.id === k.id);
        return { ...k, herkunft: g ? 'fachbetrieb' : 'voltpilot', von: g ? g.von : null, eigen: !!g && g.eigen };
      }),
    };
  }) as never,
  bausteinVorschau: (async (_s: string, id: string, fuellung: BausteinFuellung) => {
    aufgerufen.push(`vorschau:${id}`);
    return dienst<BausteinEingesetzt>('/baustein', { baustein: text(id), fuellung, registry: REGISTRY });
  }) as never,
  bausteinEinsetzen: (async (_s: string, id: string, fuellung: BausteinFuellung) => {
    aufgerufen.push(`einsetzen:${id}`);
    const e = await dienst<BausteinEingesetzt>('/baustein', { baustein: text(id), fuellung, registry: REGISTRY });
    if (!e.vollstaendig) throw new ApiError(422, 'Bitte jede Lücke füllen.', { grund: 'baustein_unvollstaendig' });
    if (e.bericht?.sperrt) throw new ApiError(422, 'Die Prüfung sperrt die Logik.', { grund: 'pruefung_sperrt' });
    welt.logikId = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
    welt.logikName = e.bericht?.name ?? e.name;
    welt.fassungen = [{ fassung: 1, zustand: 'geprueft', contentHash: 'sha256:1', angelegtAm: jetzt(), angelegtVon: ich.von, rolle: ich.rolle,
      notiz: `Aus dem Baustein „${e.name}“`, scharfAm: null, vorgelegtAm: null, vorgelegtVon: null, bericht: e.bericht, text: e.text }];
    welt.protokoll = [{ fassung: 1, was: 'gespeichert', am: jetzt(), von: ich.von, rolle: ich.rolle, daten: { notiz: `Aus dem Baustein „${e.name}“` } }];
    return { logikId: welt.logikId, fassung: 1, name: welt.logikName, contentHash: 'sha256:1', bericht: e.bericht };
  }) as never,
  bausteinSpeichern: (async (_s: string, logikId: string, fassung: number, name: string, satz: string) => {
    aufgerufen.push(`als-baustein:${logikId}:${fassung}`);
    const f = welt.fassungen.find((x) => x.fassung === fassung)!;
    const r = await dienst<{ baustein: string; name: string }>('/baustein/aus-logik', { text: f.text, name, satz });
    welt.bausteine.push({ id: '0f1e2d3c-4b5a-4968-8776-655443322110', text: r.baustein, von: 'Thomas Brunner', eigen: true });
    return { id: welt.bausteine[welt.bausteine.length - 1].id, herkunft: 'fachbetrieb', name, satz: [], luecken: [] };
  }) as never,
  bausteinEntfernen: (async (_s: string, id: string) => {
    welt.bausteine = welt.bausteine.filter((b) => b.id !== id);
    return { entfernt: true };
  }) as never,
  logikListe: (async (): Promise<LogikListe> => ({
    darfBearbeiten, darfAnfragen: true,
    logiken: welt.logikId ? [{ logikId: welt.logikId, name: welt.logikName, neueste: welt.fassungen[0].fassung,
      aktiv: welt.laufFassung, zustand: welt.laufFassung ? 'mitlaufend' : 'geprueft', vorgelegt: null, offeneAnfragen: 0,
      gemeldetAm: null, lage: null }] : [],
  })) as never,
  logikQuellen: (async () => ({ quellen: [], geraete: [] })) as never,
  logikAnsicht: (async () => ansicht()) as never,
  logikText: (async (_s: string, _l: string, n: number) => {
    const f = welt.fassungen.find((x) => x.fassung === n)!;
    return { logikId: welt.logikId, fassung: n, zustand: f.zustand, text: f.text, bericht: structuredClone(f.bericht) };
  }) as never,
  logikPruefen: (async (_s: string, t: string) => {
    const r = await fetch('/dienst/pruefe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: t, registry: REGISTRY }) });
    const b = await r.json() as { bericht?: LogikBericht; message?: string };
    return r.status === 200 && b.bericht ? { lesbar: true, sperrt: !!b.bericht.sperrt, message: null, bericht: b.bericht, meldungen: b.bericht.meldungen ?? [] }
      : { lesbar: false, sperrt: true, message: b.message ?? 'nicht lesbar', bericht: null, meldungen: [] };
  }) as never,
  logikFassungSchritt: (async (_s: string, _l: string, n: number, schritt: string) => {
    aufgerufen.push(`${schritt}:${n}`);
    const f = welt.fassungen.find((x) => x.fassung === n)!;
    if (schritt === 'mitlaufen') {
      f.zustand = 'mitlaufend';
      welt.laufFassung = n;
      welt.protokoll.unshift({ fassung: n, was: 'mitlaufen', am: jetzt(), von: ich.von, rolle: ich.rolle, daten: null });
    }
    return { logikId: welt.logikId, fassung: n, name: welt.logikName, contentHash: f.contentHash, bericht: f.bericht, box: 'box-1', veroeffentlicht: true, zustand: f.zustand };
  }) as never,
  logikProtokoll: (async () => ({ logikId: welt.logikId, von: '2026-08-17', bis: '2026-11-15', schritte: structuredClone(welt.protokoll) })) as never,
  siteSteuerlogikVerlauf: (async () => ({ logikId: welt.logikId, tag: '2026-11-15', wechsel: [], schritte: [] })) as never,
};
const offen = api as unknown as Record<string, unknown>;
for (const [name, wert] of Object.entries(offen)) {
  if (typeof wert !== 'function') continue;
  offen[name] = belegt[name] ?? (() => Promise.reject(new ApiError(404, `E2E-Bühne: ${name} ist nicht belegt`)));
}

/** Eine Logik der Anlage, aus der der Fachbetrieb einen Baustein macht (`?logik=1`): das Warmwasser des Vertrags. */
async function logikVorbereiten() {
  const e = await dienst<BausteinEingesetzt>('/baustein', { baustein: text('heizstab-ueberschuss'), fuellung: { name: 'Warmwasser Keller' }, registry: REGISTRY });
  welt.logikId = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
  welt.logikName = 'Warmwasser Keller';
  welt.fassungen = [{ fassung: 1, zustand: 'mitlaufend', contentHash: 'sha256:1', angelegtAm: jetzt(), angelegtVon: 'Thomas Brunner', rolle: 'unterstuetzer',
    notiz: null, scharfAm: null, vorgelegtAm: null, vorgelegtVon: null, bericht: e.bericht, text: e.text }];
  welt.laufFassung = 1;
}

async function fachbetriebVorbereiten() {
  await logikVorbereiten();
  const r = await dienst<{ baustein: string }>('/baustein/aus-logik', { text: welt.fassungen[0].text, name: 'Speicher mit Sonne (Brunner)', satz: 'Heize {heizstab} mit Sonnenstrom bis {ziel}.' });
  welt.bausteine.push({ id: '0f1e2d3c-4b5a-4968-8776-655443322110', text: r.baustein, von: 'Thomas Brunner', eigen: person === 'TB' });
  welt.logikId = null;
  welt.fassungen = [];
  welt.laufFassung = null;
}

/** Einmal, auch wenn React im StrictMode den Effekt zweimal ausführt. */
let vorbereitet: Promise<void> | null = null;
function vorbereiten(): Promise<void> {
  vorbereitet ??= q.get('fachbetrieb') === '1' ? fachbetriebVorbereiten() : q.get('logik') === '1' ? logikVorbereiten() : Promise.resolve();
  return vorbereitet;
}

function istLogik(): boolean {
  return window.location.hash.startsWith(`#/anlage/${SITE.id}/logik`);
}

function Buehne() {
  const [hash, setHash] = useState(window.location.hash);
  const [liste, setListe] = useState<LogikListe | null>(null);
  const [bereit, setBereit] = useState(false);
  useEffect(() => {
    const h = () => setHash(window.location.hash);
    window.addEventListener('hashchange', h);
    void vorbereiten().then(() => setBereit(true));
    return () => window.removeEventListener('hashchange', h);
  }, []);
  useEffect(() => { if (bereit && !istLogik()) void api.logikListe(SITE.id).then(setListe); }, [bereit, hash]);
  if (!bereit) return null;
  void hash;
  if (istLogik()) {
    return (
      <div style={{ maxWidth: 1180, margin: '0 auto', padding: '0 16px' }}>
        <LogikSeite site={SITE} onOpenSub={(sub) => { aufgerufen.push(`sub:${sub}`); window.location.hash = '#/regeln'; }} />
      </div>
    );
  }
  return (
    <div className="stn" style={{ maxWidth: 1180, margin: '0 auto', padding: '0 16px' }}>
      <div className="stn-main regeln">
        <button type="button" className="btn voll" style={{ width: '100%', minHeight: 52, fontSize: 16 }}>
          <Ic n="plus" s={20} />
          Neue Regel
        </button>
        <BausteineAbschnitt siteId={SITE.id} />
        <LogikenAbschnitt siteId={SITE.id} liste={liste} />
      </div>
    </div>
  );
}

if (q.get('logik') === '1') window.location.hash = `#/anlage/${SITE.id}/logik?id=9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a`;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Buehne />
  </React.StrictMode>,
);
