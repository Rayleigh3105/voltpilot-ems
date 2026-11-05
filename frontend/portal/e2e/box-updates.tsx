import './rollen-fixture';
/** Real admin components with fictional data; all API calls stay in memory. */
import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { AppShell } from '../src/shell/AppShell';
import { GeraeteBereich } from '../src/pages/admin/GeraeteBereich';
import { adminApi } from '../src/admin/adminApi';
import { keycloak } from '../src/auth';
import {
  GRUND_LIGHT_AUF_UNBEKANNT, GRUND_LIGHT_STUFE_1_LOADER, type EdgeUpdates, type FleetRow,
} from '../src/adminEdgeUpdates';
import { type PageId } from '../src/nav';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

const now = new Date().toISOString();
const vor = (ms: number) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;
// Die drei Fakten einer Anfrage (Geräte & Updates G2), wie die API sie liefert.
const anfrage = (o: { am: string; angenommen: string; angenommenAm?: string | null; grund?: string | null;
  bestaetigt?: string; bestaetigtAm?: string | null; schritt?: string | null }) => ({
  angefragt: { release: 'edge-2026.09.10', releaseSeq: 42, am: o.am, von: 'alex' },
  angenommen: { stand: o.angenommen, am: o.angenommenAm ?? null, grund: o.grund ?? null },
  bestaetigt: { stand: o.bestaetigt ?? 'offen', am: o.bestaetigtAm ?? null, schritt: o.schritt ?? null, grund: null },
});
const base: FleetRow = {
  deviceId: 'd1', label: 'VP-BOX-1001', externalRef: 'VP-BOX-1001', siteId: 's1',
  siteName: 'Solarpark Sonnenhof', tenantId: 't1', tenantName: 'Stadtwerke Musterstadt',
  ist: 'edge-2026.09.10-a18b472eab90', soll: 'edge-2026.09.10', sollSeq: 42,
  state: 'bestaetigt', reason: null, since: now, reportedAt: now, rolloutId: null, boxArt: 'docker',
  trust: { rootKeyIds: ['root'], trustSetKeyIds: ['release'], trustSetGeneratedAt: now, trustSetError: null },
  // Geräte & Updates G1/G2: Linie, Linien-Stand, die eine Uhr und die drei Fakten (fiktiv).
  linie: 'docker', stand: 'aktuell', stufe1: false, lastSeenAt: vor(40_000),
  istRelease: 'edge-2026.09.10', releasesDahinter: 0, istSeit: '2026-09-11T08:30:00Z',
  fakten: anfrage({ am: '2026-09-11T08:00:00Z', angenommen: 'ja', angenommenAm: '2026-09-11T08:02:00Z',
    bestaetigt: 'ja', bestaetigtAm: '2026-09-11T08:30:00Z' }),
};
const aelter = { ist: 'edge-2026.09.02-73486bab2980', istRelease: 'edge-2026.09.02', releasesDahinter: 1, istSeit: null };
const fleet: FleetRow[] = [
  // Geräte & Updates G8: was die Box über ihr Gerät meldet (fiktiv).
  { ...base, geraetModell: 'Raspberry Pi 4 Model B Rev 1.4', geraetArch: 'arm64' },
  { ...base, ...aelter, deviceId: 'd2', externalRef: 'edge-abcdefj', label: 'Box Werkstatt', siteName: 'Werkstatt am Bach',
    geraetModell: 'Intel(R) Client Systems NUC11TNHi5', geraetArch: 'amd64',
    state: 'laedt', reason: 'Das Update wird heruntergeladen.', stand: 'laeuft',
    fakten: anfrage({ am: vor(20 * MIN), angenommen: 'ja', angenommenAm: vor(18 * MIN), bestaetigt: 'laeuft', schritt: 'laedt' }) },
  { ...base, ...aelter, deviceId: 'd3', externalRef: 'VP-BOX-1003', label: 'VP-BOX-1003', siteName: 'Gewerbepark West',
    tenantName: 'Muster Solar GmbH', state: 'blockiert', stand: 'gehalten',
    blocker: 'platte', reason: 'Zu wenig freier Speicherplatz auf der Box.',
    fakten: anfrage({ am: vor(20 * MIN), angenommen: 'zurueckgestellt', grund: 'Zu wenig freier Speicherplatz auf der Box.' }) },
  { ...base, ...aelter, deviceId: 'd4', externalRef: 'VP-BOX-1004', label: 'VP-BOX-1004', siteName: 'Hof Lindenallee',
    tenantName: 'Familie Beispiel', state: 'offline_holt_nach', stand: 'offline', lastSeenAt: vor(4 * 60 * MIN),
    reportedAt: vor(4 * 60 * MIN), reason: 'Die Box meldet sich gerade nicht.',
    fakten: anfrage({ am: vor(20 * MIN), angenommen: 'wartet' }) },
  { ...base, deviceId: 'd5', externalRef: 'VP-BOX-1005', label: 'VP-BOX-1005', siteName: 'Neubau am Feldrain',
    tenantName: 'Familie Beispiel', ist: null, soll: null, sollSeq: null, reportedAt: null, boxArt: null,
    state: 'unbekannt', reason: 'Diese Box hat noch keine Version gemeldet.',
    linie: null, stand: 'unbekannt', lastSeenAt: null, istRelease: null, releasesDahinter: null, istSeit: null, fakten: null },
  // Edge Light, Stufe 1: am Stempel erkannt, Wurzel eingebacken, aber kein Vertrauens-Set,
  // und ein Startprogramm, das nur die Fassung aus dem Flash startet.
  { ...base, deviceId: 'd6', externalRef: 'edge-m4ng0q1', label: 'Mango Hof', siteName: 'Kleingarten Ostend',
    tenantName: 'Familie Beispiel', ist: 'edge-light-g2d2bca1b6', soll: null, sollSeq: null,
    state: 'aktuell', boxArt: 'light', geraetModell: 'GL.iNet GL-MT300N-V2', geraetArch: 'mipsle', loader: 'flash',
    trust: { rootKeyIds: ['root'], trustSetKeyIds: [], trustSetGeneratedAt: null,
      trustSetError: 'Das Vertrauens-Set oder seine Signatur fehlt.' },
    linie: 'light', stand: 'hand', stufe1: true, istRelease: null, releasesDahinter: null, istSeit: null, fakten: null },
  // Geräte & Updates G6: zwei Docker-Boxen auf dem älteren Release, ohne Anfrage - sie bekommen es über den Dialog.
  { ...base, ...aelter, deviceId: 'd7', externalRef: 'edge-bsp0001', label: 'edge-bsp0001', siteName: 'Ahrenberg Werk 1',
    tenantName: 'Ahrenberg GmbH', geraetModell: 'Raspberry Pi 4 Model B Rev 1.4', geraetArch: 'arm64',
    soll: null, sollSeq: null, state: 'aktuell', stand: 'aelter', fakten: null },
  { ...base, ...aelter, deviceId: 'd8', externalRef: 'edge-bsp0002', label: 'edge-bsp0002', siteName: 'Ahrenberg Lager',
    tenantName: 'Ahrenberg GmbH', geraetModell: 'Mini-PC', geraetArch: 'amd64',
    soll: null, sollSeq: null, state: 'aktuell', stand: 'aelter', fakten: null },
];
const data: EdgeUpdates = {
  fleet, rollouts: [], journal: [],
  releases: [
    // Das jüngste Release ist eines für Edge Light (wie am 05.11.2026): es darf
    // das Docker-Release nicht aus dem Blick drängen (Geräte & Updates S0).
    { releaseSeq: 43, version: 'edge-light-2026.09.12', targetCommit: 'c0ffee12', signed: true, boxArt: 'light',
      signingKeyId: 'release', createdAt: now, runningOnDevices: 0, notes: 'Edge Light: Leser für weitere Wechselrichter.' },
    { releaseSeq: 42, version: 'edge-2026.09.10', targetCommit: 'a18b472e', signed: true, boxArt: 'docker',
      signingKeyId: 'release', createdAt: '2026-09-10T12:00:00Z', runningOnDevices: 1, notes: 'Verbesserte Verbindungsstabilität und zuverlässigere Updates.' },
    { releaseSeq: 41, version: 'edge-2026.09.02', targetCommit: '73486bab', signed: true, boxArt: 'docker',
      signingKeyId: 'release', createdAt: '2026-09-02T12:00:00Z', runningOnDevices: 3, notes: null },
  ],
  // Die KPI älterer Portale misst am neuesten Release über BEIDE Linien; die
  // Linien tragen das Urteil je Box-Art (so liefert es die API seit S0/G1).
  kpi: { known: 5, upToDate: 0, unknown: 1, inRollout: 1, failed: 0, newestRelease: 'edge-light-2026.09.12' },
  lines: [
    { boxArt: 'docker', newestRelease: 'edge-2026.09.10', newestReleaseSeq: 42, devices: 6, known: 6, upToDate: 1,
      releases: 2, stand: { hand: 0, fehler: 0, offline: 1, laeuft: 1, gehalten: 1, aktuell: 1, aelter: 2, unbekannt: 0 },
      versions: [
        { version: 'edge-2026.09.10', releaseSeq: 42, devices: ['d1'] },
        { version: 'edge-2026.09.02', releaseSeq: 41, devices: ['d2', 'd3', 'd4', 'd7', 'd8'] },
      ] },
    { boxArt: 'light', newestRelease: 'edge-light-2026.09.12', newestReleaseSeq: 43, devices: 1, known: 1, upToDate: 0,
      releases: 1, stand: { hand: 1, fehler: 0, offline: 0, laeuft: 0, gehalten: 0, aktuell: 0, aelter: 0, unbekannt: 0 },
      versions: [
        { version: 'edge-light-2026.09.12', releaseSeq: 43, devices: [] },
        { version: 'edge-light-g2d2bca1b6', releaseSeq: null, devices: ['d6'] },
      ] },
  ],
};
// Die Release-Seiten (G4): Edge Light mit beiden Programmen fertig im Portal, Docker mit seinen Bildern.
const releaseSeite = (releaseSeq: number) => {
  const rel = data.releases.find((r) => r.releaseSeq === releaseSeq)!;
  const light = rel.boxArt === 'light';
  return {
    releaseSeq, version: rel.version, boxArt: rel.boxArt ?? 'docker', signed: rel.signed, signingKeyId: rel.signingKeyId,
    createdAt: rel.createdAt, targetCommit: rel.targetCommit, notes: rel.notes, erlaubtRueckschritt: false, minFromSeq: null,
    aenderungen: light ? ['Leser für weitere Wechselrichter (#1693)'] : releaseSeq === 42
      ? ['Core: Neuverbindung nach Funkloch (#1601)', 'Updater: Bilder vor dem Stoppen holen (#1588)'] : null,
    inhalt: light
      ? [{ typ: 'binary', name: 'vp-edge-light', arch: 'linux/mipsle', groesse: 14614743, gzGroesse: 4679121 },
        { typ: 'binary', name: 'vp-edge-light', arch: 'linux/arm64', groesse: 13893816, gzGroesse: 4475301 }]
      : [{ typ: 'oci-image', name: 'core', arch: null, groesse: null, gzGroesse: null },
        { typ: 'oci-image', name: 'nodered', arch: null, groesse: null, gzGroesse: null }],
    programme: light ? [
      { arch: 'linux/mipsle', groesse: 4679121, empfangen: 4679121, fertig: true },
      { arch: 'linux/arm64', groesse: 4475301, empfangen: 4475301, fertig: true },
    ] : [],
    laeuftAuf: fleet.filter((r) => r.istRelease === rel.version).map((r) => r.deviceId),
    boxenDerLinie: fleet.filter((r) => r.linie === (light ? 'light' : 'docker')).length,
    verteilt: releaseSeq === 42
      ? [{ rolloutId: 'r42', state: 'active', createdBy: 'alex', createdAt: vor(20 * MIN), total: 3, confirmed: 0, failed: 0 },
        { rolloutId: 'r41', state: 'done', createdBy: 'alex', createdAt: '2026-09-11T08:00:00Z', total: 1, confirmed: 1, failed: 0 }]
      : [],
  };
};
// Der Verlauf je Box (G3), neueste zuerst.
const verlauf = (deviceId: string) => {
  const e = (am: string, quelle: string, art: string, release: string | null, vorher: string | null = null, von: string | null = null) =>
    ({ am, quelle, art, release, vorher, grund: null, von, rolloutId: null });
  const eintraege: Record<string, ReturnType<typeof e>[]> = {
    d1: [e('2026-09-11T08:30:00Z', 'box', 'stand', 'edge-2026.09.10-a18b472eab90', 'edge-2026.09.02-73486bab2980'),
      e('2026-09-11T08:02:00Z', 'box', 'angenommen', 'edge-2026.09.10'),
      e('2026-09-11T08:00:00Z', 'portal', 'angefragt', 'edge-2026.09.10', null, 'alex'),
      e('2026-09-02T14:00:00Z', 'box', 'stand', 'edge-2026.09.02-73486bab2980', null)],
    d2: [e(vor(18 * MIN), 'box', 'angenommen', 'edge-2026.09.10'),
      e(vor(20 * MIN), 'portal', 'angefragt', 'edge-2026.09.10', null, 'alex'),
      e('2026-09-03T09:00:00Z', 'box', 'stand', 'edge-2026.09.02-73486bab2980', null)],
    d6: [e('2026-11-04T10:00:00Z', 'box', 'stand', 'edge-light-g2d2bca1b6', null)],
  };
  return { deviceId, eintraege: eintraege[deviceId] ?? [] };
};
// Die Eignung je Release (G1), wie die API sie aus denselben Boxen bildet.
const eignung = (releaseSeq: number) => {
  const rel = data.releases.find((r) => r.releaseSeq === releaseSeq)!;
  const light = rel.boxArt === 'light';
  const boxen = fleet.filter((r) => (light ? r.linie !== 'docker' : r.linie !== 'light')).map((r) => {
    const seq = (v: string | null | undefined) => data.releases.find((x) => x.version === v)?.releaseSeq ?? null;
    const offline = !r.lastSeenAt || Date.now() - Date.parse(r.lastSeenAt) > 5 * MIN;
    let gruppe = 'bereit';
    let grund: string | null = null;
    if (light && r.linie == null) { gruppe = 'kann_nicht'; grund = GRUND_LIGHT_AUF_UNBEKANNT; }
    else if (light && r.loader === 'flash') { gruppe = 'kann_nicht'; grund = GRUND_LIGHT_STUFE_1_LOADER; }
    else if (r.istRelease === rel.version) gruppe = 'aktuell';
    else if ((seq(r.istRelease) ?? 0) > releaseSeq) {
      gruppe = 'kann_nicht'; grund = `Läuft schon ${r.istRelease} (neuer). Eine ältere Fassung lehnt die Box ab.`;
    } else if (offline) { gruppe = 'wartet'; grund = 'Meldet sich gerade nicht – bekommt die Anfrage, sobald sie sich meldet.'; }
    return { deviceId: r.deviceId, label: r.label, externalRef: r.externalRef, siteName: r.siteName,
      tenantName: r.tenantName, ist: r.ist, gruppe, grund, lastSeenAt: r.lastSeenAt ?? null };
  });
  return { releaseSeq, version: rel.version, boxArt: rel.boxArt ?? 'docker', boxen, andereLinie: fleet.length - boxen.length };
};
const LETZTE_MELDUNG: Record<string, string | null> = {
  d4: new Date(Date.now() - 4 * 3600_000).toISOString(),
  d5: null,
};
Object.assign(keycloak, { tokenParsed: { name: 'Alex Beispiel', email: 'alex@example.test', realm_access: { roles: ['platform-admin'] } } });
Object.assign(adminApi, {
  edgeUpdates: async () => data,
  edgeRelease: async (releaseSeq: number) => releaseSeite(releaseSeq),
  edgeEignung: async (releaseSeq: number) => eignung(releaseSeq),
  boxVerlauf: async (deviceId: string) => verlauf(deviceId),
  // Online-Status der Registrierung: je Box eine eigene letzte Meldung - zwei
  // frisch, eine seit 4 Std. still, eine hat sich noch nie gemeldet.
  listDevices: async () => fleet.map((d) => ({
    ...d, provisioned: true, provisionedAt: now, kind: 'inverter', note: null,
    lastSeenAt: d.deviceId! in LETZTE_MELDUNG
      ? LETZTE_MELDUNG[d.deviceId!]
      : new Date(Date.now() - 40_000).toISOString(),
  })),
  listPendingEnrollments: async () => [{ externalRef: 'edge-xyz234q', deviceInfo: 'Box im Lager', csrUpdatedAt: now, everIssued: false, issuedAt: null }],
  createRollout: async () => { throw new Error('Vorschau: Es werden keine Updates an echte Boxen gesendet.'); },
  setUpdateTarget: async () => { throw new Error('Vorschau: Es werden keine Updates an echte Boxen gesendet.'); },
  revertUpdateTarget: async () => { throw new Error('Vorschau: Keine Änderung an echten Boxen.'); },
  provisionDevice: async () => { throw new Error('Vorschau: Es wird keine Geräte-ID registriert.'); },
  deleteProvisionedDevice: async () => { throw new Error('Vorschau: Es wird keine Geräte-ID gelöscht.'); },
});

function Fixture() {
  const [page, setPage] = useState<PageId>('edge-updates');
  return <AppShell page={page} onNavigate={setPage} isAdmin showOverview={false} showAddAnlage={false}
    counts={{ sites: 8, devices: 8 }} tenants={[]} tenantOverride={null} onTenantChange={() => {}}>
    <GeraeteBereich page={page} onNavigate={(r) => setPage(typeof r === 'string' ? r : r.page)} />
  </AppShell>;
}
ReactDOM.createRoot(document.getElementById('root')!).render(<Fixture />);
