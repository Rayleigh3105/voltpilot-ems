/**
 * Die GERÄTEAKTE mit fiktiven Daten, reich befüllt auf ALLEN sechs Reitern (Überblick, Software,
 * Verbindung, Anlage, Einrichtung, Verlauf) - der Mobil-Durchgang (`vp-adminview-mobile-rework`)
 * braucht den WORST CASE jedes Reiters, nicht den Leerlauf, um echtes Scroll-Verhalten am Telefon
 * zu sehen. `?reiter=` wählt den Reiter wie bei anderen Admin-Bühnen `?lauf=`/`?szenario=`.
 */
import { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { AppShell } from '../src/shell/AppShell';
import { GeraeteBereich } from '../src/pages/admin/GeraeteRegistryPage';
import { adminApi } from '../src/admin/adminApi';
import { fleetApi } from '../src/admin/fleetApi';
import { keycloak } from '../src/auth';
import { type GeraeteAkteReiter, type PageId } from '../src/nav';
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
const SZENARIO = new URLSearchParams(window.location.search).get('szenario');
/**
 * `?szenario=nie-gemeldet` (L1/L2/N8, Konzept vp-plattform-admin-box-benutzer-konzept): die Box
 * "edge-cyhchfr" ist verbunden, hat sich aber nie gemeldet - Kopf-Karte und Menü zeigen „Vom
 * Kunden lösen …", Fernwartung/Aktualisieren bleiben weg (N8).
 */
/**
 * `?szenario=wartet` (Konzept vp-update-vor-zuordnung S1): eine erfundene Box ohne Kundenkonto,
 * aus der Werkstatt mit 2026.11.5, im Tunnel, fragt nach Schlüsseln. `&fernlauf=` wählt den
 * Zustand der Karte „Durch den Tunnel aufspielen": `knopf` (Vorgabe), `gesperrt`, `laeuft`,
 * `zurueck`, `fertig`. „Aufspielen" im Dialog schaltet die Bühne auf einen erteilten Auftrag.
 */
const WARTET = SZENARIO === 'wartet';
const FERNLAUF = new URLSearchParams(window.location.search).get('fernlauf') ?? 'knopf';
const BOX = SZENARIO === 'nie-gemeldet' ? 'edge-cyhchfr' : WARTET ? 'edge-k7m2xq3' : 'edge-a1';

Object.assign(keycloak, {
  tokenParsed: { name: 'Alex Beispiel', email: 'alex@example.test', realm_access: { roles: ['platform-admin'] } },
});

const NIE_GEMELDET = SZENARIO === 'nie-gemeldet';

const connectedRow = {
  deviceId: 'd1', label: BOX, externalRef: BOX, siteId: 's1', siteName: 'Pilsting',
  tenantId: 't1', tenantName: 'Kunststoffwerk Ahrenberg GmbH', ist: 'edge-2026.09.0', soll: 'edge-2026.09.0', sollSeq: 14,
  state: 'bestaetigt', reason: null, since: null, reportedAt: NIE_GEMELDET ? null : iso(-8_000), rolloutId: null,
  lastSeenAt: NIE_GEMELDET ? null : iso(-8_000), boxArt: 'docker', linie: 'docker', stand: 'cloud', stufe1: false,
  trust: 'ok', loader: 'ok',
};

const fleetSite = {
  siteId: 's1', siteName: 'Pilsting', tenantId: 't1', tenantName: 'Kunststoffwerk Ahrenberg GmbH', plantKind: 'pv_storage',
  netzladenErlaubt: true, tarifArt: 'börse',
  boxes: [{
    deviceId: 'd1', externalRef: BOX, name: NIE_GEMELDET ? null : 'Box Leitstand', fuehrtAnlage: true,
    lastSeenAt: NIE_GEMELDET ? null : iso(-8_000),
    herzschlagAm: NIE_GEMELDET ? null : iso(-8_000), messwertAm: NIE_GEMELDET ? null : iso(-8_000),
    edge: null, update: null,
  }],
  deviceCount: 1, onlineCount: NIE_GEMELDET ? 0 : 1, waitingCount: NIE_GEMELDET ? 1 : 0,
  worstStatus: NIE_GEMELDET ? 'waiting' : 'online', lastSeenAt: NIE_GEMELDET ? null : iso(-8_000),
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

const fernlaufSchritte = (bis: number) => [
  { schritt: 'anmelden', zustand: 'belegt', zeit: iso(-170_000), zeile: 'Angemeldet als Techniker-Zugang SHA256:WerkstattDienstErfunden; Host-Schlüssel wie in der Werkstatt' },
  { schritt: 'bestand', zustand: 'belegt', zeit: iso(-165_000), zeile: 'Läuft edge-light-2026.11.5, Stand 205, kein Zertifikat, Flash frei 6200 kB' },
  { schritt: 'fassungen', zustand: 'belegt', zeit: iso(-150_000), zeile: 'edge-light-2026.11.15 Stand 215, signiert von rel-2026-a, Kette gegen die eingebackene Wurzel geprüft; Programm und Skriptstand nach sha256' },
  { schritt: 'sichern', zustand: 'belegt', zeit: iso(-120_000), zeile: 'Gesichert: 12 Pfade, 4918211 Bytes, sha256 4be1c0d27a9e1f02… (ohne Identität)' },
  { schritt: 'aufspielen', zustand: 'belegt', zeit: iso(-60_000), zeile: 'install.sh: Prüfsumme auf der Box bestätigt; Land DE, Paket relayd' },
].slice(0, bis);
let fernlaufErteilt = false;
function fernlaufStand() {
  const basis = {
    edgeRef: BOX, laeuft: 'edge-light-2026.11.5', laeuftGemeldetAm: iso(-3 * 3_600_000), fragtZuletztAm: iso(-25_000),
    neueste: 'edge-light-2026.11.15', werkstattFassung: 'edge-light-2026.11.5', werkstattAm: iso(-9 * 86_400_000),
    moeglich: true, gruende: [] as { code: string; text: string }[],
    haken: { tunnelVerbunden: true, fragtNachSchluesseln: true, keinKundenkonto: true }, verlauf: [] as unknown[], stand: iso(0),
  };
  const auftrag = {
    id: 'f1', art: 'aufspielen', fassungVorher: 'edge-light-2026.11.5', fassungZiel: 'edge-light-2026.11.15',
    akteurName: 'Alex Beispiel', erteiltAm: iso(-180_000), begonnenAm: iso(-175_000), fensterEnde: iso(27 * 60_000),
  };
  if (fernlaufErteilt) {
    return { ...basis, moeglich: false, gruende: [{ code: 'laeuft_schon', text: 'Für diese Box läuft schon ein Fernlauf.' }],
      verlauf: [{ ...auftrag, erteiltAm: iso(-2_000), begonnenAm: null, zustand: 'erteilt', schritt: null, schrittSeit: null, schritte: [], ergebnis: null }] };
  }
  switch (FERNLAUF) {
    case 'gesperrt':
      return { ...basis, moeglich: false, haken: { tunnelVerbunden: false, fragtNachSchluesseln: false, keinKundenkonto: true },
        gruende: [{ code: 'nicht_verbunden', text: 'Die Box ist gerade nicht im Tunnel (kein Handshake in den letzten 3 Minuten).' }] };
    case 'laeuft':
      return { ...basis, moeglich: false, gruende: [{ code: 'laeuft_schon', text: 'Für diese Box läuft schon ein Fernlauf.' }],
        verlauf: [{ ...auftrag, zustand: 'laeuft', schritt: 'neustart', schrittSeit: iso(-20_000), schritte: fernlaufSchritte(5), ergebnis: null }] };
    case 'zurueck':
      return { ...basis, verlauf: [{ ...auftrag, zustand: 'zurueck', schritt: 'fenster_zu', schrittSeit: iso(-30_000),
        schritte: [...fernlaufSchritte(5),
          { schritt: 'neustart', zustand: 'gescheitert', zeit: iso(-50_000), zeile: 'nach dem Neustart: /health nennt "edge-light-2026.11.14" statt edge-light-2026.11.15' },
          { schritt: 'zurueck', zustand: 'belegt', zeit: iso(-35_000), zeile: 'Zurück auf edge-light-2026.11.5: /health nennt sie, die Plattform hört sie wieder' },
          { schritt: 'fenster_zu', zustand: 'belegt', zeit: iso(-30_000), zeile: 'Fenster geschlossen' }],
        ergebnis: { ergebnis: 'zurueck', grund: 'nach dem Neustart: /health nennt "edge-light-2026.11.14" statt edge-light-2026.11.15', schritt: 'neustart',
          fassungNachher: 'edge-light-2026.11.5', belege: {}, quelle: 'dienst', erfasstAm: iso(-30_000) } }] };
    case 'fertig':
      return { ...basis, laeuft: 'edge-light-2026.11.15', laeuftGemeldetAm: iso(-60_000), moeglich: false,
        gruende: [{ code: 'schon_neueste', text: 'Die Box läuft schon edge-light-2026.11.15; neuer ist nichts.' }],
        verlauf: [{ ...auftrag, zustand: 'fertig', schritt: 'fenster_zu', schrittSeit: iso(-10_000),
          schritte: [...fernlaufSchritte(5),
            { schritt: 'neustart', zustand: 'belegt', zeit: iso(-50_000), zeile: '/health: edge-light-2026.11.15, Referenz edge-k7m2xq3, update-bereit (Stand 215)' },
            { schritt: 'meldet_sich', zustand: 'belegt', zeit: iso(-20_000), zeile: 'Meldet sich mit edge-light-2026.11.15 (Zertifikatsanfrage, danach weiter gefragt)' },
            { schritt: 'tunnel', zustand: 'belegt', zeit: iso(-15_000), zeile: 'Tunnel wie vorher: latest handshake: 7 seconds ago' },
            { schritt: 'fenster_zu', zustand: 'belegt', zeit: iso(-10_000), zeile: 'Fenster geschlossen' }],
          ergebnis: { ergebnis: 'fertig', grund: null, schritt: 'tunnel', fassungNachher: 'edge-light-2026.11.15', belege: {}, quelle: 'dienst', erfasstAm: iso(-10_000) } }] };
    default:
      return basis;
  }
}

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
    rollouts: [], fleet: WARTET ? [] : [connectedRow],
  }),
  listDevices: async () => (WARTET ? [] : [{
    externalRef: BOX, deviceId: 'd1', tenantName: 'Kunststoffwerk Ahrenberg GmbH', siteName: 'Pilsting',
    provisioned: true, provisionedAt: iso(-200 * 86_400_000), note: 'Erstinstallation durch Technik-Partner Nordlicht',
  }]),
  listPendingEnrollments: async () => (WARTET ? [{
    externalRef: BOX, deviceInfo: 'vp-edge-core edge-light-2026.11.5', csrUpdatedAt: iso(-3 * 3_600_000), everIssued: false,
    issuedAt: null, werkstattAbnahmeAm: iso(-9 * 86_400_000), zuletztAbgefragtAm: iso(-25_000),
  }] : []),
  werkstattBoxen: async () => (WARTET ? [{
    id: 'w1', edgeRef: BOX, boxArt: 'edge-light', lanNetz: '10.213.0.1/24', schritte: {}, notiz: null,
    angelegtAm: iso(-9 * 86_400_000), angelegtVon: 'Werkstatt-Dienst', geaendertAm: iso(-9 * 86_400_000),
    abnahmen: [{ id: 'a1', fassung: 'edge-light-2026.11.5', erfasstAm: iso(-9 * 86_400_000) }],
  }] : []),
  geraeteFernlauf: async () => {
    if (!WARTET) throw new Error('keine Box ohne Kundenkonto');
    return fernlaufStand();
  },
  geraeteFernlaufAufspielen: async () => {
    fernlaufErteilt = true;
    return fernlaufStand().verlauf[0];
  },
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
  geraeteAkte: async () => (WARTET ? {
    externalRef: BOX, lebensabschnitt: 'meldet_sich', lebensabschnittSeit: iso(-9 * 86_400_000),
    kopf: null, software: null,
    verbindung: { lanHost: null, lanSeenAt: null, tunnelAktiv: true, tunnelAdresse: '10.10.16.5' },
    einrichtung: { zertifikatAusgestelltAm: null, zertifikatGueltigBis: null, werkstattAngelegtAm: iso(-9 * 86_400_000) },
  } : NIE_GEMELDET ? {
    externalRef: BOX, lebensabschnitt: 'kunde', lebensabschnittSeit: iso(-6 * 86_400_000),
    kopf: {
      deviceId: 'd1', name: null, siteId: 's1', siteName: 'Pilsting', tenantId: 't1',
      tenantName: 'Kunststoffwerk Ahrenberg GmbH', herzschlagAm: null, messwertAm: null,
      lastSeenAt: null, ausgebautAm: null,
    },
    software: { edge: null, update: null, supports: null, boxArt: null },
    verbindung: { lanHost: null, lanSeenAt: null, tunnelAktiv: null, tunnelAdresse: null },
    einrichtung: { zertifikatAusgestelltAm: iso(-6 * 86_400_000), zertifikatGueltigBis: iso(359 * 86_400_000), werkstattAngelegtAm: iso(-20 * 86_400_000) },
  } : {
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
  // L1 (B1-B4): der Befund „Vom Kunden lösen" - lösbar, kein Schlüssel abgeholt.
  geraeteLoesenBefund: async () => ({
    loesbar: true,
    gruende: [],
    fakten: {
      verbundenAm: iso(-6 * 86_400_000), herzschlagAm: null, messwertAm: null, meldungAm: null,
      anmeldung: { zuletztAngefragtAm: null, schluesselAbgeholtAm: null },
    },
  }),
  geraeteLoesen: async () => ({ externalRef: BOX, anlass: 'falsche_kennung' }),
});

function Fixture() {
  const sucheReiter = new URLSearchParams(window.location.search).get('reiter') as GeraeteAkteReiter | null;
  const [reiter, setReiter] = useState<GeraeteAkteReiter | null>(sucheReiter ?? null);
  const [page, setPage] = useState<PageId>('geraete-registry');
  return (
    <AppShell page={page} onNavigate={() => undefined} isAdmin showOverview={false}
      showAddAnlage={false} counts={{ sites: 1, devices: 1 }} tenants={[]} tenantOverride={null}
      onTenantChange={() => undefined}>
      <GeraeteBereich page={page} geraeteAkte={{ ref: BOX, reiter }}
        onNavigate={(r) => {
          if (typeof r === 'string') { setPage(r); return; }
          setPage(r.page);
          if ('geraeteAkte' in r && r.geraeteAkte) setReiter(r.geraeteAkte.reiter);
        }}
        onJumpToTenant={() => undefined} tenants={[]} />
    </AppShell>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Fixture />);
