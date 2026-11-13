// Kunden-Alarmierung P3 („Ein Ort: Jetzt · Verlauf · Einstellen“): die Seite Meldungen mit festen Daten, je Kundenart
// (`?kunde=privat|unternehmen`) und Reiter (`?reiter=`). Dasselbe Fetch-Stell-Muster wie `ueberwachung-loeschen.tsx` -
// kein Server, aber derselbe Vertrag (`Meldung` mit P1-Text, `UeberwachungsRegel` mit Bedingung und Empfängern, Wege).
// Nichts verlässt den Browser: Probe, Push und Schalten antworten aus diesem Modul.
import ReactDOM from 'react-dom/client';
import { MeldungenPage } from '../src/pages/MeldungenPage';
import type { Meldung, UeberwachungsRegel } from '../src/meldungenApi';
import { keycloak } from '../src/auth';
import './rollen-fixture';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';
import '../src/components/Profile.css'; // .vp-switch-knob der Einstellungs-Schalter (in der App lädt die Schale es)

Object.assign(keycloak, { token: 'e2e-token', authenticated: true, updateToken: async () => false });

const suche = new URLSearchParams(location.search);
const unternehmen = suche.get('kunde') === 'unternehmen';
const reiter = suche.get('reiter') ?? 'jetzt';
const anfragen: unknown[] = [];
(window as unknown as { __anfragen: unknown[] }).__anfragen = anfragen;

const vor = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const ANLAGEN = unternehmen
  ? [{ id: 'an-1', name: 'Werk Ahrenberg, Halle 1' }, { id: 'an-2', name: 'Lager Ostheim' }]
  : [{ id: 'an-1', name: 'Zuhause' }];

function box(id: string, anlage: { id: string; name: string }, seit: number, extra: Partial<Meldung> = {}): Meldung {
  return {
    id, kennzeichen: `AL-2026-0000${id.slice(-2)}`, wertart: 'box.erreichbar', schwere: 'warnung',
    anlageId: anlage.id, anlageName: anlage.name, standortId: null, ausgeloestAm: vor(seit), zustand: 'aktiv',
    wiederNormalAm: null, gesehenVon: null, gesehenAm: null, erledigtAm: null, bezugKennung: `anlage:${anlage.id}`,
    ueberwachungId: `r-box-${anlage.id}`,
    text: {
      wertart: 'box.erreichbar', herkunft: 'ab_werk', regelName: 'Box erreichbar', schwere: 'warnung', bezugArt: 'anlage',
      ort: anlage.name, bedingung: { art: 'zustand', ziel: ['nicht_erreichbar'], dauer_s: 900, erholen_s: 300 },
      wert: { zahl: null, einheit: null, zustand: 'nicht_erreichbar', satz: null }, beginn: vor(seit + 15), ende: null,
    },
    ...extra,
  } as Meldung;
}

const JETZT: Meldung[] = unternehmen
  ? [
      {
        ...box('m-41', ANLAGEN[0], 6), id: 'm-41', wertart: 'anlage.netz.lastspitze_laufend', schwere: 'dringend',
        ueberwachungId: 'r-spitze',
        text: {
          wertart: 'anlage.netz.lastspitze_laufend', herkunft: 'ab_werk', regelName: null, schwere: 'dringend',
          bezugArt: 'anlage', ort: ANLAGEN[0].name, bedingung: { art: 'ueber', schwelle: 290, dauer_s: 0 },
          wert: { zahl: 296.4, einheit: 'kW', zustand: null, satz: null }, beginn: vor(6), ende: null,
        },
      } as Meldung,
      box('m-42', ANLAGEN[1], 34, { gesehenVon: 'Ines Kraft', gesehenAm: vor(20) }),
    ]
  : [
      box('m-02', ANLAGEN[0], 22),
      {
        ...box('m-03', ANLAGEN[0], 48), id: 'm-03', wertart: 'anlage.preis.jetzt', schwere: 'hinweis', ueberwachungId: 'r-preis',
        text: {
          wertart: 'anlage.preis.jetzt', herkunft: 'ab_werk', regelName: null, schwere: 'hinweis', bezugArt: 'anlage',
          ort: ANLAGEN[0].name, bedingung: { art: 'unter', schwelle: 8, dauer_s: 300 },
          wert: { zahl: 6.6, einheit: 'ct/kWh', zustand: null, satz: null }, beginn: vor(48), ende: null,
        },
      } as Meldung,
    ];

const VERLAUF: Meldung[] = [
  box('m-01', ANLAGEN[0], 60 * 26, {
    zustand: 'erledigt', wiederNormalAm: vor(60 * 26 - 42), erledigtAm: vor(60 * 26 - 42),
    gesehenVon: unternehmen ? 'Jonas Wendlinger' : 'Sabine Sommer', gesehenAm: vor(60 * 26 - 10),
  }),
];
VERLAUF[0].text = { ...VERLAUF[0].text!, ende: VERLAUF[0].wiederNormalAm };

function regel(id: string, wertart: string, anlage: string | null, extra: Partial<UeberwachungsRegel>): UeberwachungsRegel {
  return {
    id, name: null, wertart, schwere: 'warnung', herkunft: 'ab_werk', aktiv: true, probelaufBis: null,
    bezugJson: anlage ? JSON.stringify({ anlage }) : '{"alle":"anlage"}', standortId: null,
    bedingung: { art: 'zustand', dauer_s: 900 },
    empfaenger: unternehmen
      ? [{ person: null, rolle: 'kundenadministrator', name: null }, { person: null, rolle: 'energiemanager', name: null },
        { person: null, rolle: 'bearbeiter', name: null }, { person: null, rolle: 'bedienberechtigt', name: null }]
      : [{ person: null, rolle: 'kundenadministrator', name: null }],
    fassung: 1, ...extra,
  };
}

const REGELN: UeberwachungsRegel[] = unternehmen
  ? [
      ...ANLAGEN.map((a) => regel(`r-box-${a.id}`, 'box.erreichbar', a.id, {})),
      ...ANLAGEN.map((a) => regel(`r-dq-${a.id}`, 'datenquelle.liefert_daten', a.id, { bedingung: { art: 'zustand', dauer_s: 3600 } })),
      regel('r-spitze', 'anlage.netz.lastspitze_laufend', 'an-1', { schwere: 'dringend', bedingung: { art: 'ueber', schwelle: 290, dauer_s: 0 } }),
      regel('r-eigen', 'anlage.netz.leistung', 'an-1', {
        herkunft: 'eigen', name: 'Netzbezug über 300 kW', bedingung: { art: 'ueber', schwelle: 300, rueckkehr: 285, dauer_s: 300, erholen_s: 300 },
        empfaenger: [{ person: 'jw', rolle: null, name: 'Jonas Wendlinger' }],
      }),
    ]
  : [
      regel('r-box-an-1', 'box.erreichbar', 'an-1', {}),
      regel('r-dq-an-1', 'datenquelle.liefert_daten', 'an-1', { bedingung: { art: 'zustand', dauer_s: 3600 } }),
      regel('r-wb', 'ladepunkt.wallbox_meldet_sich_nicht', 'an-1', {}),
      regel('r-preis', 'anlage.preis.jetzt', 'an-1', { schwere: 'hinweis', bedingung: { art: 'unter', schwelle: 8, dauer_s: 300 } }),
      regel('r-eigen', 'anlage.preis.jetzt', 'an-1', {
        herkunft: 'eigen', name: 'Börsenpreis über 5 ct/kWh', probelaufBis: new Date(Date.now() + 20 * 86400_000).toISOString(),
        bedingung: { art: 'ueber', schwelle: 5, rueckkehr: 4.8, dauer_s: 300, erholen_s: 300 },
        empfaenger: [{ person: 'ss', rolle: null, name: 'Sabine Sommer' }],
      }),
    ];

const EMAIL = {
  ziel: unternehmen ? 'jonas@ahrenberg.example' : 'sommer@voltpilot.local', bestaetigt: true, aktiv: true,
  abSchwere: 'warnung', zusammenfassungAktiv: unternehmen, zusammenfassungUhrzeit: '07:00:00',
  herkunft: unternehmen ? 'eigen' : 'anmeldung',
};
const PUSH = unternehmen
  ? [{ id: 'p-1', geraet: 'iPhone von Jonas', aktiv: true, abSchwere: 'warnung', erstelltAm: vor(9000), endpoint: null }]
  : [];
const RUHE = unternehmen
  ? '{"werktags":{"von":"22:00","bis":"07:00"},"wochenende":"ganz"}'
  : '{"werktags":{"von":"22:00","bis":"07:00"},"wochenende":{"von":"22:00","bis":"07:00"}}';

const echtesFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.origin);
  const methode = (init?.method ?? 'GET').toUpperCase();
  const p = url.pathname;
  if (methode !== 'GET') anfragen.push({ methode, pfad: p, koerper: init?.body ? JSON.parse(String(init.body)) : null });

  if (p === '/api/v1/sites') return Response.json({ eintraege: ANLAGEN, teilansicht: { sichtbar: ANLAGEN.length, gesamt: ANLAGEN.length } });
  if (p === '/api/v1/meldungen') return Response.json({ meldungen: url.searchParams.get('status') === 'verlauf' ? VERLAUF : JETZT });
  if (p === '/api/v1/meldungen/zahl') return Response.json({ ungesehen: 1, dringend: unternehmen });
  const gesehen = p.match(/^\/api\/v1\/meldungen\/([^/]+)\/gesehen$/);
  if (gesehen) {
    const m = JETZT.find((x) => x.id === gesehen[1])!;
    m.gesehenVon = unternehmen ? 'Jonas Wendlinger' : 'Sabine Sommer';
    m.gesehenAm = new Date().toISOString();
    return Response.json(m);
  }
  if (p === '/api/v1/meldungen/regeln' && methode === 'GET') return Response.json({ ueberwachungen: REGELN });
  const schalten = p.match(/^\/api\/v1\/meldungen\/regeln\/([^/]+)\/aktiv$/);
  if (schalten) {
    const r = REGELN.find((x) => x.id === schalten[1])!;
    r.aktiv = JSON.parse(String(init?.body)).aktiv;
    return Response.json(r);
  }
  if (p === '/api/v1/meldungen/regeln/probelauf') return Response.json({ fensterTage: 30, ausgeloest: 3, zuletzt: vor(4000), gesamtdauerS: 2400, moeglich: true });
  const aendern = p.match(/^\/api\/v1\/meldungen\/regeln\/([^/]+)$/);
  if (aendern && methode === 'PUT') {
    const r = REGELN.find((x) => x.id === aendern[1])!;
    const k = JSON.parse(String(init?.body));
    Object.assign(r, { bedingung: k.bedingung, schwere: k.schwere, probelaufBis: k.probelauf ? r.probelaufBis : null, fassung: (r.fassung ?? 1) + 1 });
    return Response.json(r);
  }
  if (p === '/api/v1/stummschaltungen') return Response.json({ id: 's-1' }, { status: 201 });
  if (p === '/api/v1/zustellwege/email') return Response.json(EMAIL);
  if (p === '/api/v1/zustellwege/email/probe' || /\/push\/[^/]+\/probe$/.test(p)) return Response.json({ erfolgreich: true, fehler: null });
  if (p === '/api/v1/zustellwege/push') return Response.json(PUSH);
  if (p === '/api/v1/zustellwege/webhook') return Response.json([]);
  if (p.startsWith('/api/v1/zustellwege/telegram')) return Response.json({ verfuegbar: false, ziele: [] });
  if (p === '/api/v1/ruhezeit') return Response.json({ regeln: RUHE, zeitzone: 'Europe/Berlin', dringendDurch: true, vorgabe: !unternehmen });
  if (p === '/api/v1/ruhezeit/probe') return Response.json({ aktivBis: null });
  if (p.startsWith('/api/v1/sites/') && p.endsWith('/anlagensteuerungen')) return Response.json({ steuerungen: [] });
  return echtesFetch(input, init);
};

window.location.hash = `#/meldungen?reiter=${reiter}`;
ReactDOM.createRoot(document.getElementById('root')!).render(<MeldungenPage />);
