/**
 * Die echte Werkstatt-Seite mit fiktiven Daten; alle API-Aufrufe bleiben im Speicher. Register,
 * Schritte, LAN-Netz und Abnahme verhalten sich wie auf dem Server (Prüfungen vollständig, Fenster der
 * Probe geschlossen, übliche Heimnetze abgelehnt); Tunnel-Schlüssel und Fenster wie in der Fernwartung.
 * Der Tunnel-Dienst meldet jede Box als verbunden und den Schlüssel jedes Fensters als gleich abgeholt.
 *
 * Im Register: edge-wrk7abg (Edge Light, bis zur Probe gekommen, Tunnel, LAN-Netz festgehalten) und
 * edge-wrk8cdb (Docker-Box, nur im Register). Alle Referenzen und Schlüssel sind erfunden.
 */
import { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { AppShell } from '../src/shell/AppShell';
import { GeraeteBereich } from '../src/pages/admin/GeraeteBereich';
import { adminApi } from '../src/admin/adminApi';
import { ApiError } from '../src/api';
import { keycloak } from '../src/auth';
import type { FernwartungBox, FernwartungFenster, FernwartungServer, FernwartungTechniker } from '../src/adminFernwartung';
import { PRUEFUNGEN, type WerkstattAbnahme, type WerkstattBox } from '../src/werkstatt';
import { type PageId } from '../src/nav';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

const start = Date.now();
const iso = (ms: number) => new Date(start + ms).toISOString();
const jetztIso = () => new Date().toISOString();
const dienstStart = iso(-6 * 3_600_000);

const server: FernwartungServer = {
  endpunkt: 'wartung.example.test', port: 51820, publicKey: 'LnLMuBG+dDEeaEKlQrdTlPifX2fk0hOaB/NFc/BudjE=',
  eingerichtet: true, boxNetz: '10.10.16.0/20', technikerNetz: '10.10.32.0/24',
  boxServerAdresse: '10.10.16.1', technikerServerAdresse: '10.10.32.1',
};
const techniker: FernwartungTechniker[] = [
  { id: 't1', name: 'Alex (Laptop)', publicKey: 'FY4LLXFaOvh8LPZu/gA4AeS2WJjXkuOUPB4hlxBI8/Y=', publicKeyKurz: 'FY4LLXFa…BI8/Y=',
    adresse: '10.10.32.3', status: 'aktiv', notiz: null, angelegtAm: iso(-86_400_000), geaendertAm: iso(-86_400_000),
    sshPublicKey: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC65yGMPv85jYw73Y34zwg28UDa5p7',
    sshFingerabdruck: 'SHA256:TDOx3bpPNtPLIdd+juZoGcDMz3ZRCklaP5G6aBrp9Zc', sshBits: 3072 },
];

const schritt = (ms: number) => ({ am: iso(ms), von: 'alex' });
let register: WerkstattBox[] = [
  { id: 'w1', edgeRef: 'edge-wrk7abg', boxArt: 'edge-light', lanNetz: '10.213.0.1/24',
    schritte: { openwrt: schritt(-3_600_000), kabel: schritt(-3_500_000), passwort: schritt(-3_400_000),
      notfall: schritt(-3_300_000), programm: schritt(-3_200_000), tunnel_schluessel: schritt(-3_100_000),
      tunnel: schritt(-3_000_000), status: schritt(-2_900_000) },
    notiz: null, angelegtAm: iso(-3_200_000), angelegtVon: 'alex', geaendertAm: iso(-2_900_000), abnahmen: [] },
  { id: 'w2', edgeRef: 'edge-wrk8cdb', boxArt: 'edge-app', lanNetz: null, schritte: {},
    notiz: 'Raspberry Pi 5, für die Prüfanlage', angelegtAm: iso(-86_400_000), angelegtVon: 'alex',
    geaendertAm: iso(-86_400_000), abnahmen: [] },
];
let tunnel: FernwartungBox[] = [
  { id: 'b1', edgeRef: 'edge-wrk7abg', publicKey: 'jUg9DePFPkIQ+KNIAXqSEuVTw2UNHwbUH/HPFK5HiEM=', publicKeyKurz: 'jUg9DePF…5HiEM=',
    adresse: '10.10.16.7', status: 'aktiv', notiz: 'Werkstatt', angelegtAm: iso(-3_100_000), geaendertAm: iso(-3_100_000),
    siteId: null, siteName: null, tenantId: null, tenantName: null, laufendeFenster: [], rueckmeldung: null },
];
let fenster: FernwartungFenster[] = [];

function boxOder404(ref: string): WerkstattBox {
  const b = register.find((x) => x.edgeRef === ref);
  if (!b) throw new ApiError(404, `${ref} steht nicht im Werkstatt-Register.`);
  return b;
}
function aendere(ref: string, f: (b: WerkstattBox) => WerkstattBox): WerkstattBox {
  register = register.map((b) => (b.edgeRef === ref ? { ...f(b), geaendertAm: jetztIso() } : b));
  return boxOder404(ref);
}
function zustand(f: FernwartungFenster): FernwartungFenster {
  if (f.geschlossenAm) return { ...f, zustand: 'geschlossen', wirksamesEnde: f.geschlossenAm };
  return { ...f, zustand: new Date(f.ende).getTime() > Date.now() ? 'offen' : 'abgelaufen' };
}
function gemeldet(f: FernwartungFenster): FernwartungFenster {
  return { ...f, rueckmeldung: { gemeldetAm: jetztIso(), schluesselAbgeholtUm: f.geoeffnetAm } };
}

Object.assign(keycloak, { tokenParsed: { name: 'Alex Beispiel', email: 'alex@example.test', realm_access: { roles: ['platform-admin'] } } });
Object.assign(adminApi, {
  fernwartung: async () => ({
    server, maxFensterMinuten: 1440,
    abrufe: [{ dienst: 'voltpilot-tunnel-dienst', zuletztAm: iso(-20_000), peers: 2, fenster: 0 }],
    rueckmeldungen: [{ dienst: 'voltpilot-tunnel-dienst', zuletztAm: jetztIso(), gestartetUm: dienstStart, schluesselausgabe: true, boxen: tunnel.length, fenster: 0 }],
    boxenAktiv: tunnel.length, boxenGesperrt: 0, technikerAktiv: 1, technikerGesperrt: 0, fensterOffen: 0, fensterGeplant: 0,
    stand: jetztIso(),
  }),
  fernwartungBoxen: async () => tunnel.map((b) => ({
    ...b,
    rueckmeldung: { gemeldetAm: jetztIso(), verbundenSeit: dienstStart, zuletztGefragtUm: iso(-9_000) },
    laufendeFenster: fenster.map(zustand).filter((f) => f.edgeRef === b.edgeRef && f.zustand === 'offen').map(gemeldet),
  })),
  fernwartungTechniker: async () => techniker,
  fernwartungFenster: async (box: string) => fenster.filter((f) => f.edgeRef === box).map(zustand).map(gemeldet).reverse(),
  fernwartungSchluessel: async (ref: string, i: { publicKey: string }) => {
    const box: FernwartungBox = { ...tunnel[0], id: `b-${Date.now()}`, edgeRef: ref, publicKey: i.publicKey,
      publicKeyKurz: `${i.publicKey.slice(0, 8)}…${i.publicKey.slice(-6)}`, adresse: `10.10.16.${tunnel.length + 7}`,
      angelegtAm: jetztIso(), geaendertAm: jetztIso() };
    tunnel = [...tunnel, box];
    return { ergebnis: 'angelegt', box, server };
  },
  fernwartungFensterOeffnen: async (i: { edgeRef: string; technikerId: string; grund: string; dauerMinuten: number }) => {
    const t = techniker.find((x) => x.id === i.technikerId)!;
    const ende = new Date(Date.now() + i.dauerMinuten * 60_000).toISOString();
    const f: FernwartungFenster = { id: `f-${Date.now()}`, edgeRef: i.edgeRef, technikerId: t.id, technikerName: t.name,
      grund: i.grund, beginn: jetztIso(), ende, wirksamesEnde: ende, zustand: 'offen', geoeffnetAm: jetztIso(),
      geoeffnetVon: 'alex', geschlossenAm: null, geschlossenVon: null };
    fenster = [...fenster, f];
    return f;
  },
  fernwartungFensterSchliessen: async (id: string) => {
    const f = fenster.find((x) => x.id === id);
    if (!f || f.geschlossenAm) throw new ApiError(409, 'Das Fenster ist nicht mehr offen.');
    fenster = fenster.map((x) => (x.id === id ? { ...x, geschlossenAm: jetztIso(), geschlossenVon: 'alex' } : x));
    return zustand(fenster.find((x) => x.id === id)!);
  },
  werkstattGrundlagen: async () => ({ pruefungen: PRUEFUNGEN.map((p) => p.id), lanNetzVorschlag: '10.213.0.1/24' }),
  werkstattBoxen: async () => register,
  werkstattBoxAnlegen: async (i: { edgeRef: string; boxArt?: 'edge-light' | 'edge-app'; schritte?: string[] }) => {
    const da = register.find((b) => b.edgeRef === i.edgeRef);
    if (da) return da;
    const b: WerkstattBox = { id: `w-${Date.now()}`, edgeRef: i.edgeRef, boxArt: i.boxArt ?? 'edge-light', lanNetz: null,
      schritte: Object.fromEntries((i.schritte ?? []).map((s) => [s, { am: jetztIso(), von: 'alex' }])), notiz: null,
      angelegtAm: jetztIso(), angelegtVon: 'alex', geaendertAm: jetztIso(), abnahmen: [] };
    register = [b, ...register];
    return b;
  },
  werkstattSchritt: async (ref: string, s: string, erledigt: boolean) =>
    aendere(ref, (b) => {
      const schritte = { ...b.schritte };
      if (erledigt) schritte[s] = schritte[s] ?? { am: jetztIso(), von: 'alex' };
      else delete schritte[s];
      return { ...b, schritte };
    }),
  werkstattLanNetz: async (ref: string, lanNetz: string) => {
    if (/^192\.168\.(0|1|2|8|178)\./.test(lanNetz)) {
      throw new ApiError(422, `${lanNetz.replace(/\.\d+\//, '.0/')} enthält ein übliches Netz von Heimroutern. Bitte ein unübliches wählen, etwa 10.213.0.1/24.`);
    }
    return aendere(ref, (b) => ({ ...b, lanNetz }));
  },
  werkstattAbnahme: async (ref: string, i: { hostSchluessel: string; fassung: string; pruefungen: string[]; probeFensterId: string; notiz?: string | null }) => {
    const f = fenster.find((x) => x.id === i.probeFensterId);
    if (!f) throw new ApiError(422, `Dieses Fenster gehört nicht zu ${ref}.`);
    if (!f.geschlossenAm && new Date(f.ende).getTime() > Date.now()) {
      throw new ApiError(409, 'Das Fenster der Probe ist noch offen. Erst schließen und den Versuch wiederholen (Werkstatt-Regel 6).');
    }
    const box = boxOder404(ref);
    const a: WerkstattAbnahme = { id: `a-${Date.now()}`, edgeRef: ref, hostSchluessel: i.hostSchluessel, fassung: i.fassung,
      tunnelAdresse: tunnel.find((b) => b.edgeRef === ref)!.adresse, lanNetz: box.lanNetz!, pruefungen: i.pruefungen,
      probe: { fensterId: f.id, technikerName: f.technikerName, grund: f.grund, beginn: f.beginn, ende: f.geschlossenAm ?? f.ende,
        geschlossenAm: f.geschlossenAm, geschlossenVon: f.geschlossenVon, schluesselAbgeholtUm: gemeldet(f).rueckmeldung?.schluesselAbgeholtUm ?? null,
        gemeldetAm: jetztIso() },
      notiz: i.notiz ?? null, erfasstAm: jetztIso(), erfasstVon: 'alex' };
    aendere(ref, (b) => ({ ...b, abnahmen: [a, ...b.abnahmen] }));
    return a;
  },
});

function Fixture() {
  const [page, setPage] = useState<PageId>('werkstatt');
  return <AppShell page={page} onNavigate={setPage} isAdmin showOverview={false} showAddAnlage={false}
    counts={{ sites: 3, devices: 3 }} tenants={[]} tenantOverride={null} onTenantChange={() => {}}>
    <GeraeteBereich page={page} onNavigate={(r) => setPage(typeof r === 'string' ? r : r.page)} />
  </AppShell>;
}
ReactDOM.createRoot(document.getElementById('root')!).render(<Fixture />);
