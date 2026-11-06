/**
 * Die GERÄTEAKTE mit fiktiven Daten, reich befüllt auf ALLEN sechs Reitern (Überblick, Software,
 * Verbindung, Anlage, Einrichtung, Verlauf) - der Mobil-Durchgang (`vp-adminview-mobile-rework`)
 * braucht den WORST CASE jedes Reiters, nicht den Leerlauf, um echtes Scroll-Verhalten am Telefon
 * zu sehen. `?reiter=` wählt den Reiter wie bei anderen Admin-Bühnen `?lauf=`/`?szenario=`.
 */
import { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { AppShell } from '../src/shell/AppShell';
import { GeraeteAktePage } from '../src/pages/admin/GeraeteAktePage';
import { adminApi } from '../src/admin/adminApi';
import { fleetApi } from '../src/admin/fleetApi';
import { keycloak } from '../src/auth';
import { type GeraeteAkteReiter } from '../src/nav';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

const now = Date.now();
const iso = (deltaMs: number) => new Date(now + deltaMs).toISOString();
const BOX = 'edge-a1';

Object.assign(keycloak, {
  tokenParsed: { name: 'Alex Beispiel', email: 'alex@example.test', realm_access: { roles: ['platform-admin'] } },
});

const connectedRow = {
  deviceId: 'd1', label: BOX, externalRef: BOX, siteId: 's1', siteName: 'Pilsting',
  tenantId: 't1', tenantName: 'Kunststoffwerk Ahrenberg GmbH', ist: 'edge-2026.09.0', soll: 'edge-2026.09.0', sollSeq: 14,
  state: 'bestaetigt', reason: null, since: null, reportedAt: null, rolloutId: null,
  lastSeenAt: iso(-8_000), boxArt: 'docker', linie: 'docker', stand: 'cloud', stufe1: false, trust: 'ok', loader: 'ok',
};

const fleetSite = {
  siteId: 's1', siteName: 'Pilsting', tenantId: 't1', tenantName: 'Kunststoffwerk Ahrenberg GmbH', plantKind: 'pv_storage',
  netzladenErlaubt: true, tarifArt: 'börse',
  boxes: [{ deviceId: 'd1', externalRef: BOX, name: 'Box Leitstand', fuehrtAnlage: true, lastSeenAt: iso(-8_000), edge: null, update: null }],
  deviceCount: 1, onlineCount: 1, waitingCount: 0, worstStatus: 'online', lastSeenAt: iso(-8_000),
  lastPlanGeneratedAt: iso(-600_000), hasStorage: true, batteryWithoutDevice: false,
  sources: { total: 6, ok: 6, stale: 0, never: 0 }, edge: null, update: null,
  control: { state: 'scharf', since: iso(-9_000_000) }, curtailment: { state: 'aktiv', since: iso(-9_000_000) },
  kwp: { configuredKwp: 420, observedPeakKw: 402, buckets: 1200, verdict: 'ok', reason: 'Plausibel.' },
  forecast: [],
  pflege: [
    { code: 'p1', label: 'Wechselrichter-Firmware veraltet', detail: 'Hersteller empfiehlt ein Update auf 3.4.2 vor der nächsten Saison.' },
    { code: 'p2', label: 'Zweiter Stromzähler ohne Messstelle', detail: 'Ein Register meldet sich, ist aber keiner Messstelle zugeordnet.' },
  ],
};

Object.assign(fleetApi, {
  fleet: async () => ({
    sites: [fleetSite],
    releases: [{ releaseSeq: 14, version: 'edge-2026.09.0' }, { releaseSeq: 12, version: 'edge-2026.08.0' }],
    unterstuetzungBis: {}, unterstuetzungStandorte: [],
  }),
});

Object.assign(adminApi, {
  edgeUpdates: async () => ({
    releases: [
      { releaseSeq: 15, version: 'edge-2026.10.1', targetCommit: null, notes: null, signed: true, signingKeyId: 'k1', createdAt: iso(-86_400_000), runningOnDevices: 4, boxArt: 'docker' },
      { releaseSeq: 14, version: 'edge-2026.09.0', targetCommit: null, notes: null, signed: true, signingKeyId: 'k1', createdAt: iso(-30 * 86_400_000), runningOnDevices: 12, boxArt: 'docker' },
    ],
    rollouts: [], fleet: [connectedRow],
  }),
  listDevices: async () => [{
    externalRef: BOX, deviceId: 'd1', tenantName: 'Kunststoffwerk Ahrenberg GmbH', siteName: 'Pilsting',
    provisioned: true, provisionedAt: iso(-200 * 86_400_000), note: 'Erstinstallation durch Technik-Partner Nordlicht',
  }],
  listPendingEnrollments: async () => [],
  werkstattBoxen: async () => [],
  werkstattDienst: async () => ({ ansicht: null, gemeldetAm: null, dienstZeit: null, alterSekunden: null, aktuell: true, laeufe: [] }),
  werkstattFreigaben: async () => [],
  fernwartungProtokoll: async () => ([
    { id: 'p1', zeit: iso(-2 * 3_600_000), akteur: 'Alex', aktion: 'fenster_geoeffnet', edgeRef: BOX, technikerId: 't1', technikerName: 'Jan Techniker', fensterId: 'f1', details: {} },
    { id: 'p2', zeit: iso(-1.5 * 3_600_000), akteur: 'Alex', aktion: 'fenster_geschlossen', edgeRef: BOX, technikerId: 't1', technikerName: 'Jan Techniker', fensterId: 'f1', details: {} },
    { id: 'p3', zeit: iso(-50 * 60_000), akteur: 'Dienst', aktion: 'box_schluessel_hinterlegt', edgeRef: BOX, technikerId: null, technikerName: null, fensterId: null, details: {} },
  ]),
  boxVerlauf: async () => ({
    deviceId: 'd1',
    eintraege: [
      { am: iso(-30 * 86_400_000), quelle: 'portal', art: 'zugewiesen', release: 'edge-2026.09.0', vorher: 'edge-2026.08.0', grund: null, von: 'Alex', rolloutId: null },
      { am: iso(-29.9 * 86_400_000), quelle: 'box', art: 'angenommen', release: 'edge-2026.09.0', vorher: 'edge-2026.08.0', grund: null, von: null, rolloutId: null },
    ],
  }),
  fernwartungBox: async () => ({
    id: 'fw1', edgeRef: BOX, publicKey: 'erfunden', publicKeyKurz: 'q3Zr…Xk8=', adresse: '10.10.16.9', status: 'aktiv', notiz: null,
    angelegtAm: iso(-200 * 86_400_000), geaendertAm: iso(-50 * 60_000), siteId: 's1', siteName: 'Pilsting', tenantId: 't1',
    tenantName: 'Kunststoffwerk Ahrenberg GmbH', laufendeFenster: [], rueckmeldung: null,
  }),
  fernwartung: async () => ({
    server: {
      endpunkt: 'wartung.example.test', port: 51820, publicKey: 'erfunden', eingerichtet: true,
      boxNetz: '10.10.0.0/16', technikerNetz: '10.20.0.0/16', boxServerAdresse: '10.10.0.1', technikerServerAdresse: '10.20.0.1',
    },
    maxFensterMinuten: 120, abrufe: [{ dienst: 'tunnel-dienst', zuletztAm: iso(-30_000), peers: 4, fenster: 1 }],
    rueckmeldungen: [{ dienst: 'tunnel-dienst', zuletztAm: iso(-30_000), gestartetUm: iso(-7 * 86_400_000), schluesselausgabe: true, boxen: 4, fenster: 1 }],
    boxenAktiv: 4, boxenGesperrt: 0, technikerAktiv: 2, technikerGesperrt: 0, fensterOffen: 1, fensterGeplant: 0, stand: iso(-30_000),
  }),
  fernwartungTechniker: async () => [{ id: 't1', name: 'Jan Techniker' }],
  controlCandidates: async () => [{
    deviceId: 'd1', activated: true, activatedBy: 'Alex', platformCertVerdict: 'bereit', certSource: 'plattform',
  }],
  componentFleet: async () => [{
    siteId: 's1',
    componentAuthority: 'kunde',
    syncStatus: 'abweichend',
    sources: ['modbus', 'hersteller-api'],
    ablehnungsgrund: 'Kunde hat die Übernahme einer neuen Batterie-Kapazität abgelehnt.',
  }],
  geraeteAkte: async () => ({
    externalRef: BOX, lebensabschnitt: 'kunde', lebensabschnittSeit: iso(-200 * 86_400_000),
    kopf: {
      deviceId: 'd1', name: 'Box Leitstand', siteId: 's1', siteName: 'Pilsting', tenantId: 't1',
      tenantName: 'Kunststoffwerk Ahrenberg GmbH', herzschlagAm: iso(-8_000), messwertAm: iso(-8_000),
      lastSeenAt: iso(-8_000), ausgebautAm: null,
    },
    software: {
      edge: { coreVersion: 'edge-2026.09.0', paletteVersion: '0.9.0', reportedAt: iso(-8_000) },
      update: { version: 'edge-2026.09.0', backend: 'compose', currentVersion: 'edge-2026.09.0', targetVersion: null, state: 'idle', reason: null, lastKnownGood: 'edge-2026.08.0', reportedAt: iso(-8_000) },
      supports: ['modbus', 'sunspec'], boxArt: 'docker',
    },
    verbindung: { lanHost: '192.168.10.44', lanSeenAt: iso(-8_000), tunnelAktiv: true, tunnelAdresse: '10.10.16.9' },
    einrichtung: { zertifikatAusgestelltAm: iso(-200 * 86_400_000), zertifikatGueltigBis: iso(165 * 86_400_000), werkstattAngelegtAm: iso(-205 * 86_400_000) },
  }),
  setUpdateTarget: async () => ({}),
  revertUpdateTarget: async () => ({}),
  activateControl: async () => ({}),
  deactivateControl: async () => ({}),
});

function Fixture() {
  const sucheReiter = new URLSearchParams(window.location.search).get('reiter') as GeraeteAkteReiter | null;
  const [reiter, setReiter] = useState<GeraeteAkteReiter | null>(sucheReiter ?? null);
  return (
    <AppShell page="geraete-registry" onNavigate={() => undefined} isAdmin showOverview={false}
      showAddAnlage={false} counts={{ sites: 1, devices: 1 }} tenants={[]} tenantOverride={null}
      onTenantChange={() => undefined}>
      <GeraeteAktePage boxRef={BOX} reiter={reiter}
        onNavigate={(r) => { if ('geraeteAkte' in r && r.geraeteAkte) setReiter(r.geraeteAkte.reiter); }}
        onJumpToTenant={() => undefined} tenants={[]} />
    </AppShell>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Fixture />);
