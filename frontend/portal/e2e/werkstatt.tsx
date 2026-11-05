/**
 * Die echte Werkstatt-Seite mit fiktiven Daten; alle API-Aufrufe bleiben im Speicher. Der
 * Werkstatt-Dienst meldet seine Ansicht (Vertrag werkstatt-ansicht-v1) frisch; welcher Lauf gerade an
 * der Werkbank steht, wählt `?lauf=` (laeuft, wartet, fertig, problem, startlader, still, ohne; dazu die Fälle der
 * Lauf-Seite: gl_passwort, bruecke_weg, passwort_fremd, startet). `problem` und `startlader` sind Stände eines älteren
 * Dienstes ohne `fall`, `belege` und `nochmal_moeglich`: daran zeigt sich, dass die Seite dann wie bisher bleibt.
 *
 * Im Register: edge-5t2dcy6 (vom Dienst abgenommen, mit Belegen), edge-k7m2xq3 (der Lauf an der
 * Werkbank), edge-p3n8rv4 (angehalten: kein Handshake) und edge-wrk8cdb (Docker-Box, nur im Register).
 * Alle Referenzen, Schlüssel und Prüfsummen sind erfunden.
 */
import { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { AppShell } from '../src/shell/AppShell';
import { GeraeteBereich } from '../src/pages/admin/GeraeteBereich';
import { adminApi } from '../src/admin/adminApi';
import { ApiError } from '../src/api';
import { keycloak } from '../src/auth';
import { type WerkstattBox } from '../src/werkstatt';
import type { LaufStand, Loesung, SchrittBeleg, WerkstattAnsicht, WerkstattDienst, WerkstattFreigabe, WerkstattLauf, ZurSeite } from '../src/werkstattBank';
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
const szenario = new URLSearchParams(window.location.search).get('lauf') ?? 'laeuft';

let freigaben: WerkstattFreigabe[] = szenario === 'ohne' ? [] : [{
  id: 'f1', kennung: '2026-11-mango-1', boxArt: 'mango', gueltigAb: iso(-86_400_000), gueltigBis: '2026-11-30T08:00:00Z', obergrenze: 20,
  openwrt: { fassung: '25.12.5', datei: 'openwrt-25.12.5-ramips-mt76x8-glinet_gl-mt300n-v2-squashfs-sysupgrade.bin', sha256: SHA,
    quelle: 'https://downloads.openwrt.org/releases/25.12.5/targets/ramips/mt76x8/' },
  edgeLight: { fassung: 'edge-light-2026.11.1', quelle: 'https://git.example.test/releases/edge-light-2026.11.1/', programmSha256: SHA, skripteSha256: SHA },
  notiz: null, erteiltAm: iso(-86_400_000), erteiltVon: 'Alex', beendetAm: null, beendetVon: null, zustand: 'laufend', grund: null,
}];

const ERLEDIGT_BIS_TUNNEL = ['erkennen', 'fassungen', 'openwrt', 'wiedererkennen', 'internet', 'passwort', 'notfall', 'programm', 'tunnel_schluessel'];
const ALLE = [...ERLEDIGT_BIS_TUNNEL, 'einloesen', 'tunnel', 'lan', 'neustart', 'probe', 'internet_weg', 'uebergabe'];

/** Belegzeilen und Dauern, wie der Dienst sie aus seiner festen Liste bildet (lauf/zeile.go). */
const BELEG: Record<string, [number, string]> = {
  erkennen: [12.4, 'GL.iNet GL-MT300N-V2 · GL-Firmware 4.3.17 · root-Passwort: leer'],
  fassungen: [3.8, 'Freigabe 2026-11-mango-1 · Prüfsummen = Freigabe · Manifest signiert'],
  openwrt: [108, 'Prüfsumme auf der Box = Freigabe · Test vor dem Aufspielen bestanden'],
  wiedererkennen: [190, 'OpenWrt meldet sich nach 3m8s · MAC 94:83:c4:12:34:56'],
  internet: [6.1, 'downloads.openwrt.org erreichbar (befristet)'],
  passwort: [9, 'gesetzt, nur verschlüsselt abgelegt · ohne Passwort abgewiesen'],
  notfall: [2.2, '1 Notfall-Schlüssel auf der Box'],
  programm: [112, 'meldet sich: ref edge-k7m2xq3, version 2026.11.1 · update-bereit'],
  tunnel_schluessel: [14, 'erzeugt für edge-k7m2xq3 (Prüfzeichen gültig)'],
  einloesen: [18, 'Tunnel-Adresse 10.10.16.9 · Geräteschlüssel festgehalten'],
  tunnel: [41, 'Wartungstunnel eingerichtet · SSH nur im Tunnel'],
  lan: [9, 'LAN-Netz 10.213.0.1/24 · Neustart angestoßen'],
  neustart: [161, 'wieder da nach 2m41s · Host-Schlüssel unverändert'],
  probe: [74, 'Anmeldung über den Tunnel gelungen nach 2 Versuchen in 31s'],
  internet_weg: [5, 'beim Kunden geht die Box nur über WAN ins Netz'],
  uebergabe: [11, 'edge-light-g1a2b3c · 9 Prüfungen mit Beleg'],
};
const belege = (erledigt: string[]): SchrittBeleg[] => erledigt.map((x) => ({ schritt: x, dauer_s: BELEG[x][0], zeile: BELEG[x][1] }));
const VORHER_WERK = { system: 'GL-Firmware 4.3.17', edge_light: 'kein VoltPilot' };
const RESET = 'Den Reset-Knopf der Mango mit einem Stift 10 Sekunden gedrückt halten, bis die Leuchte schnell blinkt. Dann loslassen.';
const KURZ_AB = 'Das orange Kabel kurz abziehen und wieder einstecken.';
const ZUR_SEITE = 'Zur Seite legen, Zettel „Problem“ drauf. Der Grund bleibt hier für die Technik stehen.';
const LOESUNG: Record<string, Loesung> = {
  gl_passwort: { titel: 'Diese Mango hat schon jemand eingerichtet.', selbst: true, zur_seite: false,
    schritte: [RESET, 'Kabel und Strom bleiben stecken. Die Mango startet neu; das dauert ein paar Minuten.'] },
  bruecke_weg: { titel: 'Die Brücke war während des Laufs weg.', selbst: true, zur_seite: false,
    schritte: ['Am Raspberry Pi nachsehen: Strom und WLAN.', KURZ_AB] },
  passwort_fremd: { titel: 'Diese Mango gehört nicht zur Werkstatt.', selbst: false, zur_seite: true, schritte: ['Nicht zurücksetzen.', ZUR_SEITE] },
  startet: { titel: 'Die Mango startet noch.', selbst: true, zur_seite: false,
    schritte: ['Nichts tun und nicht abziehen. Der Dienst fängt an, sobald sie fertig gestartet ist.'] },
};
let nochmalSeit: string | null = null;
let zurSeite: ZurSeite[] = [{ id: 'z1', lauf: 'lauf-20261101-1530', box: 'edge-p3n8rv4', fall: 'schritt_gescheitert',
  loesungTitel: 'Hier hat etwas nicht geklappt.', schritt: 'probe', grund: 'kein Handshake an wg_wartung seit 180 s',
  gelegtAm: iso(-17 * 3_600_000), gelegtVon: 'alex' }];

function laufAnDerBank(): LaufStand | null {
  const basis = { kennung: 'lauf-20261102-0907', freigabe: '2026-11-mango-1', box_art: 'mango', beginn: iso(-9 * 60_000) };
  switch (szenario) {
    case 'laeuft':
      return { ...basis, box: 'edge-k7m2xq3', zustand: 'laeuft', schritt: 'einloesen', titel: 'Einmal-Code einlösen', erledigt: ERLEDIGT_BIS_TUNNEL,
        schritt_seit: iso(-42_000), schritt_frist_s: 300, belege: belege(ERLEDIGT_BIS_TUNNEL), vorher: VORHER_WERK };
    case 'wartet':
      // Nur ohne API-Konto des Dienstes (Rückfall, Schritt tunnel_adresse): Er wartet auf die Adresse aus dem Portal.
      return { ...basis, box: 'edge-k7m2xq3', zustand: 'wartet', schritt: 'tunnel_adresse', titel: 'Tunnel-Adresse', erledigt: ERLEDIGT_BIS_TUNNEL,
        wartet_auf: 'tunnel_adresse', hinweis: 'Tunnel-Adresse aus dem Portal (Fernwartung › Boxen) eintragen.' };
    case 'fertig':
      return { ...basis, box: 'edge-k7m2xq3', zustand: 'fertig', ende: iso(-60_000), erledigt: ALLE, belege: belege(ALLE), vorher: VORHER_WERK };
    case 'gl_passwort':
      return { ...basis, zustand: 'angehalten', schritt: 'erkennen', titel: 'Mango erkennen', erledigt: [], ende: iso(-20_000),
        grund: 'Die Mango verlangt ein Passwort: Jemand hat ihre Werksfirmware schon eingerichtet (gebraucht gekauft oder angefangen).',
        handgriff: 'Zurücksetzen: Reset-Knopf 10 s', fall: 'gl_passwort', loesung: LOESUNG.gl_passwort,
        vorher: { system: 'GL-Firmware, Fassung unbekannt (Passwort)', edge_light: 'unbekannt' } };
    case 'bruecke_weg':
      return { ...basis, zustand: 'angehalten', schritt: 'openwrt', titel: 'OpenWrt aufspielen', erledigt: ['erkennen', 'fassungen'],
        belege: belege(['erkennen', 'fassungen']), vorher: VORHER_WERK, ende: iso(-20_000),
        grund: 'Frist von 1m0s überschritten: Brücke 192.168.0.157:22 nicht erreichbar', fall: 'bruecke_weg', loesung: LOESUNG.bruecke_weg,
        nochmal_moeglich: true, ...(nochmalSeit ? { nochmal_seit: nochmalSeit } : {}) };
    case 'passwort_fremd':
      return { ...basis, zustand: 'angehalten', schritt: 'erkennen', titel: 'Mango mit OpenWrt erkennen', erledigt: [], ende: iso(-20_000),
        grund: 'Das Gerät unter 192.168.1.1 verlangt ein Passwort: kein frisches OpenWrt.', fall: 'passwort_fremd', loesung: LOESUNG.passwort_fremd,
        vorher: { system: 'OpenWrt mit Passwort', edge_light: 'unbekannt' } };
    case 'problem':
      return { ...basis, box: 'edge-k7m2xq3', zustand: 'angehalten', schritt: 'probe', titel: 'Probe über den Tunnel',
        grund: 'kein Handshake an wg_wartung seit 180 s', erledigt: [...ERLEDIGT_BIS_TUNNEL, 'einloesen', 'tunnel', 'lan', 'neustart'] };
    case 'startlader':
      return { ...basis, zustand: 'angehalten', schritt: 'openwrt', titel: 'OpenWrt aufspielen', erledigt: ['erkennen', 'fassungen'],
        handgriff: 'Startlader (Handgriff M4): Mango vom Strom, Reset gedrückt halten, Strom an, nach fünfmal Blinken loslassen' };
    default:
      return null;
  }
}

function ansicht(): WerkstattAnsicht {
  const f = freigaben.find((x) => x.zustand === 'laufend');
  return {
    schema: 'vp-werkstatt-ansicht.v1',
    zeit: new Date().toISOString(),
    werkbank: { adresse: '10.10.40.2', bereit: true, fassung_soll: 'brueckpi-2026.11.1', host_schluessel: 'SHA256:' + 'W'.repeat(43),
      status: { fassung: 'brueckpi-2026.11.1', werkstatt: { kabel: true },
        antworten: szenario === 'ohne' ? [] : [{ adresse: szenario === 'gl_passwort' ? '192.168.8.1' : '192.168.1.1', macs: ['94:83:c4:12:34:56'] }] },
      status_zeit: new Date().toISOString() },
    freigabe: f
      ? { laufend: true, boxen: 2, freigabe: { kennung: f.kennung, box_art: 'mango', gueltig_bis: f.gueltigBis,
          openwrt: { fassung: f.openwrt.fassung, datei: f.openwrt.datei, sha256: f.openwrt.sha256, quelle: f.openwrt.quelle },
          edge_light: { fassung: f.edgeLight.fassung, quelle: f.edgeLight.quelle } } }
      : { laufend: false, boxen: 0, grund: 'keine laufende Freigabe für mango', freigabe: null },
    anschluss: szenario === 'startet' ? 'Mango erkannt unter 192.168.1.1; der Dienst wartet, bis sie fertig gestartet ist. Nicht abziehen.' : 'eth1 (orange)',
    ...(szenario === 'startet' ? { anschluss_fall: 'startet', anschluss_loesung: LOESUNG.startet } : {}),
    lauf: f ? laufAnDerBank() : null,
  };
}

function lauf(s: LaufStand): WerkstattLauf {
  return { kennung: s.kennung, freigabe: s.freigabe, boxArt: s.box_art, zustand: s.zustand, schritt: s.schritt ?? null, titel: s.titel ?? null,
    grund: s.grund ?? null, beginn: s.beginn, ende: s.ende ?? null, aktualisiertAm: new Date().toISOString(), stand: s };
}

const fruehererLauf: LaufStand = { kennung: 'lauf-20261102-0812', freigabe: '2026-11-mango-1', box_art: 'mango', box: 'edge-5t2dcy6',
  beginn: iso(-50 * 60_000), ende: iso(-28 * 60_000), zustand: 'fertig', erledigt: ALLE };
const angehaltenerLauf: LaufStand = { kennung: 'lauf-20261101-1530', freigabe: '2026-11-mango-1', box_art: 'mango', box: 'edge-p3n8rv4',
  beginn: iso(-18 * 3_600_000), ende: iso(-17.5 * 3_600_000), zustand: 'angehalten', schritt: 'probe', titel: 'Probe über den Tunnel',
  grund: 'kein Handshake an wg_wartung seit 180 s', erledigt: [...ERLEDIGT_BIS_TUNNEL, 'einloesen', 'tunnel', 'lan', 'neustart'] };

function registerBox(edgeRef: string, boxArt: 'edge-light' | 'edge-app', over: Partial<WerkstattBox> = {}): WerkstattBox {
  return { id: `w-${edgeRef}`, edgeRef, boxArt, lanNetz: boxArt === 'edge-light' ? '10.213.0.1/24' : null, schritte: {}, notiz: null,
    angelegtAm: iso(-40 * 60_000), angelegtVon: 'werkstatt-dienst', geaendertAm: iso(-28 * 60_000), abnahmen: [], kunde: null, ...over };
}

const register: WerkstattBox[] = [
  registerBox('edge-5t2dcy6', 'edge-light', {
    abnahmen: [{ id: 'a1', edgeRef: 'edge-5t2dcy6', hostSchluessel: 'SHA256:' + 'Q'.repeat(42) + 'c', fassung: 'edge-light-2026.11.1',
      tunnelAdresse: '10.10.16.9', lanNetz: '10.213.0.1/24', pruefungen: [], notiz: null, erfasstAm: iso(-28 * 60_000), erfasstVon: 'werkstatt-dienst',
      probe: { fensterId: 'p1', technikerName: 'Werkstatt-Dienst', grund: 'Werkstatt-Probe', beginn: iso(-34 * 60_000), ende: iso(-30 * 60_000),
        geschlossenAm: iso(-30 * 60_000), geschlossenVon: 'werkstatt-dienst', schluesselAbgeholtUm: iso(-33 * 60_000), gemeldetAm: iso(-30 * 60_000) },
      quelle: 'dienst', freigabeId: 'f1', einloesungId: 'e1',
      passwortAge: '-----BEGIN AGE ENCRYPTED FILE-----\nYWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBlcmZ1bmRlbg\n-----END AGE ENCRYPTED FILE-----',
      belege: {
        root_passwort: 'Schritt passwort: Passwort gesetzt, verschlüsselt abgelegt (age)',
        notfall_schluessel: 'Schritt notfall: ein Schlüssel, Fingerabdruck SHA256:N0tfa11…',
        tunnel_status: 'Schritt tunnel: Handshake 4 s, 2222 außerhalb abgewiesen, Abholer läuft',
        anmeldeprobe: 'Schritt probe: Anmeldung über den Tunnel als werkstatt-dienst',
        host_schluessel: 'Schritt probe: Host-Schlüssel über LAN und Tunnel gleich',
        fenster_zu: 'Schritt probe: nach dem Schließen Connection timed out',
        lan_netz: 'Schritt lan: 10.213.0.1/24',
        neustart: 'Schritt neustart: frischer Handshake, dieselbe Referenz',
      } }],
  }),
  registerBox('edge-p3n8rv4', 'edge-light', { geaendertAm: iso(-17.5 * 3_600_000) }),
  registerBox('edge-wrk8cdb', 'edge-app', { notiz: 'Raspberry Pi 5, für die Prüfanlage', angelegtVon: 'alex', geaendertAm: iso(-86_400_000) }),
];

function dienst(): WerkstattDienst {
  if (szenario === 'still') {
    return { ansicht: ansicht(), gemeldetAm: iso(-7 * 60_000), dienstZeit: iso(-7 * 60_000), alterSekunden: 420, aktuell: false, laeufe: [lauf(fruehererLauf)] };
  }
  const a = ansicht();
  const laeufe = [a.lauf, fruehererLauf, angehaltenerLauf].filter((s): s is LaufStand => !!s).map(lauf);
  return { ansicht: a, gemeldetAm: new Date().toISOString(), dienstZeit: a.zeit, alterSekunden: 3, aktuell: true, laeufe, zurSeite };
}

Object.assign(adminApi, {
  werkstattBoxen: async () => {
    const lb = ansicht().lauf?.box;
    return lb && !register.some((b) => b.edgeRef === lb) ? [registerBox(lb, 'edge-light', { geaendertAm: new Date().toISOString() }), ...register] : register;
  },
  werkstattDienst: async () => dienst(),
  // Der Dienst nimmt „Nochmal“ nur für einen Lauf an, der es anbietet; danach meldet er nochmal_seit.
  werkstattNochmal: async (k: string) => {
    const l = ansicht().lauf;
    if (!l || l.kennung !== k || !l.nochmal_moeglich) throw new ApiError(409, 'Für diesen Lauf gibt es kein „Nochmal versuchen“ aus dem Portal.');
    nochmalSeit = new Date().toISOString();
    return { id: 'auftrag-1', art: 'nochmal', lauf: k, erteiltAm: nochmalSeit };
  },
  werkstattZurSeite: async (k: string) => {
    const l = ansicht().lauf;
    if (!l || l.kennung !== k) throw new ApiError(404, 'Diesen Lauf kennt die Werkstatt nicht.');
    const z: ZurSeite = { id: `z-${k}`, lauf: k, box: l.box ?? null, fall: l.fall ?? null, loesungTitel: l.loesung?.titel ?? null,
      schritt: l.schritt ?? null, grund: l.grund ?? null, gelegtAm: new Date().toISOString(), gelegtVon: 'alex' };
    zurSeite = [z, ...zurSeite.filter((x) => x.lauf !== k)];
    return z;
  },
  edgeUpdates: async () => ({ releases: [
    { releaseSeq: 14, version: '2026.11.3', targetCommit: null, notes: null, signed: true, signingKeyId: 'k1', createdAt: iso(-3_600_000), runningOnDevices: 1, boxArt: 'edge-light' },
    { releaseSeq: 12, version: '2026.11.1', targetCommit: null, notes: null, signed: true, signingKeyId: 'k1', createdAt: iso(-86_400_000), runningOnDevices: 3, boxArt: 'edge-light' },
  ], rollouts: [], fleet: [] }),
  // Bindung: nur die abgenommene Box ist einem Kunden gekoppelt, die anderen haben keinen Tunnel-Schlüssel.
  fernwartungBox: async (ref: string) => {
    if (ref !== 'edge-5t2dcy6') throw new ApiError(404, 'Für diese Box ist kein Tunnel-Schlüssel hinterlegt.');
    return { id: 'fw1', edgeRef: ref, publicKey: 'erfunden', publicKeyKurz: 'q3Zr…Xk8=', adresse: '10.10.16.9', status: 'aktiv', notiz: null,
      angelegtAm: iso(-35 * 60_000), geaendertAm: iso(-30 * 60_000), siteId: 's1', siteName: 'Halle 1', tenantId: 't1', tenantName: 'Beispiel GmbH',
      laufendeFenster: [], rueckmeldung: null };
  },
  fernwartung: async () => ({ rueckmeldungen: [] }),
  werkstattFreigaben: async () => freigaben,
  werkstattFreigeben: async (i: { tage: number; obergrenze: number; openwrt: WerkstattFreigabe['openwrt']; edgeLight: WerkstattFreigabe['edgeLight'] }) => {
    if (!/^[0-9a-f]{64}$/.test(i.openwrt.sha256)) throw new ApiError(422, 'Freigabe ungültig: openwrt.sha256: 64 Zeichen 0-9a-f');
    const f: WerkstattFreigabe = { id: `f-${Date.now()}`, kennung: '2026-11-mango-2', boxArt: 'mango', gueltigAb: new Date().toISOString(),
      gueltigBis: new Date(Date.now() + i.tage * 86_400_000).toISOString(), obergrenze: i.obergrenze, openwrt: i.openwrt, edgeLight: i.edgeLight,
      notiz: null, erteiltAm: new Date().toISOString(), erteiltVon: 'Alex', beendetAm: null, beendetVon: null, zustand: 'laufend', grund: null };
    freigaben = [f, ...freigaben];
    return f;
  },
  werkstattFreigabeBeenden: async (kennung: string) => {
    freigaben = freigaben.map((f) => (f.kennung === kennung ? { ...f, zustand: 'beendet', beendetAm: new Date().toISOString(), beendetVon: 'Alex', grund: 'beendet von Alex' } : f));
    return freigaben.find((f) => f.kennung === kennung)!;
  },
});

Object.assign(keycloak, { tokenParsed: { name: 'Alex Beispiel', email: 'alex@example.test', realm_access: { roles: ['platform-admin'] } } });

function Fixture() {
  const [page, setPage] = useState<PageId>('werkstatt');
  return <AppShell page={page} onNavigate={setPage} isAdmin showOverview={false} showAddAnlage={false}
    counts={{ sites: 3, devices: 3 }} tenants={[]} tenantOverride={null} onTenantChange={() => {}}>
    <GeraeteBereich page={page} onNavigate={(r) => setPage(typeof r === 'string' ? r : r.page)} />
  </AppShell>;
}
ReactDOM.createRoot(document.getElementById('root')!).render(<Fixture />);
