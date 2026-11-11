/**
 * Die Lauf-Seite der Werkbank (Konzept vp-werkstatt-lauf-seite, entschieden
 * 05.11.2026: E1–E4 je A). Reine Ableitungen ohne React aus der Ansicht des
 * Dienstes (`docs/contracts/werkstatt-ansicht-v1.md`):
 *
 * - je Fall-Code eine Seite (`fallSeite`): Art (Der Dienst wartet / Einmal kurz
 *   du / Zur Seite legen), Titel und Schritte aus `loesung`, ein Satz, was los
 *   ist, Bild, Knöpfe. Den Reset nennt sie nur bei `gl_passwort` und
 *   `halb_eigene`; kein Knopf löscht etwas an einer Box;
 * - die Jetzt-Karte und alle Schritte nach Phasen mit Belegzeile und Dauer (E3);
 * - die Software-Karte „Kommt auf diese Box“ mit „vorher → danach“.
 *
 * Ein älterer Dienst meldet `fall`, `belege`, `vorher` und `nochmal_moeglich`
 * nicht: Dann fehlen Belegzeilen und der Knopf „Nochmal versuchen“, und die
 * Fall-Seite liest den Fall aus `handgriff` wie bisher.
 */
import { PRUEFUNGEN } from './werkstatt';
import {
  MINUTEN,
  PHASEN,
  SCHRITTE,
  zaehlt,
  type LaufStand,
  type Loesung,
  type PhaseZustand,
  type WerkstattAnsicht,
  type WerkstattLauf,
} from './werkstattBank';

const ZAHLWORT = ['null', 'eine', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn', 'elf', 'zwölf'];

/** „neun“: so viele Prüfungen hat die Abnahme (Vektor werkstatt-pruefungen.json, Zwilling `PRUEFUNGEN`). */
export const PRUEFUNGEN_WORT = ZAHLWORT[PRUEFUNGEN.length] ?? String(PRUEFUNGEN.length);

// ── Schritte ───────────────────────────────────────────────────────────────

/** Titel und ein Satz, was der Dienst in dem Schritt tut (Jetzt-Karte). */
export const SCHRITT_TEXT: Record<string, { titel: string; tut: string }> = {
  erkennen: { titel: 'Mango erkennen', tut: 'Liest Modell, System und ob root ein Passwort hat. Ein Passwort rät der Dienst nie.' },
  fassungen: { titel: 'Dateien der Freigabe bereitlegen', tut: 'Lädt OpenWrt und Edge Light der Freigabe und prüft jede Prüfsumme.' },
  openwrt: { titel: 'OpenWrt aufspielen', tut: 'Überträgt das neue System, prüft die Prüfsumme auf der Box und spielt es auf. Danach startet die Mango neu.' },
  wiedererkennen: { titel: 'Neustart in OpenWrt abwarten', tut: 'Wartet, bis die Mango mit OpenWrt wieder antwortet.' },
  internet: { titel: 'Internet über die Brücke (befristet)', tut: 'Gibt der Mango für den Lauf Internet über die Brücke; am Ende kommt es wieder weg.' },
  passwort: { titel: 'Root-Passwort setzen', tut: 'Setzt ein zufälliges Passwort; abgelegt wird es nur verschlüsselt.' },
  notfall: { titel: 'Notfall-Schlüssel', tut: 'Legt genau einen Notfall-Schlüssel der Technik auf die Box.' },
  programm: { titel: 'Edge Light einspielen', tut: 'Installiert das Programm, startet es und wartet, bis es sich mit seiner Referenz meldet.' },
  tunnel_schluessel: { titel: 'Tunnel-Schlüssel erzeugen', tut: 'Die Box erzeugt ihren Schlüssel für den Wartungstunnel.' },
  einloesen: { titel: 'Bei VoltPilot anmelden (Einmal-Code)', tut: 'Die Box löst einen Einmal-Code ein; das Portal hält ihren Geräteschlüssel fest.' },
  tunnel_adresse: { titel: 'Tunnel-Adresse aus dem Portal', tut: 'Wartet auf die Tunnel-Adresse aus dem Portal.' },
  tunnel: { titel: 'Wartungstunnel einrichten', tut: 'Richtet den Wartungstunnel ein; SSH geht danach nur noch durch ihn.' },
  lan: { titel: 'LAN umstellen und neu starten', tut: 'Stellt das Netz der Box um und startet sie neu.' },
  neustart: { titel: 'Neustart-Probe', tut: 'Wartet, bis die Box nach dem Neustart mit demselben Host-Schlüssel antwortet.' },
  probe: { titel: 'Anmeldung über den Tunnel', tut: 'Meldet sich als Techniker durch den Tunnel an und prüft, dass danach niemand mehr hineinkommt.' },
  internet_weg: { titel: 'Werkstatt-Internet entfernen', tut: 'Nimmt den befristeten Weg über die Brücke wieder weg.' },
  uebergabe: {
    titel: `Abnahme: ${PRUEFUNGEN_WORT} Prüfungen mit Beleg`,
    tut: `Schickt die Belege aller ${PRUEFUNGEN_WORT} Prüfungen an das Portal; ohne „update-bereit“ keine Abnahme.`,
  },
};

export function schrittTitel(s: string): string {
  return SCHRITT_TEXT[s]?.titel ?? s;
}

/** „1:48“ (Minuten:Sekunden) oder „12:03:10“ ab einer Stunde. */
export function dauerText(sek: number): string {
  const s = Math.max(0, Math.round(sek));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

/** „~2 Min“, „~½ Min“. */
function minutenText(sek: number): string {
  const min = sek / 60;
  return min < 0.75 ? '~½ Min' : `~${Math.max(1, Math.round(min))} Min`;
}

/** Die Schritte, die in diesem Lauf zählen (Einlösen oder Tunnel-Adresse von Hand, nie beides). */
export function laufSchritte(s: LaufStand): string[] {
  return SCHRITTE.filter((x) => zaehlt(s, x));
}

/**
 * Wie lange ein Schritt meist dauert, in Sekunden: der Median der gemessenen
 * Dauern aus den Belegen der letzten Läufe (E3), sonst die feste Schätzung.
 */
export function meistDauer(laeufe: readonly WerkstattLauf[]): Record<string, number> {
  const je = new Map<string, number[]>();
  for (const l of laeufe) {
    for (const b of l.stand?.belege ?? []) {
      if (typeof b.dauer_s === 'number' && b.dauer_s >= 0) je.set(b.schritt, [...(je.get(b.schritt) ?? []), b.dauer_s]);
    }
  }
  const aus: Record<string, number> = {};
  for (const s of SCHRITTE) {
    const d = (je.get(s) ?? []).slice().sort((a, b) => a - b);
    aus[s] = d.length ? d[Math.floor((d.length - 1) / 2)] : (MINUTEN[s] ?? 0.5) * 60;
  }
  return aus;
}

export type SchrittZustand = 'ok' | 'lauf' | 'warn' | 'offen';

export interface SchrittZeile {
  schritt: string;
  titel: string;
  zustand: SchrittZustand;
  /** Eine Zeile Beleg (nur erledigte Schritte, nur wenn der Dienst sie meldet). */
  beleg: string | null;
  /** Gemessene Dauer (erledigt), seit wann (läuft) oder die übliche (offen). */
  dauer: string | null;
}

export interface PhasenZeile {
  id: string;
  titel: string;
  zustand: PhaseZustand;
  schritte: SchrittZeile[];
  /** Rechts in der Zeile: „4 ✓“ oder „ca. 3 Min“. */
  rechts: string;
}

function seitSekVonIso(iso: string | null | undefined, jetztMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, (jetztMs - t) / 1000) : null;
}

function seitSek(s: LaufStand, jetztMs: number): number | null {
  return seitSekVonIso(s.schritt_seit, jetztMs);
}

/** Sekunden seit einem beliebigen ISO-Zeitpunkt (Läuft-Anzeige außerhalb eines Laufs, z. B. Werkbank-Meldung). */
export function liveSeitSek(iso: string | null | undefined, jetztMs: number): number | null {
  return seitSekVonIso(iso, jetztMs);
}

/** „vor 4 s“, ab einer Minute „vor 1:15“ - das Lebenszeichen eines Checks, den der Dienst selbst wiederholt. */
export function seitText(sek: number): string {
  const s = Math.max(0, Math.round(sek));
  return s < 60 ? `vor ${s} s` : `vor ${dauerText(s)}`;
}

/** Alle Schritte des Laufs nach Phasen, jeder mit Belegzeile und Dauer (E3 A). */
export function schrittListe(s: LaufStand, meist: Record<string, number>, jetztMs: number): PhasenZeile[] {
  const belege = new Map((s.belege ?? []).map((b) => [b.schritt, b]));
  const erledigt = new Set(s.erledigt);
  const zeile = (x: string): SchrittZeile => {
    let zustand: SchrittZustand = 'offen';
    if (s.zustand === 'fertig' || erledigt.has(x)) zustand = 'ok';
    else if (s.schritt === x) zustand = s.zustand === 'angehalten' ? 'warn' : 'lauf';
    const b = belege.get(x);
    let dauer: string | null = null;
    if (zustand === 'ok' && b) dauer = dauerText(b.dauer_s);
    else if (zustand === 'lauf') {
      const seit = seitSek(s, jetztMs);
      dauer = seit == null ? null : dauerText(seit);
    } else if (zustand === 'offen') dauer = minutenText(meist[x] ?? 30);
    return { schritt: x, titel: schrittTitel(x), zustand, beleg: zustand === 'ok' ? b?.zeile ?? null : null, dauer };
  };
  return PHASEN.map((p) => {
    const ss = p.schritte.filter((x) => zaehlt(s, x)).map(zeile);
    const zustand: PhaseZustand = ss.every((x) => x.zustand === 'ok')
      ? 'ok'
      : ss.some((x) => x.zustand === 'warn')
        ? 'warn'
        : ss.some((x) => x.zustand === 'lauf') || (ss.some((x) => x.zustand === 'ok') && s.zustand !== 'angehalten')
          ? 'lauf'
          : 'offen';
    const offen = ss.filter((x) => x.zustand === 'offen').reduce((a, x) => a + (meist[x.schritt] ?? 30), 0);
    const rechts = zustand === 'ok' ? `${ss.length} ✓` : zustand === 'offen' ? `ca. ${Math.max(1, Math.round(offen / 60))} Min` : '';
    return { id: p.id, titel: p.titel, zustand, schritte: ss, rechts };
  });
}

export interface Jetzt {
  nummer: number;
  von: number;
  schritt: string;
  titel: string;
  tut: string;
  /** Seit wann der Schritt läuft (s); null, wenn der Dienst es nicht meldet. */
  seitSek: number | null;
  meistSek: number;
  /** Frist des Schritts (s); null ohne Meldung. */
  fristSek: number | null;
  danach: string | null;
  dann: string[];
}

/** Die Jetzt-Karte: was der Dienst gerade tut, seit wann, wie lange meist, Frist, was danach kommt. */
export function jetzt(s: LaufStand, meist: Record<string, number>, jetztMs: number): Jetzt | null {
  if (!s.schritt || (s.zustand !== 'laeuft' && s.zustand !== 'wartet')) return null;
  const liste = laufSchritte(s);
  const i = liste.indexOf(s.schritt);
  if (i < 0) return null;
  const rest = liste.slice(i + 1);
  return {
    nummer: i + 1,
    von: liste.length,
    schritt: s.schritt,
    titel: schrittTitel(s.schritt),
    tut: s.zustand === 'wartet' && s.hinweis ? s.hinweis : SCHRITT_TEXT[s.schritt]?.tut ?? '',
    seitSek: seitSek(s, jetztMs),
    meistSek: meist[s.schritt] ?? 30,
    fristSek: s.schritt_frist_s && s.schritt_frist_s > 0 ? s.schritt_frist_s : null,
    danach: rest[0] ? schrittTitel(rest[0]) : null,
    dann: rest.slice(1, 3).map(schrittTitel),
  };
}

// ── Software ───────────────────────────────────────────────────────────────

export interface Paket {
  name: string;
  fassung: string;
  /** „✓ Prüfsumme = Freigabe“, „wird eingespielt“, „noch nicht drauf“ … */
  pruef: string;
  ok: boolean;
  /** Was vorher auf der Box war; null, solange der Dienst es nicht gelesen hat. */
  vorher: string | null;
  ersetzt: boolean;
  /** Kurze Prüfsumme der Freigabe (OpenWrt). */
  sha: string | null;
}

export interface Software {
  freigabe: string;
  gueltigBis: string | null;
  openwrt: Paket;
  edgeLight: Paket;
}

/** „0123…cdef“ */
export function shaKurz(sha: string | undefined | null): string | null {
  return sha && sha.length > 12 ? `${sha.slice(0, 4)}…${sha.slice(-4)}` : sha ?? null;
}

/** Edge Light ohne den Präfix des Programmnamens: „2026.11.1“. */
export function edgeFassung(f: string): string {
  return f.replace(/^edge-light-/, '');
}

/**
 * Was auf diese Box kommt: Freigabe, OpenWrt mit Prüfsumme, Edge Light, je mit
 * „vorher“ (aus dem Schritt erkennen) und dem Stand im Lauf. Null ohne Freigabe.
 */
export function software(a: WerkstattAnsicht, lauf: LaufStand | null): Software | null {
  const f = a.freigabe.freigabe;
  if (!f) return null;
  const erledigt = new Set(lauf?.erledigt ?? []);
  const fertig = lauf?.zustand === 'fertig';
  const v = lauf?.vorher ?? null;
  const schonOpenWrt = !!v && v.system === `OpenWrt ${f.openwrt.fassung}`;
  const ow = fertig || erledigt.has('openwrt')
    ? { pruef: '✓ Prüfsumme = Freigabe', ok: true }
    : schonOpenWrt && erledigt.has('erkennen')
      ? { pruef: '✓ schon drauf', ok: true }
      : lauf?.schritt === 'openwrt' && lauf.zustand !== 'angehalten'
        ? { pruef: 'wird aufgespielt', ok: false }
        : { pruef: 'noch nicht drauf', ok: false };
  const updateBereit = (lauf?.belege ?? []).some((b) => b.schritt === 'programm' && b.zeile.includes('update-bereit'));
  const el = fertig || erledigt.has('programm')
    ? { pruef: updateBereit || fertig ? '✓ update-bereit' : '✓ läuft', ok: true }
    : lauf?.schritt === 'programm' && lauf.zustand !== 'angehalten'
      ? { pruef: 'wird eingespielt', ok: false }
      : { pruef: 'noch nicht drauf', ok: false };
  return {
    freigabe: lauf?.freigabe || f.kennung,
    gueltigBis: f.gueltig_bis ?? null,
    openwrt: { name: 'OpenWrt', fassung: f.openwrt.fassung, ...ow, vorher: v?.system ?? null, ersetzt: false, sha: shaKurz(f.openwrt.sha256) },
    edgeLight: { name: 'Edge Light', fassung: edgeFassung(f.edge_light.fassung), ...el, vorher: v?.edge_light ?? null, ersetzt: !!v?.ersetzt, sha: null },
  };
}

/**
 * Ein neueres signiertes Edge-Light-Release als die Freigabe, oder null. Die Box-Art des Releases ist die der API
 * (`ota.BoxArt`: `docker` oder `light`) - bis 06.11.2026 stand hier `edge-light`, und der Hinweis kam nie.
 */
export function neueresRelease(
  freigabeFassung: string,
  releases: readonly { version: string; signed: boolean; boxArt?: string; releaseSeq: number }[],
): string | null {
  const jetzt = edgeFassung(freigabeFassung);
  const neu = releases
    .filter((r) => r.signed && r.boxArt === 'light')
    .map((r) => edgeFassung(r.version))
    .filter((v) => v.localeCompare(jetzt, 'de', { numeric: true }) > 0)
    .sort((x, y) => y.localeCompare(x, 'de', { numeric: true }));
  return neu[0] ?? null;
}

// ── Fälle ──────────────────────────────────────────────────────────────────

export type FallArt = 'warten' | 'hand' | 'seite';
export type Bild = 'reset' | 'startlader' | 'pi' | 'kabel';
export type KnopfArt = 'nochmal' | 'zur-seite' | 'freigeben' | 'freigabe-ansehen' | 'abbild' | 'register' | 'box-oeffnen';
export type KnopfStil = 'primary' | 'outline' | 'leise';

export interface Knopf {
  art: KnopfArt;
  stil: KnopfStil;
  text: string;
}

export interface LivePunkt {
  zustand: 'ok' | 'lauf' | 'offen' | 'warn';
  text: string;
  /** Nur am laufenden Punkt: ein Satz in Alltagssprache, was der Dienst dabei gerade tut. */
  tut?: string;
  /** Nur am laufenden Punkt, wenn der Dienst selbst wiederholt prüft: seit wann zuletzt (ISO), für die mitzählende Anzeige. */
  seit?: string | null;
}

export interface FallSeite {
  code: string;
  /** am Anschluss (ohne Lauf) oder ein angehaltener Lauf */
  wo: 'anschluss' | 'lauf';
  art: FallArt;
  titel: string;
  was: string;
  schritte: string[];
  selbst: boolean;
  bild: Bild | null;
  knoepfe: Knopf[];
  /** Ein Satz nach den Schritten (etwa, was mit der alten Referenz geschieht). */
  nach: string | null;
  /** Woran man sieht, dass der Dienst von selbst weitermacht. */
  live: LivePunkt[];
}

/** Der Dienst wartet, du musst nichts tun. */
const WARTEN = new Set(['startet', 'keine_box', 'kein_kabel']);
/** Nur hier nennt die Seite den Reset-Knopf (Sicherheitslinie aus faelle.md, NA-1 B). */
export const RESET_FAELLE: ReadonlySet<string> = new Set(['gl_passwort', 'halb_eigene']);
const STARTLADER = new Set(['ssh_zu', 'abbild_abgelehnt', 'openwrt_fassung']);
const PI = new Set(['bruecke_nicht_bereit', 'bruecke_unterspannung', 'bruecke_weg']);

/** Ein Satz je Code: was los ist, ohne Fachwörter. */
export const WAS: Record<string, string> = {
  startet: 'Sie meldet sich, nimmt aber noch keine Anmeldung an. Der Dienst beginnt erst, wenn sie zweimal hintereinander gleich antwortet.',
  keine_box: 'Das Kabel steckt, aber an ihm meldet sich noch niemand.',
  kein_kabel: 'Das orange Kabel WERKSTATT steckt in keiner Mango.',
  bruecke_nicht_bereit: 'Der kleine Rechner (Pi) an der Werkbank antwortet nicht. Ohne ihn erreicht der Dienst keine Mango.',
  bruecke_unterspannung: 'Der Pi meldet zu wenig Strom. Das kann Verbindungen abbrechen lassen; ein Lauf wird deshalb nicht angehalten.',
  nicht_freigegeben: 'Ohne Freigabe richtet der Dienst keine Box ein.',
  zwei_geraete: 'Am orangen Kabel antworten mehrere Geräte. Der Dienst fasst keins an.',
  gesperrt: 'Für diese Mango ist der Lauf vorbei. Der Dienst fasst sie erst wieder an, wenn sie einmal weg war.',
  eingerichtet: 'Sie steht schon im Netz einer fertigen Box. Fertige Boxen fasst der Dienst nie an.',
  gl_passwort: 'Ihre Werksfirmware verlangt ein Passwort. Der Dienst rät keine Passwörter.',
  halb_eigene: 'Ein früherer Lauf dieser Werkstatt hat sie angefangen und nicht fertig gemacht. Sie ist nicht abgenommen und mit keinem Kunden gekoppelt.',
  passwort_fremd: 'Sie hat ein Passwort, das kein Lauf dieser Werkstatt gesetzt hat, zum Beispiel von Hand eingerichtet.',
  box_in_gebrauch: 'Sie ist abgenommen oder mit einem Kunden gekoppelt. So eine Box setzt der Dienst nie zurück.',
  nicht_nachweisbar: 'Der Dienst kann nicht belegen, dass es dieselbe Box wie in seinem früheren Lauf ist. Dann setzt er nichts zurück.',
  ssh_zu: 'Ihre Werksfirmware öffnet keinen Zugang. Dann hilft der Startlader, einmal am Rechner.',
  abbild_abgelehnt: 'Der Test vor dem Aufspielen ist gescheitert. Über den Startlader geht es trotzdem.',
  falsches_geraet: 'An der Werkbank werden nur Mangos GL-MT300N-V2 eingerichtet.',
  schon_edge_light: 'Auf ihr läuft schon Edge Light, aber kein Lauf dieser Werkstatt kennt sie.',
  openwrt_fassung: 'Auf ihr ist ein anderes System als in der Freigabe, wahrscheinlich eine zurückgesetzte Box aus einer älteren Freigabe.',
  kein_internet: 'Über die Brücke kommt die Mango nicht ins Internet; ohne Internet lädt sie nichts.',
  fassung_nicht_bereit: 'Die Dateien der Freigabe lassen sich nicht laden oder passen nicht zu ihr. Die Mango wurde nicht angefasst.',
  uebertragung: 'Die Prüfsumme auf der Box passt nicht. Aufgespielt wurde nichts.',
  bruecke_weg: 'Der Dienst hat den Pi während des Laufs nicht erreicht.',
  box_weg: 'Sie antwortete während des Laufs nicht mehr.',
  einloesen_abgewiesen: 'Das Portal hat die Anmeldung der Box abgewiesen, zum Beispiel weil die Freigabe voll oder abgelaufen ist.',
  nicht_update_bereit: 'Ohne Update-Bereitschaft gibt es keine Abnahme (Entscheid 5c).',
  dienst_neu_gestartet: 'Der Dienst wurde neu gestartet. Beim nächsten Versuch erkennt er, wie weit die Mango war.',
  schritt_gescheitert: 'Ein Fehler, den der Dienst nicht genauer kennt. Der Grund steht unten für die Technik.',
};

const NACH: Record<string, string> = {
  halb_eigene: 'Nach dem Reset bekommt sie eine neue Referenz; die alte bleibt im Register als Verlauf stehen.',
  bruecke_weg: 'Hatte die Mango schon ein Passwort, kommt beim nächsten Mal der Reset-Schritt.',
};

/** Ein Lauf eines älteren Dienstes ohne `fall`: wie bisher aus dem Handgriff gelesen. */
function fallOhneCode(lauf: LaufStand): string {
  const h = lauf.handgriff ?? '';
  if (h.startsWith('Zurücksetzen')) return 'gl_passwort';
  if (h.startsWith('Startlader')) return 'ssh_zu';
  return 'schritt_gescheitert';
}

/** Die Lösung, wenn der Dienst keine meldet (älterer Dienst): dieselben Worte wie bisher. */
function loesungOhne(code: string): Loesung {
  if (RESET_FAELLE.has(code)) {
    return { titel: 'Diese Mango muss zurückgesetzt werden.', selbst: true, zur_seite: false, schritte: [
      'Den Reset-Knopf der Mango mit einem Stift 10 Sekunden gedrückt halten, bis die Leuchte schnell blinkt. Dann loslassen.',
      'Kabel und Strom bleiben stecken. Die Mango startet neu; das dauert ein paar Minuten.',
    ] };
  }
  if (STARTLADER.has(code)) {
    return { titel: 'Die Mango lässt den Dienst nicht hinein.', selbst: true, zur_seite: false, schritte: [
      'Startlader: Mango vom Strom, Reset-Knopf halten und Strom wieder anstecken; nach etwa fünf Sekunden loslassen, wenn die Leuchte blinkt.',
      'Am Rechner das neue System hochladen, wie unter „Details für Technik“ beschrieben. Das orange Kabel bleibt stecken.',
    ] };
  }
  return { titel: 'Hier hat etwas nicht geklappt.', selbst: true, zur_seite: false, schritte: [
    'Das orange Kabel kurz abziehen und wieder einstecken: der Dienst versucht es noch einmal.',
    'Klappt es wieder nicht: zur Seite legen, Zettel „Problem“ drauf. Der Grund bleibt hier für die Technik stehen.',
  ] };
}

export interface FallEingabe {
  code: string | null | undefined;
  loesung: Loesung | null | undefined;
  wo: 'anschluss' | 'lauf';
  ansicht: WerkstattAnsicht;
  /** Der angehaltene Lauf (bei `wo: 'lauf'`, oder der letzte am Anschluss). */
  lauf: LaufStand | null;
}

function kabelPunkte(a: WerkstattAnsicht): LivePunkt[] {
  const kabel = a.werkbank.status?.werkstatt?.kabel ?? false;
  const meldet = (a.werkbank.status?.antworten ?? []).some((x) => (x.macs ?? []).length > 0);
  const seit = a.werkbank.status_zeit ?? null;
  return [
    kabel
      ? { zustand: 'ok', text: 'Kabel steckt' }
      : { zustand: 'lauf', text: 'Kabel steckt', tut: 'Wartet, bis das orange Kabel WERKSTATT eingesteckt ist.', seit },
    meldet
      ? { zustand: 'ok', text: 'Mango meldet sich' }
      : kabel
        ? { zustand: 'lauf', text: 'Mango meldet sich', tut: 'Prüft, ob sich die Mango meldet.', seit }
        : { zustand: 'offen', text: 'Mango meldet sich' },
    { zustand: 'offen', text: 'Lauf beginnt von selbst' },
  ];
}

/** Woran man sieht, dass es weitergeht; aus dem, was der Dienst am Anschluss sieht. */
function live(code: string, wo: 'anschluss' | 'lauf', a: WerkstattAnsicht, selbst: boolean, nochmal: boolean): LivePunkt[] {
  if (!selbst) return [];
  const amAnschluss = a.anschluss_fall ?? null;
  const seit = a.werkbank.status_zeit ?? null;
  if (RESET_FAELLE.has(code)) {
    const weg = amAnschluss === 'keine_box' || amAnschluss === 'kein_kabel';
    const startet = amAnschluss === 'startet';
    return [
      weg || startet
        ? { zustand: 'ok', text: 'Warten auf den Reset' }
        : { zustand: 'lauf', text: 'Warten auf den Reset', tut: 'Wartet, bis du den Reset-Knopf drückst.', seit },
      startet
        ? { zustand: 'ok', text: 'Mango startet neu (bis 5 Minuten)' }
        : weg
          ? { zustand: 'lauf', text: 'Mango startet neu (bis 5 Minuten)', tut: 'Prüft, ob die Mango nach dem Reset wieder antwortet.', seit }
          : { zustand: 'offen', text: 'Mango startet neu (bis 5 Minuten)' },
      startet
        ? { zustand: 'lauf', text: 'Neuer Lauf beginnt von selbst', tut: 'Mango antwortet; der Dienst startet gleich einen neuen Lauf.', seit }
        : { zustand: 'offen', text: 'Neuer Lauf beginnt von selbst' },
    ];
  }
  if (STARTLADER.has(code)) {
    const startet = amAnschluss === 'startet';
    return [
      startet
        ? { zustand: 'ok', text: 'Frisches OpenWrt meldet sich am orangen Kabel' }
        : {
            zustand: 'lauf',
            text: 'Frisches OpenWrt meldet sich am orangen Kabel',
            tut: 'Prüft, ob sich frisches OpenWrt am orangen Kabel meldet.',
            seit,
          },
      startet
        ? { zustand: 'lauf', text: 'Lauf beginnt von selbst', tut: 'Meldet sich; der Dienst startet gleich einen neuen Lauf.', seit }
        : { zustand: 'offen', text: 'Lauf beginnt von selbst' },
    ];
  }
  if (code === 'kein_kabel' || code === 'keine_box') return kabelPunkte(a);
  if (code === 'startet') {
    const [k, m] = kabelPunkte(a);
    return [
      k,
      m,
      { zustand: 'lauf', text: 'Mango nimmt die Anmeldung an', tut: 'Prüft, ob die Mango zweimal hintereinander gleich antwortet.', seit },
      { zustand: 'offen', text: 'Lauf beginnt von selbst' },
    ];
  }
  if (PI.has(code) && wo === 'anschluss') {
    const bereit = a.werkbank.bereit;
    return [
      { zustand: bereit ? 'ok' : 'warn', text: bereit ? 'Brücke antwortet' : 'Brücke antwortet nicht' },
      {
        zustand: 'lauf',
        text: 'Der Dienst fragt alle 10 Sekunden wieder',
        tut: bereit ? 'Prüft gerade, ob die Brücke wieder genug Strom hat.' : 'Prüft gerade, ob die Brücke wieder antwortet.',
        seit,
      },
    ];
  }
  if (wo === 'lauf') {
    return [
      { zustand: 'lauf', text: nochmal ? 'Kabel kurz abziehen oder „Nochmal versuchen“' : 'Kabel kurz abziehen und wieder einstecken' },
      { zustand: 'offen', text: 'Neuer Lauf beginnt von selbst' },
    ];
  }
  return [];
}

/** Die Seite zu einem Fall (E1 A, E2 A; Konzept Abschnitt 5). */
export function fallSeite(e: FallEingabe): FallSeite {
  const code = e.code || (e.lauf ? fallOhneCode(e.lauf) : 'schritt_gescheitert');
  const l = e.loesung ?? loesungOhne(code);
  const art: FallArt = WARTEN.has(code) ? 'warten' : l.zur_seite || code === 'eingerichtet' ? 'seite' : 'hand';
  const bild: Bild | null = RESET_FAELLE.has(code) ? 'reset' : STARTLADER.has(code) ? 'startlader' : PI.has(code) ? 'pi'
    : code === 'kein_kabel' || code === 'keine_box' ? 'kabel' : null;
  const lauf = e.lauf;
  const nochmal = !!lauf && lauf.zustand === 'angehalten' && lauf.nochmal_moeglich === true && !lauf.nochmal_seit;
  const knoepfe: Knopf[] = [];
  if (code === 'nicht_freigegeben') knoepfe.push({ art: 'freigeben', stil: 'primary', text: 'Werkstatt freigeben' });
  if (nochmal) knoepfe.push({ art: 'nochmal', stil: art === 'seite' ? 'leise' : 'primary', text: 'Nochmal versuchen' });
  if (STARTLADER.has(code) && e.ansicht.freigabe.freigabe) {
    knoepfe.push({ art: 'abbild', stil: 'outline', text: `OpenWrt-Abbild ${e.ansicht.freigabe.freigabe.openwrt.fassung} herunterladen` });
  }
  if (code === 'fassung_nicht_bereit' || code === 'einloesen_abgewiesen') knoepfe.push({ art: 'freigabe-ansehen', stil: 'outline', text: 'Freigabe ansehen' });
  if (code === 'eingerichtet') knoepfe.push({ art: 'register', stil: 'outline', text: 'Register öffnen' });
  if (e.wo === 'lauf' && lauf) {
    const haupt = art === 'seite' || code === 'schritt_gescheitert';
    knoepfe.push({ art: 'zur-seite', stil: haupt ? 'outline' : 'leise', text: 'Box zur Seite legen' });
  }
  if (code === 'box_in_gebrauch' && lauf?.box) knoepfe.push({ art: 'box-oeffnen', stil: 'leise', text: `${lauf.box} öffnen` });
  return {
    code,
    wo: e.wo,
    art,
    titel: l.titel,
    was: WAS[code] ?? 'Der Dienst hat hier angehalten.',
    schritte: l.schritte,
    selbst: l.selbst,
    bild,
    knoepfe,
    nach: NACH[code] ?? null,
    live: live(code, e.wo, e.ansicht, l.selbst, nochmal),
  };
}

/** Fall-Codes, die der Dienst kennt (Vertrag werkstatt-ansicht-v1, „Fälle“): für Tests und die Doku. */
export const FALL_CODES = Object.keys(WAS);
