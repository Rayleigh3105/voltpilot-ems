/**
 * Die echte Werkstatt-Seite für einen WAGO PFC200 (Edge Industrie), mit fiktiven Daten; alle API-Aufrufe bleiben im
 * Speicher. Die Ansicht des Werkstatt-Dienstes ist der Vertragsvektor
 * `docs/contracts/werkstatt-ansicht-v1.zustaende-pfc200.json` (erzeugt aus dem Dienst selbst): `?zustand=` wählt einen
 * seiner Zustände (ohne: `ohne_antwort`, das Kabel steckt und niemand antwortet). Nur die Zeiten sind auf jetzt
 * gestellt, damit „läuft seit“ nicht in Tagen zählt.
 *
 * Im Register: edge-k7m2xq3 (PFC200, vom Dienst abgenommen, mit den zehn Belegen und den drei Angaben) und
 * edge-5t2dcy6 (eine Mango daneben, nur im Register). Die Werkstatt läuft für beide Geräte nach der Regel;
 * `?regel=wartet` lässt sie für den PFC200 warten (keine Fassung mit Skriptstand und Tunnel-Programm).
 * Alle Referenzen, Schlüssel, Prüfsummen und die Seriennummer sind erfunden.
 */
import { useState } from 'react';
import ReactDOM from 'react-dom/client';
import zustaende from '../../../docs/contracts/werkstatt-ansicht-v1.zustaende-pfc200.json';
import { AppShell } from '../src/shell/AppShell';
import { GeraeteBereich } from '../src/pages/admin/GeraeteRegistryPage';
import { adminApi } from '../src/admin/adminApi';
import { ApiError } from '../src/api';
import { keycloak } from '../src/auth';
import { PRUEFUNGEN_PFC200, type WerkstattBox } from '../src/werkstatt';
import type { LaufStand, WerkstattAnsicht, WerkstattDienst, WerkstattFreigabe, WerkstattFreigabePfc200, WerkstattLauf, WerkstattRegel } from '../src/werkstattBank';
import type { WerkstattRegelPfc200 } from '../src/werkstattPfc200';
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
const SHA = 'a3f1c09b7e2d4f6a8b0c1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5e6f708';
const parameter = new URLSearchParams(window.location.search);
const zustand = parameter.get('zustand') ?? 'ohne_antwort';
const regelWartet = parameter.get('regel') === 'wartet';
const BOX = 'edge-k7m2xq3';

const OPENWRT = { fassung: '25.12.5', datei: 'openwrt-25.12.5-ramips-mt76x8-glinet_gl-mt300n-v2-squashfs-sysupgrade.bin', sha256: SHA,
  quelle: 'https://downloads.openwrt.org/releases/25.12.5/targets/ramips/mt76x8/' };
const QUELLE = 'https://git.tecmaxx.de/mamotec/voltpilot-ems/releases/download/';
const INDUSTRIE = { fassung: 'edge-industrie-2026.11.0', quelle: `${QUELLE}edge-industrie-2026.11.0/`, programmSha256: '4'.repeat(64),
  skripteSha256: '5'.repeat(64), wartungSha256: '6'.repeat(64) };

const freigaben: WerkstattFreigabe[] = [
  { id: 'f1', kennung: '2026-11-mango-1', boxArt: 'mango', gueltigAb: iso(-5 * 3_600_000), gueltigBis: iso(20 * 3_600_000), obergrenze: 40,
    openwrt: OPENWRT, edgeLight: { fassung: 'edge-light-2026.11.3', quelle: `${QUELLE}edge-light-2026.11.3/`, programmSha256: SHA, skripteSha256: SHA },
    notiz: null, erteiltAm: iso(-5 * 3_600_000), erteiltVon: 'Regel: neueste Fassung', beendetAm: null, beendetVon: null, zustand: 'laufend', grund: null,
    quelle: 'regel', edgeReleaseSeq: 14 },
];
const freigabenPfc: WerkstattFreigabePfc200[] = [
  { id: 'p1', kennung: '2026-11-pfc200-1', boxArt: 'pfc200', gueltigAb: iso(-5 * 3_600_000), gueltigBis: iso(20 * 3_600_000), obergrenze: 40,
    openwrt: null, edgeLight: INDUSTRIE, notiz: null, erteiltAm: iso(-5 * 3_600_000), erteiltVon: 'Regel: neueste Fassung', beendetAm: null,
    beendetVon: null, zustand: 'laufend', grund: null, quelle: 'regel', edgeReleaseSeq: 21 },
];
const regel: WerkstattRegel = { zustand: 'laeuft', grund: null, neueste: 'edge-light-2026.11.3', openwrt: OPENWRT, edgeLight: freigaben[0].edgeLight,
  releaseSeq: 14, freigabe: '2026-11-mango-1', vonHand: false, heute: 1, tagesgrenze: 40, angehalten: null, verlauf: [] };
const regelPfc: WerkstattRegelPfc200 = regelWartet
  ? { zustand: 'wartet', neueste: 'edge-industrie-2026.10.9', openwrt: null, edgeLight: null, releaseSeq: null, freigabe: null, heute: 1, tagesgrenze: 40,
      grund: 'Die Fassung edge-industrie-2026.10.9 trägt Skriptstand und Tunnel-Programm nicht im signierten Manifest. Die Werkstatt nimmt erst eine Fassung, die damit gebaut ist.' }
  : { zustand: 'laeuft', grund: null, neueste: INDUSTRIE.fassung, openwrt: null, edgeLight: INDUSTRIE, releaseSeq: 21, freigabe: '2026-11-pfc200-1',
      heute: 1, tagesgrenze: 40 };

/** Der Zustand des Vektors, mit den Zeiten von jetzt. */
function ansicht(): WerkstattAnsicht {
  const a = structuredClone((zustaende as unknown as Record<string, WerkstattAnsicht>)[zustand]
    ?? (zustaende as unknown as Record<string, WerkstattAnsicht>).ohne_antwort);
  a.zeit = new Date().toISOString();
  a.werkbank.status_zeit = a.zeit;
  if (a.lauf) {
    a.lauf.beginn = iso(-9 * 60_000);
    if (a.lauf.ende) a.lauf.ende = iso(-60_000);
    if (a.lauf.schritt_seit) a.lauf.schritt_seit = iso(-42_000);
  }
  if (regelWartet && a.freigabe_pfc200) a.freigabe_pfc200 = { laufend: false, boxen: 0, grund: regelPfc.grund ?? undefined, freigabe: null };
  return a;
}

function lauf(s: LaufStand): WerkstattLauf {
  return { kennung: s.kennung, freigabe: s.freigabe, boxArt: s.box_art, zustand: s.zustand, schritt: s.schritt ?? null, titel: s.titel ?? null,
    grund: s.grund ?? null, beginn: s.beginn, ende: s.ende ?? null, aktualisiertAm: new Date().toISOString(), stand: s };
}

/** Die Belege einer Abnahme am PFC200: je Prüfung eine Zeile, wie der Dienst sie nennt (erfunden). */
const BELEGE: Record<string, string> = {
  zugaenge: 'Schritt zugaenge: Werkspasswort abgewiesen an SSH (root, admin, user), Anmeldung mit Passwort aus',
  notfall_schluessel: 'Schritt notfall: ein Schlüssel, Fingerabdruck SHA256:N0tfa11…',
  tunnel_status: 'Schritt tunnel: Handshake 3 s, Port 2222 nur im Tunnel, Abholer läuft',
  anmeldeprobe: 'Schritt probe: Anmeldung über den Tunnel als werkstatt-dienst',
  host_schluessel: 'Schritt probe: Host-Schlüssel im Anlagennetz und im Tunnel gelesen (gleich)',
  fenster_zu: 'Schritt probe: nach dem Schließen Connection timed out',
  netze: 'Schritt netze: X1 Kundennetz (DHCP), X2 Anlagennetz 10.213.0.1/24, Weiterleitung aus',
  dienste_zu: 'Schritt netze: Firewall ein; an X1 nur die Web-App der Box und OCPP; an X2 dazu codesysr, https, ssh; Docker aus; Start nur intern',
  neustart: 'Schritt neustart: frischer Handshake, dieselbe Referenz, derselbe Host-Schlüssel, Schalter auf RUN',
  update_bereit: 'Schritt programm: signierte Fassung bestätigt, Vertrauens-Set geprüft, Box-Art Edge Industrie',
};

const register: WerkstattBox[] = [
  { id: `w-${BOX}`, edgeRef: BOX, boxArt: 'edge-industrie', lanNetz: '10.213.0.1/24', schritte: {}, notiz: null, angelegtAm: iso(-40 * 60_000),
    angelegtVon: 'werkstatt-dienst', geaendertAm: iso(-2 * 60_000), kunde: null,
    // Abgenommen, sobald der Lauf fertig ist; solange am Anschluss nur gewartet wird, steht dort die Box von vorhin.
    abnahmen: !/^(laeuft|wartet|angehalten)/.test(zustand)
      ? [{ id: 'a1', edgeRef: BOX, hostSchluessel: 'SHA256:' + 'Q'.repeat(42) + 'c', fassung: INDUSTRIE.fassung, tunnelAdresse: '10.10.16.7',
          lanNetz: '10.213.0.1/24', pruefungen: PRUEFUNGEN_PFC200.map((p) => p.id), notiz: null, erfasstAm: iso(-2 * 60_000), erfasstVon: 'werkstatt-dienst',
          probe: { fensterId: 'p1', technikerName: 'Werkstatt-Dienst', grund: 'Werkstatt-Probe', beginn: iso(-8 * 60_000), ende: iso(-4 * 60_000),
            geschlossenAm: iso(-4 * 60_000), geschlossenVon: 'werkstatt-dienst', schluesselAbgeholtUm: iso(-7 * 60_000), gemeldetAm: iso(-4 * 60_000) },
          quelle: 'dienst', freigabeId: 'p1', einloesungId: 'e1', belege: BELEGE,
          angaben: { artikel: '750-8212', firmware: '03.10.08(22)', seriennummer: 'SN-BEISPIEL-0001' },
          passwortAge: '-----BEGIN AGE ENCRYPTED FILE-----\nYWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBlcmZ1bmRlbg\n-----END AGE ENCRYPTED FILE-----' }]
      : [] },
  { id: 'w-edge-5t2dcy6', edgeRef: 'edge-5t2dcy6', boxArt: 'edge-light', lanNetz: '10.213.0.1/24', schritte: {}, notiz: null,
    angelegtAm: iso(-86_400_000), angelegtVon: 'werkstatt-dienst', geaendertAm: iso(-86_400_000), abnahmen: [], kunde: null },
];

function dienst(): WerkstattDienst {
  const a = ansicht();
  return { ansicht: a, gemeldetAm: new Date().toISOString(), dienstZeit: a.zeit, alterSekunden: 3, aktuell: true,
    laeufe: a.lauf ? [lauf(a.lauf)] : [], zurSeite: [] };
}

Object.assign(adminApi, {
  werkstattBoxen: async () => register,
  werkstattDienst: async () => dienst(),
  werkstattNochmal: async (k: string) => ({ id: 'auftrag-1', art: 'nochmal', lauf: k, erteiltAm: new Date().toISOString() }),
  werkstattZurSeite: async (k: string) => ({ id: `z-${k}`, lauf: k, box: null, fall: null, loesungTitel: null, schritt: null, grund: null,
    gelegtAm: new Date().toISOString(), gelegtVon: 'alex' }),
  edgeUpdates: async () => ({ releases: [], rollouts: [], fleet: [] }),
  fernwartungBox: async () => { throw new ApiError(404, 'Für diese Box ist kein Tunnel-Schlüssel hinterlegt.'); },
  fernwartung: async () => ({ rueckmeldungen: [] }),
  werkstattErstesVerbinden: async () => undefined,
  werkstattFernlaufZeile: async () => undefined,
  werkstattFreigaben: async () => freigaben,
  werkstattFreigabenPfc200: async () => freigabenPfc,
  werkstattRegel: async () => regel,
  werkstattRegelPfc200: async () => regelPfc,
  werkstattAnhalten: async () => regel,
  werkstattFortsetzen: async () => regel,
});

Object.assign(keycloak, { tokenParsed: { name: 'Alex Beispiel', email: 'alex@example.test', realm_access: { roles: ['platform-admin'] } } });
(keycloak as unknown as { token: string; updateToken: () => Promise<boolean> }).token = 'e2e-token';
(keycloak as unknown as { updateToken: () => Promise<boolean> }).updateToken = async () => false;
const echtesFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (url.includes('/api/v1/meldungen/zahl')) {
    return Promise.resolve(new Response(JSON.stringify({ ungelesen: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }
  return echtesFetch(input, init);
};

function Fixture() {
  const [page, setPage] = useState<PageId>('werkstatt');
  return <AppShell page={page} onNavigate={setPage} isAdmin showOverview={false} showAddAnlage={false}
    counts={{ sites: 3, devices: 3 }} tenants={[]} tenantOverride={null} onTenantChange={() => {}}>
    <GeraeteBereich page={page} onNavigate={(r) => setPage(typeof r === 'string' ? r : r.page)} />
  </AppShell>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Fixture />);
