/**
 * Der ANBINDE-ASSISTENT einer Ladesäule (Geräteseiten-Revision `vp-geraeteseite-rev-b8`
 * §8 / NACHTRAG, Captain-Entscheid **E1**): Kennung festlegen → Adresse in der
 * Säule eintragen → warten, bis sie sich meldet.
 *
 * **Es ist eine reine Textschicht.** Jede Regel und jeder Satz steht hier;
 * `components/LadesaeuleAnbindenDrawer.tsx` rendert nur und meldet, was jemand
 * angefasst hat.
 *
 * ## Die drei Regeln, die den Assistenten tragen
 *
 * **⚠ 1. Die ALLOWLIST bleibt die Allowlist — es wandert nur ihr PFLEGE-Ort.**
 * Eine unbekannte Kennung weist die Box weiterhin ab und protokolliert sie; es
 * entsteht kein Anlern-Fenster und kein TOFU. Seit der Captain-Order vom
 * 24.08.2026 lässt sich eine eingetragene Kennung hier auch wieder ENTFERNEN —
 * das ist eine eigene, ausdrückliche Handlung mit Rückfrage, nie die
 * Nebenwirkung eines Speicherns, und die Folge wird VORHER genannt.
 *
 * **⚠ 2. Die ADRESSE wird nie erfunden.** Sie entsteht ausschließlich aus dem,
 * was das GERÄT meldet: seine LAN-Adresse (D5) und Port + Pfad seines
 * OCPP-Servers. Fehlt eines davon, nennt die Fläche den WEG statt eine Adresse
 * zu behaupten, unter der niemand antwortet.
 *
 * **⚠ 3. Eingetragen ≠ gemeldet.** Dass eine Kennung in der Liste steht heißt,
 * dass die Box sie ANNEHMEN würde — nicht, dass eine Säule sie benutzt hat. Der
 * Abschluss wird deshalb ausschließlich aus dem gelesen, was die Box über
 * tatsächlich gesehene Säulen berichtet.
 */

import type { Device } from './api';
import type {
  AllowedChargePoint,
  ChargePoint,
  ChargerConnection,
  SiteCharging,
} from './ladepunkte';
import { privateLanAddress } from './geraetSeite';

// ---------------------------------------------------------------------------
// Schritt 1: die Kennung
// ---------------------------------------------------------------------------

/**
 * Das Zeichen-Vokabular einer ChargePointId — dasselbe, das der Kontrakt führt
 * und der Server ein zweites Mal prüft (er glaubt dieser Fläche nichts). Es ist
 * zugleich das eines MQTT-Topic-Segments und eines URL-Pfad-Segments.
 */
const KENNUNG = /^[A-Za-z0-9._-]{1,64}$/;

/** Der Hinweis unter dem Kennungs-Feld — er sagt, WORAUF es ankommt. */
export const KENNUNG_HILFE =
  'Dieselbe Kennung tragen Sie gleich in der Säule ein — beide Seiten müssen zeichengleich übereinstimmen. Erlaubt sind Buchstaben, Ziffern, Punkt, Bindestrich und Unterstrich.';

/**
 * Prüft die Kennung, bevor irgendetwas gespeichert wird — und nennt bei einer
 * Ablehnung den erlaubten Satz. „Ungültig" ist auf einer Kundenfläche keine
 * Antwort.
 */
export function kennungFehler(raw: string, vergeben: string[] = []): string | null {
  const v = String(raw ?? '').trim();
  if (!v) return 'Bitte eine Kennung eintragen — unter ihr meldet sich die Säule.';
  if (v.length > 64) return 'Die Kennung darf höchstens 64 Zeichen lang sein.';
  if (!KENNUNG.test(v)) {
    return 'Erlaubt sind Buchstaben, Ziffern, Punkt, Bindestrich und Unterstrich — keine Leerzeichen, keine Umlaute und keine Schrägstriche.';
  }
  if (vergeben.some((x) => x === v)) {
    return 'Diese Kennung ist für diese Anlage schon eingetragen.';
  }
  return null;
}

/**
 * Ein Vorschlag für die Kennung, aus dem Namen, den der Kunde ohnehin tippt.
 *
 * Er ist eine BEQUEMLICHKEIT, keine Vorgabe: das Feld bleibt frei editierbar,
 * denn zeichengleich mit der Säule zu sein ist das Einzige, worauf es ankommt.
 * Ergibt der Name keine erlaubten Zeichen, wird NICHTS vorgeschlagen — ein
 * erfundener Name wäre schlechter als ein leeres Feld.
 */
export function kennungVorschlag(name: string): string {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

// ---------------------------------------------------------------------------
// Schritt 2: die Adresse, die in die Säule kommt
// ---------------------------------------------------------------------------

/** Was die Fläche über den Endpunkt sagen kann — oder eben nicht. */
export interface EndpunktSicht {
  /** Die vollständige Adresse inklusive Kennung, oder null. */
  url: string | null;
  /** Dieselbe Adresse OHNE Kennung — manche Säulen hängen sie selbst an. */
  basis: string | null;
  /** Der Satz daneben: was sie ist, bzw. warum es keine gibt. */
  satz: string;
  /** Warum die Adresse fehlt — nur gesetzt, wenn `url` null ist. */
  grund: 'keine-adresse' | 'nicht-bewiesen' | 'noch-nicht-gemeldet' | 'lauscht-nicht' | null;
}

/** Der Weg, der IMMER gilt — auch ohne bekannte Adresse. */
export const ENDPUNKT_WEG =
  'Adresse und Anschluss zeigt Ihnen die Geräteseite von VoltPilot in Ihrem Netzwerk.';

/**
 * ⚠ Der Satz, der die häufigste Fehlbedienung verhindert: OCPP kennt ZWEI
 * Schreibweisen, und welche eine Säule will, weiß nur ihr Handbuch. Eine Fläche,
 * die nur eine zeigt, schickt die Hälfte der Kunden in einen Verbindungsfehler,
 * den niemand erklären kann.
 */
export const ENDPUNKT_ZWEI_FORMEN =
  'Manche Säulen wollen die vollständige Adresse, andere nur den Teil bis „/ocpp" und hängen ihre Kennung selbst an. Steht in Ihrem Säulen-Handbuch nichts dazu, beginnen Sie mit der vollständigen.';

/**
 * Baut den `ws://`-Endpunkt, den ein Mensch in die Säule tippt.
 *
 * **⚠ Drei Bedingungen, und jede fehlende wird BENANNT statt überspielt:**
 *
 * 1. Die Box muss eine LAN-Adresse gemeldet haben (D5) — ohne sie gibt es
 *    nichts zu kopieren.
 * 2. Sie muss als privater Kundennetz-Endpunkt validierbar sein. Moderne Boxen
 *    melden dafür den vom Host erkannten/konfigurierten Endpunkt; `erreicht`
 *    bleibt der kompatible Alt-Beleg. WAN, Loopback und kaputte Ports werden
 *    vor dem Kopierfeld verworfen.
 * 3. Die Box muss ihren Anschluss GEMELDET haben. Hier gibt es ZWEI Fälle, und
 *    sie zu verwechseln wäre eine Falschaussage über eine gesunde Anlage: hat
 *    sie zu ihren Ladepunkten noch gar nichts gemeldet (`budget == null`, der
 *    Normalfall VOR der ersten eingetragenen Kennung), dann wissen wir es
 *    schlicht noch nicht — der Server läuft trotzdem. Meldet sie einen Block
 *    OHNE Anschluss, lauscht wirklich nichts.
 *
 * Die gemeldete LAN-Adresse trägt den Anschluss der lokalen Oberfläche
 * (`…:8484`) — der wird abgeschnitten, denn OCPP hat seinen eigenen.
 */
export function endpunkt(
  device: Device | undefined,
  charging: SiteCharging | null,
  kennung: string,
): EndpunktSicht {
  const roh = privateLanAddress(device?.lanHost);
  if (!roh) {
    return {
      url: null,
      basis: null,
      satz: `VoltPilot kennt die Adresse Ihrer Box im Heimnetz noch nicht. ${ENDPUNKT_WEG}`,
      grund: 'keine-adresse',
    };
  }
  const port = anschluss(charging?.budget?.ocppPort);
  if (port == null) {
    // ⚠ „Noch nichts gemeldet" ist NICHT „lauscht nicht": eine Box meldet ihre
    // Ladepunkt-Lage erst, wenn es welche gibt. Vor der ersten eingetragenen
    // Kennung ist das der Normalfall - „es kann sich keine Säule verbinden"
    // wäre dort schlicht falsch.
    if (!charging?.budget) {
      return {
        url: null,
        basis: null,
        satz: `Sobald die Kennung eingetragen ist, meldet Ihre Box ihren Anschluss — dann steht hier die Adresse zum Kopieren. ${ENDPUNKT_WEG}`,
        grund: 'noch-nicht-gemeldet',
      };
    }
    return {
      url: null,
      basis: null,
      satz: `Der Ladepunkt-Server Ihrer Box meldet gerade keinen Anschluss — solange kann sich keine Säule verbinden. ${ENDPUNKT_WEG}`,
      grund: 'lauscht-nicht',
    };
  }
  const basis = `ws://${hostOhnePort(roh)}:${port}${normPfad(charging?.budget?.ocppUrlPath)}`;
  const id = String(kennung ?? '').trim();
  return {
    url: id ? `${basis}/${id}` : basis,
    basis,
    satz:
      'Diese Adresse tragen Sie in der Säule ein — je nach Hersteller heißt das Feld „Backend-URL", „OCPP-Server" oder „Central System".',
    grund: null,
  };
}

/*
 * ⚠ Die ZUSAGE („nur eine eingetragene Kennung wird zugelassen") lebt bewusst
 * NICHT hier, sondern bleibt `ladepunkte.ANBINDEN_ALLOWLIST` — sie steht auf
 * mehreren Flächen, und zwei Formulierungen derselben Zusage wären zwei
 * Wahrheiten über dieselbe Regel.
 */

// ---------------------------------------------------------------------------
// Schritt 3: hat sie sich gemeldet?
// ---------------------------------------------------------------------------

/** Der Zustand des Wartens — er behauptet nie mehr, als gemeldet ist. */
export interface MeldungSicht {
  gemeldet: boolean;
  wort: string;
  satz: string;
  ton: 'ok' | 'warten';
}

/**
 * Hat sich die Säule bei der Box gemeldet?
 *
 * **⚠ Gelesen wird ausschließlich das GEMELDETE** (die Säulen-Liste des
 * Herzschlags), nie der eigene Eintrag — siehe Regel 3 oben.
 */
export function meldung(charging: SiteCharging | null, kennung: string): MeldungSicht {
  const id = String(kennung ?? '').trim();
  const cp = id ? (charging?.chargers ?? []).find((c) => c.chargePointId === id) : undefined;
  if (!cp) {
    return {
      gemeldet: false,
      wort: 'Wartet auf die Säule',
      satz: 'Sobald sich die Säule unter dieser Kennung meldet, erscheint sie hier — mit Modell und Steckern, die sie selbst mitbringt.',
      ton: 'warten',
    };
  }
  return {
    gemeldet: true,
    wort: cp.connected ? 'Verbunden' : 'Hat sich gemeldet',
    satz: meldungsSatz(cp),
    ton: 'ok',
  };
}

function meldungsSatz(cp: ChargePoint): string {
  const teile: string[] = [];
  const name = [cp.vendor, cp.model].filter(Boolean).join(' ').trim();
  if (name) teile.push(name);
  const stecker = (cp.connectors ?? []).length;
  if (stecker > 0) teile.push(stecker === 1 ? '1 Stecker' : `${stecker} Stecker`);
  const zusatz = teile.length ? ` (${teile.join(' · ')})` : '';
  return cp.connected
    ? `Die Säule ist verbunden${zusatz}.`
    : `Die Säule hat sich gemeldet${zusatz}, ist gerade aber nicht verbunden.`;
}

// ---------------------------------------------------------------------------
// Schritt 1b: WO die Saeule haengt (Cockpit Phase 1 / C1, Captain-Entscheid E5)
// ---------------------------------------------------------------------------

/**
 * Die Frage ueber dem Auswahl-Paar. Sie fragt nach einer TATSACHE der Anlage,
 * nicht nach einer Vorliebe — deshalb ist sie eine Ortsfrage und keine
 * Einstellung mit „empfohlen".
 */
export const ANSCHLUSS_FRAGE = 'Wo hängt diese Säule?';

/**
 * Warum das ueberhaupt gefragt wird — in der Waehrung des Kunden.
 *
 * ⚠ Er sagt die FOLGE, nicht die Formel: das Budget-Gesetz der Box
 * (`budget = planbar − (Netzbezug − Ladeleistung)`) gehoert in den Vertrag und
 * in den Code, nicht in einen Dialog.
 */
export const ANSCHLUSS_HILFE =
  'Davon hängt ab, ob VoltPilot die Ladeleistung dieser Säule aus dem Netzbezug Ihrer Anlage herausrechnet. Im Zweifel gilt der Normalfall: hinter dem Hausanschluss.';

export interface AnschlussOption {
  value: ChargerConnection;
  label: string;
  satz: string;
  /** Die Vorgabe — genau EINE trägt sie. */
  vorgabe: boolean;
}

/**
 * Die zwei Orte, an denen eine Ladesäule hängen kann.
 *
 * ⚠ `haus` ist die Vorgabe, und das ist die SICHERE Richtung: sie heißt „ihre
 * Leistung steckt in unserer Netzmessung und wird zurückaddiert". Waere die
 * Wahrheit `eigen`, fiele das Budget zu GROSS aus — der Hausanschluss koennte
 * um genau ihre Leistung ueberschritten werden. Umgekehrt kostet ein
 * faelschlich als `eigen` gefuehrter Ladepunkt nur Budget, nie Sicherheit.
 */
export const ANSCHLUSS_OPTIONEN: AnschlussOption[] = [
  {
    value: 'haus',
    label: 'Hinter dem Hausanschluss',
    satz: 'Der Normalfall: die Säule hängt an derselben Zuleitung wie Ihr Haus. VoltPilot teilt die verfügbare Leistung zwischen Haus und Ladesäulen auf.',
    vorgabe: true,
  },
  {
    value: 'eigen',
    label: 'Eigener Netzanschluss',
    satz: 'Die Säule hat einen eigenen Anschluss mit eigenem Zähler. Ihre Leistung zählt dann nicht gegen den Hausanschluss — und erscheint im Cockpit als eigene Gruppe.',
    vorgabe: false,
  },
];

/** Die Vorgabe des Dialogs, an EINER Stelle. */
export const ANSCHLUSS_VORGABE: ChargerConnection =
  ANSCHLUSS_OPTIONEN.find((o) => o.vorgabe)?.value ?? 'haus';

/**
 * Der gespeicherte SOLL-Anschluss einer Kennung.
 *
 * ⚠ `null` heisst „der Kunde hat dazu nichts gesagt" — NICHT `haus`. Die zwei
 * sind verschieden: aus „nichts gesagt" schickt die api kein Feld, die Box
 * behaelt also, was sie hat.
 */
export function anschlussSoll(
  eingetragen: AllowedChargePoint[] | null | undefined,
  kennung: string,
): ChargerConnection | null {
  const id = String(kennung ?? '').trim();
  if (!id) return null;
  const cp = (eingetragen ?? []).find((c) => c.chargePointId === id);
  return cp?.connection ?? null;
}

/** Was das Auswahl-Paar zeigt: das Gespeicherte, sonst die Vorgabe. */
export function anschlussWahl(soll: ChargerConnection | null | undefined): ChargerConnection {
  return soll ?? ANSCHLUSS_VORGABE;
}

/**
 * Was beim Eintragen wirklich gesendet wird.
 *
 * ⚠ Eine unveraenderte Wahl auf einer schon eingetragenen Saeule sendet
 * `undefined` — das Dokument bleibt dann byte-gleich, und eine Zustellung, die
 * nichts aendert, wird gar nicht erst ausgeloest. Beim ERSTEN Eintragen reist
 * die Wahl dagegen immer mit, auch wenn sie die Vorgabe ist: der Kunde hat sie
 * dann gesehen und stehen lassen, und genau das ist eine Aussage.
 */
export function anschlussZumSenden(
  wahl: ChargerConnection,
  soll: ChargerConnection | null | undefined,
): ChargerConnection | undefined {
  return wahl === soll ? undefined : wahl;
}

export interface AnschlussSicht {
  /** Das Wort fuer die Zeile — immer das SOLL, denn es ist die Wahl des Kunden. */
  wort: string;
  /**
   * Der Nachsatz, wenn Soll und Ist auseinanderliegen; sonst `null`.
   *
   * ⚠ Er wird NUR gesagt, wenn die Box wirklich etwas ANDERES meldet. Eine Box,
   * die gar nichts meldet (`ist == null`), ist ein aelterer Stand — daraus eine
   * Abweichung zu machen waere eine Behauptung ueber eine Anlage, die dazu
   * nichts gesagt hat.
   */
  hinweis: string | null;
}

/**
 * Soll und Ist eines Anschlusses, als Zeile.
 *
 * `soll` = was der Kunde gewaehlt hat (Allowlist), `ist` = was die BOX meldet.
 * Ohne Wahl steht die Vorgabe da — sie IST das, wonach gerechnet wird.
 */
export function anschlussSicht(
  soll: ChargerConnection | null | undefined,
  ist: ChargerConnection | null | undefined,
): AnschlussSicht {
  const gewaehlt = anschlussWahl(soll);
  const wort = gewaehlt === 'eigen' ? 'Eigener Netzanschluss' : 'Hinter dem Hausanschluss';
  if (!ist || ist === gewaehlt) return { wort, hinweis: null };
  return {
    wort,
    hinweis:
      gewaehlt === 'eigen'
        ? 'Ihre Box rechnet sie noch hinter dem Hausanschluss — sobald sie das Dokument übernommen hat, gilt Ihre Wahl.'
        : 'Ihre Box führt sie noch auf einem eigenen Anschluss — sobald sie das Dokument übernommen hat, gilt Ihre Wahl.',
  };
}

// ---------------------------------------------------------------------------
// Der Ablauf
// ---------------------------------------------------------------------------

export type SchrittId = 'kennung' | 'eintragen' | 'melden';

export interface SchrittSicht {
  id: SchrittId;
  titel: string;
  /** Erledigt = BELEGT abgeschlossen, nie geraten. */
  erledigt: boolean;
}

/**
 * Die drei Schritte samt ihrem Fortschritt.
 *
 * ⚠ Erledigt ist nur, was BELEGT ist - und für Schritt 1 gibt es zwei Belege:
 * die Kennung steht in der Allowlist, ODER eine Säule meldet sich schon unter
 * ihr (dann ist die Identität durch die Tatsache verabredet - eine Kennung, die
 * ein Betreiber direkt am Gerät eingetragen hat, steht in der Liste des Portals
 * nicht, und einen offenen Schritt neben einer VERBUNDENEN Säule zu zeigen wäre
 * schlicht falsch; im Browser-Beweis aufgefallen). Ob jemand die Adresse in die
 * Säule getippt hat (Schritt 2), kann von hier aus niemand wissen — er gilt als
 * erledigt, sobald Schritt 3 es ist, denn dann ist er es nachweislich gewesen.
 */
export function schritte(eingetragen: boolean, gemeldet: boolean): SchrittSicht[] {
  return [
    { id: 'kennung', titel: 'Kennung festlegen', erledigt: eingetragen || gemeldet },
    { id: 'eintragen', titel: 'Adresse in der Säule eintragen', erledigt: gemeldet },
    { id: 'melden', titel: 'Säule meldet sich', erledigt: gemeldet },
  ];
}

/** Eine Zeile der schon eingetragenen Kennungen. */
export interface EingetrageneZeile {
  kennung: string;
  name: string;
  zustand: string;
  ton: 'ok' | 'warten';
  /**
   * WO sie hängt — Soll (die Wahl des Kunden) und, wenn die Box etwas ANDERES
   * meldet, der Nachsatz dazu (Cockpit Phase 1 / C1).
   */
  anschluss: AnschlussSicht;
}

/**
 * Die Zeilen der Liste „Schon eingetragen".
 *
 * ⚠ Ohne vergebenen Namen wird KEINER erfunden — die Box nimmt dann ebenfalls
 * die Kennung, und zwei verschiedene Anzeigen für dieselbe Säule wären zwei
 * Wahrheiten.
 */
export function eingetrageneZeilen(
  eingetragen: AllowedChargePoint[] | null | undefined,
  charging: SiteCharging | null,
): EingetrageneZeile[] {
  return (eingetragen ?? []).map((cp) => {
    const m = meldung(charging, cp.chargePointId);
    // ⚠ Das IST kommt aus der Meldung der BOX, nicht aus der Allowlist: die
    // Allowlist ist unsere eigene Zeile und kann nichts darüber sagen, wonach
    // die Box wirklich rechnet.
    const ist = (charging?.chargers ?? []).find(
      (c) => c.chargePointId === cp.chargePointId,
    )?.connection;
    return {
      kennung: cp.chargePointId,
      name: (cp.label ?? '').trim() || cp.chargePointId,
      zustand: m.wort,
      ton: m.ton,
      anschluss: anschlussSicht(cp.connection, ist),
    };
  });
}

/** Der Satz, der die Liste ersetzt, solange sie leer ist. */
export const KEINE_EINGETRAGEN =
  'Für diese Anlage ist noch keine Ladesäule eingetragen.';

/**
 * Der Satz am Ende: was jetzt gilt.
 *
 * ⚠ Er behauptet KEINE Zustellung („sobald sie das nächste Mal…") — das
 * Dokument reist retained, und wann die Box es abholt, entscheidet sie.
 */
export function abschluss(gemeldet: boolean): string {
  return gemeldet
    ? 'Fertig — die Säule ist eingetragen und hat sich gemeldet. Ihre Leistung teilt sie sich ab jetzt mit den anderen; Anschlussgrenze und Ausfall-Schutz gelten unverändert.'
    : 'Die Kennung ist eingetragen. Sobald Ihre Box das nächste Mal verbunden ist, übernimmt sie sie — danach lässt sie die Säule herein.';
}

/**
 * Wohin der Kunde nach dem Anbinden schaut (Konzept `vp-verbraucher-cockpit-k1`
 * §8, Phase 0 Schritt 6).
 *
 * ⚠ Er verspricht die Kachel erst, wenn die Säule sich WIRKLICH gemeldet hat.
 * Eine eingetragene, aber stumme Kennung ist noch kein Ladepunkt — das Cockpit
 * bietet den Baustein dann gar nicht erst an (`verfuegbar`), und ein Satz, der
 * ihn trotzdem ankündigt, schickte den Kunden auf die Suche nach einer Kachel,
 * die es nicht gibt.
 *
 * ⚠ Und er sagt „automatisch": der Baustein ist ab dem ersten Ladepunkt
 * verfügbar UND vorgewählt — der Kunde muss nichts anschalten, kann die Kachel
 * unter „Anpassen" aber abwählen.
 */
export function cockpitHinweis(gemeldet: boolean): string | null {
  return gemeldet
    ? 'Im Cockpit finden Sie Ihre Ladepunkte ab jetzt automatisch: die Kachel „Laden" sagt, ob ein Auto steckt und wie viel gerade fliesst, und der Energiefluss zeigt „Laden" als Abzweig vom Hausverbrauch. Beides lässt sich unter „Anpassen" ausblenden.'
    : null;
}

// ---------------------------------------------------------------------------
// Eine Kennung wieder entfernen
// ---------------------------------------------------------------------------

/**
 * Die FOLGENLISTE der Rücknahme (Haus-`ConfirmDialog`).
 *
 * ⚠ Sie sagt die WAHRHEIT über das, was am Gerät passiert — und die ist nicht
 * „der Ladevorgang endet": OCPP kennt einen eigenen Totmann, das
 * Sicherheitsprofil liegt IN der Säule, und sie lädt damit weiter (langsam,
 * aber sie lädt). Genau so sagt es auch der Dialog auf `:8484`
 * (`VPOcpp.removalConsequences`); zwei Formulierungen derselben Folge wären
 * zwei Wahrheiten über dieselbe Handlung.
 *
 * ⚠ Und sie nennt, was GLEICH bleibt (die anderen Säulen, die Anschlussgrenze)
 * — sonst liest sich jede Rücknahme wie ein Lockern der Regeln.
 */
export function entfernenFolgen(name: string): string[] {
  return [
    `„${name}" wird nicht mehr angenommen: die Verbindung zur Säule wird getrennt, und ein Wiederverbinden weist VoltPilot ab.`,
    'Ein laufender Ladevorgang endet dadurch NICHT. Die Säule behält ihr zuletzt hinterlegtes Sicherheitsprofil und lädt damit weiter — langsam, aber sie lädt.',
    'Alle anderen Säulen, Ihre Anschlussgrenze und der Ausfall-Schutz bleiben unverändert.',
    'Sie können dieselbe Kennung jederzeit wieder eintragen — dann lässt VoltPilot die Säule wieder herein.',
  ];
}

/** Der eine Satz über der Folgenliste. */
export function entfernenFrage(name: string): string {
  return `Soll VoltPilot die Ladesäule „${name}" nicht mehr annehmen?`;
}

/**
 * ⚠ Der Satz, der die Rücknahme EINORDNET statt sie zu verschweigen: sie wirkt
 * nicht in dem Moment, in dem geklickt wird, sondern sobald die Box das nächste
 * Mal verbunden ist. Eine Zustellung zu behaupten wäre eine Aussage über ein
 * Gerät, das gerade offline sein kann.
 */
export const ENTFERNEN_HINWEIS =
  'Eine hier entfernte Kennung wird nicht mehr angenommen, sobald Ihre Box das nächste Mal verbunden ist. Bis dahin gilt, was sie zuletzt übernommen hat.';

// ---------------------------------------------------------------------------
// Kleinkram
// ---------------------------------------------------------------------------

/** `192.168.1.5:8484` → `192.168.1.5`; eine IPv6-Klammer bleibt heil. */
function hostOhnePort(raw: string): string {
  if (raw.startsWith('[')) {
    const zu = raw.indexOf(']');
    return zu > 0 ? raw.slice(0, zu + 1) : raw;
  }
  // Ein nacktes IPv6-Literal hat keinen eindeutig abtrennbaren Port. Die
  // vollständige Adresse bleibt erhalten und bekommt URL-Klammern, bevor der
  // eigene OCPP-Port angehängt wird.
  if ((raw.match(/:/g) ?? []).length > 1) return `[${raw}]`;
  const doppel = raw.lastIndexOf(':');
  return doppel > 0 && /^\d+$/.test(raw.slice(doppel + 1)) ? raw.slice(0, doppel) : raw;
}

/** Ein Pfad beginnt mit `/` und endet ohne — `/ocpp/` ergäbe `//` in der URL. */
function normPfad(raw: string | null | undefined): string {
  const v = String(raw ?? '').trim();
  if (!v || v === '/') return '';
  const mitSlash = v.startsWith('/') ? v : `/${v}`;
  return mitSlash.endsWith('/') ? mitSlash.slice(0, -1) : mitSlash;
}

/** Ein Anschluss, den eine Säule wirklich anwählen kann — sonst nichts. */
function anschluss(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 65535 ? v : null;
}
