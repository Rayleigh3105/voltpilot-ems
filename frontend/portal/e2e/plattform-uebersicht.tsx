import './rollen-fixture';
/** Real admin components with fictional data; all API calls stay in memory. */
import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { AppShell } from '../src/shell/AppShell';
import { PlattformBereich } from '../src/pages/admin/PlattformBereich';
import { GeraeteRegistryPage } from '../src/pages/admin/GeraeteRegistryPage';
import { adminApi, type AdminGeraeteAkte } from '../src/admin/adminApi';
import { fleetApi, type AdminFleetSite } from '../src/admin/fleetApi';
import { keycloak } from '../src/auth';
import type { EdgeUpdates, FleetRow } from '../src/adminEdgeUpdates';
import { type GeraeteAkteReiter, type PageId, type Route } from '../src/nav';
import type { WerkstattBox } from '../src/werkstatt';
import type { WerkstattDienst, WerkstattFreigabe } from '../src/werkstattBank';
import type { FernwartungBox, FernwartungUebersicht } from '../src/adminFernwartung';
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
const STD = 60 * MIN;

// ── Die erfundene Flotte (Konzept-Board §4.3/10, dieselben Boxen) ──────────

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
  linie: 'docker', stand: 'aktuell', stufe1: false, lastSeenAt: vor(6_000),
  istRelease: 'edge-2026.09.10', releasesDahinter: 0, istSeit: vor(2 * STD), fakten: anfrage({
    am: vor(2 * STD), angenommen: 'ja', angenommenAm: vor(2 * STD), bestaetigt: 'ja', bestaetigtAm: vor(2 * STD),
  }),
};
const aelter = { ist: 'edge-2026.09.02-73486bab2980', istRelease: 'edge-2026.09.02', releasesDahinter: 1, istSeit: null };

const fleet: FleetRow[] = [
  { ...base },
  // Fehler: zurückgenommenes Update.
  { ...base, ...aelter, deviceId: 'd2', externalRef: 'VP-BOX-1002', label: 'Pumpwerk Ost', siteName: 'Pumpwerk Ost',
    tenantName: 'Stadtwerke Musterstadt', state: 'blockiert', stand: 'fehler',
    fakten: anfrage({ am: vor(STD), angenommen: 'ja', angenommenAm: vor(STD), bestaetigt: 'zurueckgenommen', bestaetigtAm: vor(30 * MIN), grund: 'Selbsttest nicht grün' }) },
  // Zurückhalten: hält das Update zurück (zu wenig Speicher).
  { ...base, ...aelter, deviceId: 'd3', externalRef: 'VP-BOX-1003', label: 'Gewerbepark West', siteName: 'Gewerbepark West',
    tenantName: 'Muster Solar GmbH', state: 'blockiert', stand: 'gehalten', blocker: 'platte',
    reason: 'Zu wenig freier Speicherplatz auf der Box.',
    fakten: anfrage({ am: vor(20 * MIN), angenommen: 'zurueckgestellt', grund: 'Zu wenig freier Speicherplatz auf der Box.' }) },
  // Offline mit wartender Anfrage.
  { ...base, ...aelter, deviceId: 'd4', externalRef: 'VP-BOX-1004', label: 'Hof Lindenallee', siteName: 'Hof Lindenallee',
    tenantName: 'Familie Beispiel', state: 'offline_holt_nach', stand: 'offline', lastSeenAt: vor(4 * STD), reportedAt: vor(4 * STD),
    fakten: anfrage({ am: vor(20 * MIN), angenommen: 'wartet' }) },
  // Stufe 1 (Edge Light, nur von Hand).
  { ...base, deviceId: 'd5', externalRef: 'edge-m4ng0q1', label: 'Kleingarten Ostend', siteName: 'Kleingarten Ostend',
    tenantName: 'Familie Beispiel', ist: 'edge-light-g2d2bca1b6', soll: null, sollSeq: null, state: 'aktuell',
    boxArt: 'light', linie: 'light', stand: 'hand', stufe1: true, istRelease: null, releasesDahinter: null, istSeit: null, fakten: null },
  // Update läuft - ruhig, nur im Flottenbild als „läuft" zu sehen.
  { ...base, ...aelter, deviceId: 'd6', externalRef: 'edge-abcdefj', label: 'Werkstatt am Bach', siteName: 'Werkstatt am Bach',
    tenantName: 'Stadtwerke Musterstadt', state: 'laedt', reason: 'Das Update wird heruntergeladen.', stand: 'laeuft',
    fakten: anfrage({ am: vor(20 * MIN), angenommen: 'ja', angenommenAm: vor(18 * MIN), bestaetigt: 'laeuft', schritt: 'laedt' }) },
  // Zwei ruhige Boxen (für die Flotte und das Steuerungs-/Plan-Bild).
  { ...base, deviceId: 'd7', externalRef: 'VP-BOX-AH-01', label: 'Box Leitstand', siteName: 'Werk Ahrenberg',
    tenantName: 'Kunststoffwerk Ahrenberg', lastSeenAt: vor(8_000) },
  { ...base, deviceId: 'd8', externalRef: 'VP-BOX-AH-02', label: 'Box Halle 2', siteName: 'Werk Ahrenberg',
    tenantName: 'Kunststoffwerk Ahrenberg', lastSeenAt: vor(9_000) },
  // E6 (S7): drei ausgebliebene Herzschläge - „Verzögert", reine Anzeige, zählt nicht als Ausnahme.
  { ...base, deviceId: 'd9', externalRef: 'VP-BOX-AH-03', label: 'Box Halle 3', siteName: 'Werk Ahrenberg',
    tenantName: 'Kunststoffwerk Ahrenberg', lastSeenAt: vor(2 * MIN) },
];

const data: EdgeUpdates = {
  fleet, rollouts: [], journal: [],
  releases: [
    { releaseSeq: 43, version: 'edge-light-2026.09.12', targetCommit: 'c0ffee12', signed: true, boxArt: 'light',
      signingKeyId: 'release', createdAt: now, runningOnDevices: 0, notes: null },
    { releaseSeq: 42, version: 'edge-2026.09.10', targetCommit: 'a18b472e', signed: true, boxArt: 'docker',
      signingKeyId: 'release', createdAt: vor(2 * STD), runningOnDevices: 3, notes: null },
    { releaseSeq: 41, version: 'edge-2026.09.02', targetCommit: '73486bab', signed: true, boxArt: 'docker',
      signingKeyId: 'release', createdAt: vor(10 * STD), runningOnDevices: 3, notes: null },
  ],
  kpi: { known: 7, upToDate: 2, unknown: 0, inRollout: 1, failed: 1, newestRelease: 'edge-light-2026.09.12' },
  lines: [
    { boxArt: 'docker', newestRelease: 'edge-2026.09.10', newestReleaseSeq: 42, devices: 7, known: 7, upToDate: 2 },
    { boxArt: 'light', newestRelease: 'edge-light-2026.09.12', newestReleaseSeq: 43, devices: 1, known: 1, upToDate: 0 },
  ],
};

// ── `/admin/fleet` (dieselben Boxen, je eine Anlage) ───────────────────────

const box = (r: FleetRow) => ({
  deviceId: r.deviceId, externalRef: r.externalRef, name: r.label, fuehrtAnlage: true,
  lastSeenAt: r.lastSeenAt ?? null, edge: null,
  update: r.ist ? { version: r.ist, backend: 'compose', current: r.ist, target: null, state: 'idle', reason: null, lastKnownGood: null, reportedAt: now } : null,
});

const sites: AdminFleetSite[] = fleet.map((r, i) => ({
  siteId: `s${i + 1}`, siteName: r.siteName, tenantId: r.tenantId, tenantName: r.tenantName,
  plantKind: 'eigenverbrauch', netzladenErlaubt: false, tarifArt: 'fest',
  deviceCount: 1, onlineCount: r.lastSeenAt && Date.now() - Date.parse(r.lastSeenAt) < 5 * MIN ? 1 : 0,
  waitingCount: 0, worstStatus: 'online',
  lastSeenAt: r.lastSeenAt, lastPlanGeneratedAt: i === 2 ? vor(3 * STD) : vor(6 * MIN),
  hasStorage: i === 0, batteryWithoutDevice: false, sources: null, edge: null, update: null,
  control: i === 0
    ? {
      deviceId: r.deviceId, commandedKw: 3.2, confirmedKw: 1.1, allMatch: false, controlEnabled: true,
      certified: true, mismatchRoles: 'Batterie', slotStart: null, checkedAt: vor(2 * MIN),
    }
    : null,
  curtailment: null,
  kwp: { configuredKwp: null, observedPeakKw: null, buckets: 0, verdict: 'unbekannt', reason: 'Noch keine Messung.' },
  forecast: [],
  pflege: i === 6 ? [{ code: 'kwp-unplausibel', label: 'Einspeisegrenze prüfen', detail: 'Gemessene PV-Spitze über der installierten Leistung.' }] : [],
  boxes: [box(r)],
}));

// ── Fernwartung: eine Box mit offenem Fenster, aber ohne abgeholten Schlüssel ──

const fernwartungUebersicht: FernwartungUebersicht = {
  server: { endpunkt: 'wartung.voltpilot.example', port: 51820, publicKey: 'srv-pub-key', eingerichtet: true,
    boxNetz: '10.90.4.0/24', technikerNetz: '10.90.9.0/24', boxServerAdresse: '10.90.4.1', technikerServerAdresse: '10.90.9.1' },
  maxFensterMinuten: 60, abrufe: [{ dienst: 'tunnel-dienst', zuletztAm: vor(18_000), peers: 2, fenster: 1 }],
  rueckmeldungen: [{ dienst: 'tunnel-dienst', zuletztAm: vor(18_000), gestartetUm: vor(5 * STD), schluesselausgabe: true, boxen: 2, fenster: 1 }],
  boxenAktiv: 2, boxenGesperrt: 0, technikerAktiv: 1, technikerGesperrt: 0, fensterOffen: 1, fensterGeplant: 0, stand: vor(18_000),
};
const fernwartungBoxenListe: FernwartungBox[] = [
  { id: 'fw1', edgeRef: 'VP-BOX-1001', publicKey: 'k', publicKeyKurz: 'k', adresse: '10.90.4.12', status: 'aktiv',
    notiz: null, angelegtAm: vor(90 * 24 * STD), geaendertAm: vor(10 * MIN),
    siteId: 's1', siteName: 'Solarpark Sonnenhof', tenantId: 't1', tenantName: 'Stadtwerke Musterstadt',
    laufendeFenster: [{
      id: 'fen1', edgeRef: 'VP-BOX-1001', technikerId: 'tech1', technikerName: 'Max', grund: 'Service',
      beginn: vor(30 * MIN), ende: vor(-30 * MIN), wirksamesEnde: vor(-30 * MIN), zustand: 'offen',
      geoeffnetAm: vor(30 * MIN), geoeffnetVon: 'alex', geschlossenAm: null, geschlossenVon: null,
      rueckmeldung: { gemeldetAm: vor(18_000), schluesselAbgeholtUm: null },
    }] },
];
const fernwartungBoxenNachRef: Record<string, FernwartungBox> = Object.fromEntries(fernwartungBoxenListe.map((b) => [b.edgeRef, b]));

// ── Werkstatt: ein angehaltener Lauf, eine Box in Einrichtung ──────────────

const werkstattBoxen: WerkstattBox[] = [
  { id: 'w1', edgeRef: 'edge-m1', boxArt: 'edge-light', lanNetz: null, schritte: {}, notiz: null,
    angelegtAm: vor(2 * STD), angelegtVon: 'werkstatt', geaendertAm: vor(5 * MIN), abnahmen: [] },
];
const werkstattDienst: WerkstattDienst = {
  ansicht: null, gemeldetAm: vor(7_000), dienstZeit: vor(7_000), alterSekunden: 7, aktuell: true,
  laeufe: [{
    kennung: 'L1', freigabe: 'FR1', boxArt: 'edge-light', zustand: 'angehalten', schritt: 'tunnel', titel: null,
    grund: 'Kabel nicht am Werkstatt-Anschluss', beginn: vor(20 * MIN), ende: null, aktualisiertAm: vor(5 * MIN),
    stand: { kennung: 'L1', freigabe: 'FR1', box_art: 'edge-light', box: 'edge-m1', beginn: vor(20 * MIN), zustand: 'angehalten', erledigt: [] },
  }],
};

// ── Eine wartende Anmeldung ohne Kunde, vermutlich ein Tippfehler ─────────

const pending = [{ externalRef: 'edge-q7xk2p9', deviceInfo: 'Box im Lager', csrUpdatedAt: vor(2 * 24 * STD), everIssued: false, issuedAt: null }];

// L3/L2 (S6/S7): die Akte-in-einer-Antwort, herzschlagAm und messwertAm getrennt.
const geraeteAkteVon = (ref: string): AdminGeraeteAkte => {
  const r = fleet.find((f) => f.externalRef === ref);
  if (!r) return { externalRef: ref, lebensabschnitt: 'gedruckt', lebensabschnittSeit: null, kopf: null, software: null, verbindung: null, einrichtung: null };
  const herzschlagAm = r.lastSeenAt ?? null;
  return {
    externalRef: ref, lebensabschnitt: 'kunde', lebensabschnittSeit: null,
    kopf: {
      deviceId: r.deviceId, name: r.label, siteId: r.siteId, siteName: r.siteName,
      tenantId: r.tenantId, tenantName: r.tenantName, herzschlagAm, messwertAm: herzschlagAm,
      lastSeenAt: r.lastSeenAt ?? null, ausgebautAm: null,
    },
    software: null, verbindung: null, einrichtung: null,
  };
};
Object.assign(keycloak, { tokenParsed: { name: 'Alex Beispiel', email: 'alex@example.test', realm_access: { roles: ['platform-admin'] } } });
Object.assign(fleetApi, { fleet: async () => ({ sites, releases: data.releases, unterstuetzungBis: {} }) });
Object.assign(adminApi, {
  edgeUpdates: async () => data,
  geraeteAkte: async (ref: string) => geraeteAkteVon(ref),
  fernwartung: async () => fernwartungUebersicht,
  fernwartungBoxen: async () => fernwartungBoxenListe,
  fernwartungBox: async (ref: string) => fernwartungBoxenNachRef[ref],
  werkstattBoxen: async () => werkstattBoxen,
  werkstattDienst: async () => werkstattDienst,
  werkstattFreigaben: async () => [] as WerkstattFreigabe[],
  listPendingEnrollments: async () => pending,
  listDevices: async () => fleet.map((r) => ({
    ...r, provisioned: true, provisionedAt: now, kind: 'inverter', note: null,
  })),
  fernwartungProtokoll: async () => [],
  fernwartungTechniker: async () => [],
  // L1 (S6): Optimierer, Preise, Messwerte - additiv neben Tunnel/Werkstatt.
  plattformDienste: async () => ({
    dienste: [
      { name: 'optimierer', zuletztAm: vor(4 * MIN) },
      { name: 'preise', zuletztAm: vor(40 * MIN) },
      { name: 'messwerte', zuletztAm: vor(8_000) },
    ],
  }),
});

function Fixture() {
  const [page, setPage] = useState<PageId>('plattform-uebersicht');
  const [geraeteAkte, setGeraeteAkte] = useState<{ ref: string; reiter: GeraeteAkteReiter | null } | null>(null);

  function navigate(target: Route | PageId) {
    if (typeof target === 'string') { setPage(target); setGeraeteAkte(null); return; }
    setPage(target.page);
    setGeraeteAkte(target.geraeteAkte ?? null);
  }

  return <AppShell page={page} onNavigate={(p) => navigate(p)} isAdmin showOverview={false} showAddAnlage={false}
    counts={{ sites: sites.length, devices: fleet.length }} tenants={[]} tenantOverride={null} onTenantChange={() => {}}>
    {page === 'geraete-registry'
      ? <GeraeteRegistryPage geraeteAkte={geraeteAkte} onNavigate={navigate} />
      : <PlattformBereich page={page} onNavigate={navigate} />}
  </AppShell>;
}
ReactDOM.createRoot(document.getElementById('root')!).render(<Fixture />);
