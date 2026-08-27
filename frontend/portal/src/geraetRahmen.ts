/**
 * DER RAHMEN aller Geräteseiten (Konzept `data/vp-geraeteseite-rahmen-r2` §4,
 * Geräteseiten Stufe 1; Captain-Entscheide **D1a** Brotkrume · **D2a** Standard
 * offen = Jetzt + Befehle).
 *
 * **Der behobene Befund ist ZUSCHNITT, nicht fehlende Gestaltung** (§2.2): eine
 * Geräteseite warf elf bis zwölf gleich laute Blöcke in EIN `auto-fit`-Raster,
 * das nach BREITE ordnete statt nach Bedeutung - bei 1440 px standen Befehle und
 * Komponenten nebeneinander, bei 1100 px rutschte die Zuordnung. Einklappen ließ
 * sich nichts außer Diagnose und Plattform-Sicht, eine Sprungnavigation gab es
 * nicht, und die drei Sektionen, die alle die Steuerung erklären („Grenzen dieses
 * Geräts", „Einspeise-Begrenzung", „Steuerungs-Bezüge"), standen an drei Orten.
 *
 * Diese Datei ist die EINE Wahrheit darüber, **welche Sektionen es gibt, in
 * welcher Reihenfolge sie stehen, welche offen beginnt und was passiert, wenn
 * eine leer ist**. Sie ist rein und framework-frei (der
 * `geraetSeite.ts`/`geraetGesicht.ts`-Präzedenzfall) - `components/GeraetRahmen.tsx`
 * rendert sie und entscheidet nichts.
 *
 * ⚠ **Sie formuliert KEINEN Befund neu.** Jeder Satz, der hier durchläuft
 * (Kurzfassung, Kopf-Hinweis, Grund einer entfallenen Sektion), kommt von seiner
 * geteilten Ableitung - `exportGuardView`, `deviceLimitLine`, `controlStrip`,
 * `OHNE_REGISTER_SATZ`. Zwei Formulierungen über denselben Befund wären zwei
 * Urteile.
 */
import type { GeraetTon } from './geraetSeite';
import type { SektionId as GesichtSektionId } from './geraetGesicht';

/**
 * Eine Sektion des Rahmens. Die Reihenfolge ist FEST (§4.4) - ein Blatt LÄSST
 * AUS, was sein Typ nicht hat, sortiert aber nie um.
 */
export type RahmenSektionId =
  | 'jetzt'
  | 'befehle'
  | 'steuerung'
  | 'komponenten'
  | 'register'
  | 'verbindung'
  | 'software'
  | 'diagnose'
  | 'plattform';

/**
 * Die kanonische Ordnung (§4.4).
 *
 * Warum genau diese: 1-2 sind die 5-Sekunden-Fragen und das tägliche
 * Nachsehen; 3-4 erklären das Jetzt (die Anschlussfrage „warum?"); 5-7 sind
 * Werkzeug und Technik, die man AUFSUCHT; 8-9 sind Support und Betreiber.
 */
export const SEKTIONS_ORDNUNG: readonly RahmenSektionId[] = [
  'jetzt',
  'befehle',
  'steuerung',
  'komponenten',
  'register',
  'verbindung',
  'software',
  'diagnose',
  'plattform',
];

/** Der Name einer Sektion - auf JEDER Geräteseite derselbe. */
export const SEKTION_TITEL: Record<RahmenSektionId, string> = {
  jetzt: 'Jetzt',
  befehle: 'Befehle',
  steuerung: 'Steuerung & Grenzen',
  komponenten: 'Komponenten',
  register: 'Register',
  verbindung: 'Verbindung',
  software: 'Software',
  diagnose: 'Diagnose (technisch)',
  plattform: 'Plattform-Sicht (Admin)',
};

/**
 * Die FRAGE, die eine Sektion beantwortet (§4.4). Sie steht im geschlossenen
 * Zustand unter dem Namen: eine Klappe, die nicht sagt, was hinter ihr liegt,
 * ist genau die Wand, die dieser Rahmen beendet.
 */
export const SEKTION_FRAGE: Record<RahmenSektionId, string | null> = {
  jetzt: 'Was tut es gerade, steuert VoltPilot es?',
  befehle: 'Was hat VoltPilot zuletzt geschickt - und kam es an?',
  steuerung: 'Warum tut es das, was darf es nie?',
  komponenten: 'Was misst und steuert es?',
  register: 'Was lese ich, was beobachte ich, was schreibe ich?',
  verbindung: 'Wie ist es angebunden, wie frisch?',
  software: 'Welcher Stand läuft?',
  diagnose: 'Für den Support.',
  plattform: null,
};

/**
 * Das Sinnbild einer Sektion. Bewusst dieselben wie heute, wo eine Sektion
 * schon existiert - der Rahmen ordnet um, er tauscht keine Zeichen.
 */
export const SEKTION_ICON: Record<RahmenSektionId, string> = {
  jetzt: 'activity',
  befehle: 'history',
  steuerung: 'shield',
  komponenten: 'layers',
  register: 'sliders',
  verbindung: 'wifi',
  software: 'settings',
  diagnose: 'file-text',
  plattform: 'building',
};

/**
 * Standard offen (Captain-Entscheid **D2a**): Jetzt + Befehle, alles Übrige zu.
 *
 * Begründung aus dem Entscheid: Befehle ist das TÄGLICHE Nachsehen (die
 * 5-Sekunden-Fragen 3/4). „Alles offen" wäre die heutige Wand mit Anker; „nur
 * Jetzt" versteckte die zweithäufigste Frage hinter einem Klick.
 */
export const STANDARD_OFFEN: readonly RahmenSektionId[] = ['jetzt', 'befehle'];

/**
 * „Jetzt" hat KEINEN Klapp-Kopf (§4.5). Sie ist die Antwort auf die erste
 * Frage; eine Klappe davor wäre ein Klick vor die Auskunft, für die man die
 * Seite geöffnet hat.
 */
export function istKlappbar(id: RahmenSektionId): boolean {
  return id !== 'jetzt';
}

/** Ob eine Sektion ohne gespeicherte Wahl offen beginnt. */
export function standardOffen(id: RahmenSektionId): boolean {
  return STANDARD_OFFEN.includes(id);
}

/**
 * Wo eine Sektion des GESICHTS (`geraetGesicht.SektionId`) im Rahmen aufgeht.
 *
 * ⚠ Vier Sektionen fallen in EINE: „Grenzen dieses Geräts", „Einspeise-
 * Begrenzung", „Ausfall-Schutz" und „Diese Säule im Ladepark" erklären alle
 * dasselbe - was das Gerät darf und was es nie darf. Vier Kästen dafür waren
 * drei zu viel (§4.4).
 */
export const GESICHT_ZU_RAHMEN: Record<GesichtSektionId, RahmenSektionId> = {
  jetzt: 'jetzt',
  befehle: 'befehle',
  komponenten: 'komponenten',
  grenzen: 'steuerung',
  einspeise: 'steuerung',
  ausfallschutz: 'steuerung',
  ladepark: 'steuerung',
  register: 'register',
  verbindung: 'verbindung',
  software: 'software',
};

/** Was ein Wirt dem Rahmen über EINE Sektion sagt. */
export interface SektionAngebot {
  id: RahmenSektionId;
  /**
   * `true` = STRUKTURELL leer: dieser TYP hat das nie (Register auf einem
   * HTTP-Gerät, Befehle an einen Zähler). Die Sektion ENTFÄLLT, ihr `grund`
   * zieht in die Diagnose (§4.6).
   *
   * ⚠ Nicht zu verwechseln mit SITUATIV leer („heute noch keine Daten"): die
   * Sektion BLEIBT und trägt ihren Grund in der Kurzfassung.
   */
  entfaellt?: boolean;
  /** Der Grund einer entfallenen Sektion - er verschwindet nie, er zieht um. */
  grund?: string | null;
  /** Der Zustands-Punkt neben dem Namen; null = keine Aussage. */
  ton?: GeraetTon | null;
  /** Die Kurzfassung im geschlossenen Zustand („zuletzt 14:02 · bestätigt"). */
  kurzfassung?: string | null;
  /**
   * Ein abweichender Name. Nur für den Fall, dass ein Blatt dasselbe Fach
   * anders NENNEN muss (eine OCPP-Säule hat keine „Register", aber Messwerte -
   * D3) - die ORDNUNG bleibt kanonisch, es wird nichts umsortiert.
   */
  titel?: string | null;
}

/** Eine Sektion, wie der Rahmen sie rendert. */
export interface SektionEintrag {
  id: RahmenSektionId;
  titel: string;
  frage: string | null;
  icon: string;
  ton: GeraetTon | null;
  kurzfassung: string | null;
  /** false = „Jetzt": ohne Klapp-Kopf, immer sichtbar. */
  klappbar: boolean;
  /** Der Zustand ohne gespeicherte Wahl des Kunden. */
  offenAlsVorgabe: boolean;
}

export interface RahmenView {
  sektionen: SektionEintrag[];
  /**
   * Die Gründe der WEGGEFALLENEN Sektionen, in kanonischer Ordnung - sie
   * gehören in die Diagnose, damit „diese Seite hat keine Register" eine
   * beantwortbare Frage bleibt statt einer stillen Lücke.
   */
  entfallen: string[];
}

/**
 * Die Sektionen einer Geräteseite - kanonisch geordnet, strukturell Leeres
 * entfernt, jede mit ihrem Namen und ihrer Frage.
 *
 * Drei Regeln, die alle drei Wirte teilen:
 * 1. **Die Ordnung gehört dem Rahmen, nicht dem Aufrufer.** Ein Wirt kann
 *    Sektionen weglassen, nie umsortieren - sonst stünde dasselbe Fach auf
 *    zwei Geräten an zwei Orten.
 * 2. **Ein unbekanntes Fach wird ausgelassen**, nie gerendert: eine Sektion,
 *    die niemand füllen kann, ist eine leere Behauptung.
 * 3. **Doppelt genannt = einmal gezeigt** (der erste Eintrag gewinnt).
 */
export function rahmen(angebote: readonly (SektionAngebot | null | undefined)[]): RahmenView {
  const gesehen = new Map<RahmenSektionId, SektionAngebot>();
  for (const a of angebote) {
    if (!a || !SEKTIONS_ORDNUNG.includes(a.id)) continue;
    if (!gesehen.has(a.id)) gesehen.set(a.id, a);
  }
  const sektionen: SektionEintrag[] = [];
  const entfallen: string[] = [];
  for (const id of SEKTIONS_ORDNUNG) {
    const a = gesehen.get(id);
    if (!a) continue;
    if (a.entfaellt) {
      const grund = (a.grund ?? '').trim();
      if (grund) entfallen.push(grund);
      continue;
    }
    sektionen.push({
      id,
      titel: (a.titel ?? '').trim() || SEKTION_TITEL[id],
      frage: SEKTION_FRAGE[id],
      icon: SEKTION_ICON[id],
      ton: a.ton ?? null,
      kurzfassung: (a.kurzfassung ?? '').trim() || null,
      klappbar: istKlappbar(id),
      offenAlsVorgabe: standardOffen(id),
    });
  }
  return { sektionen, entfallen };
}

/**
 * Eine Kurzfassung aus Teilen - leere Teile fallen weg, nichts wird erfunden.
 *
 * ⚠ Ohne einen einzigen belegten Teil gibt es KEINE Kurzfassung (`null`), nie
 * ein „—": die geschlossene Zeile sagt dann nur ihren Namen, statt eine
 * Auskunft vorzutäuschen.
 */
export function kurz(...teile: readonly (string | null | undefined)[]): string | null {
  const echte = teile.map((t) => (t ?? '').trim()).filter((t) => t.length > 0);
  return echte.length > 0 ? echte.join(' · ') : null;
}

// ---------------------------------------------------------------------------
// Der Kopf-Hinweis (§4.1 Zeile 3, die 5-Sekunden-Frage 4 „muss ich etwas tun?")
// ---------------------------------------------------------------------------

/**
 * Die Art eines Befunds. Die Reihenfolge dieser Liste IST die Rangfolge -
 * der schlimmste gewinnt, und es wird immer nur EINER gezeigt.
 */
export type BefundArt = 'verbindung' | 'ruecklesen' | 'waechter' | 'grenze';

const BEFUND_RANG: readonly BefundArt[] = ['verbindung', 'ruecklesen', 'waechter', 'grenze'];

/** In welcher Sektion ein Befund seine Erklärung hat. */
const BEFUND_SEKTION: Record<BefundArt, RahmenSektionId> = {
  verbindung: 'verbindung',
  ruecklesen: 'befehle',
  waechter: 'steuerung',
  grenze: 'register',
};

export interface Befund {
  art: BefundArt;
  /**
   * Der Satz - WÖRTLICH aus seiner geteilten Ableitung. Der Rahmen formuliert
   * keinen; ein leerer Satz ist kein Befund.
   */
  satz: string;
  ton: 'warn' | 'off';
}

export interface KopfHinweis {
  satz: string;
  ton: 'warn' | 'off';
  art: BefundArt;
  /**
   * Die Sektion, die den Befund trägt - ein Klick klappt sie auf und springt
   * hin. `null`, wenn diese Seite die Sektion gar nicht hat: dann steht der
   * Satz allein da, statt einen Knopf ins Leere anzubieten (die
   * `registerZugang`-Regel).
   */
  sektion: RahmenSektionId | null;
}

/**
 * Der EINE Hinweis im Kopf - der schlimmste anstehende Befund, oder nichts.
 *
 * ⚠ **Warum die Zustands-Pill hier NICHT noch einmal auftaucht**: sie steht
 * eine Zeile darüber und beantwortet Frage 1 („läuft es, wie aktuell ist
 * das?"). Sie als Hinweis zu wiederholen wäre Lärm - der Hinweis ist für die
 * Befunde da, die seit diesem Rahmen in einer GESCHLOSSENEN Sektion stecken
 * und ohne ihn unsichtbar wären. Ein Verbindungs-Befund reist trotzdem als
 * Art mit, weil ein Blatt ihn ausdrücklich melden darf (etwa eine Box, deren
 * Pill die Anlage meint und nicht dieses Gerät).
 *
 * @param befunde in beliebiger Reihenfolge; der Rang entscheidet, nicht die Position.
 * @param angeboten die Sektionen, die es auf DIESER Seite gibt.
 */
export function kopfHinweis(
  befunde: readonly (Befund | null | undefined)[],
  angeboten: readonly RahmenSektionId[] = SEKTIONS_ORDNUNG,
): KopfHinweis | null {
  const echte = befunde.filter(
    (b): b is Befund => Boolean(b && (b.satz ?? '').trim() && BEFUND_RANG.includes(b.art)),
  );
  if (echte.length === 0) return null;
  let beste: Befund | null = null;
  for (const b of echte) {
    if (beste == null || BEFUND_RANG.indexOf(b.art) < BEFUND_RANG.indexOf(beste.art)) beste = b;
  }
  if (!beste) return null;
  const ziel = BEFUND_SEKTION[beste.art];
  return {
    satz: beste.satz.trim(),
    ton: beste.ton,
    art: beste.art,
    sektion: angeboten.includes(ziel) ? ziel : null,
  };
}

// ---------------------------------------------------------------------------
// Klapp-Zustand je Gerät und Tab-Sitzung (§4.5)
// ---------------------------------------------------------------------------

/**
 * Der Speicherschlüssel EINER Sektion EINES Geräts.
 *
 * ⚠ Je GERÄT, nicht je Seite: wer den Registerkasten an seinem Wechselrichter
 * offen lässt, will ihn nicht auch an seiner Wallbox offen finden. Und je
 * TAB-SITZUNG (`sessionStorage`) - `localStorage` bleibt portalweit verboten,
 * sonst ersetzte eine einmalige Wahl den Grundzustand für immer.
 */
export function sektionKey(geraetKey: string, id: RahmenSektionId): string {
  return `vp.geraet.sektion.${geraetKey}.${id}`;
}

/**
 * Die gespeicherte Wahl - sie GEWINNT über den Standard (§4.5), in beide
 * Richtungen. Alles außer den zwei bekannten Wörtern ist keine Wahl.
 */
export function initialSektionOffen(stored: string | null | undefined, id: RahmenSektionId): boolean {
  if (stored === '1') return true;
  if (stored === '0') return false;
  return standardOffen(id);
}

// ---------------------------------------------------------------------------
// Deep-Link `?abschnitt=` (§4.3)
// ---------------------------------------------------------------------------

/**
 * Der Parametername. ⚠ Es ist ein PARAMETER im Hash, keine zweite Raute: die
 * App ist hash-geroutet, `#/anlage/…#register` wäre keine gültige Route (das
 * `settingsNav`-Muster; `parseRoute` schneidet den Query-Teil ohnehin ab).
 */
const PARAM = 'abschnitt';

/**
 * Die angesprungene Sektion aus einem Hash - null, wenn keine oder eine
 * unbekannte genannt ist. **Nie raten**: ein unbekanntes Wort öffnet nichts,
 * statt irgendeine Sektion aufzuklappen.
 */
export function parseAbschnitt(hash: string): RahmenSektionId | null {
  const q = hash.indexOf('?');
  if (q < 0) return null;
  const value = new URLSearchParams(hash.slice(q + 1)).get(PARAM);
  return value && (SEKTIONS_ORDNUNG as readonly string[]).includes(value)
    ? (value as RahmenSektionId)
    : null;
}

/**
 * Eine Geräte-Adresse mit gezielter Sektion. Der bestehende Query-Teil bleibt
 * erhalten (eine Adresse kann schon `?` tragen), `abschnitt` wird ersetzt.
 */
export function abschnittHash(basisHash: string, id: RahmenSektionId | null): string {
  const q = basisHash.indexOf('?');
  const basis = q < 0 ? basisHash : basisHash.slice(0, q);
  const params = new URLSearchParams(q < 0 ? '' : basisHash.slice(q + 1));
  if (id) params.set(PARAM, id);
  else params.delete(PARAM);
  const rest = params.toString();
  return rest ? `${basis}?${rest}` : basis;
}

/** Die DOM-Kennung einer Sektion - der Sprungpunkt (`scrollIntoView`). */
export function ankerId(id: RahmenSektionId): string {
  return `geraet-abschnitt-${id}`;
}
