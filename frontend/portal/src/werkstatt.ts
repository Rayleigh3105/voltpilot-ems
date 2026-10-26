/**
 * Werkstatt (Entscheid des Kapitäns vom 26.10.2026, erster Schnitt aus dem Bericht
 * voltpilot-box-einrichtung-portal): die reine Schicht hinter „Geräte › Werkstatt“.
 *
 * Die Seite führt durch die Einrichtung eines Edge Light (GL.iNet Mango mit OpenWrt), wie sie heute
 * geht: Die Befehle laufen weiter am eigenen Rechner, mit dem Repository; das Portal zeigt sie fertig
 * an, hält fest, welcher Schritt erledigt ist, öffnet für die Werkstatt-Probe ein Fenster und schließt
 * es wieder, und legt am Ende das Abnahmeprotokoll an (Werkstatt-Regel, `edge-light/docs/mango.md`).
 *
 * Eingebaut sind die Entscheide vom 26.10.2026:
 *   3a  je Box ein eigenes, zufälliges Root-Passwort, einmal angezeigt, abgelegt vom Betreiber;
 *       es entsteht hier im Browser und geht nie an die API,
 *   6a  das LAN der Box auf ein unübliches Netz,
 *   5c  keine Box mit Stufe 1 an einen Kunden: Der Ablauf endet mit der Abnahme, nicht mit dem Versand,
 *   8   Referenz und QR-Code werden aufs Gehäuse gedruckt, kein Aufkleber.
 *
 * Reines Modul: kein React, kein Netzwerk.
 */
import { BOX_SSH_PORT, SSH_DATEI, type FernwartungFenster, type FernwartungServer } from './adminFernwartung';
import { koppelLink } from './koppelLink';

// ── Formen der API (/api/v1/admin/werkstatt) ────────────────────────────────

export type BoxArt = 'edge-light' | 'edge-app';

export interface WerkstattSchrittStand {
  /** ISO-Zeit, zu der der Haken gesetzt wurde. */
  am: string;
  von: string;
}

/** Was das Portal über das Fenster der Werkstatt-Probe wusste; null = keine Meldung nannte es. */
export interface WerkstattProbeBeleg {
  fensterId: string;
  technikerName: string;
  grund: string;
  beginn: string;
  ende: string;
  geschlossenAm: string | null;
  geschlossenVon: string | null;
  schluesselAbgeholtUm: string | null;
  gemeldetAm: string | null;
}

export interface WerkstattAbnahme {
  id: string;
  edgeRef: string;
  hostSchluessel: string;
  fassung: string;
  tunnelAdresse: string;
  lanNetz: string;
  pruefungen: string[];
  probe: WerkstattProbeBeleg;
  notiz: string | null;
  erfasstAm: string;
  erfasstVon: string;
}

export interface WerkstattBox {
  id: string;
  edgeRef: string;
  boxArt: BoxArt;
  /** Die LAN-Adresse der Box mit Präfix, sobald sie festgehalten ist (Entscheid 6a). */
  lanNetz: string | null;
  schritte: Record<string, WerkstattSchrittStand>;
  notiz: string | null;
  angelegtAm: string;
  angelegtVon: string;
  geaendertAm: string;
  /** Neueste zuerst; leer = noch nicht abgenommen. */
  abnahmen: WerkstattAbnahme[];
}

export interface WerkstattGrundlagen {
  pruefungen: string[];
  lanNetzVorschlag: string;
}

// ── Die Prüfungen der Werkstatt-Regel ──────────────────────────────────────

/** Zwilling von `WerkstattPruefungen.java`; Vektor: `docs/contracts/werkstatt-pruefungen.json`. */
export const PRUEFUNGEN = [
  { id: 'root_passwort', text: 'Root-Passwort gesetzt: je Box ein eigenes, zufällig erzeugt, in der Passwortablage' },
  { id: 'notfall_schluessel', text: 'Genau ein dauerhafter Schlüssel auf der Box, und sein Fingerabdruck ist der des Notfall-Schlüssels' },
  { id: 'tunnel_status', text: 'Tunnel eingerichtet: Handshake, SSH 2222 außerhalb der Tunnel abgewiesen, Abholer läuft' },
  { id: 'anmeldeprobe', text: 'Anmeldung über Portal und Tunnel im Fenster der Werkstatt-Probe gelungen' },
  { id: 'host_schluessel', text: 'Host-Schlüssel auf zwei Wegen gelesen und gleich' },
  { id: 'fenster_zu', text: 'Fenster geschlossen, der neue Versuch endet mit Connection timed out' },
  { id: 'lan_netz', text: 'LAN der Box auf ein unübliches Netz gestellt' },
  { id: 'neustart', text: 'Neustart-Probe: Tunnel wieder oben, dieselbe Referenz, ein dauerhafter Schlüssel' },
] as const;

export type PruefungId = (typeof PRUEFUNGEN)[number]['id'];

// ── Feste Größen des Ablaufs ────────────────────────────────────────────────

/** So meldet sich eine frische Mango im LAN; der Name aus der SSH-Konfiguration zeigt darauf. */
export const BOX_WERKSEITIG = '192.168.1.1';
/** Der Name der Box am Werkstatt-Tisch (`~/.ssh/config`, siehe {@link SSH_KONFIG}). */
export const SSH_NAME = 'mango';
/** Die Fassung, die alle Skripte erwarten (apk, Dropbear ab 2025.89). */
export const OPENWRT_FASSUNG = '25.12.5';
export const OPENWRT_ABBILD = `openwrt-${OPENWRT_FASSUNG}-ramips-mt76x8-glinet_gl-mt300n-v2-squashfs-sysupgrade.bin`;
export const OPENWRT_QUELLE = `https://downloads.openwrt.org/releases/${OPENWRT_FASSUNG}/targets/ramips/mt76x8/`;
/** Der öffentliche Teil des Notfall-Schlüssels (Entscheid K2 a vom 08.10.2026). */
export const NOTFALL_PUB = 'voltpilot-notfall.pub';
export const PROBE_GRUND = 'Werkstatt-Probe';
/** Wie die Werkstatt-Regel in `mango.md`: 30 Minuten, die kürzeste Dauer im Dialog der Fernwartung. Die Seite schließt das Fenster nach der Probe ohnehin selbst. */
export const PROBE_MINUTEN = 30;

/** Der Eintrag in `~/.ssh/config`: eine gehaltene Verbindung fragt einmal nach dem Passwort statt rund 14-mal. */
export const SSH_KONFIG = [
  `Host ${SSH_NAME}`,
  `    HostName ${BOX_WERKSEITIG}`,
  '    User root',
  '    ControlMaster auto',
  '    ControlPath ~/.ssh/vp-%C',
  '    ControlPersist 30m',
].join('\n');

/** Was einmal bereitliegen muss, bevor die erste Box kommt (Bericht, Abschnitt 2.1). */
export const VORBEREITUNG: readonly { titel: string; text: string; befehle: string[] }[] = [
  {
    titel: 'Rechner mit dem Repository',
    text: 'Stand main, dazu ssh, ssh-keygen, ssh-keyscan und Docker oder Go ab 1.24 zum Bauen. Nach jedem git pull das Programm neu bauen.',
    befehle: ['git pull', 'edge-light/scripts/build.sh mipsle'],
  },
  {
    titel: `OpenWrt ${OPENWRT_FASSUNG}`,
    text: `Das Abbild ${OPENWRT_ABBILD} von ${OPENWRT_QUELLE} und dort die Datei sha256sums; die Prüfsumme muss übereinstimmen.`,
    befehle: [`sha256sum ${OPENWRT_ABBILD}`],
  },
  {
    titel: 'Notfall-Schlüssel',
    text: `Einmal erzeugen, mit Kennwort. Der private Teil liegt getrennt (Datenträger im Tresor, zweite Kopie woanders), auf dem Werkstatt-Rechner nur ${NOTFALL_PUB}; der Fingerabdruck steht in der Passwortablage.`,
    befehle: ['ssh-keygen -t rsa -b 4096 -C voltpilot-notfall -f voltpilot-notfall', `ssh-keygen -lf ${NOTFALL_PUB}`],
  },
  {
    titel: 'Der Name der Box am Tisch',
    text: 'In ~/.ssh/config eintragen. Das SSH von Windows kennt die drei Control-Zeilen nicht; dann fragt jeder Befehl nach dem Passwort.',
    befehle: [SSH_KONFIG],
  },
];

// ── Root-Passwort (Entscheid 3a) ────────────────────────────────────────────

/** Ohne 0/O, 1/l/I: das Passwort wird abgeschrieben oder eingefügt, nie geraten. */
export const PASSWORT_ZEICHEN = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PASSWORT_GRUPPEN = 5;
const PASSWORT_GRUPPE = 4;

/**
 * Ein Root-Passwort: 20 Zeichen aus 56 (rund 116 Bit), in Gruppen zu vier mit Bindestrich, damit es
 * sich in die Ablage übertragen lässt. `zufall` liefert gleichverteilte Bytes (im Browser
 * `crypto.getRandomValues`); Bytes über dem größten Vielfachen von 56 werden verworfen, damit kein
 * Zeichen häufiger vorkommt als ein anderes. Nur Buchstaben, Ziffern und Bindestrich: Die Zeile lässt
 * sich in jedes Terminal einfügen.
 */
export function erzeugePasswort(zufall: (n: number) => Uint8Array): string {
  const n = PASSWORT_ZEICHEN.length;
  const grenze = 256 - (256 % n);
  const zeichen: string[] = [];
  while (zeichen.length < PASSWORT_GRUPPEN * PASSWORT_GRUPPE) {
    for (const b of zufall(32)) {
      if (b < grenze && zeichen.length < PASSWORT_GRUPPEN * PASSWORT_GRUPPE) zeichen.push(PASSWORT_ZEICHEN[b % n]);
    }
  }
  const gruppen: string[] = [];
  for (let i = 0; i < zeichen.length; i += PASSWORT_GRUPPE) gruppen.push(zeichen.slice(i, i + PASSWORT_GRUPPE).join(''));
  return gruppen.join('-');
}

// ── LAN-Netz (Entscheid 6a) ─────────────────────────────────────────────────

/** Die Form, die die API annimmt; Lage und übliche Heimnetze prüft sie selbst (`LanNetz.java`). */
export function lanNetzForm(text: string): { adresse: string; praefix: number } | null {
  const m = /^\s*(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})\s*$/.exec(text);
  if (!m) return null;
  const oktette = m.slice(1, 5).map(Number);
  const praefix = Number(m[5]);
  if (oktette.some((o) => o > 255) || praefix < 16 || praefix > 28) return null;
  return { adresse: oktette.join('.'), praefix };
}

/**
 * Die Befehlszeile, die das LAN der Box umstellt und sie neu startet. Die Liste `ipaddr` mit Präfix
 * ersetzt Adresse und Netzmaske; DHCP im LAN folgt dem neuen Netz von selbst.
 */
export function lanBefehl(lanNetz: string): string | null {
  const f = lanNetzForm(lanNetz);
  if (!f) return null;
  return (
    `ssh ${SSH_NAME} "uci -q delete network.lan.ipaddr; uci -q delete network.lan.netmask; ` +
    `uci add_list network.lan.ipaddr='${f.adresse}/${f.praefix}'; uci commit network && reboot"`
  );
}

// ── Befehle mit Tunnel ──────────────────────────────────────────────────────

/**
 * Die Befehlszeile aus dem Portal (`boxBefehl`), mit dem Namen der Box am Tisch statt `root@<box>`.
 * Sie gilt im Wurzelverzeichnis des Repositorys.
 */
export function tunnelBefehl(boxAdresse: string, server: FernwartungServer): string | null {
  if (!server.publicKey) return null;
  return [
    `VP_SERVICE_ENDPOINT=${server.endpunkt}`,
    `VP_SERVICE_PUBKEY='${server.publicKey}'`,
    `VP_SERVICE_NET=${server.technikerNetz}`,
    'edge-light/openwrt/service-tunnel.sh',
    SSH_NAME,
    boxAdresse,
    String(server.port),
  ].join(' ');
}

/** Die Anmeldung im Fenster der Probe: nur mit dem Fenster-Schlüssel, kein anderer Schlüssel des Rechners. */
export function probeAnmeldung(boxAdresse: string): string {
  return `ssh -i ~/.ssh/${SSH_DATEI} -o IdentitiesOnly=yes -p ${BOX_SSH_PORT} root@${boxAdresse}`;
}

/** Der Host-Schlüssel auf zwei Wegen: durch den Tunnel (offenes Fenster) und an der Box selbst. */
export function hostBefehle(boxAdresse: string): string[] {
  return [
    `ssh-keyscan -t rsa -p ${BOX_SSH_PORT} ${boxAdresse} | ssh-keygen -lf -`,
    `ssh ${SSH_NAME} 'dropbearkey -y -f /etc/dropbear/dropbear_rsa_host_key | grep Fingerprint'`,
  ];
}

// ── Die Schritte ────────────────────────────────────────────────────────────

export type SchrittId =
  | 'openwrt'
  | 'kabel'
  | 'passwort'
  | 'notfall'
  | 'programm'
  | 'tunnel_schluessel'
  | 'tunnel'
  | 'status'
  | 'probe'
  | 'host'
  | 'fenster_zu'
  | 'lan'
  | 'neustart';

/** Was die Seite in einem Schritt zusätzlich zu den Befehlen anbietet. */
export type SchrittWerkzeug =
  | 'passwort'
  | 'referenz'
  | 'tunnel_schluessel'
  | 'befehlszeile'
  | 'probe'
  | 'fenster_zu'
  | 'lan';

export interface Schritt {
  id: SchrittId;
  nummer: number;
  titel: string;
  /** Wozu der Schritt da ist, ein Satz. */
  wozu: string;
  /** Fertige Befehlszeilen; leer, wenn der Schritt ein Handgriff ist. */
  befehle: string[];
  /** Ein Hinweis zu den Befehlen, wenn sie noch nicht fertig sein können. */
  fehlt: string | null;
  sehen: string;
  werkzeug: SchrittWerkzeug | null;
}

/** Was die Schritte über die Box wissen; null = noch nicht bekannt. */
export interface Lage {
  ref: string | null;
  /** Die Tunnel-Adresse, sobald der Schlüssel hinterlegt ist. */
  tunnelAdresse: string | null;
  server: FernwartungServer | null;
  lanNetz: string | null;
}

/**
 * Der Ablauf für ein Edge Light, in der Reihenfolge der Werkstatt-Regel (Bericht, Abschnitt 2.2), mit
 * den Entscheiden 3a und 6a. Danach folgen auf der Seite Beschriftung, Abnahme und der Satz zum Versand.
 */
export function schritte(lage: Lage): Schritt[] {
  const ref = lage.ref;
  const adr = lage.tunnelAdresse;
  const ohneTunnel = 'Die Befehle stehen hier, sobald der Tunnel-Schlüssel hinterlegt ist (Schritt 6).';
  const lan = lage.lanNetz ? lanNetzForm(lage.lanNetz) : null;
  const tunnel = adr && lage.server ? tunnelBefehl(adr, lage.server) : null;
  const liste: Omit<Schritt, 'nummer'>[] = [
    {
      id: 'openwrt',
      titel: `OpenWrt ${OPENWRT_FASSUNG} aufspielen`,
      wozu: 'Alle Skripte erwarten OpenWrt 25.12; auf einem älteren Dropbear richtet das Tunnel-Skript keine Fenster-Schlüssel ein.',
      befehle: [],
      fehlt: null,
      sehen: `Startlader der Mango: Reset halten und Strom einstecken, bis die Leuchte fünfmal blinkt. Dem Rechner die Adresse 192.168.1.2 geben, http://${BOX_WERKSEITIG} öffnen und ${OPENWRT_ABBILD} hochladen. Nach einigen Minuten antwortet ${BOX_WERKSEITIG} als OpenWrt.`,
      werkzeug: null,
    },
    {
      id: 'kabel',
      titel: 'Verkabeln, erste Anmeldung',
      wozu: 'Die Box braucht Internet für das Programm und den Tunnel.',
      befehle: [`ssh -O exit ${SSH_NAME}`, `ssh-keygen -R ${BOX_WERKSEITIG}`, `ssh ${SSH_NAME}`],
      fehlt: null,
      sehen: 'Rechner an LAN, Internet an WAN. Die erste Zeile schließt eine gehaltene Verbindung zur vorigen Box; ohne sie landet der nächste Befehl dort. Danach ist man ohne Passwort root.',
      werkzeug: null,
    },
    {
      id: 'passwort',
      titel: 'Root-Passwort: je Box ein eigenes',
      wozu: 'Ohne Passwort lässt die Box im LAN jeden hinein. Entscheid 3a: zufällig, einmal angezeigt, in die Passwortablage.',
      befehle: [`ssh ${SSH_NAME} passwd`, `ssh -O exit ${SSH_NAME}`],
      fehlt: null,
      sehen: 'passwd fragt zweimal; beide Male das Passwort von hier einfügen. Dann „passwd: password for root changed by root“. Nach ssh -O exit fragt ssh mango nach dem Passwort.',
      werkzeug: 'passwort',
    },
    {
      id: 'notfall',
      titel: 'Notfall-Schlüssel als einziger dauerhafter Schlüssel',
      wozu: 'Der Rückweg, wenn Portal oder Wartungsserver ausfallen.',
      befehle: [
        `ssh ${SSH_NAME} 'cat >> /etc/dropbear/authorized_keys' < ${NOTFALL_PUB}`,
        `ssh ${SSH_NAME} 'cat /etc/dropbear/authorized_keys' | ssh-keygen -lf -`,
      ],
      fehlt: null,
      sehen: 'Genau eine Zeile, und ihr Fingerabdruck ist der aus der Passwortablage. Eine gezählte Zeile allein beweist nicht, dass es der Notfall-Schlüssel ist.',
      werkzeug: null,
    },
    {
      id: 'programm',
      titel: 'Programm einspielen und starten',
      wozu: 'Beim ersten Start entsteht die Referenz der Box; mit ihr kommt die Box in die Liste dieser Seite.',
      befehle: [
        `edge-light/openwrt/install.sh ${SSH_NAME}`,
        `ssh ${SSH_NAME} /etc/init.d/vp-edge-light restart`,
        `curl -s http://${BOX_WERKSEITIG}:8484/health`,
      ],
      fehlt: null,
      sehen: '„Pruefsumme auf dem Geraet bestaetigt“ und einmal die harmlose Zeile „Command failed: ubus call service delete … (Not found)“. /health nennt nach einigen Sekunden "ref" (edge-…) und "version" (edge-light-g…).',
      werkzeug: 'referenz',
    },
    {
      id: 'tunnel_schluessel',
      titel: 'Tunnel-Schlüssel erzeugen und hinterlegen',
      wozu: 'Installiert WireGuard; der private Teil bleibt auf der Box. Das Portal teilt die Tunnel-Adresse zu.',
      befehle: [`edge-light/openwrt/service-tunnel.sh ${SSH_NAME} key`],
      fehlt: null,
      sehen: `Der öffentliche Schlüssel (44 Zeichen) und „Box-Referenz: ${ref ?? 'edge-…'}“. Den Schlüssel hier einfügen.`,
      werkzeug: 'tunnel_schluessel',
    },
    {
      id: 'tunnel',
      titel: 'Tunnel einrichten',
      wozu: 'Tunnel, SSH auf 2222 nur aus dem Tunnel, Abholer der Fenster-Schlüssel, Web-App im Tunnel, Wächter.',
      befehle: tunnel ? [tunnel] : [],
      fehlt: tunnel
        ? null
        : adr
          ? 'Der Wartungsserver ist im Portal noch nicht eingerichtet (Server-Schlüssel fehlt); ohne ihn gibt es keine Befehlszeile.'
          : ohneTunnel,
      sehen: '„eingerichtet: wg_wartung …“. Beim ersten Lauf „netifd kennt wireguard noch nicht - Netzwerk-Neustart in 2 s“ und einmal „schluessel-holen.sh: line 277: can\'t open …“ (harmlos, die Datei gibt es noch nicht). Am Ende „Wartungsserver: antwortet“.',
      werkzeug: 'befehlszeile',
    },
    {
      id: 'status',
      titel: 'Stand ansehen',
      wozu: 'Der Tunnel steht, bevor jemand sich anmeldet.',
      befehle: [`edge-light/openwrt/service-tunnel.sh ${SSH_NAME} status`],
      fehlt: null,
      sehen: '„latest handshake“, „SSH 2222 ausserhalb der Tunnel: abgewiesen“, „Abholer laeuft“ mit einer gültigen Antwort, „dauerhaft …: 1 Schluessel“.',
      werkzeug: null,
    },
    {
      id: 'probe',
      titel: 'Werkstatt-Probe: Anmeldung über Portal und Tunnel',
      wozu: 'Der eigentliche Beweis: Ein Mensch kommt mit seinem Fenster-Schlüssel hinein, ohne einen Schlüssel auf der Box. „Alles bereit“ im Portal allein genügt nicht.',
      befehle: adr ? [probeAnmeldung(adr), "logread -l 200 -e dropbear | grep 'Pubkey auth' | tail -1"] : [],
      fehlt: adr ? null : ohneTunnel,
      sehen: 'Die Anmeldung gelingt. Auf der Box nennt die zweite Zeile den Fingerabdruck des Zugangs, mit dem das Fenster geöffnet wurde.',
      werkzeug: 'probe',
    },
    {
      id: 'host',
      titel: 'Host-Schlüssel lesen',
      wozu: 'Beim Kunden bestätigt der Techniker ihn dann nicht mehr blind. Das Fenster muss dafür noch offen sein.',
      befehle: adr ? hostBefehle(adr) : [],
      fehlt: adr ? null : ohneTunnel,
      sehen: 'Beide Befehle nennen denselben Fingerabdruck (SHA256:…). Ihn unten bei der Abnahme eintragen.',
      werkzeug: null,
    },
    {
      id: 'fenster_zu',
      titel: 'Fenster schließen, noch einmal versuchen',
      wozu: 'Ohne Fenster kommt niemand hinein, auch nicht mit dem Schlüssel von eben.',
      befehle: adr ? [probeAnmeldung(adr)] : [],
      fehlt: adr ? null : ohneTunnel,
      sehen: '„Connection timed out“. Auf der Box steht „Sitzung beendet (Dropbear-Prozess …): ihr Fenster-Schluessel ist gestrichen“.',
      werkzeug: 'fenster_zu',
    },
    {
      id: 'lan',
      titel: 'LAN der Box umstellen und neu starten',
      wozu: 'Entscheid 6a: Hat der Router des Kunden dasselbe Netz wie die Box (ab Werk 192.168.1.1), kommt sie nicht ins Internet.',
      befehle: lage.lanNetz && lanBefehl(lage.lanNetz) ? [lanBefehl(lage.lanNetz) as string] : [],
      fehlt: lage.lanNetz ? null : 'Erst das Netz festhalten; dann steht hier der Befehl.',
      sehen: `Die Verbindung bricht ab, die Box startet neu. Den Rechner einmal vom LAN ab- und wieder anstecken: Er bekommt eine Adresse im neuen Netz. Antwortet die Box dort nicht, kommt man im offenen Fenster durch den Tunnel an sie heran.`,
      werkzeug: 'lan',
    },
    {
      id: 'neustart',
      titel: 'Neustart-Probe und Schlusskontrolle',
      wozu: 'Nach dem Neustart steht alles wieder von selbst.',
      befehle: lan
        ? [
            `ssh -O exit ${SSH_NAME}`,
            `edge-light/openwrt/service-tunnel.sh root@${lan.adresse} status`,
            `ssh root@${lan.adresse} 'cat /etc/vp-edge-light/ref; ls /etc/rc.d | grep vp-'`,
            `ssh root@${lan.adresse} 'cat /etc/dropbear/authorized_keys' | ssh-keygen -lf -`,
          ]
        : [],
      fehlt: lan ? null : 'Die Befehle nennen die neue Adresse der Box; erst das LAN-Netz festhalten.',
      sehen: `Drei Minuten nach dem Neustart: frischer Handshake; ${ref ?? 'dieselbe Referenz'}; K10vp-edge-light K20vp-wartung S60vp-wartung S99vp-edge-light; ein Schlüssel. Beim ersten ssh an die neue Adresse zeigt der Rechner den Host-Schlüssel: Es ist der von eben.`,
      werkzeug: null,
    },
  ];
  return liste.map((s, i) => ({ ...s, nummer: i + 1 }));
}

/** Die Schritte, die man abhaken kann, bevor die Box in der Liste steht (die Referenz entsteht in Schritt 5). */
export const VOR_DER_REFERENZ: readonly SchrittId[] = ['openwrt', 'kabel', 'passwort', 'notfall'];

export const SCHRITT_IDS: readonly SchrittId[] = schritte({ ref: null, tunnelAdresse: null, server: null, lanNetz: null }).map(
  (s) => s.id,
);

/** „5 von 13“ - wie weit die Box ist. */
export function fortschritt(box: Pick<WerkstattBox, 'schritte'>): { erledigt: number; gesamt: number } {
  return { erledigt: SCHRITT_IDS.filter((s) => box.schritte[s]).length, gesamt: SCHRITT_IDS.length };
}

// ── Werkstatt-Probe ─────────────────────────────────────────────────────────

/**
 * Das Fenster der Probe: das jüngste Fenster dieser Box mit dem Grund der Probe, das nicht abgesagt
 * wurde. Ein abgesagtes war nie offen und taugt nicht als Beleg.
 */
export function probeFenster(fenster: readonly FernwartungFenster[], ref: string): FernwartungFenster | null {
  return (
    fenster
      .filter((f) => f.edgeRef === ref && f.grund.startsWith(PROBE_GRUND) && f.zustand !== 'abgesagt')
      .sort((a, b) => b.beginn.localeCompare(a.beginn))[0] ?? null
  );
}

// ── Abnahme ─────────────────────────────────────────────────────────────────

const HOST_SCHLUESSEL = /^SHA256:[A-Za-z0-9+/]{43}$/;
const FASSUNG = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/;

/** Was die Abnahme braucht; ssh-keygen schreibt manchmal „256 SHA256:… (RSA)“ - das Portal nimmt nur den Abdruck. */
export function hostSchluesselAus(eingabe: string): string | null {
  const m = /SHA256:[A-Za-z0-9+/]{43}(?![A-Za-z0-9+/])/.exec(eingabe.trim());
  return m && HOST_SCHLUESSEL.test(m[0]) ? m[0] : null;
}

export function fassungGueltig(fassung: string): boolean {
  return FASSUNG.test(fassung.trim());
}

export interface AbnahmeEingabe {
  hostSchluessel: string;
  fassung: string;
  pruefungen: ReadonlySet<string>;
}

/**
 * Warum die Abnahme (noch) nicht geht, in der Reihenfolge, in der man es beheben würde - oder eine
 * leere Liste. Die API prüft dasselbe noch einmal.
 */
export function abnahmeSperre(
  box: Pick<WerkstattBox, 'boxArt' | 'lanNetz'>,
  tunnelAdresse: string | null,
  probe: FernwartungFenster | null,
  e: AbnahmeEingabe,
): string[] {
  if (box.boxArt !== 'edge-light') {
    return ['Eine Abnahme gibt es bisher nur für das Edge Light: Für die Docker-Box fehlt der Wartungstunnel für Linux.'];
  }
  const gruende: string[] = [];
  if (!tunnelAdresse) gruende.push('Der Tunnel-Schlüssel ist noch nicht hinterlegt (Schritt 6).');
  if (!probe) gruende.push('Es gibt noch kein Fenster der Werkstatt-Probe (Schritt 9).');
  else if (probe.zustand === 'offen' || probe.zustand === 'geplant')
    gruende.push('Das Fenster der Probe ist noch offen: erst schließen und den Versuch wiederholen (Schritt 11).');
  if (!box.lanNetz) gruende.push('Das LAN-Netz ist noch nicht festgehalten (Schritt 12).');
  const fehlend = PRUEFUNGEN.filter((p) => !e.pruefungen.has(p.id));
  if (fehlend.length > 0) gruende.push(`Noch nicht abgehakt: ${fehlend.length} von ${PRUEFUNGEN.length} Prüfungen.`);
  if (!hostSchluesselAus(e.hostSchluessel)) gruende.push('Der Host-Schlüssel fehlt oder hat nicht die Form SHA256:… (43 Zeichen).');
  if (!fassungGueltig(e.fassung)) gruende.push('Die Fassung fehlt (aus /health, etwa edge-light-g9c3368e3a).');
  return gruende;
}

// ── Beschriftung des Gehäuses (Entscheid 8, geändert am 26.10.2026) ─────────

export interface Beschriftung {
  /** Die Referenz, wie sie gedruckt wird: Die Strichschrift des Gehäuses kennt nur Großbuchstaben. */
  klartext: string;
  /** Der Inhalt des QR-Codes: der Direktlink ins Portal. */
  link: string;
}

export function beschriftung(ref: string): Beschriftung {
  return { klartext: ref.toUpperCase(), link: koppelLink(ref) };
}

/**
 * Der Satz am Ende des Ablaufs (Entscheid 5c vom 26.10.2026). Er steht dort, wo sonst „verpacken und
 * versenden“ stünde, und bei jeder abgenommenen Box.
 */
export const VERSAND_SATZ =
  'Nicht versenden. Entscheid 5c vom 26.10.2026: Keine Box mit Stufe 1 geht an einen Kunden, bevor Stufe 2 steht (Programm mit geprüfter Signatur und Updates aus dem Portal). Eine abgenommene Box bleibt in der Werkstatt; sie ist eingerichtet und geprüft, mehr nicht.';

/** Wann eine Box als abgenommen gilt: mit ihrem jüngsten Abnahmeprotokoll. */
export function letzteAbnahme(box: Pick<WerkstattBox, 'abnahmen'>): WerkstattAbnahme | null {
  return box.abnahmen[0] ?? null;
}
