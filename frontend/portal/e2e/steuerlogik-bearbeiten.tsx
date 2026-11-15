import './rollen-fixture';
import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import {
  api,
  ApiError,
  type LogikAnsicht,
  type LogikAnfrage,
  type LogikBericht,
  type LogikFassungKopf,
  type LogikGeprueft,
  type LogikListe,
  type LogikQuellen,
  type Site,
  type SteuerlogikRueckmeldung,
  type SteuerlogikSchritt,
  type SteuerlogikWechsel,
} from '../src/api';
import { keycloak } from '../src/auth';
import { logikHash } from '../src/nav';
import { LogikSeite } from '../src/steuerung/logik/LogikSeite';
import { LogikenAbschnitt } from '../src/steuerung/logik/LogikenAbschnitt';
import wasserText from '../../../docs/contracts/v2/steuerlogik/wasser.logic.yaml?raw';
import dienstAntwort from '../../../docs/contracts/v2/examples/steuerlogik-dienst.valid.wasser-scharf.json';
import rueckmeldung from '../../../docs/contracts/v2/examples/steuerlogik-rueckmeldung.valid.scharf.json';
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
 * E2E-Bühne „Steuerlogik bearbeiten“ (Stufe 4): die Seite einer Logik mit Aufbau, Text, Mitlaufen, Fassungen und
 * Protokoll. Die Logik ist das Warmwasser-Beispiel des Vertrags (`steuerlogik/wasser.logic.yaml`), Fassung 1 läuft
 * mit. PRÜFEN UND SPEICHERN FRAGEN DEN ECHTEN LOGIK-DIENST: die Bühne schickt den Text an `/dienst/pruefe`, die Spec
 * leitet das an einen laufenden `vp-logik-dienst` weiter - dieselben Leser und dieselbe Prüfung wie Box und API.
 * Alles andere der API spielt die Bühne mit einem kleinen Zustand im Speicher nach. Fiktive Daten.
 *
 * `?rolle=kundenadministrator` (Vorgabe) schreibt, `?rolle=bedienberechtigt` sieht und fragt an, `?rolle=plattform`
 * schaltet vorgelegte Fassungen scharf; `?scharf=1` macht Fassung 1 scharf; `?logik=neu` beginnt eine neue Logik; `?ansicht=` öffnet eine Ansicht;
 * `?buehne=regeln` zeigt die Logiken im Reiter „Regeln“.
 */
const q = new URLSearchParams(window.location.search);
const rolle = q.get('rolle') ?? 'kundenadministrator';
const SITE = { id: 'site-1', name: 'Haus am Hang' } as unknown as Site;
const LOGIK = '5e1f0c2a-7b3d-4e8f-9a1b-2c3d4e5f6a7b';
const STAB = '7b0c2f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const FUEHLER = '3d2c1b0a-9f8e-4d7c-8b6a-5f4e3d2c1b0a';
const TEXT_1 = wasserText.replace('heizstab-warmwasser', STAB).replace('fuehler-speicher-oben', FUEHLER);

type F = LogikFassungKopf & { text: string };
const welt = {
  fassungen: [{
    fassung: 1, zustand: 'mitlaufend', contentHash: 'sha256:1', angelegtAm: '2026-11-14T08:00:00Z', angelegtVon: 'VoltPilot Betrieb',
    rolle: 'voltpilot_betrieb', notiz: null, scharfAm: null, vorgelegtAm: null, vorgelegtVon: null,
    bericht: dienstAntwort.bericht as unknown as LogikBericht, text: TEXT_1,
  }] as F[],
  anfragen: [] as LogikAnfrage[],
  protokoll: [
    { fassung: 1, was: 'angenommen', am: '2026-11-14T08:00:00Z', von: 'VoltPilot Betrieb', rolle: 'voltpilot_betrieb', daten: null },
    { fassung: 1, was: 'stellwert', am: '2026-11-14T08:30:00Z', von: 'Jonas Wendlinger', rolle: 'kundenadministrator', daten: { kennung: 'mindest', name: 'Nie kälter als', alt: '40 °C', neu: '42 °C', stand: 1 } },
  ] as SteuerlogikSchritt[],
  laufFassung: 1 as number | null,
};
const aufgerufen: string[] = [];
(window as unknown as { welt: typeof welt; aufgerufen: string[] }).welt = welt;
(window as unknown as { aufgerufen: string[] }).aufgerufen = aufgerufen;

const jetzt = () => new Date().toISOString();
const ich = rolle === 'plattform' ? { von: 'VoltPilot Betrieb', rolle: 'voltpilot_betrieb' }
  : rolle === 'bedienberechtigt' ? { von: 'Murat Demirci', rolle: 'bedienberechtigt' } : { von: 'Jonas Wendlinger', rolle: 'kundenadministrator' };

/** Der echte Logik-Dienst (über die Spec): `/pruefe` mit dem Text, wie die API ihn schickt. */
async function dienstPruefe(text: string): Promise<LogikGeprueft> {
  const r = await fetch('/dienst/pruefe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  const b = await r.json() as { bericht?: LogikBericht; message?: string; meldungen?: LogikGeprueft['meldungen'] };
  if (r.status === 200 && b.bericht) return { lesbar: true, sperrt: !!b.bericht.sperrt, message: null, bericht: b.bericht, meldungen: b.bericht.meldungen ?? [] };
  if (r.status === 422) return { lesbar: false, sperrt: true, message: b.message ?? 'nicht lesbar', bericht: null, meldungen: b.meldungen ?? [] };
  throw new ApiError(503, 'Der Logik-Dienst ist nicht erreichbar.');
}

function kopfVon(f: F): LogikFassungKopf {
  const { text: _t, ...k } = f;
  void _t;
  return structuredClone(k);
}

function lauf(): LogikAnsicht['lauf'] {
  if (welt.laufFassung == null) return null;
  const l = structuredClone(rueckmeldung.laeufe[0]) as unknown as SteuerlogikRueckmeldung;
  l.flow_version = welt.laufFassung;
  l.zustand = welt.fassungen.find((f) => f.fassung === welt.laufFassung)?.zustand === 'scharf' ? 'scharf' : 'mitlaufend';
  if (l.geraete?.heizstab) {
    l.geraete.heizstab.entity_id = STAB;
    delete l.geraete.heizstab.befehl;
    delete l.geraete.heizstab.schutz;
  }
  return { box: 'box-1', fassung: welt.laufFassung, contentHash: 'sha256:x', zustand: l.zustand, seit: '2026-11-14T09:00:00Z', rueckmeldung: l, gemeldetAm: jetzt() };
}

function ansicht(): LogikAnsicht {
  const aktiv = welt.fassungen.find((f) => f.zustand === 'mitlaufend' || f.zustand === 'scharf');
  return {
    logikId: LOGIK, name: 'Warmwasser', darfBearbeiten: rolle !== 'bedienberechtigt', darfAnfragen: true,
    plattform: rolle === 'plattform', boxKann: true, boxKannScharf: true, fassungen: welt.fassungen.map(kopfVon),
    anfragen: structuredClone(welt.anfragen), einstellung: { stand: 1, werte: { mindest: '42 °C' } },
    lauf: aktiv ? lauf() : null,
  };
}

function protokolliere(fassung: number, was: SteuerlogikSchritt['was'], daten: Record<string, unknown> | null = null) {
  welt.protokoll.unshift({ fassung, was, am: jetzt(), von: ich.von, rolle: ich.rolle, daten });
}

const quellen: LogikQuellen = {
  quellen: [
    { source: 'site.grid', name: 'Netzbezug', einheit: 'kW' }, { source: 'site.pv', name: 'PV-Leistung', einheit: 'kW' },
    { source: 'battery.power', name: 'Batterie lädt mit', einheit: 'kW' }, { source: 'battery.soc', name: 'Ladestand der Batterie', einheit: '%' },
    { source: 'sun.elevation', name: 'Sonnenstand', einheit: '°' }, { source: 'price.current', name: 'Börsenpreis', einheit: 'ct/kWh' },
    { source: `${FUEHLER}.temperature`, name: 'Speicher oben', entity_id: FUEHLER, signal: 'temperature', einheit: '°C' },
  ],
  geraete: [
    { entity_id: STAB, name: 'Heizstab Warmwasser', typ: 'heating-rod', ausgaenge: ['level', 'on_off'], ausgangszahl: 3, kw_je_ausgang: 2 },
    { entity_id: 'a7e3c1d2-4b5f-4a6e-9c8d-7e6f5a4b3c2d', name: 'Wärmepumpe', typ: 'heat-pump-sgready', ausgaenge: ['on_off', 'mode'], betriebsarten: ['normal', 'boost'] },
  ],
};

const wechsel: SteuerlogikWechsel[] = rueckmeldung.laeufe[0].wechsel.map((w) => ({
  box: 'box-1', fassung: 1, laufSeit: '2026-11-14T09:00:00Z', ...w,
})) as unknown as SteuerlogikWechsel[];

function fassung(n: number): F {
  const f = welt.fassungen.find((x) => x.fassung === n);
  if (!f) throw new ApiError(404, 'Diese Fassung gibt es nicht.', { grund: 'fassung_unbekannt', message: 'Diese Fassung gibt es nicht.' });
  return f;
}

function abgelehnt(status: number, grund: string, message: string, mehr: Record<string, unknown> = {}): never {
  throw new ApiError(status, message, { grund, message, ...mehr });
}

const belegt: Record<string, (...args: never[]) => Promise<unknown>> = {
  logikListe: (async (): Promise<LogikListe> => {
    const a = ansicht();
    const aktiv = a.fassungen.find((f) => f.zustand === 'mitlaufend' || f.zustand === 'scharf') ?? null;
    return {
      darfBearbeiten: a.darfBearbeiten, darfAnfragen: true,
      logiken: [{ logikId: LOGIK, name: 'Warmwasser', neueste: a.fassungen[0].fassung, aktiv: aktiv?.fassung ?? null,
        zustand: aktiv?.zustand ?? a.fassungen[0].zustand, vorgelegt: null, offeneAnfragen: welt.anfragen.filter((x) => !x.erledigtAm).length,
        gemeldetAm: jetzt(), lage: { nr: 5, titel: 'Wartet auf Sonnenstrom', art: 'waiting' } }],
    };
  }) as never,
  logikQuellen: (async () => structuredClone(quellen)) as never,
  logikAnsicht: (async () => ansicht()) as never,
  logikText: (async (_s: string, _l: string, n: number) => {
    const f = fassung(n);
    return { logikId: LOGIK, fassung: n, zustand: f.zustand, text: f.text, bericht: structuredClone(f.bericht) };
  }) as never,
  logikPruefen: (async (_s: string, text: string) => { aufgerufen.push('pruefen'); return dienstPruefe(text); }) as never,
  logikSpeichern: (async (_s: string, text: string, notiz: string | null, logikId?: string, basis?: number) => {
    aufgerufen.push('speichern');
    const g = await dienstPruefe(text);
    if (!g.lesbar) abgelehnt(422, 'logik_unlesbar', g.message ?? 'Die Logik ist nicht lesbar.', { meldungen: g.meldungen });
    if (g.sperrt) abgelehnt(422, 'pruefung_sperrt', 'Die Prüfung sperrt die Logik.', { bericht: g.bericht, meldungen: g.meldungen });
    const neueste = welt.fassungen[0].fassung;
    if (logikId && basis !== neueste) abgelehnt(409, 'fassung_veraltet', `Inzwischen gibt es Fassung ${neueste}.`);
    const n = neueste + 1;
    welt.fassungen.unshift({ fassung: n, zustand: 'geprueft', contentHash: `sha256:${n}`, angelegtAm: jetzt(), angelegtVon: ich.von, rolle: ich.rolle,
      notiz, scharfAm: null, vorgelegtAm: null, vorgelegtVon: null, bericht: g.bericht, text });
    protokolliere(n, 'gespeichert', notiz ? { notiz } : null);
    return { logikId: LOGIK, fassung: n, name: g.bericht?.name ?? 'Logik', contentHash: `sha256:${n}`, bericht: g.bericht };
  }) as never,
  logikFassungSchritt: (async (_s: string, _l: string, n: number, schritt: string) => {
    aufgerufen.push(`${schritt}:${n}`);
    const f = fassung(n);
    const aktiv = welt.fassungen.find((x) => x.zustand === 'mitlaufend' || x.zustand === 'scharf');
    if (schritt === 'vorlegen') {
      f.vorgelegtAm = jetzt();
      f.vorgelegtVon = ich.von;
      protokolliere(n, 'vorgelegt');
      return { vorgelegt: true, fassung: n };
    }
    if (schritt === 'mitlaufen' && aktiv?.zustand === 'scharf') abgelehnt(409, 'scharf_abloesen', 'Die Logik ist scharf.');
    if (aktiv?.fassung === n) abgelehnt(409, 'laeuft_schon', `Fassung ${n} läuft schon.`);
    const zustand = schritt === 'zurueck' && aktiv?.zustand === 'scharf' ? 'scharf' : 'mitlaufend';
    if (aktiv) aktiv.zustand = 'stillgelegt';
    f.zustand = zustand;
    welt.laufFassung = n;
    protokolliere(n, schritt === 'zurueck' ? 'zurueck' : 'mitlaufen', schritt === 'zurueck' ? { von: aktiv?.fassung, auf: n } : null);
    return { logikId: LOGIK, fassung: n, name: 'Warmwasser', contentHash: f.contentHash, bericht: f.bericht, box: 'box-1', veroeffentlicht: true, zustand };
  }) as never,
  logikStilllegen: (async () => {
    const aktiv = welt.fassungen.find((x) => x.zustand === 'mitlaufend' || x.zustand === 'scharf');
    if (aktiv) { aktiv.zustand = 'stillgelegt'; protokolliere(aktiv.fassung, 'stillgelegt'); }
    welt.laufFassung = null;
    return { stillgelegt: !!aktiv };
  }) as never,
  logikAnfragen: (async (_s: string, _l: string, text: string, kennung?: string | null) => {
    const id = `anfrage-${welt.anfragen.length + 1}`;
    welt.anfragen.unshift({ id, kennung: kennung ?? null, text, am: jetzt(), von: ich.von, rolle: ich.rolle, erledigtAm: null, erledigtVon: null });
    protokolliere(welt.fassungen[0].fassung, 'anfrage', { anfrage: id, kennung, text });
    return { id };
  }) as never,
  logikAnfrageErledigt: (async (_s: string, _l: string, id: string) => {
    const a = welt.anfragen.find((x) => x.id === id);
    if (a) { a.erledigtAm = jetzt(); a.erledigtVon = ich.von; }
    return { erledigt: true };
  }) as never,
  logikProtokoll: (async () => ({ logikId: LOGIK, von: '2026-08-17', bis: '2026-11-15', schritte: structuredClone(welt.protokoll) })) as never,
  siteSteuerlogikVerlauf: (async () => ({ logikId: LOGIK, tag: '2026-11-14', wechsel: structuredClone(wechsel), schritte: [] })) as never,
  steuerlogikVorschauFassung: (async (_s: string, _l: string, n: number) => ({
    logikId: LOGIK, fassung: n, name: 'Warmwasser', zustand: 'mitlaufend', boxKann: true, bericht: fassung(n).bericht,
    hinweise: ['Die bisherige Steuerung dieser Geräte (etwa Home Assistant) muss aus sein. Das Portal kann das nicht prüfen.'],
    konflikte: [], geraete: ['Heizstab'], kundeStellt: ['Mit Sonnenstrom bis', 'Nie kälter als'], moeglich: true,
  })) as never,
  steuerlogikScharf: (async (_s: string, _l: string, n: number) => {
    aufgerufen.push(`scharf:${n}`);
    const f = fassung(n);
    const aktiv = welt.fassungen.find((x) => x.zustand === 'mitlaufend' || x.zustand === 'scharf');
    if (aktiv && aktiv.fassung !== n) aktiv.zustand = 'stillgelegt';
    f.zustand = 'scharf';
    f.scharfAm = jetzt();
    welt.laufFassung = n;
    protokolliere(n, 'scharf');
    return { logikId: LOGIK, fassung: n, name: 'Warmwasser', contentHash: f.contentHash, bericht: f.bericht, box: 'box-1', veroeffentlicht: true, zustand: 'scharf' };
  }) as never,
};
const offen = api as unknown as Record<string, unknown>;
for (const [name, wert] of Object.entries(offen)) {
  if (typeof wert !== 'function') continue;
  offen[name] = belegt[name] ?? (() => Promise.reject(new ApiError(404, `E2E-Bühne: ${name} ist nicht belegt`)));
}

if (q.get('scharf') === '1') {
  // Fassung 1 ist scharf: eine neue Fassung legt der Kunde vor, scharf schaltet die Plattform.
  welt.fassungen[0].zustand = 'scharf';
  welt.fassungen[0].scharfAm = '2026-11-14T09:00:00Z';
}
if (q.get('vorgelegt') === '1') {
  // Eine zweite Fassung, vom Kundenadministrator gespeichert und vorgelegt (für die Plattform).
  welt.fassungen.unshift({ ...structuredClone(welt.fassungen[0]), fassung: 2, zustand: 'geprueft', angelegtVon: 'Jonas Wendlinger',
    rolle: 'kundenadministrator', notiz: 'Sonnenziel 60 °C', vorgelegtAm: '2026-11-15T07:00:00Z', vorgelegtVon: 'Jonas Wendlinger',
    text: TEXT_1.replace('default: 57 °C', 'default: 60 °C') });
}
if (q.get('anfrage') === '1') {
  welt.anfragen.push({ id: 'anfrage-0', kennung: 'netz_ab', text: 'Bitte schon ab 5 Uhr aus dem Netz heizen.', am: '2026-11-15T06:40:00Z',
    von: 'Murat Demirci', rolle: 'bedienberechtigt', erledigtAm: null, erledigtVon: null });
}

window.location.hash = logikHash(SITE.id, q.get('logik') === 'neu' ? 'neu' : LOGIK, (q.get('ansicht') as never) ?? 'aufbau');

function Buehne() {
  const [liste, setListe] = useState<LogikListe | null>(null);
  if (q.get('buehne') === 'regeln') {
    if (!liste) void api.logikListe(SITE.id).then(setListe);
    return (
      <div className="stn" style={{ maxWidth: 1180, margin: '0 auto', padding: '0 16px' }}>
        <div className="stn-main regeln"><LogikenAbschnitt siteId={SITE.id} liste={liste} /></div>
      </div>
    );
  }
  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', padding: '0 16px' }}>
      <LogikSeite site={SITE} onOpenSub={(sub) => aufgerufen.push(`sub:${sub}`)} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Buehne />
  </React.StrictMode>,
);
