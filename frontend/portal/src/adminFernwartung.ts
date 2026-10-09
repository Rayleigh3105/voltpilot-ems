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

/**
 * Ein gelöschter Techniker-Zugang hat keinen Status hier: die API lässt ihn aus
 * jeder Liste weg. Er lebt nur in früheren Fenstern und im Protokoll weiter.
 */
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
  /**
   * Der öffentliche SSH-Schlüssel des Technikers für die Anmeldung an der Box,
   * in Normalform (`ssh-rsa <Base64>`). Alle drei Felder sind gesetzt oder
   * alle drei null: ohne Schlüssel öffnet ein Fenster nur den Netzweg.
   */
  sshPublicKey: string | null;
  /** Wie `ssh-keygen -lf` ihn zeigt: `SHA256:…`. */
  sshFingerabdruck: string | null;
  sshBits: number | null;
}

export type ProtokollAktion =
  | 'box_schluessel_hinterlegt'
  | 'box_schluessel_getauscht'
  | 'box_gesperrt'
  | 'box_entsperrt'
  | 'techniker_angelegt'
  | 'techniker_gesperrt'
  | 'techniker_entsperrt'
  | 'techniker_geloescht'
  | 'techniker_ssh_schluessel_gesetzt'
  | 'techniker_ssh_schluessel_entfernt'
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
        sub: `${t.adresse} · ${t.sshFingerabdruck ? 'mit SSH-Schlüssel' : 'ohne SSH-Schlüssel'}`,
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

// ── SSH-Schlüssel des Technikers (Fenster-Schlüssel, Schritt 1) ─────────────

/** Der SSH-Port der Wartungs-Instanz auf der Box und der Port ihrer Web-App. */
export const BOX_SSH_PORT = 2222;
export const BOX_WEB_PORT = 8484;

/** Der Dateiname, den die Befehle des Portals durchgehend benutzen. */
export const SSH_DATEI = 'id_rsa_voltpilot';

export interface SshErzeugen {
  system: string;
  /** Erzeugt das Schlüsselpaar; der private Teil bleibt auf dem Gerät. */
  erzeugen: string;
  /** Gibt die eine Zeile aus, die ins Portal gehört. */
  anzeigen: string;
  /** Zeigt den Fingerabdruck zum Vergleich mit dem Portal. */
  fingerabdruck: string;
  hinweis: string | null;
}

/**
 * Die Befehle, mit denen der Techniker seinen Schlüssel erzeugt. RSA, weil der
 * SSH-Server der Boxen (Dropbear) nichts anderes annimmt; ein eigener
 * Dateiname, damit kein vorhandener Schlüssel überschrieben wird.
 */
export const SSH_ERZEUGEN: SshErzeugen[] = [
  {
    system: 'Windows (PowerShell)',
    erzeugen: `ssh-keygen -t rsa -b 3072 -f $env:USERPROFILE\\.ssh\\${SSH_DATEI}`,
    anzeigen: `Get-Content $env:USERPROFILE\\.ssh\\${SSH_DATEI}.pub`,
    fingerabdruck: `ssh-keygen -lf $env:USERPROFILE\\.ssh\\${SSH_DATEI}.pub`,
    hinweis: 'Fehlt der Ordner .ssh, legt ihn „mkdir $env:USERPROFILE\\.ssh“ an.',
  },
  {
    system: 'Linux und macOS',
    erzeugen: `ssh-keygen -t rsa -b 3072 -f ~/.ssh/${SSH_DATEI}`,
    anzeigen: `cat ~/.ssh/${SSH_DATEI}.pub`,
    fingerabdruck: `ssh-keygen -lf ~/.ssh/${SSH_DATEI}.pub`,
    hinweis: null,
  },
];

export interface SshBefehle {
  /** Anmeldung an der Box. */
  ssh: string;
  /** Dieselbe Anmeldung, die zusätzlich die Web-App der Box auf den eigenen Rechner holt. */
  webApp: string;
  /** Wo die Web-App dann im Browser des Technikers liegt. */
  webAdresse: string;
}

/**
 * Die fertigen Befehle für ein offenes Fenster. `~` löst der SSH-Client selbst
 * auf, deshalb gilt dieselbe Zeile unter Windows und Linux. Die Web-App der Box
 * ist im Tunnel nicht direkt offen; sie kommt über die SSH-Anmeldung.
 */
export function sshBefehle(boxAdresse: string): SshBefehle {
  const basis = `ssh -i ~/.ssh/${SSH_DATEI} -p ${BOX_SSH_PORT}`;
  return {
    ssh: `${basis} root@${boxAdresse}`,
    webApp: `${basis} -L ${BOX_WEB_PORT}:127.0.0.1:${BOX_WEB_PORT} root@${boxAdresse}`,
    webAdresse: `http://127.0.0.1:${BOX_WEB_PORT}`,
  };
}

/** „SHA256:… (RSA 3072)" - oder null ohne Schlüssel. */
export function sshText(t: Pick<FernwartungTechniker, 'sshFingerabdruck' | 'sshBits'>): string | null {
  if (!t.sshFingerabdruck) return null;
  return t.sshBits ? `${t.sshFingerabdruck} (RSA ${t.sshBits})` : t.sshFingerabdruck;
}

/** Was im Portal steht, wenn ein Zugang keinen SSH-Schlüssel hat. */
export const NUR_NETZWEG = 'nur Netzweg';

/**
 * Was die Seite über den SSH-Schlüssel ehrlich dazusagt: Das Portal gibt ihn
 * weiter, aber ob eine Box ihn holt, liegt nicht am Portal.
 *
 * ⚠ Der zweite Satz beschreibt den Stand vor den Schritten 2 (Tunnel-Dienst)
 * und 3 (Box-Skript). Wer Schritt 3 ausliefert, ersetzt ihn.
 */
export const SSH_STAND_SATZ =
  'Das Portal gibt den SSH-Schlüssel eines Zugangs an den Tunnel-Dienst weiter. Abholen können ihn die Boxen noch nicht: Bis Tunnel-Dienst und Box dafür eingerichtet sind, gelingt die Anmeldung nur mit einem Schlüssel, der schon auf der Box liegt.';

/** Der Satz beim Öffnen eines Fensters für einen Zugang ohne SSH-Schlüssel. */
export function nurNetzwegSatz(name: string): string {
  return `Dieses Fenster öffnet nur den Netzweg. Der Zugang „${name}“ hat keinen SSH-Schlüssel; an der Box anmelden kann sich damit nur, wessen Schlüssel dort schon liegt.`;
}

export interface FensterAnmeldung {
  befehle: SshBefehle;
  /**
   * Trägt der Zugang einen SSH-Schlüssel? `unbekannt`, wenn der Zugang nicht
   * in der geladenen Liste steht - das ist kein „fehlt".
   */
  schluessel: 'vorhanden' | 'fehlt' | 'unbekannt';
  /** Fingerabdruck des SSH-Schlüssels am Zugang, sonst null. */
  fingerabdruck: string | null;
  /** Ein Satz: womit die Anmeldung gelingt - oder dass das Fenster nur den Netzweg öffnet. */
  satz: string;
  ton: Ton;
}

/**
 * Was der Techniker für ein OFFENES Fenster braucht: die Befehle und die
 * ehrliche Auskunft, ob sein Zugang einen SSH-Schlüssel trägt. Für geplante
 * und beendete Fenster gibt es nichts anzumelden: null.
 */
export function fensterAnmeldung(
  f: FernwartungFenster,
  boxAdresse: string,
  techniker: FernwartungTechniker[],
): FensterAnmeldung | null {
  if (f.zustand !== 'offen') return null;
  const befehle = sshBefehle(boxAdresse);
  const t = techniker.find((x) => x.id === f.technikerId);
  if (!t) {
    return {
      befehle,
      schluessel: 'unbekannt',
      fingerabdruck: null,
      ton: 'off',
      satz: `Ob „${f.technikerName}“ einen SSH-Schlüssel hinterlegt hat, ist hier nicht bekannt.`,
    };
  }
  if (!t.sshFingerabdruck) {
    return {
      befehle,
      schluessel: 'fehlt',
      fingerabdruck: null,
      ton: 'warn',
      satz: `Nur Netzweg: „${f.technikerName}“ hat keinen SSH-Schlüssel. Anmelden kann sich nur, wessen Schlüssel schon auf der Box liegt.`,
    };
  }
  return {
    befehle,
    schluessel: 'vorhanden',
    fingerabdruck: t.sshFingerabdruck,
    ton: 'ok',
    satz: `Anmeldung mit dem SSH-Schlüssel ${t.sshFingerabdruck}, sobald die Box ihn abgeholt hat oder wenn er schon auf ihr liegt.`,
  };
}

export const SSH_ERZEUGEN_KURZ = 'ssh-keygen -t rsa -b 3072';
export const SSH_MIN_BITS = 2048;
export const SSH_MAX_BITS = 4096;

export type SshPruefung = { ok: true; bits: number } | { ok: false; fehler: string };

const SSH_KEIN_SCHLUESSEL =
  'Das ist kein öffentlicher SSH-Schlüssel. Erwartet wird die eine Zeile aus der .pub-Datei; sie beginnt mit „ssh-rsa AAAA".';
const SSH_BESCHAEDIGT =
  'Der SSH-Schlüssel ist beschädigt oder unvollständig. Bitte die ganze Zeile aus der .pub-Datei kopieren.';

function sshFremderTyp(typ: string): string | null {
  if (typ.startsWith('sk-')) return 'ein FIDO-Sicherheitsschlüssel';
  if (typ.startsWith('ssh-ed25519')) return 'ein Ed25519-Schlüssel';
  if (typ.startsWith('ecdsa-sha2-')) return 'ein ECDSA-Schlüssel';
  if (typ.startsWith('ssh-dss')) return 'ein DSA-Schlüssel';
  return null;
}

/** Die Felder des SSH-Formats: je vier Byte Länge, dann die Bytes. Null, wenn es nicht aufgeht. */
function sshFelder(base64: string): Uint8Array[] | null {
  let roh: string;
  try {
    roh = atob(base64);
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(roh, (c) => c.charCodeAt(0));
  const felder: Uint8Array[] = [];
  let i = 0;
  while (i < bytes.length) {
    if (i + 4 > bytes.length) return null;
    const laenge = bytes[i] * 2 ** 24 + bytes[i + 1] * 2 ** 16 + bytes[i + 2] * 2 ** 8 + bytes[i + 3];
    i += 4;
    if (i + laenge > bytes.length) return null;
    felder.push(bytes.subarray(i, i + laenge));
    i += laenge;
  }
  return felder;
}

/** Bitlänge einer vorzeichenbehafteten Zahl im SSH-Format; -1, wenn sie nicht positiv ist. */
function sshBitlaenge(zahl: Uint8Array): number {
  if (zahl.length === 0 || zahl[0] >= 0x80) return -1;
  let i = 0;
  while (i < zahl.length && zahl[i] === 0) i += 1;
  if (i === zahl.length) return -1;
  return (zahl.length - i - 1) * 8 + (32 - Math.clz32(zahl[i]));
}

/**
 * Dieselben Regeln wie die API (`SshSchluessel.java`), schon im Browser: nur
 * `ssh-rsa`, 2048 bis 4096 Bit, eine Zeile, keine Optionen davor. Wichtig ist
 * das vor allem für einen versehentlich eingefügten PRIVATEN Schlüssel - er
 * verlässt den Browser so gar nicht erst. Den Fingerabdruck berechnet die API.
 */
export function sshSchluesselPruefen(eingabe: string): SshPruefung {
  const text = eingabe.trim();
  if (!text) return { ok: false, fehler: 'Der SSH-Schlüssel fehlt.' };
  if (text.includes('PRIVATE KEY')) {
    return {
      ok: false,
      fehler:
        'Das ist ein privater Schlüssel. Er gehört nie ins Portal. Bitte die Zeile aus der Datei mit der Endung .pub eintragen.',
    };
  }
  if (text.length > 2000) {
    return { ok: false, fehler: 'Das ist kein öffentlicher SSH-Schlüssel: die Eingabe ist zu lang.' };
  }
  if (/[\r\n]/.test(text)) {
    return {
      ok: false,
      fehler: 'Der SSH-Schlüssel muss genau eine Zeile sein: der Inhalt der .pub-Datei, ohne Zeilenumbruch.',
    };
  }
  const teile = text.split(/[ \t]+/);
  const fremd = sshFremderTyp(teile[0]);
  if (fremd) {
    return {
      ok: false,
      fehler: `Das ist ${fremd}. Die Boxen nehmen nur RSA an. Bitte einen RSA-Schlüssel erzeugen: ${SSH_ERZEUGEN_KURZ}`,
    };
  }
  if (teile[0] !== 'ssh-rsa') {
    return {
      ok: false,
      fehler: teile.slice(1).includes('ssh-rsa')
        ? 'Vor dem Schlüssel dürfen keine Optionen stehen: die Zeile muss mit „ssh-rsa" beginnen.'
        : SSH_KEIN_SCHLUESSEL,
    };
  }
  const felder = teile.length > 1 ? sshFelder(teile[1]) : null;
  if (!felder || felder.length !== 3 || String.fromCharCode(...felder[0]) !== 'ssh-rsa') {
    return { ok: false, fehler: SSH_BESCHAEDIGT };
  }
  const bits = sshBitlaenge(felder[2]);
  if (bits < 0 || sshBitlaenge(felder[1]) < 2) return { ok: false, fehler: SSH_BESCHAEDIGT };
  if (bits < SSH_MIN_BITS) {
    return {
      ok: false,
      fehler: `Der RSA-Schlüssel hat nur ${bits} Bit, verlangt sind mindestens ${SSH_MIN_BITS}. Bitte einen neuen erzeugen: ${SSH_ERZEUGEN_KURZ}`,
    };
  }
  if (bits > SSH_MAX_BITS) {
    return {
      ok: false,
      fehler: `Der RSA-Schlüssel hat ${bits} Bit, die Boxen sind nur bis ${SSH_MAX_BITS} Bit geprüft. Bitte einen neuen erzeugen: ${SSH_ERZEUGEN_KURZ}`,
    };
  }
  return { ok: true, bits };
}

// ── Techniker-Zugang löschen ────────────────────────────────────────────────

export interface Rueckfrage {
  titel: string;
  /** EIN Satz: was passiert und dass es endgültig ist. */
  satz: string;
  /** Was dabei gleich bleibt. */
  folgen: string[];
}

/**
 * Löschbar ist nur ein gesperrter Zugang; ein aktiver muss erst gesperrt
 * werden (das Sperren schließt seine Fenster und nimmt ihn vom Server).
 */
export function loeschbar(t: FernwartungTechniker): boolean {
  return t.status === 'gesperrt';
}

/**
 * Die Rückfrage vor dem Löschen. Adresse und Schlüssel stehen im Satz, weil
 * zwei Zugänge denselben Namen tragen können - genau dann wird gelöscht. Der
 * Name steht im Satz und nicht im Titel: der Titel eines Dialogs ist einzeilig
 * und schnitte einen Namen am Telefon ab.
 */
export function loeschenRueckfrage(t: FernwartungTechniker): Rueckfrage {
  return {
    titel: 'Zugang löschen?',
    satz: `Der gesperrte Zugang „${t.name}“ (${t.adresse}, ${t.publicKeyKurz}) verschwindet endgültig aus allen Listen und lässt sich nicht wiederherstellen.`,
    folgen: [
      'Seine Tunnel-Adresse und sein Schlüssel bleiben vergeben und werden nie wieder zugeteilt.',
      'Frühere Fenster und Protokolleinträge bleiben lesbar und nennen den Zugang weiter beim Namen.',
    ],
  };
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
  techniker_geloescht: 'Techniker-Zugang gelöscht',
  techniker_ssh_schluessel_gesetzt: 'SSH-Schlüssel gesetzt',
  techniker_ssh_schluessel_entfernt: 'SSH-Schlüssel entfernt',
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
      return [d.adresse, d.publicKey].filter(Boolean).join(' · ');
    case 'techniker_angelegt':
      return [d.adresse, d.publicKey, d.sshFingerabdruck ? `SSH ${d.sshFingerabdruck}` : null]
        .filter(Boolean)
        .join(' · ');
    case 'techniker_ssh_schluessel_gesetzt':
      return [
        d.fingerabdruck,
        d.bits ? `RSA ${d.bits}` : null,
        d.vorher ? `ersetzt ${d.vorher}` : null,
      ]
        .filter(Boolean)
        .join(' · ');
    case 'techniker_ssh_schluessel_entfernt':
      return d.fingerabdruck ? `${d.fingerabdruck} · der Zugang öffnet nur noch den Netzweg` : '';
    case 'box_schluessel_getauscht':
      return `${d.alt ?? '?'} → ${d.neu ?? '?'}`;
    case 'box_gesperrt':
    case 'techniker_gesperrt':
      return d.grund ? `Grund: ${d.grund}` : '';
    case 'techniker_geloescht': {
      const vergeben = [d.adresse, d.publicKey].filter(Boolean).join(' · ');
      return vergeben ? `${vergeben} · bleiben vergeben` : '';
    }
    default:
      return '';
  }
}
