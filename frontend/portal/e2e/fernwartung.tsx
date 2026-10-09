/**
 * Echte Fernwartungs-Komponenten mit fiktiven Daten; alle API-Aufrufe bleiben im Speicher.
 * Zugänge lassen sich hier sperren, entsperren und löschen wie auf dem Server: gelöscht
 * heißt aus der Liste, im Protokoll bleibt der Name.
 */
import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { AppShell } from '../src/shell/AppShell';
import { GeraeteBereich } from '../src/pages/admin/GeraeteBereich';
import { adminApi } from '../src/admin/adminApi';
import { ApiError } from '../src/api';
import { keycloak } from '../src/auth';
import type {
  FernwartungBox,
  FernwartungFenster,
  FernwartungProtokollEintrag,
  FernwartungServer,
  FernwartungTechniker,
} from '../src/adminFernwartung';
import { type PageId } from '../src/nav';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

const jetzt = Date.now();
const iso = (ms: number) => new Date(jetzt + ms).toISOString();

const server: FernwartungServer = {
  endpunkt: 'wartung.example.test', port: 51820, publicKey: 'LnLMuBG+dDEeaEKlQrdTlPifX2fk0hOaB/NFc/BudjE=',
  eingerichtet: true, boxNetz: '10.10.16.0/20', technikerNetz: '10.10.32.0/24',
  boxServerAdresse: '10.10.16.1', technikerServerAdresse: '10.10.32.1',
};
// Zweimal „Alex (Laptop)": der erste Zugang bekam einen falschen Schlüssel, wurde gesperrt
// und unter demselben Namen neu angelegt. Der gesperrte lässt sich löschen.
let techniker: FernwartungTechniker[] = [
  { id: 't0', name: 'Alex (Laptop)', publicKey: 'dTkajHaCSCVbnmtc9YaXOW4Fvi51HANh0Fg2KTFV3kk=', publicKeyKurz: 'dTkajHaC…V3kk=',
    adresse: '10.10.32.2', status: 'gesperrt', notiz: 'falscher Schlüssel', angelegtAm: iso(-90_000_000), geaendertAm: iso(-88_000_000) },
  { id: 't1', name: 'Alex (Laptop)', publicKey: 'FY4LLXFaOvh8LPZu/gA4AeS2WJjXkuOUPB4hlxBI8/Y=', publicKeyKurz: 'FY4LLXFa…BI8/Y=',
    adresse: '10.10.32.3', status: 'aktiv', notiz: null, angelegtAm: iso(-86_400_000), geaendertAm: iso(-86_400_000) },
  { id: 't2', name: 'Werkstatt-Tablet', publicKey: 'Pgf4aS+67rz4HdSHuy8KKgm5e/UP3xnrMWJskXaZB9c=', publicKeyKurz: 'Pgf4aS+6…ZB9c=',
    adresse: '10.10.32.4', status: 'gesperrt', notiz: 'Gerät verloren gemeldet', angelegtAm: iso(-86_400_000), geaendertAm: iso(-3_600_000) },
];
const offen: FernwartungFenster = {
  id: 'f1', edgeRef: 'edge-zay5sdd', technikerId: 't1', technikerName: 'Alex (Laptop)', grund: 'Update auf Stufe 2',
  beginn: iso(-600_000), ende: iso(3_000_000), wirksamesEnde: iso(3_000_000), zustand: 'offen',
  geoeffnetAm: iso(-600_000), geoeffnetVon: 'alex', geschlossenAm: null, geschlossenVon: null,
};
let boxen: FernwartungBox[] = [
  { id: 'b1', edgeRef: 'edge-zay5sdd', publicKey: 'jUg9DePFPkIQ+KNIAXqSEuVTw2UNHwbUH/HPFK5HiEM=', publicKeyKurz: 'jUg9DePF…5HiEM=',
    adresse: '10.10.16.2', status: 'aktiv', notiz: null, angelegtAm: iso(-86_400_000), geaendertAm: iso(-86_400_000),
    siteId: 's1', siteName: 'Hof Lindenallee', tenantId: 'k1', tenantName: 'Familie Beispiel', laufendeFenster: [offen] },
  { id: 'b2', edgeRef: 'edge-k7m2xq3', publicKey: 'SBsk0U9z6BgB/U8nb+L9PdK/46p7mBvWRQe8I0Vg3C0=', publicKeyKurz: 'SBsk0U9z…Vg3C0=',
    adresse: '10.10.16.3', status: 'aktiv', notiz: null, angelegtAm: iso(-3_600_000), geaendertAm: iso(-3_600_000),
    siteId: null, siteName: null, tenantId: null, tenantName: null, laufendeFenster: [] },
  { id: 'b3', edgeRef: 'edge-q2w3e4r', publicKey: 'Rs0dJ9n7J1n0mF1pY8h2K3v6xQ9wZ5cB7tA4uE2iO0k=', publicKeyKurz: 'Rs0dJ9n7…iO0k=',
    adresse: '10.10.16.4', status: 'gesperrt', notiz: null, angelegtAm: iso(-7_200_000), geaendertAm: iso(-1_800_000),
    siteId: 's3', siteName: 'Gewerbepark West', tenantId: 'k3', tenantName: 'Muster Solar GmbH', laufendeFenster: [] },
];
let protokoll: FernwartungProtokollEintrag[] = [
  { id: 'p2', zeit: iso(-600_000), akteur: 'alex', aktion: 'fenster_geoeffnet', edgeRef: 'edge-zay5sdd', technikerId: 't1',
    technikerName: 'Alex (Laptop)', fensterId: 'f1', details: { dauerMinuten: '60', beginn: iso(-600_000), grund: 'Update auf Stufe 2' } },
  { id: 'p1', zeit: iso(-3_600_000), akteur: 'alex', aktion: 'techniker_gesperrt', edgeRef: null, technikerId: 't2',
    technikerName: 'Werkstatt-Tablet', fensterId: null, details: { grund: 'Gerät verloren gemeldet' } },
  { id: 'p0', zeit: iso(-88_000_000), akteur: 'alex', aktion: 'techniker_gesperrt', edgeRef: null, technikerId: 't0',
    technikerName: 'Alex (Laptop)', fensterId: null, details: { grund: 'falscher Schlüssel' } },
];

/** Ein Protokolleintrag zu einem Zugang, neueste zuerst wie auf dem Server. */
function vermerke(aktion: FernwartungProtokollEintrag['aktion'], t: FernwartungTechniker, details: Record<string, string>) {
  protokoll = [{ id: `p-${protokoll.length + 1}`, zeit: new Date().toISOString(), akteur: 'alex', aktion, edgeRef: null,
    technikerId: t.id, technikerName: t.name, fensterId: null, details }, ...protokoll];
}
function zugang(id: string): FernwartungTechniker {
  const t = techniker.find((x) => x.id === id);
  if (!t) throw new ApiError(404, 'Diesen Techniker-Zugang gibt es nicht.');
  return t;
}
function setze(id: string, status: FernwartungTechniker['status']): FernwartungTechniker {
  techniker = techniker.map((t) => (t.id === id ? { ...t, status, geaendertAm: new Date().toISOString() } : t));
  return zugang(id);
}

Object.assign(keycloak, { tokenParsed: { name: 'Alex Beispiel', email: 'alex@example.test', realm_access: { roles: ['platform-admin'] } } });
Object.assign(adminApi, {
  fernwartung: async () => ({
    server, maxFensterMinuten: 1440,
    abrufe: [{ dienst: 'voltpilot-tunnel-dienst', zuletztAm: new Date(Date.now() - 20_000).toISOString(),
      peers: 2 + techniker.filter((t) => t.status === 'aktiv').length, fenster: 1 }],
    boxenAktiv: 2, boxenGesperrt: 1, technikerAktiv: techniker.filter((t) => t.status === 'aktiv').length,
    technikerGesperrt: techniker.filter((t) => t.status === 'gesperrt').length, fensterOffen: 1, fensterGeplant: 0,
    stand: new Date().toISOString(),
  }),
  fernwartungBoxen: async () => boxen,
  fernwartungTechniker: async () => techniker,
  fernwartungProtokoll: async () => protokoll,
  fernwartungFensterOeffnen: async (i: { edgeRef: string; technikerId: string; grund: string; dauerMinuten: number }) => {
    const f: FernwartungFenster = { ...offen, id: `f-${boxen.length}`, edgeRef: i.edgeRef, grund: i.grund,
      beginn: iso(0), ende: iso(i.dauerMinuten * 60_000), wirksamesEnde: iso(i.dauerMinuten * 60_000) };
    boxen = boxen.map((b) => (b.edgeRef === i.edgeRef ? { ...b, laufendeFenster: [...b.laufendeFenster, f] } : b));
    return f;
  },
  fernwartungFensterSchliessen: async () => { throw new Error('Vorschau: Es wird kein echtes Fenster geschlossen.'); },
  fernwartungSchluessel: async () => { throw new Error('Vorschau: Es wird kein Schlüssel hinterlegt.'); },
  fernwartungTechnikerAnlegen: async () => { throw new Error('Vorschau: Es wird kein Zugang angelegt.'); },
  fernwartungTechnikerSperren: async (id: string) => {
    const t = setze(id, 'gesperrt');
    boxen = boxen.map((b) => ({ ...b, laufendeFenster: b.laufendeFenster.filter((f) => f.technikerId !== id) }));
    vermerke('techniker_gesperrt', t, {});
    return t;
  },
  fernwartungTechnikerEntsperren: async (id: string) => {
    const t = setze(id, 'aktiv');
    vermerke('techniker_entsperrt', t, {});
    return t;
  },
  // Wie der Server: nur aus gesperrt, danach in keiner Liste mehr; das Protokoll behält den Namen.
  fernwartungTechnikerLoeschen: async (id: string) => {
    const t = zugang(id);
    if (t.status !== 'gesperrt') throw new ApiError(409, `Der Zugang „${t.name}" ist aktiv. Erst sperren, dann löschen.`);
    techniker = techniker.filter((x) => x.id !== id);
    vermerke('techniker_geloescht', t, { name: t.name, adresse: t.adresse, publicKey: t.publicKeyKurz });
  },
});

function Fixture() {
  const [page, setPage] = useState<PageId>('fernwartung');
  return <AppShell page={page} onNavigate={setPage} isAdmin showOverview={false} showAddAnlage={false}
    counts={{ sites: 3, devices: 3 }} tenants={[]} tenantOverride={null} onTenantChange={() => {}}>
    <GeraeteBereich page={page} onNavigate={(r) => setPage(typeof r === 'string' ? r : r.page)} />
  </AppShell>;
}
ReactDOM.createRoot(document.getElementById('root')!).render(<Fixture />);
