/**
 * Software (Raum „Geräte", vormals „Geräte & Updates") mit fiktiven Daten:
 * zwei Linien mit eigener Karte (Edge Industrie und Edge Light - die Docker-Box
 * bekommt seit Captain 23.11.2026 keine Karte mehr), eine Box, die Aufmerksamkeit
 * braucht, und ein gefülltes Verlauf-Journal - der Mobil-Durchgang
 * (`vp-adminview-mobile-rework`) braucht den WORST CASE, nicht den Leerlauf.
 */
import ReactDOM from 'react-dom/client';
import { AppShell } from '../src/shell/AppShell';
import { GeraeteBereich } from '../src/pages/admin/GeraeteRegistryPage';
import { adminApi } from '../src/admin/adminApi';
import { keycloak } from '../src/auth';
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

Object.assign(keycloak, {
  tokenParsed: { name: 'Alex Beispiel', email: 'alex@example.test', realm_access: { roles: ['platform-admin'] } },
});

/** Der Beginn der nächsten Nacht: 02:00 Berliner Zeit (Sommer- oder Winterzeit) am nächsten Tag. */
function naechsteNacht(): string {
  const t = new Date(now + 86_400_000);
  for (const h of [0, 1]) {
    const k = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), h));
    if (k.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }) === '02:00') {
      return k.toISOString();
    }
  }
  return iso(86_400_000);
}

/** S4: der Schalter „Nachts von selbst", ab Werk an; „Anhalten"/„Einschalten" schaltet die Bühne um. */
let nachtlaufAn = true;
const nachtlaufSchalter = () => ({
  an: nachtlaufAn, geaendertVon: nachtlaufAn ? null : 'Alex Beispiel', geaendertAm: nachtlaufAn ? null : iso(0),
  beginn: naechsteNacht(), ende: new Date(new Date(naechsteNacht()).getTime() + 3 * 3_600_000).toISOString(),
  naechsterLauf: naechsteNacht(), imFenster: false, angelegt: 0, grenze: 20, stand: iso(0),
});
const AUS = 'Nachts von selbst ist angehalten; es bleibt der Knopf.';
/** `?pfc200=1`: in der Liste „Ohne Kundenkonto" steht dazu ein WAGO PFC200 (Edge Industrie) mit seiner Linie. */
const MIT_PFC200 = new URLSearchParams(window.location.search).get('pfc200') === '1';
const PFC200_ZEILE = {
  edgeRef: 'edge-zz9988g', laeuft: 'edge-industrie-2026.11.5', laeuftGemeldetAm: iso(-200_000),
  fragtZuletztAm: iso(-12_000), neueste: 'edge-industrie-2026.11.20', werkstattFassung: 'edge-industrie-2026.11.5',
  werkstattAm: iso(-2 * 86_400_000), moeglich: true, gruende: [],
  haken: { tunnelVerbunden: true, fragtNachSchluesseln: true, keinKundenkonto: true }, verlauf: [],
  nachtlauf: { dran: true, grund: null }, stand: iso(0),
};

/** Wofür die Spec `ohne-kundenkonto.spec.ts` liest, ob und mit welchen Werten „Aufspielen" die API rief. */
const fernlaufAufspielenAufrufe: { ref: string; fassung: string }[] = [];
(window as unknown as { __fernlaufAufspielenAufrufe: typeof fernlaufAufspielenAufrufe })
  .__fernlaufAufspielenAufrufe = fernlaufAufspielenAufrufe;

Object.assign(adminApi, {
  // Erstverbindung: der Schalter der Automatik, ab Werk an.
  erstverbindungSchalter: async () => ({ alle: true, docker: true, light: true, eintraege: [] }),
  edgeUpdates: async () => ({
    releases: [
      { releaseSeq: 15, version: 'edge-industrie-2026.10.1', targetCommit: '3bf8c038', notes: null, signed: true, signingKeyId: 'rel-a', createdAt: iso(-7 * 86_400_000), runningOnDevices: 2, boxArt: 'industrie' },
      { releaseSeq: 14, version: 'edge-industrie-2026.09.0', targetCommit: '665d59b8', notes: null, signed: true, signingKeyId: 'rel-a', createdAt: iso(-37 * 86_400_000), runningOnDevices: 3, boxArt: 'industrie' },
      { releaseSeq: 9, version: 'edge-light-2026.11.1', targetCommit: null, notes: null, signed: true, signingKeyId: 'rel-a', createdAt: iso(-3 * 86_400_000), runningOnDevices: 1, boxArt: 'light' },
    ],
    rollouts: [{
      id: 'r1', releaseVersion: 'edge-industrie-2026.10.1', releaseSeq: 15, state: 'active', createdBy: 'admin', createdAt: iso(-3_600_000),
      total: 2, confirmed: 1, failed: 1,
      devices: [
        { deviceId: 'd1', label: 'edge-a1', siteName: 'Pilsting', tenantName: 'Kunststoffwerk Ahrenberg GmbH', state: 'bestaetigt', reason: null, since: iso(-1_800_000) },
        { deviceId: 'd2', label: 'edge-b2', siteName: 'Auernheim', tenantName: 'Beispiel GmbH', state: 'fehlgeschlagen', reason: 'Image-Download fehlgeschlagen (Platz).', since: iso(-900_000) },
      ],
    }],
    fleet: [
      {
        deviceId: 'd1', label: 'edge-a1', externalRef: 'edge-a1', siteId: 's1', siteName: 'Pilsting', tenantId: 't1',
        tenantName: 'Kunststoffwerk Ahrenberg GmbH', ist: 'edge-industrie-2026.10.1', soll: 'edge-industrie-2026.10.1', sollSeq: 15,
        state: 'bestaetigt', reason: null, since: iso(-1_800_000), reportedAt: iso(-30_000), rolloutId: 'r1',
        boxArt: 'industrie', linie: 'industrie', lastSeenAt: iso(-30_000), stufe1: false, stand: 'aktuell',
        istRelease: 'edge-industrie-2026.10.1', releasesDahinter: 0,
      },
      {
        deviceId: 'd2', label: 'edge-b2', externalRef: 'edge-b2', siteId: 's2', siteName: 'Auernheim', tenantId: 't2',
        tenantName: 'Beispiel GmbH', ist: 'edge-industrie-2026.09.0', soll: 'edge-industrie-2026.10.1', sollSeq: 15,
        state: 'fehlgeschlagen', reason: 'Image-Download fehlgeschlagen (Platz).', since: iso(-900_000), reportedAt: iso(-60_000), rolloutId: 'r1',
        boxArt: 'industrie', linie: 'industrie', lastSeenAt: iso(-60_000), stufe1: false, stand: 'aelter',
        istRelease: 'edge-industrie-2026.09.0', releasesDahinter: 1,
      },
      {
        deviceId: 'd3', label: 'edge-tgjn9gd', externalRef: 'edge-tgjn9gd', siteId: 's3', siteName: 'Zuhause', tenantId: 't3',
        tenantName: 'Mustermann', ist: 'edge-light-2026.11.1', soll: 'edge-light-2026.11.1', sollSeq: 9,
        state: 'bestaetigt', reason: null, since: iso(-5_000_000), reportedAt: iso(-45_000), rolloutId: null,
        boxArt: 'light', linie: 'light', lastSeenAt: iso(-45_000), stufe1: false, stand: 'aktuell',
        istRelease: 'edge-light-2026.11.1', releasesDahinter: 0,
      },
    ],
    journal: [
      { id: 3, at: iso(-900_000), actor: 'system', event: 'device_state', rolloutId: 'r1', deviceId: 'd2', detail: 'fehlgeschlagen' },
      { id: 2, at: iso(-1_800_000), actor: 'system', event: 'device_state', rolloutId: 'r1', deviceId: 'd1', detail: 'bestaetigt' },
      { id: 1, at: iso(-3_600_000), actor: 'admin', event: 'rollout_created', rolloutId: 'r1', deviceId: null, detail: 'edge-industrie-2026.10.1' },
    ],
    kpi: { known: 3, upToDate: 2, unknown: 0, inRollout: 1, failed: 1, newestRelease: 'edge-industrie-2026.10.1' },
  }),
  listDevices: async () => [],
  boxVerlauf: async () => ({ deviceId: 'd2', eintraege: [] }),
  edgeRelease: async (seq: number) => ({
    releaseSeq: seq, version: seq === 9 ? 'edge-light-2026.11.1' : 'edge-industrie-2026.10.1', boxArt: seq === 9 ? 'light' : 'industrie',
    signed: true, signingKeyId: 'rel-a', createdAt: iso(-7 * 86_400_000), targetCommit: null, notes: null,
    aenderungen: [], erlaubtRueckschritt: false, minFromSeq: null, inhalt: [], laeuftAuf: [], boxenDerLinie: 1, verteilt: [],
    programme: seq === 9 ? [{ arch: 'mt76x8', groesse: 4_800_000, empfangen: 4_800_000, fertig: true }] : [],
  }),
  edgeEignung: async () => ({ releaseSeq: 15, version: 'edge-industrie-2026.10.1', boxArt: 'industrie', andereLinie: 0, boxen: [] }),
  createRollout: async () => ({}),
  setUpdateTarget: async () => ({}),
  revertUpdateTarget: async () => ({}),
  // Karte „Ohne Kundenkonto" (vp-update-vor-zuordnung S2): eine Box bereit (S4: „heute Nacht"), eine ohne
  // Tunnel-Rückmeldung (kein Knopf, Grund), eine dritte mit einem in der Nacht zurückgenommenen Fernlauf - „Braucht
  // dich" mit Grund und dem Halt der Automatik.
  nachtlaufSchalter: async () => nachtlaufSchalter(),
  nachtlaufSchalten: async (an: boolean) => {
    nachtlaufAn = an;
    return nachtlaufSchalter();
  },
  geraeteOhneKundenkonto: async () => [
    {
      edgeRef: 'edge-cyhchfr', laeuft: 'edge-light-2026.11.5', laeuftGemeldetAm: iso(-180_000),
      fragtZuletztAm: iso(-10_000), neueste: 'edge-light-2026.11.15', werkstattFassung: 'edge-light-2026.11.5',
      werkstattAm: iso(-9 * 86_400_000), moeglich: true, gruende: [],
      haken: { tunnelVerbunden: true, fragtNachSchluesseln: true, keinKundenkonto: true }, verlauf: [],
      nachtlauf: nachtlaufAn ? { dran: true, grund: null } : { dran: false, grund: AUS },
      stand: iso(0),
    },
    {
      edgeRef: 'edge-mnpqrsb', laeuft: 'edge-light-2026.11.5', laeuftGemeldetAm: iso(-900_000), fragtZuletztAm: null,
      neueste: 'edge-light-2026.11.15', werkstattFassung: 'edge-light-2026.11.5', werkstattAm: iso(-9 * 86_400_000),
      moeglich: false,
      gruende: [{ code: 'nicht_verbunden', text: 'Die Box ist gerade nicht im Tunnel (kein Handshake in den letzten 3 Minuten).' }],
      haken: { tunnelVerbunden: false, fragtNachSchluesseln: false, keinKundenkonto: true }, verlauf: [],
      nachtlauf: { dran: false, grund: 'Der Tunnel-Dienst hat zu dieser Box seit mehr als 3 Minuten nichts gemeldet; '
        + 'ohne frische Rückmeldung kein Lauf.' },
      stand: iso(0),
    },
    {
      edgeRef: 'edge-k7m2xq3', laeuft: 'edge-light-2026.11.5', laeuftGemeldetAm: iso(-240_000),
      fragtZuletztAm: iso(-15_000), neueste: 'edge-light-2026.11.15', werkstattFassung: 'edge-light-2026.11.5',
      werkstattAm: iso(-9 * 86_400_000), moeglich: true, gruende: [],
      haken: { tunnelVerbunden: true, fragtNachSchluesseln: true, keinKundenkonto: true },
      verlauf: [{
        id: 'f1', art: 'aufspielen', zustand: 'zurueck', fassungVorher: 'edge-light-2026.11.5',
        fassungZiel: 'edge-light-2026.11.15', akteurName: 'Automatik · nachts', nachts: true, erteiltAm: iso(-20 * 60_000),
        begonnenAm: iso(-19 * 60_000), schritt: 'neustart', schrittSeit: null, schritte: [], fensterEnde: null,
        ergebnis: { ergebnis: 'zurueck', grund: '/health nennt edge-light-2026.11.9', schritt: 'neustart',
          fassungNachher: 'edge-light-2026.11.5', belege: {}, quelle: 'dienst', erfasstAm: iso(-15 * 60_000) },
      }],
      nachtlauf: { dran: false, grund: 'Der letzte Lauf auf 2026.11.15 wurde zurückgenommen; die Automatik versucht '
        + 'diese Fassung hier nicht noch einmal („Noch einmal“ von Hand gibt sie frei).' },
      stand: iso(0),
    },
    ...(MIT_PFC200 ? [PFC200_ZEILE] : []),
  ],
  geraeteFernlauf: async () => ({
    edgeRef: 'edge-cyhchfr', laeuft: 'edge-light-2026.11.15', laeuftGemeldetAm: iso(0), fragtZuletztAm: iso(0),
    neueste: 'edge-light-2026.11.15', werkstattFassung: 'edge-light-2026.11.5', werkstattAm: iso(-9 * 86_400_000),
    moeglich: false, gruende: [{ code: 'schon_neueste', text: 'x' }],
    haken: { tunnelVerbunden: true, fragtNachSchluesseln: true, keinKundenkonto: true },
    nachtlauf: null,
    verlauf: [{
      id: 'f2', art: 'aufspielen', zustand: 'fertig', fassungVorher: 'edge-light-2026.11.5',
      fassungZiel: 'edge-light-2026.11.15', akteurName: 'Alex Beispiel', nachts: false, erteiltAm: iso(-60_000),
      begonnenAm: iso(-59_000), schritt: 'tunnel', schrittSeit: null, schritte: [], fensterEnde: null,
      ergebnis: { ergebnis: 'fertig', grund: null, schritt: 'tunnel', fassungNachher: 'edge-light-2026.11.15',
        belege: {}, quelle: 'dienst', erfasstAm: iso(0) },
    }],
    stand: iso(0),
  }),
  geraeteFernlaufAufspielen: async (ref: string, fassung: string) => {
    fernlaufAufspielenAufrufe.push({ ref, fassung });
    return {};
  },
});

function Fixture() {
  return (
    <AppShell page="edge-updates" onNavigate={() => undefined} isAdmin showOverview={false}
      showAddAnlage={false} counts={{ sites: 3, devices: 3 }} tenants={[]} tenantOverride={null}
      onTenantChange={() => undefined}>
      <GeraeteBereich page="edge-updates" onNavigate={() => undefined} />
    </AppShell>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Fixture />);
