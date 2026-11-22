/**
 * Der WAGO PFC200 750-8212 an der Werkbank (PFC200-Konzept Stufe 3, Teilstufe 4):
 * was die Werkstatt-Bildschirme über ihn sagen, an einer Stelle. Das Gerät
 * heißt PFC200, die Box, die daraus wird, „Edge Industrie“ (die Mango: Edge
 * Light).
 *
 * Was die Werkstatt an ihm tut und was nicht:
 * - Sie richtet Zugänge, Notfall-Schlüssel, Edge Industrie, Wartungstunnel und
 *   die zwei Netze ein und nimmt ihn mit zehn Prüfungen ab.
 * - Sie hat keinen Schritt für die SPS: kein Programm, keine Koppelprobe; die
 *   Laufzeit (CODESYS) und ihre Einstellungen bleiben unberührt.
 * - Die Firmware liest sie nur. Ihr Stand steht als Angabe an der Abnahme.
 *
 * Reines Modul: kein React, kein Netzwerk, keine Abhängigkeit zu
 * `werkstattBank.ts` oder `werkstattLauf.ts` (beide lesen von hier).
 */
import { PRUEFUNGEN_PFC200, zahlwort } from './werkstatt';

/** `box_art` eines Laufs und einer Freigabe für den PFC200 (Vertrag werkstatt-ansicht-v1). */
export const PFC200 = 'pfc200';
/** Wie das Gerät in den Bildschirmen heißt. */
export const PFC200_NAME = 'PFC200';
/** Wie die Box heißt, die aus einem PFC200 wird. */
export const EDGE_INDUSTRIE = 'Edge Industrie';
/** Die Adresse, die der PFC200 nach dem Handgriff „feste Adresse“ vorübergehend hat. */
export const PFC200_FESTE_ADRESSE = '192.168.1.17';

export function istPfc200(boxArt: string | null | undefined): boolean {
  return boxArt === PFC200;
}

/** „zehn“: so viele Prüfungen hat die Abnahme eines PFC200 (`geraete.pfc200` im Vektor). */
export const PRUEFUNGEN_PFC200_WORT = zahlwort(PRUEFUNGEN_PFC200.length);

// ── Phasen und Schritte ────────────────────────────────────────────────────

/**
 * Sechs Phasen in Alltagsworten, in der Reihenfolge des Laufs (Vertrag
 * werkstatt-ansicht-v1, `lauf.box_art` = `pfc200`). Eine Phase „Steuerung“
 * gibt es nicht: Die SPS gehört nicht in die Werkstatt.
 */
export const PHASEN_PFC200 = [
  { id: 'erkannt', titel: 'Erkannt', klein: 'PFC200 erkannt, Firmware gelesen', schritte: ['erkennen'] },
  { id: 'absichern', titel: 'Absichern', klein: 'Dateien der Freigabe, drei Passwörter, Notfall-Schlüssel', schritte: ['fassungen', 'internet', 'zugaenge', 'notfall'] },
  { id: 'software', titel: 'Software', klein: `${EDGE_INDUSTRIE} einspielen`, schritte: ['programm'] },
  { id: 'anmelden', titel: 'Bei VoltPilot anmelden', klein: 'Geräteschlüssel und Wartungstunnel', schritte: ['tunnel_schluessel', 'einloesen', 'tunnel_adresse', 'tunnel'] },
  { id: 'probe', titel: 'Netze trennen und Probe', klein: 'Zwei Buchsen, Neustart, Anmeldung über den Tunnel', schritte: ['netze', 'neustart', 'probe'] },
  { id: 'abnahme', titel: 'Abnahme', klein: `Alle ${PRUEFUNGEN_PFC200_WORT} Prüfungen mit Beleg`, schritte: ['internet_weg', 'uebergabe'] },
] as const;

/** Die Schritte des Dienstes am PFC200 in ihrer Reihenfolge. */
export const SCHRITTE_PFC200: readonly string[] = PHASEN_PFC200.flatMap((p) => p.schritte);

/** Titel und ein Satz, was der Dienst in dem Schritt tut (Jetzt-Karte). */
export const SCHRITT_TEXT_PFC200: Record<string, { titel: string; tut: string }> = {
  erkennen: {
    titel: 'PFC200 erkennen',
    tut: 'Liest Bestellnummer, Firmware und Seriennummer und prüft, ob die Werkspasswörter noch gelten, das Kabel in X2 steckt und der Schalter auf RUN steht. Am Gerät ändert sich dabei nichts.',
  },
  fassungen: {
    titel: 'Dateien der Freigabe bereitlegen',
    tut: `Lädt ${EDGE_INDUSTRIE}, den Skriptstand und das Tunnel-Programm der Freigabe und prüft jede Prüfsumme und die Signatur.`,
  },
  internet: {
    titel: 'Internet über die Brücke (befristet), Uhr stellen',
    tut: 'Gibt dem PFC200 für den Lauf Internet über die Brücke und stellt seine Uhr; am Ende kommt der Weg wieder weg.',
  },
  zugaenge: {
    titel: 'Zugänge: drei Passwörter setzen',
    tut: 'Setzt für root, admin und user je ein zufälliges Passwort; abgelegt werden sie nur verschlüsselt. Danach geht die Anmeldung nur noch mit Schlüssel.',
  },
  notfall: { titel: 'Notfall-Schlüssel', tut: 'Legt genau einen Notfall-Schlüssel der Technik auf das Gerät.' },
  programm: {
    titel: `${EDGE_INDUSTRIE} einspielen`,
    tut: 'Installiert das Programm, startet es und wartet, bis es sich mit seiner Referenz meldet. Die Laufzeit der SPS bleibt unberührt.',
  },
  tunnel_schluessel: { titel: 'Tunnel-Schlüssel erzeugen', tut: 'Das Gerät erzeugt seinen Schlüssel für den Wartungstunnel.' },
  einloesen: { titel: 'Bei VoltPilot anmelden (Einmal-Code)', tut: 'Das Gerät löst einen Einmal-Code ein; das Portal hält seinen Geräteschlüssel fest.' },
  tunnel_adresse: { titel: 'Tunnel-Adresse aus dem Portal', tut: 'Wartet auf die Tunnel-Adresse aus dem Portal.' },
  tunnel: { titel: 'Wartungstunnel einrichten', tut: 'Richtet den Wartungstunnel ein; der Zugang für die Fernwartung lauscht danach nur im Tunnel.' },
  netze: {
    titel: 'Netze trennen, Firewall einschalten',
    tut: 'Trennt die zwei Buchsen: X1 wird das Kundennetz, X2 das Anlagennetz. Schaltet die Firewall ein; zum Kundennetz sind Entwicklungsumgebung, Web-Oberfläche und SSH danach zu.',
  },
  neustart: { titel: 'Neustart-Probe', tut: 'Startet das Gerät neu und wartet, bis es mit demselben Host-Schlüssel und derselben Referenz wieder antwortet.' },
  probe: { titel: 'Anmeldung über den Tunnel', tut: 'Meldet sich als Techniker durch den Tunnel an und prüft, dass danach niemand mehr hineinkommt.' },
  internet_weg: { titel: 'Werkstatt-Internet und Lauf-Schlüssel entfernen', tut: 'Nimmt den befristeten Weg über die Brücke und den Schlüssel dieses Laufs wieder weg.' },
  uebergabe: {
    titel: `Abnahme: ${PRUEFUNGEN_PFC200_WORT} Prüfungen mit Beleg`,
    tut: `Schickt die Belege aller ${PRUEFUNGEN_PFC200_WORT} Prüfungen an das Portal; ohne „update-bereit“ keine Abnahme.`,
  },
};

// ── Fälle ──────────────────────────────────────────────────────────────────

/** Nur hier nennt die Seite den Werksreset (dieselbe Sicherheitslinie wie der Reset der Mango): Er löscht das SPS-Programm. */
export const WERKSRESET_FAELLE: ReadonlySet<string> = new Set(['pfc_passwort']);

/** Die Codes, die nur ein Lauf am PFC200 kennt (Vertrag werkstatt-ansicht-v1, „Fälle eines Laufs am PFC200“). */
export const FALL_CODES_PFC200 = [
  'pfc_schalter_stop',
  'pfc_kabel_x1',
  'pfc_passwort',
  'pfc_docker_an',
  'pfc_falsches_geraet',
  'pfc_schon_eingerichtet',
  'pfc_notfall_schluessel',
] as const;

/**
 * Ein Satz je Code: was los ist, ohne Fachwörter. Für die eigenen Codes des
 * PFC200 und für die gemeinsamen, deren Satz sonst die Mango nennt; fehlt ein
 * Code hier, gilt der gemeinsame Satz (`WAS` in `werkstattLauf.ts`).
 */
export const WAS_PFC200: Record<string, string> = {
  pfc_schalter_stop: 'Solange der Betriebsartenschalter auf STOP steht, macht der Dienst nicht weiter. Nach dem Handgriff „feste Adresse“ steht er oft noch dort.',
  pfc_kabel_x1: 'Der Lauf trennt später die zwei Buchsen. Steckte das Kabel dann in X1, erreichte der Dienst das Gerät nicht mehr.',
  pfc_passwort: 'Ein früherer Lauf dieser Werkstatt hat ihn angefangen und nicht fertig gemacht. Er ist nicht abgenommen und mit keinem Kunden gekoppelt. Nur darum nennt die Werkstatt hier den Werksreset.',
  pfc_docker_an: 'Auf dem Gerät läuft Docker. Fremde Container beendet der Dienst nicht, und mit Docker stimmen Weiterleitung und Firewall des Geräts nicht.',
  pfc_falsches_geraet: 'An der Werkbank werden von WAGO nur PFC200 mit der Bestellnummer 750-8212 eingerichtet.',
  pfc_schon_eingerichtet: `Auf ihm liegt schon ${EDGE_INDUSTRIE}, aber kein Lauf dieser Werkstatt kennt ihn.`,
  pfc_notfall_schluessel: 'Der Notfall-Schlüssel der Werkstatt ist von einer Art, die der PFC200 nicht annimmt. Am Gerät wurde nichts geändert.',
  bruecke_nicht_bereit: 'Der kleine Rechner (Pi) an der Werkbank antwortet nicht. Ohne ihn erreicht der Dienst keinen PFC200.',
  startet: 'Er meldet sich, nimmt aber noch keine Anmeldung an. Der Dienst beginnt erst, wenn er zweimal hintereinander gleich antwortet.',
  keine_box: 'Das Kabel steckt, aber an ihm meldet sich noch niemand. Ein PFC200 ab Werk hat ohne den Handgriff „feste Adresse“ keine Adresse.',
  kein_kabel: 'Das orange Kabel WERKSTATT steckt in keinem PFC200.',
  gesperrt: 'Für diesen PFC200 ist der Lauf vorbei. Der Dienst fasst ihn erst wieder an, wenn er einmal weg war.',
  eingerichtet: 'Er steht schon im Netz eines fertigen Geräts. Fertige Geräte fasst der Dienst nie an.',
  passwort_fremd: 'Sein Werkspasswort gilt nicht mehr, und kein Lauf dieser Werkstatt hat es geändert. Einen Werksreset nennt die Werkstatt dann nie: Er löscht das SPS-Programm.',
  box_in_gebrauch: 'Er ist abgenommen oder mit einem Kunden gekoppelt. So ein Gerät lässt der Dienst nie zurücksetzen.',
  nicht_nachweisbar: 'Der Dienst kann nicht belegen, dass es dasselbe Gerät wie in seinem früheren Lauf ist. Dann lässt er nichts zurücksetzen.',
  kein_internet: 'Über die Brücke kommt der PFC200 nicht ins Internet; ohne Internet lädt er nichts.',
  fassung_nicht_bereit: 'Die Dateien der Freigabe lassen sich nicht laden, passen nicht zu ihr oder sind nicht signiert. Der PFC200 wurde nicht angefasst.',
  uebertragung: 'Die Prüfsumme auf dem Gerät passt nicht. Eingespielt wurde nichts.',
  box_weg: 'Er antwortete während des Laufs nicht mehr. Hat er neu gestartet, ist die feste Adresse weg.',
  einloesen_abgewiesen: 'Das Portal hat die Anmeldung des Geräts abgewiesen, zum Beispiel weil die Werkstatt angehalten wurde oder ihre Tagesgrenze erreicht hat.',
  dienst_neu_gestartet: 'Der Dienst wurde neu gestartet. Beim nächsten Versuch erkennt er, wie weit der PFC200 war.',
};

/** Ein Satz nach den Schritten eines Falls. */
export const NACH_PFC200: Record<string, string> = {
  pfc_passwort: 'Nach dem Werksreset bekommt er eine neue Referenz; die alte bleibt im Register als Verlauf stehen.',
};

// ── Handgriffe am Gerät (je einer mit Bild) ────────────────────────────────

/**
 * Wie der Betriebsartenschalter steht, ob der Reset-Taster gedrückt ist, was die Leuchte SYS zeigt (nur wo der
 * Handgriff eine Farbe nennt; sonst `aus` = nicht hervorgehoben), wo das Kabel steckt.
 */
export interface PfcAnsicht {
  schalter: 'run' | 'stop' | 'reset';
  rst: boolean;
  sys: 'aus' | 'orange' | 'rotgruen';
  kabel: 'x1' | 'x2' | null;
}

/** Ein Teilschritt eines Handgriffs: was zu tun ist, und wie das Gerät dabei aussieht. */
export interface HandgriffSchritt {
  kurz: string;
  text: string;
  bild: PfcAnsicht;
}

/**
 * „Feste Adresse“: Ein PFC200 ab Werk wartet auf eine Adresse aus dem Netz und
 * hat an der Werkbank keine. Nach diesem Handgriff hat er vorübergehend
 * 192.168.1.17, bis zum nächsten Neustart.
 */
export const HANDGRIFF_FESTE_ADRESSE: readonly HandgriffSchritt[] = [
  { kurz: 'Schalter auf STOP', text: 'Den Betriebsartenschalter auf STOP stellen.', bild: { schalter: 'stop', rst: false, sys: 'aus', kabel: 'x2' } },
  {
    kurz: 'Reset länger als 8 Sekunden',
    text: 'Den Reset-Taster (RST) mit einem Stift länger als 8 Sekunden gedrückt halten, bis die Leuchte SYS orange blinkt. Dann loslassen.',
    bild: { schalter: 'stop', rst: true, sys: 'orange', kabel: 'x2' },
  },
  { kurz: 'Schalter zurück auf RUN', text: 'Den Betriebsartenschalter wieder auf RUN stellen.', bild: { schalter: 'run', rst: false, sys: 'aus', kabel: 'x2' } },
];

/** Was nach dem Handgriff „feste Adresse“ gilt. */
export const FESTE_ADRESSE_FOLGE =
  `Der PFC200 hat dann vorübergehend die Adresse ${PFC200_FESTE_ADRESSE}. Strom und Kabel bleiben stecken: Nach einem Neustart wäre die Adresse wieder weg.`;

/**
 * Werksreset: nur für einen PFC200, den diese Werkstatt begonnen und nicht
 * fertig gemacht hat (`pfc_passwort`). Danach ist er wie ab Werk; ein
 * SPS-Programm auf dem Gerät ist gelöscht.
 */
export const HANDGRIFF_WERKSRESET: readonly HandgriffSchritt[] = [
  { kurz: 'Reset halten', text: 'Den Reset-Taster (RST) mit einem Stift gedrückt halten.', bild: { schalter: 'run', rst: true, sys: 'aus', kabel: 'x2' } },
  {
    kurz: 'Schalter auf RESET drücken',
    text: 'Dabei den Betriebsartenschalter auf RESET drücken und beides halten.',
    bild: { schalter: 'reset', rst: true, sys: 'aus', kabel: 'x2' },
  },
  {
    kurz: 'SYS blinkt rot und grün: loslassen',
    text: 'Halten, bis die Leuchte SYS abwechselnd rot und grün blinkt. Dann loslassen: Der PFC200 startet neu und ist danach wie ab Werk.',
    bild: { schalter: 'run', rst: false, sys: 'rotgruen', kabel: 'x2' },
  },
];

/** Der eine Handgriff, auf den ein Lauf wartet: Schalter auf RUN. */
export const HANDGRIFF_SCHALTER_RUN: readonly HandgriffSchritt[] = [
  { kurz: 'Schalter steht auf STOP', text: 'Der Betriebsartenschalter steht auf STOP.', bild: { schalter: 'stop', rst: false, sys: 'aus', kabel: 'x2' } },
  { kurz: 'Schalter auf RUN', text: 'Den Betriebsartenschalter auf RUN stellen.', bild: { schalter: 'run', rst: false, sys: 'aus', kabel: 'x2' } },
];

/** Der andere: das Kabel in die Buchse X2. */
export const HANDGRIFF_KABEL_X2: readonly HandgriffSchritt[] = [
  { kurz: 'Kabel steckt in X1', text: 'Das orange Kabel steckt in der falschen Buchse.', bild: { schalter: 'run', rst: false, sys: 'aus', kabel: 'x1' } },
  { kurz: 'Kabel in X2', text: 'Das orange Kabel WERKSTATT in die Buchse X2 stecken. Die Buchse X1 bleibt leer.', bild: { schalter: 'run', rst: false, sys: 'aus', kabel: 'x2' } },
];

/** Das Gerät an der Werkbank, wie es angeschlossen wird. */
export const PFC200_ANGESCHLOSSEN: PfcAnsicht = { schalter: 'run', rst: false, sys: 'aus', kabel: 'x2' };

/** Welches Bild eine Fall-Seite zeigt (`werkstattLauf.Bild`). */
export type PfcBild = 'pfc-anschluss' | 'pfc-adresse' | 'pfc-werksreset' | 'pfc-run' | 'pfc-x2';

export const PFC_BILD: Record<PfcBild, { titel: string; schritte: readonly HandgriffSchritt[] }> = {
  'pfc-anschluss': {
    titel: 'Oranges Kabel WERKSTATT in X2, X1 bleibt leer',
    schritte: [{ kurz: 'Kabel in X2, Strom an', text: 'Das orange Kabel WERKSTATT steckt in der Buchse X2, die Buchse X1 bleibt leer.', bild: PFC200_ANGESCHLOSSEN }],
  },
  'pfc-adresse': { titel: 'Feste Adresse geben', schritte: HANDGRIFF_FESTE_ADRESSE },
  'pfc-werksreset': { titel: 'Werksreset', schritte: HANDGRIFF_WERKSRESET },
  'pfc-run': { titel: 'Betriebsartenschalter auf RUN', schritte: HANDGRIFF_SCHALTER_RUN },
  'pfc-x2': { titel: 'Kabel in die Buchse X2', schritte: HANDGRIFF_KABEL_X2 },
};

/** Welche Bilder ein Fall am PFC200 zeigt, in der Reihenfolge der Handgriffe. Kein Eintrag: kein Bild. */
export const FALL_BILDER_PFC200: Record<string, readonly PfcBild[]> = {
  pfc_passwort: ['pfc-werksreset', 'pfc-adresse'],
  pfc_schalter_stop: ['pfc-run'],
  pfc_kabel_x1: ['pfc-x2'],
  box_weg: ['pfc-adresse'],
  keine_box: ['pfc-anschluss', 'pfc-adresse'],
  kein_kabel: ['pfc-anschluss'],
};

// ── Anschließen und Fertig ─────────────────────────────────────────────────

/** Was die Person an der Werkbank tut, bevor der Dienst das Gerät sieht. */
export const ANSCHLIESSEN_PFC200: readonly string[] = [
  'Endklemme anstecken.',
  'Das orange Kabel WERKSTATT in die Buchse X2. Die Buchse X1 bleibt leer.',
  'Strom anstecken und bis zu zwei Minuten warten.',
];

/** Die Sätze der Abschlussseite und der Box-Seite zu den Zugängen und zu CODESYS. */
export const ZUGAENGE_SATZ =
  'Die Passwörter von root, admin und user stehen nur verschlüsselt an der Abnahme, für den age-Schlüssel „Box-Passwörter“. Das Portal kann sie nicht lesen, und sie stehen an keiner anderen Stelle.';
export const ADMIN_PASSWORT_SATZ =
  'Für CODESYS und die Web-Oberfläche des PFC200 brauchst du das Passwort von admin. Du entschlüsselst es selbst: den verschlüsselten Text von der Seite der Box kopieren, dann age -d -i <Schlüssel „Box-Passwörter“>. Entschlüsselt steht je Zugang eine Zeile da.';
export const CODESYS_SATZ =
  'CODESYS erreicht den PFC200 nur an der Buchse X2 (Anlagennetz). Zum Kundennetz an X1 sind Entwicklungsumgebung, Web-Oberfläche und SSH zu.';
export const SPS_SATZ =
  'Die Werkstatt hat kein SPS-Programm geladen und die Laufzeit (CODESYS) nicht angefasst. Die Firmware hat sie nur gelesen.';

/** Der Befehl, mit dem der Betreiber die drei Zugänge entschlüsselt. */
export const AGE_BEFEHL = 'age -d -i <Schlüssel „Box-Passwörter“>';

// ── Stand der Werkstatt für den PFC200 ─────────────────────────────────────

/** „2026.11.0“ aus „edge-industrie-2026.11.0“. */
export function edgeIndustrieKurz(fassung: string): string {
  return fassung.replace(/^edge-industrie-/, '');
}

/** Die Edge-Industrie-Fassung einer Freigabe für den PFC200, wie die Verwaltung sie nennt. */
export interface EdgeIndustrieFassung {
  fassung: string;
  quelle: string;
  programmSha256: string;
  skripteSha256: string;
  /** Das Tunnel-Programm `vp-wartung-linux-arm`, aus dem signierten Manifest. */
  wartungSha256: string;
}

/**
 * Der Stand der Werkstatt für den PFC200 (`/api/v1/admin/werkstatt/regel?geraet=pfc200`).
 * `openwrt` ist null: Die Firmware des Geräts fasst die Werkstatt nicht an.
 */
export interface WerkstattRegelPfc200 {
  zustand: 'laeuft' | 'angehalten' | 'wartet';
  grund: string | null;
  neueste: string | null;
  openwrt: null;
  edgeLight: EdgeIndustrieFassung | null;
  releaseSeq: number | null;
  freigabe: string | null;
  heute: number;
  tagesgrenze: number;
}

/**
 * Liest die Antwort als Stand für den PFC200. Eine API vor dem Gerät `pfc200`
 * übergeht `?geraet=` und antwortet mit dem Stand der Mango (mit `openwrt`):
 * Dann ist für den PFC200 nichts bekannt, statt die Fassung der Mango als
 * seine zu zeigen.
 */
export function liesRegelPfc200(r: unknown): WerkstattRegelPfc200 | null {
  if (!r || typeof r !== 'object') return null;
  const x = r as { openwrt?: unknown; edgeLight?: { fassung?: unknown } | null; zustand?: unknown };
  if (x.openwrt != null) return null;
  if (x.edgeLight && typeof x.edgeLight.fassung === 'string' && !x.edgeLight.fassung.startsWith('edge-industrie-')) return null;
  if (x.zustand !== 'laeuft' && x.zustand !== 'angehalten' && x.zustand !== 'wartet') return null;
  return r as WerkstattRegelPfc200;
}

/** Eine Zeile zum PFC200 in der Karte „Werkstatt“: was sie ihm aufspielt, oder worauf sie wartet. */
export interface Pfc200Zeile {
  ton: 'ok' | 'warn';
  text: string;
}

export function pfc200Zeile(r: WerkstattRegelPfc200): Pfc200Zeile {
  if (r.zustand === 'laeuft' && r.edgeLight) {
    return { ton: 'ok', text: `${PFC200_NAME}: ${EDGE_INDUSTRIE} ${edgeIndustrieKurz(r.edgeLight.fassung)}` };
  }
  if (r.zustand === 'angehalten') return { ton: 'warn', text: `${PFC200_NAME}: angehalten, wie die ganze Werkstatt` };
  return { ton: 'warn', text: `${PFC200_NAME} wartet: ${r.grund ?? 'Gerade passt keine Fassung.'}` };
}
