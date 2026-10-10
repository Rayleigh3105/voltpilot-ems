/**
 * Echte Fernwartungs-Komponenten mit fiktiven Daten; alle API-Aufrufe bleiben im Speicher.
 * Zugänge lassen sich hier anlegen, sperren, entsperren und löschen wie auf dem Server: gelöscht
 * heißt aus der Liste, im Protokoll bleibt der Name. Ein SSH-Schlüssel lässt sich hinterlegen,
 * ersetzen und entfernen; der Fingerabdruck wird wie auf dem Server aus dem Schlüssel berechnet.
 */
import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { AppShell } from '../src/shell/AppShell';
import { GeraeteBereich } from '../src/pages/admin/GeraeteBereich';
import { adminApi } from '../src/admin/adminApi';
import { ApiError } from '../src/api';
import { keycloak } from '../src/auth';
import {
  sshSchluesselPruefen,
  type FernwartungBox,
  type FernwartungFenster,
  type FernwartungProtokollEintrag,
  type FernwartungServer,
  type FernwartungTechniker,
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
const ohneSsh = { sshPublicKey: null, sshFingerabdruck: null, sshBits: null };
// Der öffentliche Beispielschlüssel des Vertragsvektors (docs/contracts/fernwartung-soll-v1.example.json);
// sein privater Teil existiert nicht mehr.
const beispielSsh = {
  sshPublicKey:
    'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC65yGMPv85jYw73Y34zwg28UDa5p7/5R89oMU38SLkF/XCJtuHiW5r63r4e0LDhKAL7IzqeRFsj/NwNBMNkIxVYzTFNWUxFPU0KrBg6jrcejgb2kTkK+a1VrzbPiWCd0gyxZEAeuVukvqr3OxHsAUc4b8WPviPjqu2BgWwVv9fHWGKcVoyGISLgI1YbrF8qzYRlpAaGSLlrHjT3JB9Ytgda7dNWXggf83lyzCvO6leSS8azex11WfYWM7tq2duUoPqm2qAD2itPapCaTL3nVdFRHZtGQ6yZhrA1wDBAxZ4/uPmD7+SaYBqH0GNWAQlz72YTL+RjAPYI9I3r2DUQx1AS7oQ3BCZ0kvpv8kmCvXzZryO6iqc3C0855Ky35Aeyykdd9wmQ1/JvUDt0v80wH6xXeE8hln/vyM6RxM9TAeQfprUrfaU/YpOiCF7jIdVgPMicOLQ/VyFuPTQibEAnui420MaDR5bBs/ebmWv34dthws64dZQXEuku4UnkhU8TF0=',
  sshFingerabdruck: 'SHA256:TDOx3bpPNtPLIdd+juZoGcDMz3ZRCklaP5G6aBrp9Zc', sshBits: 3072,
};
// Zweimal „Alex (Laptop)": der erste Zugang bekam einen falschen Schlüssel, wurde gesperrt
// und unter demselben Namen neu angelegt. Der gesperrte lässt sich löschen.
// „Alex (Laptop)" trägt einen SSH-Schlüssel, „Kim (Tablet)" nicht: sein Fenster öffnet nur den Netzweg.
let techniker: FernwartungTechniker[] = [
  { id: 't0', name: 'Alex (Laptop)', publicKey: 'dTkajHaCSCVbnmtc9YaXOW4Fvi51HANh0Fg2KTFV3kk=', publicKeyKurz: 'dTkajHaC…V3kk=',
    adresse: '10.10.32.2', status: 'gesperrt', notiz: 'falscher Schlüssel', angelegtAm: iso(-90_000_000), geaendertAm: iso(-88_000_000), ...ohneSsh },
  { id: 't1', name: 'Alex (Laptop)', publicKey: 'FY4LLXFaOvh8LPZu/gA4AeS2WJjXkuOUPB4hlxBI8/Y=', publicKeyKurz: 'FY4LLXFa…BI8/Y=',
    adresse: '10.10.32.3', status: 'aktiv', notiz: null, angelegtAm: iso(-86_400_000), geaendertAm: iso(-86_400_000), ...beispielSsh },
  { id: 't2', name: 'Werkstatt-Tablet', publicKey: 'Pgf4aS+67rz4HdSHuy8KKgm5e/UP3xnrMWJskXaZB9c=', publicKeyKurz: 'Pgf4aS+6…ZB9c=',
    adresse: '10.10.32.4', status: 'gesperrt', notiz: 'Gerät verloren gemeldet', angelegtAm: iso(-86_400_000), geaendertAm: iso(-3_600_000), ...ohneSsh },
  { id: 't3', name: 'Kim (Tablet)', publicKey: 'Skrz6Rjblq/I8mcs2kl+0mvkp3bs2IjY3us7VFInf/g=', publicKeyKurz: 'Skrz6Rjb…Inf/g=',
    adresse: '10.10.32.5', status: 'aktiv', notiz: null, angelegtAm: iso(-7_200_000), geaendertAm: iso(-7_200_000), ...ohneSsh },
];
const offen: FernwartungFenster = {
  id: 'f1', edgeRef: 'edge-zay5sdd', technikerId: 't1', technikerName: 'Alex (Laptop)', grund: 'Update auf Stufe 2',
  beginn: iso(-600_000), ende: iso(3_000_000), wirksamesEnde: iso(3_000_000), zustand: 'offen',
  geoeffnetAm: iso(-600_000), geoeffnetVon: 'alex', geschlossenAm: null, geschlossenVon: null,
};
const nurNetzweg: FernwartungFenster = {
  ...offen, id: 'f2', technikerId: 't3', technikerName: 'Kim (Tablet)', grund: 'Zähler prüfen',
  beginn: iso(-300_000), ende: iso(1_500_000), wirksamesEnde: iso(1_500_000), geoeffnetAm: iso(-300_000),
};
let boxen: FernwartungBox[] = [
  { id: 'b1', edgeRef: 'edge-zay5sdd', publicKey: 'jUg9DePFPkIQ+KNIAXqSEuVTw2UNHwbUH/HPFK5HiEM=', publicKeyKurz: 'jUg9DePF…5HiEM=',
    adresse: '10.10.16.2', status: 'aktiv', notiz: null, angelegtAm: iso(-86_400_000), geaendertAm: iso(-86_400_000),
    siteId: 's1', siteName: 'Hof Lindenallee', tenantId: 'k1', tenantName: 'Familie Beispiel', laufendeFenster: [offen, nurNetzweg] },
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

// SHA-256 ohne crypto.subtle: die Vorschau läuft im LAN über http, dort gibt es das nicht.
function sha256(daten: Uint8Array): Uint8Array {
  const k = new Uint32Array(64);
  const h = new Uint32Array(8);
  let anzahl = 0;
  for (let kandidat = 2; anzahl < 64; kandidat += 1) {
    let prim = true;
    for (let t = 2; t * t <= kandidat; t += 1) if (kandidat % t === 0) { prim = false; break; }
    if (!prim) continue;
    if (anzahl < 8) h[anzahl] = (Math.sqrt(kandidat) % 1) * 2 ** 32;
    k[anzahl] = (Math.cbrt(kandidat) % 1) * 2 ** 32;
    anzahl += 1;
  }
  const laenge = daten.length;
  const block = new Uint8Array(((laenge + 9 + 63) >> 6) << 6);
  block.set(daten);
  block[laenge] = 0x80;
  const sicht = new DataView(block.buffer);
  sicht.setUint32(block.length - 8, Math.floor((laenge * 8) / 2 ** 32));
  sicht.setUint32(block.length - 4, (laenge * 8) >>> 0);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < block.length; o += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = sicht.getUint32(o + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + k[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, hh].forEach((x, i) => { h[i] = (h[i] + x) >>> 0; });
  }
  const aus = new Uint8Array(32);
  h.forEach((x, i) => new DataView(aus.buffer).setUint32(i * 4, x));
  return aus;
}

/** Wie die API: prüfen, Kommentar verwerfen, Fingerabdruck berechnen. Sonst 400 mit dem Grund. */
function sshFelder(eingabe: string): Pick<FernwartungTechniker, 'sshPublicKey' | 'sshFingerabdruck' | 'sshBits'> {
  const p = sshSchluesselPruefen(eingabe);
  if (!p.ok) throw new ApiError(400, p.fehler);
  const base64 = eingabe.trim().split(/[ \t]+/)[1];
  const blob = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const abdruck = btoa(String.fromCharCode(...sha256(blob))).replace(/=+$/, '');
  return { sshPublicKey: `ssh-rsa ${base64}`, sshFingerabdruck: `SHA256:${abdruck}`, sshBits: p.bits };
}

Object.assign(keycloak, { tokenParsed: { name: 'Alex Beispiel', email: 'alex@example.test', realm_access: { roles: ['platform-admin'] } } });
Object.assign(adminApi, {
  fernwartung: async () => ({
    server, maxFensterMinuten: 1440,
    abrufe: [{ dienst: 'voltpilot-tunnel-dienst', zuletztAm: new Date(Date.now() - 20_000).toISOString(),
      peers: 2 + techniker.filter((t) => t.status === 'aktiv').length, fenster: boxen.flatMap((b) => b.laufendeFenster).length }],
    boxenAktiv: 2, boxenGesperrt: 1, technikerAktiv: techniker.filter((t) => t.status === 'aktiv').length,
    technikerGesperrt: techniker.filter((t) => t.status === 'gesperrt').length,
    fensterOffen: boxen.flatMap((b) => b.laufendeFenster).length, fensterGeplant: 0,
    stand: new Date().toISOString(),
  }),
  fernwartungBoxen: async () => boxen,
  fernwartungTechniker: async () => techniker,
  fernwartungProtokoll: async () => protokoll,
  fernwartungFensterOeffnen: async (i: { edgeRef: string; technikerId: string; grund: string; dauerMinuten: number }) => {
    const t = zugang(i.technikerId);
    const f: FernwartungFenster = { ...offen, id: `f-${Date.now()}`, edgeRef: i.edgeRef, grund: i.grund,
      technikerId: t.id, technikerName: t.name,
      beginn: iso(0), ende: iso(i.dauerMinuten * 60_000), wirksamesEnde: iso(i.dauerMinuten * 60_000) };
    boxen = boxen.map((b) => (b.edgeRef === i.edgeRef ? { ...b, laufendeFenster: [...b.laufendeFenster, f] } : b));
    return f;
  },
  fernwartungFensterSchliessen: async (id: string) => {
    const f = boxen.flatMap((b) => b.laufendeFenster).find((x) => x.id === id);
    if (!f) throw new ApiError(409, 'Das Fenster ist nicht mehr offen.');
    boxen = boxen.map((b) => ({ ...b, laufendeFenster: b.laufendeFenster.filter((x) => x.id !== id) }));
    return { ...f, zustand: 'geschlossen', geschlossenAm: new Date().toISOString(), geschlossenVon: 'alex' };
  },
  fernwartungSchluessel: async () => { throw new Error('Vorschau: Es wird kein Schlüssel hinterlegt.'); },
  fernwartungTechnikerAnlegen: async (i: { name: string; publicKey: string; notiz?: string | null; sshPublicKey?: string | null }) => {
    if (techniker.some((t) => t.publicKey === i.publicKey)) {
      throw new ApiError(409, 'Dieser Schlüssel ist schon einem Zugang zugeordnet. Jedes Gerät braucht seinen eigenen Schlüssel.');
    }
    const ssh = i.sshPublicKey ? sshFelder(i.sshPublicKey) : ohneSsh;
    const t: FernwartungTechniker = { id: `t-${Date.now()}`, name: i.name, publicKey: i.publicKey,
      publicKeyKurz: `${i.publicKey.slice(0, 8)}…${i.publicKey.slice(-6)}`, adresse: `10.10.32.${techniker.length + 5}`,
      status: 'aktiv', notiz: i.notiz ?? null, angelegtAm: new Date().toISOString(), geaendertAm: new Date().toISOString(), ...ssh };
    techniker = [...techniker, t];
    vermerke('techniker_angelegt', t, { name: t.name, adresse: t.adresse, publicKey: t.publicKeyKurz,
      ...(t.sshFingerabdruck ? { sshFingerabdruck: t.sshFingerabdruck } : {}) });
    return { techniker: t, server };
  },
  fernwartungTechnikerSshSetzen: async (id: string, sshPublicKey: string) => {
    const vorher = zugang(id);
    const ssh = sshFelder(sshPublicKey);
    if (ssh.sshPublicKey === vorher.sshPublicKey) return vorher;
    techniker = techniker.map((t) => (t.id === id ? { ...t, ...ssh, geaendertAm: new Date().toISOString() } : t));
    vermerke('techniker_ssh_schluessel_gesetzt', vorher, { name: vorher.name, fingerabdruck: ssh.sshFingerabdruck ?? '',
      bits: String(ssh.sshBits), ...(vorher.sshFingerabdruck ? { vorher: vorher.sshFingerabdruck } : {}) });
    return zugang(id);
  },
  fernwartungTechnikerSshEntfernen: async (id: string) => {
    const vorher = zugang(id);
    if (!vorher.sshFingerabdruck) return vorher;
    techniker = techniker.map((t) => (t.id === id ? { ...t, ...ohneSsh, geaendertAm: new Date().toISOString() } : t));
    vermerke('techniker_ssh_schluessel_entfernt', vorher, { name: vorher.name, fingerabdruck: vorher.sshFingerabdruck });
    return zugang(id);
  },
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
