/**
 * Fernwartung (Entscheid E5, 07.10.2026): die reine Schicht hinter der
 * Plattform-Seite „Geräte › Fernwartung" und der Karte auf der Box-Seite.
 *
 * Das Portal führt den SOLL-Zustand (Schlüssel, Adressen, Fenster); ein
 * Tunnel-Dienst auf der Wartungs-VM holt ihn ab und setzt ihn um. Er meldet
 * nichts zurück. Deshalb trennt diese Schicht streng:
 *   - was im Portal steht (Fenster offen bis …),
 *   - wann der Dienst zuletzt abgeholt hat (`abrufLage`),
 *   - was niemand weiß (ob es auf dem Server wirkt, ob die Box verbunden ist).
 *
 * O3: der Kunde sieht davon nichts; alles hier ist Plattform-Admin.
 * E10: was nicht geht, bleibt sichtbar und nennt seinen Grund.
 */
import type { VpOption } from './picker/optionen';

// ── Formen der API (/api/v1/admin/fernwartung) ──────────────────────────────

export interface FernwartungServer {
  endpunkt: string;
  port: number;
  /** null, solange die Wartungs-VM nicht eingerichtet ist. */
  publicKey: string | null;
  eingerichtet: boolean;
  boxNetz: string;
  technikerNetz: string;
  boxServerAdresse: string;
  technikerServerAdresse: string;
}

export interface FernwartungAbruf {
  dienst: string;
  zuletztAm: string;
  peers: number;
  fenster: number;
}

export interface FernwartungUebersicht {
  server: FernwartungServer;
  maxFensterMinuten: number;
  abrufe: FernwartungAbruf[];
  boxenAktiv: number;
  boxenGesperrt: number;
  technikerAktiv: number;
  technikerGesperrt: number;
  fensterOffen: number;
  fensterGeplant: number;
  stand: string;
}

export type FensterZustand = 'offen' | 'geplant' | 'geschlossen' | 'abgesagt' | 'abgelaufen';

export interface FernwartungFenster {
  id: string;
  edgeRef: string;
  technikerId: string;
  technikerName: string;
  grund: string;
  beginn: string;
  ende: string;
  wirksamesEnde: string;
  zustand: FensterZustand;
  geoeffnetAm: string;
  geoeffnetVon: string;
  geschlossenAm: string | null;
  geschlossenVon: string | null;
}

export type ZugangStatus = 'aktiv' | 'gesperrt';

export interface FernwartungBox {
  id: string;
  edgeRef: string;
  publicKey: string;
  publicKeyKurz: string;
  adresse: string;
  status: ZugangStatus;
  notiz: string | null;
  angelegtAm: string;
  geaendertAm: string;
  siteId: string | null;
  siteName: string | null;
  tenantId: string | null;
  tenantName: string | null;
  /** Offene UND geplante Fenster dieser Box. */
  laufendeFenster: FernwartungFenster[];
}

export interface FernwartungTechniker {
  id: string;
  name: string;
  publicKey: string;
  publicKeyKurz: string;
  adresse: string;
  status: ZugangStatus;
  notiz: string | null;
  angelegtAm: string;
  geaendertAm: string;
}

export type ProtokollAktion =
  | 'box_schluessel_hinterlegt'
  | 'box_schluessel_getauscht'
  | 'box_gesperrt'
  | 'box_entsperrt'
  | 'techniker_angelegt'
  | 'techniker_gesperrt'
  | 'techniker_entsperrt'
  | 'fenster_geoeffnet'
  | 'fenster_geschlossen';

export interface FernwartungProtokollEintrag {
  id: string;
  zeit: string;
  akteur: string;
  aktion: ProtokollAktion;
  edgeRef: string | null;
  technikerId: string | null;
  technikerName: string | null;
  fensterId: string | null;
  details: Record<string, string>;
}

export interface FernwartungSchluesselAntwort {
  ergebnis: 'angelegt' | 'unveraendert' | 'getauscht';
  box: FernwartungBox;
  server: FernwartungServer;
}

export interface FernwartungTechnikerAntwort {
  techniker: FernwartungTechniker;
  server: FernwartungServer;
}

// ── Zeit ────────────────────────────────────────────────────────────────────

const UHR = new Intl.DateTimeFormat('de-DE', {
  timeZone: 'Europe/Berlin',
  hour: '2-digit',
  minute: '2-digit',
});
const TAG_UHR = new Intl.DateTimeFormat('de-DE', {
  timeZone: 'Europe/Berlin',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const TAG = new Intl.DateTimeFormat('de-DE', {
  timeZone: 'Europe/Berlin',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** „15:30" am selben Tag, sonst „08.10., 15:30" (Europe/Berlin). */
export function zeitpunkt(iso: string, jetzt: Date): string {
  const t = new Date(iso);
  return TAG.format(t) === TAG.format(jetzt) ? UHR.format(t) : TAG_UHR.format(t);
}

/** „1 Stunde", „4 Stunden", „90 Minuten". */
export function dauerText(minuten: number): string {
  if (minuten % 60 === 0) {
    const h = minuten / 60;
    return h === 1 ? '1 Stunde' : `${h} Stunden`;
  }
  return minuten === 1 ? '1 Minute' : `${minuten} Minuten`;
}

function alterSek(iso: string, jetzt: Date): number {
  return Math.max(0, (jetzt.getTime() - new Date(iso).getTime()) / 1000);
}

function alterText(s: number): string {
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} Tagen`;
}

// ── Lage des Dienstes und des Servers ───────────────────────────────────────

export type Ton = 'ok' | 'warn' | 'off';

export interface Lage {
  ton: Ton;
  titel: string;
  text: string;
}

/** Ab diesem Alter des letzten Abrufs holt der Dienst offenbar nicht mehr ab. */
export const ABRUF_VERALTET_S = 180;

/**
 * Holt der Tunnel-Dienst überhaupt ab? Das ist ALLES, was das Portal über die
 * Server-Seite weiß - nicht, ob ein Fenster dort wirkt.
 */
export function abrufLage(u: FernwartungUebersicht, jetzt: Date): Lage {
  const letzter = [...u.abrufe].sort((a, b) => b.zuletztAm.localeCompare(a.zuletztAm))[0];
  if (!letzter) {
    return {
      ton: 'off',
      titel: 'Tunnel-Dienst holt nicht ab',
      text: 'Der Tunnel-Dienst hat den Soll-Stand noch nie abgeholt. Fenster und Sperren wirken erst, wenn er auf der Wartungs-VM läuft.',
    };
  }
  const s = alterSek(letzter.zuletztAm, jetzt);
  if (s > ABRUF_VERALTET_S) {
    return {
      ton: 'warn',
      titel: 'Tunnel-Dienst holt nicht mehr ab',
      text: `Letzter Abruf vor ${alterText(s)}. Änderungen hier wirken erst, wenn er wieder abholt; offene Fenster laufen auf dem Server zu ihrer Zeit ab.`,
    };
  }
  return {
    ton: 'ok',
    titel: 'Tunnel-Dienst holt ab',
    text: `Soll-Stand zuletzt vor ${alterText(s)} abgeholt (${letzter.peers} Zugänge, ${letzter.fenster} offene Fenster).`,
  };
}

/** Steht der Wartungsserver? Ohne Server-Schlüssel kann keine Box ihn eintragen. */
export function serverLage(server: FernwartungServer): Lage {
  if (!server.eingerichtet) {
    return {
      ton: 'warn',
      titel: 'Wartungsserver noch nicht eingerichtet',
      text: `Der API fehlt der öffentliche Schlüssel des Servers ${server.endpunkt}:${server.port}. Boxen und Techniker können ihn erst danach eintragen.`,
    };
  }
  return {
    ton: 'ok',
    titel: `${server.endpunkt}:${server.port}`,
    text: `Boxen ${server.boxNetz}, Techniker ${server.technikerNetz}.`,
  };
}

/** Der Satz, den jede Fernwartungs-Fläche ehrlich mitträgt. */
export const UNBEKANNT_SATZ =
  'Ob ein Fenster auf dem Server wirkt und ob die Box gerade verbunden ist, meldet der Tunnel-Dienst nicht zurück.';

/** Der O3-Satz: warum es keine Kundenfläche gibt. */
export const ZUSTIMMUNG_SATZ =
  'Der Kunde hat der Fernwartung über Vertrag/AGB zugestimmt und sieht die einzelnen Fenster nicht. Jedes Fenster wird mit Grund, Techniker und Zeit protokolliert.';

// ── Fenster ─────────────────────────────────────────────────────────────────

/** Ein Fenster in einem Satz: „offen bis 15:30 · Max (Laptop)". */
export function fensterText(f: FernwartungFenster, jetzt: Date): string {
  switch (f.zustand) {
    case 'offen':
      return `offen bis ${zeitpunkt(f.ende, jetzt)} · ${f.technikerName}`;
    case 'geplant':
      return `geplant ab ${zeitpunkt(f.beginn, jetzt)} · ${f.technikerName}`;
    case 'geschlossen':
      return `vorzeitig geschlossen ${zeitpunkt(f.geschlossenAm ?? f.wirksamesEnde, jetzt)}`;
    case 'abgesagt':
      return 'abgesagt';
    default:
      return `abgelaufen ${zeitpunkt(f.ende, jetzt)}`;
  }
}

const ZUSTAND_LABEL: Record<FensterZustand, string> = {
  offen: 'offen',
  geplant: 'geplant',
  geschlossen: 'geschlossen',
  abgesagt: 'abgesagt',
  abgelaufen: 'abgelaufen',
};

/**
 * Dasselbe wie {@link fensterText}, aber zerlegt: der Zustand für das Abzeichen,
 * der Rest als laufender Text (ein langer Satz im Abzeichen bricht unschön um).
 */
export function fensterTeile(f: FernwartungFenster, jetzt: Date): { zustand: string; text: string } {
  const ganz = fensterText(f, jetzt);
  const zustand = ZUSTAND_LABEL[f.zustand];
  const rest = ganz.startsWith(zustand) ? ganz.slice(zustand.length).trim() : ganz;
  return { zustand, text: rest.replace(/^vorzeitig geschlossen\s*/, '') };
}

export function fensterTon(z: FensterZustand): Ton {
  return z === 'offen' ? 'ok' : z === 'geplant' ? 'warn' : 'off';
}

export const DAUER_MINUTEN = [30, 60, 240, 1440] as const;

/** Die Dauer-Auswahl; was über der Server-Grenze liegt, bleibt sichtbar gesperrt. */
export function dauerOptionen(maxMinuten: number): VpOption[] {
  return DAUER_MINUTEN.map((m) => ({
    value: String(m),
    label: dauerText(m),
    disabled: m > maxMinuten,
    disabledHint: m > maxMinuten ? `länger als erlaubt (höchstens ${dauerText(maxMinuten)})` : null,
  }));
}

/** Techniker-Auswahl für EIN Fenster an dieser Box. */
export function technikerOptionen(
  techniker: FernwartungTechniker[],
  box: FernwartungBox,
  jetzt: Date,
): VpOption[] {
  return [...techniker]
    .sort((a, b) => a.name.localeCompare(b.name, 'de'))
    .map((t) => {
      const laufend = box.laufendeFenster.find((f) => f.technikerId === t.id);
      const grund =
        t.status === 'gesperrt'
          ? 'Zugang gesperrt'
          : laufend
            ? `hat schon ein Fenster (${fensterText(laufend, jetzt)})`
            : null;
      return {
        value: t.id,
        label: t.name,
        sub: t.adresse,
        disabled: grund != null,
        disabledHint: grund,
      };
    });
}

/**
 * Warum „Fenster öffnen" an dieser Box nicht geht - oder null. Der Knopf
 * bleibt sichtbar und nennt den Grund (E10).
 */
export function oeffnenSperre(box: FernwartungBox, techniker: FernwartungTechniker[]): string | null {
  if (box.status === 'gesperrt') {
    return 'Die Box ist für die Fernwartung gesperrt - erst entsperren.';
  }
  const aktiv = techniker.filter((t) => t.status === 'aktiv');
  if (aktiv.length === 0) {
    return 'Es gibt keinen aktiven Techniker-Zugang - erst einen Zugang anlegen.';
  }
  if (aktiv.every((t) => box.laufendeFenster.some((f) => f.technikerId === t.id))) {
    return 'Jeder aktive Zugang hat für diese Box schon ein Fenster.';
  }
  return null;
}

/** Das offene Fenster (zuerst endend), sonst null. */
export function offenesFenster(box: FernwartungBox): FernwartungFenster | null {
  return (
    box.laufendeFenster
      .filter((f) => f.zustand === 'offen')
      .sort((a, b) => a.ende.localeCompare(b.ende))[0] ?? null
  );
}

// ── Box und Techniker einrichten ────────────────────────────────────────────

/** Wo die Box hängt - oder ehrlich, dass sie noch keinem Kunden gehört. */
export function boxOrt(box: FernwartungBox): string {
  if (box.siteName) {
    return box.tenantName ? `${box.siteName} · ${box.tenantName}` : box.siteName;
  }
  return 'noch nicht gekoppelt';
}

/**
 * Die Befehlszeile für die Box (edge-light/openwrt/service-tunnel.sh): der
 * Schlüssel bleibt auf der Box, das Portal liefert Adresse und Server-Seite.
 * Ohne Server-Schlüssel gibt es noch keinen Befehl.
 */
export function boxBefehl(box: FernwartungBox, server: FernwartungServer): string | null {
  if (!server.publicKey) return null;
  return [
    `VP_SERVICE_ENDPOINT=${server.endpunkt}`,
    `VP_SERVICE_PUBKEY='${server.publicKey}'`,
    `VP_SERVICE_NET=${server.technikerNetz}`,
    'edge-light/openwrt/service-tunnel.sh',
    'root@<box>',
    box.adresse,
    String(server.port),
  ].join(' ');
}

/**
 * Die WireGuard-Konfiguration für das Gerät des Technikers. Der private
 * Schlüssel entsteht dort und kommt nie ins Portal - deshalb ein Platzhalter.
 */
export function technikerKonfig(t: FernwartungTechniker, server: FernwartungServer): string {
  return [
    '[Interface]',
    '# Privater Schlüssel: auf diesem Gerät erzeugt (wg genkey), nie ins Portal',
    'PrivateKey = <privater Schlüssel dieses Geräts>',
    `Address = ${t.adresse}/32`,
    '',
    '[Peer]',
    `# VoltPilot Wartungsserver`,
    `PublicKey = ${server.publicKey ?? '<Server-Schlüssel fehlt noch>'}`,
    `Endpoint = ${server.endpunkt}:${server.port}`,
    `AllowedIPs = ${server.boxNetz}`,
    'PersistentKeepalive = 25',
    '',
  ].join('\n');
}

const WG_SCHLUESSEL = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;

/** Dieselbe Form wie API und Tunnel-Dienst: 44 Zeichen Base64, endet auf „=". */
export function schluesselGueltig(s: string): boolean {
  return WG_SCHLUESSEL.test(s.trim());
}

// ── Protokoll ───────────────────────────────────────────────────────────────

const AKTION: Record<ProtokollAktion, string> = {
  box_schluessel_hinterlegt: 'Box-Schlüssel hinterlegt',
  box_schluessel_getauscht: 'Box-Schlüssel getauscht',
  box_gesperrt: 'Box gesperrt',
  box_entsperrt: 'Box entsperrt',
  techniker_angelegt: 'Techniker-Zugang angelegt',
  techniker_gesperrt: 'Techniker-Zugang gesperrt',
  techniker_entsperrt: 'Techniker-Zugang entsperrt',
  fenster_geoeffnet: 'Fenster geöffnet',
  fenster_geschlossen: 'Fenster geschlossen',
};

export function aktionLabel(a: ProtokollAktion | string): string {
  return AKTION[a as ProtokollAktion] ?? a;
}

const ANLASS: Record<string, string> = {
  vorzeitig: 'vorzeitig',
  abgesagt: 'abgesagt',
  box_gesperrt: 'weil die Box gesperrt wurde',
  techniker_gesperrt: 'weil der Zugang gesperrt wurde',
};

/** Die Einzelheiten eines Eintrags als ein Satz. */
export function protokollDetail(e: FernwartungProtokollEintrag, jetzt: Date): string {
  const d = e.details ?? {};
  switch (e.aktion) {
    case 'fenster_geoeffnet': {
      const teile = [
        d.dauerMinuten ? dauerText(Number(d.dauerMinuten)) : null,
        d.beginn ? `ab ${zeitpunkt(d.beginn, jetzt)}` : null,
        d.grund ? `Grund: ${d.grund}` : null,
      ];
      return teile.filter(Boolean).join(' · ');
    }
    case 'fenster_geschlossen':
      return d.anlass ? (ANLASS[d.anlass] ?? d.anlass) : '';
    case 'box_schluessel_hinterlegt':
    case 'techniker_angelegt':
      return [d.adresse, d.publicKey].filter(Boolean).join(' · ');
    case 'box_schluessel_getauscht':
      return `${d.alt ?? '?'} → ${d.neu ?? '?'}`;
    case 'box_gesperrt':
    case 'techniker_gesperrt':
      return d.grund ? `Grund: ${d.grund}` : '';
    default:
      return '';
  }
}
