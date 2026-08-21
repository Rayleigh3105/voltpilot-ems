/**
 * Das GESICHT einer Geräteseite (Scout `data/vp-geraeteseite-rev-b8` §4,
 * Captain-Punkt 2: „mehr Kreativität und Vielfalt, benutzerzentrischer").
 *
 * Der behobene Befund ist NICHT fehlende Gestaltung, sondern ein ZUSCHNITT:
 * derselbe Renderer schickte Hybrid-Wechselrichter, PV-Melder, Zähler,
 * Verbraucher und Ladesäule durch DIESELBE Sektionsliste in derselben
 * Reihenfolge - jede Seite beantwortete also zuerst dieselbe Frage
 * („wie ist dieses Gerät angebunden?"), obwohl der Benutzer je Typ eine andere
 * hat. Was ihn ZUERST interessiert (Support-Fälle Pilsting/Herzogau):
 *
 * | Typ | Die erste Frage |
 * |---|---|
 * | Wechselrichter mit Speicher | Was macht mein Speicher gerade, und folgt er dem Fahrplan? |
 * | Wechselrichter ohne Speicher | Wie viel erzeugt er gerade? |
 * | PV-Melder | Wie viel erzeugt er, wird er gedrosselt - und von wem? |
 * | Zähler | Bezug oder Einspeisung jetzt, und ist er der maßgebliche? |
 * | Verbraucher | Läuft es, und warum? |
 * | Ladesäule | Welcher Stecker lädt mit wie viel, wer wartet? |
 *
 * **Diese Datei entscheidet, WAS oben steht und welche Sektionen in welcher
 * Reihenfolge folgen - mehr nicht.** Die Sektions-Bauteile bleiben geteilt
 * (Zeilen-Liste, Komponenten-Zeile, Befehls-Film, Register-Tabelle, Drawer):
 * sieben Gesichter sind sieben Stellen, an denen eine Regel vergessen werden
 * kann, deshalb liegt die Auswahl in EINER reinen Datei mit einem Test je
 * Gattung, und es entsteht keine zweite Wahrheit über ein Gerät.
 *
 * Drei Ehrlichkeitsregeln tragen sie - alle sind Haus-Regeln:
 *
 * 1. **Eine Sektion, die nur ihre Nicht-Zuständigkeit erklärt, entfällt.** Das
 *    ist die Lehre der Box-Seite (Stufe 1): sie trug drei Sektionen, die nur
 *    dastanden, um zu sagen, dass sie hier nicht gelten. Der Grund verschwindet
 *    dabei nicht - er wandert in den Technik-Aufklapper.
 * 2. **Der eine Satz oben wird nie erfunden.** Er kommt aus den GETEILTEN
 *    Ableitungen (`controlStrip` für die Steuerung, der durchgereichte Satz der
 *    Box für die Säule) oder aus einem gemessenen Wert; wo nichts belegt ist,
 *    steht nichts.
 * 3. **Ein fehlender Wert ist `null`, nie eine 0** - und die Richtung ist ein
 *    WORT, nie ein Vorzeichen (die portalweite `live.ts`-Konvention).
 *
 * Rein + framework-frei (der `komponenten.ts`/`geraetSeite.ts`-Präzedenzfall).
 */
import type { ControlStatus, CurtailmentStatus, SiteEntity, SiteSource } from './api';
import { controlStrip } from './control';
import { fmtNum } from './format';
import type { GeraetArt, GeraetTon } from './geraetSeite';
import { NUR_GELESEN } from './geraetSeite';
import type { PlantComponent } from './komponenten';
import type { ChargeConnector, ChargePoint } from './ladepunkte';
import { NO_DATA } from './nodata';

/**
 * Die Gattung einer Geräteseite - sie entscheidet Held und Sektions-Folge.
 *
 * `geraet` ist die ehrliche RÜCKFALL-Gattung: eine gemeldete Quelle, deren
 * Rolle die Box nicht nennt und deren Komponenten nichts verraten. Sie bekommt
 * die Sektions-Folge wie vor dieser Stufe - geraten wird nichts.
 */
export type Gattung =
  | 'wechselrichter-speicher'
  | 'wechselrichter'
  | 'pv-melder'
  | 'zaehler'
  | 'verbraucher'
  | 'ladepunkt'
  | 'geraet';

/** Eine Sektion der Seite. Nicht genannte Sektionen werden NICHT gerendert. */
export type SektionId =
  | 'jetzt'
  | 'befehle'
  | 'komponenten'
  | 'grenzen'
  | 'einspeise'
  | 'ausfallschutz'
  | 'register'
  | 'verbindung'
  | 'ladepark'
  | 'software';

/** Eine Kachel des Helds. */
export interface HeldKachel {
  label: string;
  /** Der formatierte Wert, oder `—`. */
  wert: string;
  /** Das Wort darunter („lädt", „Einspeisung", „frei"), oder null. */
  wort: string | null;
  ton?: GeraetTon | null;
  /** Die FÜHRENDE Kachel einer Gattung wird größer gesetzt. */
  gross?: boolean;
}

/** Der Held: das Erste, was die Seite zeigt. */
export interface Held {
  /** Die Überschrift der Held-Karte („Jetzt", „Erzeugung", „Stecker"). */
  titel: string;
  kacheln: HeldKachel[];
  /** Die 1-Satz-Aussage - null, wo nichts belegt ist. */
  satz: string | null;
  satzTon: GeraetTon;
  /** Ein ruhiger Zusatz unter dem Satz (Nennleistung, Grund), oder null. */
  hinweis: string | null;
  /** Auslastung als ruhiger Balken - nur wo ein BELEGTER Bezug existiert. */
  balken: { pct: number; label: string } | null;
}

export interface Gesicht {
  gattung: Gattung;
  held: Held;
  sektionen: SektionId[];
}

export interface GesichtInput {
  art: GeraetArt;
  /** Die Kennung dieses Geräts auf der Box (`inverter`, `src-…`, `cp-…`). */
  geraetId: string;
  /** Die von der Box GEMELDETE Rolle (`pv-generation`/`grid-meter`/`consumer`). */
  rolle: string | null;
  /** Die Kommunikationsart, wie Soll oder Ist sie nennen. */
  communication: string | null;
  komponenten: PlantComponent[];
  /** Die Entitäten der Anlage - für die gepflegte Nennleistung (kWp). */
  entities?: SiteEntity[] | null;
  /** Der gemeldete Ist-Zustand DIESES Geräts. */
  src?: SiteSource | null;
  charger?: ChargePoint | null;
  /**
   * Der Steuerungs-Beleg - **schon auf dieses Gerät gefiltert** (die
   * `eigenerBeleg`-Regel: eine Anlage kann mehrere Boxen haben, der Beleg kommt
   * von genau einer).
   */
  control?: ControlStatus | null;
  curtailment?: CurtailmentStatus | null;
  /** Die Namen der Regeln, die eine Komponente dieses Geräts anfassen. */
  regeln?: string[];
  now?: number;
}

/**
 * Transporte OHNE Modbus-Register. Ein Gerät, das über seine Web-Schnittstelle
 * gelesen wird, bekommt keine Register-Sektion, die nur erklärt, dass es hier
 * keine gibt - der Satz steht stattdessen im Technik-Aufklapper.
 */
const OHNE_REGISTER = new Set(['fronius_solar_api', 'goe_http_api', 'shelly_http', 'ocpp']);

/** Ab welcher Leistung ein Verbraucher als „läuft" gilt (die Rausch-Schwelle). */
const LAEUFT_AB_KW = 0.05;

/**
 * Der Satz, wenn KEINE Kachel des Helds einen Wert trägt.
 *
 * ⚠ Er ist die Fortschreibung der Regel „jede leere Sektion nennt ihren Grund"
 * auf den Held: eine Reihe von „—" ohne ein Wort daneben liest sich als Fehler
 * der Seite, nicht als Zustand des Geräts.
 */
export const KEINE_MESSWERTE = 'Dieses Gerät hat noch keine Messwerte geliefert.';

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function kw(v: number | null): string {
  return v == null ? NO_DATA : fmtNum(v, 'kW');
}

/** Die Gattung aus dem, was BELEGT ist - nie geraten. */
export function gattungVon(input: {
  art: GeraetArt;
  rolle: string | null;
  komponenten: PlantComponent[];
}): Gattung {
  if (input.art === 'ladepunkt') return 'ladepunkt';
  if (input.art === 'hauptgeraet') {
    return input.komponenten.some((c) => c.role === 'storage')
      ? 'wechselrichter-speicher'
      : 'wechselrichter';
  }
  // Die gemeldete Rolle FÜHRT: sie ist die Aussage des Geräts über sich selbst.
  if (input.rolle === 'pv-generation') return 'pv-melder';
  if (input.rolle === 'grid-meter') return 'zaehler';
  if (input.rolle === 'consumer') return 'verbraucher';
  // Sonst entscheiden die Komponenten - und nur, wenn sie EINDEUTIG sind.
  const rollen = new Set(input.komponenten.filter((c) => c.aspect === 'main').map((c) => c.role));
  if (rollen.size === 1) {
    const [r] = Array.from(rollen);
    if (r === 'pv') return 'pv-melder';
    if (r === 'grid') return 'zaehler';
    if (r === 'consumer') return 'verbraucher';
    if (r === 'storage') return 'wechselrichter-speicher';
  }
  return 'geraet';
}

/** Die Sektions-Folge je Gattung. */
function sektionenVon(gattung: Gattung, registerMoeglich: boolean): SektionId[] {
  const register: SektionId[] = registerMoeglich ? ['register'] : [];
  switch (gattung) {
    case 'wechselrichter-speicher':
    case 'wechselrichter':
      // Die Grenzen stehen DIREKT über dem Werkzeug: die Zeile „Ihr
      // Wechselrichter begrenzt auf 33,0 kW - hinterlegt sind 70,0 kW" ist
      // genau das, was einen Register-Schreibvorgang motiviert.
      return ['jetzt', 'befehle', 'komponenten', 'grenzen', ...register, 'verbindung', 'software'];
    case 'pv-melder':
      return ['jetzt', 'einspeise', 'befehle', 'komponenten', ...register, 'verbindung', 'software'];
    case 'zaehler':
      // Kein Befehls-Kasten: an einen Zähler geht kein Befehl, und ein leerer
      // Kasten mit seiner eigenen Erklärung ist die Box-Lehre.
      return ['jetzt', 'komponenten', ...register, 'verbindung', 'software'];
    case 'verbraucher':
      return ['jetzt', 'befehle', 'komponenten', ...register, 'verbindung', 'software'];
    case 'ladepunkt':
      return ['jetzt', 'befehle', 'ausfallschutz', 'komponenten', 'verbindung', 'ladepark',
        'software'];
    default:
      return ['jetzt', 'befehle', 'komponenten', ...register, 'verbindung', 'software'];
  }
}

/** Die gepflegte Nennleistung der PV-Komponenten dieses Geräts (kWp). */
function kwpVon(komponenten: PlantComponent[], entities: SiteEntity[] | null | undefined):
number | null {
  const ids = new Set(komponenten.filter((c) => c.role === 'pv').map((c) => c.entityId));
  let summe: number | null = null;
  for (const e of entities ?? []) {
    if (!ids.has(e.id)) continue;
    const v = num(e.capacityKwp);
    if (v != null && v > 0) summe = (summe ?? 0) + v;
  }
  return summe;
}

/** Die Netz-Kachel: die Richtung ist ein WORT, nie ein Vorzeichen. */
function netzKachel(grid: number | null, gross = false): HeldKachel {
  return {
    label: 'Netz',
    wert: kw(grid == null ? null : Math.abs(grid)),
    wort: grid == null ? null : grid < 0 ? 'Einspeisung' : grid > 0 ? 'Bezug' : 'ausgeglichen',
    gross,
  };
}

/** Der Speicher-Wert einer Komponente dieses Geräts (Ladestand + Richtung). */
function speicherKachel(komponenten: PlantComponent[]): HeldKachel | null {
  const c = komponenten.find((k) => k.role === 'storage' && k.reading != null);
  if (!c || !c.reading) return null;
  return {
    label: 'Ladestand',
    wert: fmtNum(c.reading.value, c.reading.unit),
    wort: c.reading.caption,
    gross: true,
  };
}

/**
 * Was die ABREGELUNG über GENAU DIESES Gerät sagt (Geräteseiten Stufe 1
 * lieferte die Einheiten-Liste - erst sie macht die Aussage möglich).
 *
 * ⚠ Ohne einen Eintrag für dieses Gerät wird NICHTS über es behauptet: die
 * Zähler (`units`/`certifiedUnits`) sind eine Aussage über die ANLAGE, und sie
 * einem von mehreren Wechselrichtern anzulasten wäre genau die erfundene
 * Zuordnung, die `ANLAGENWEITE_BEFEHLE` vermeidet.
 */
export function abregelungDiesesGeraets(
  status: CurtailmentStatus | null | undefined,
  geraetId: string,
): { satz: string; ton: GeraetTon } | null {
  if (!status) return null;
  const unit = (status.perUnit ?? []).find((u) => u.sourceId === geraetId);
  if (!unit) {
    if ((status.units ?? 0) <= 0) return null;
    return {
      satz: 'Welche Einheit gerade wie stark begrenzt wird, meldet Ihre Box noch nicht einzeln '
        + `— die Begrenzung gilt anlagenweit (${status.certifiedUnits} von ${status.units} `
        + 'Wechselrichtern freigegeben).',
      ton: status.certifiedUnits < status.units ? 'warn' : 'ok',
    };
  }
  if (!unit.certified) {
    return {
      satz: 'Dieses Gerät ist für die Einspeise-Begrenzung noch nicht freigegeben — VoltPilot '
        + 'prüft das Modell zuerst am Prüfstand.',
      ton: 'off',
    };
  }
  const cap = num(unit.appliedCapKw);
  if (cap == null) {
    return {
      satz: 'Dieses Gerät nimmt Einspeise-Begrenzungen von VoltPilot an — gerade ist keine aktiv.',
      ton: 'ok',
    };
  }
  const bestaetigt = unit.match === true
    ? ' · vom Gerät bestätigt'
    : unit.match === false
      ? ' · das Gerät bestätigt sie nicht'
      : '';
  return {
    satz: `Begrenzt gerade auf ${fmtNum(cap, 'kW')}${bestaetigt}.`,
    ton: unit.match === false ? 'warn' : 'ok',
  };
}

/** Der Held der Gattung B/B' - das Live-Bild plus der EINE Steuerungs-Satz. */
function heldWechselrichter(input: GesichtInput, mitSpeicher: boolean): Held {
  const src = input.src ?? null;
  const kacheln: HeldKachel[] = [];
  const pv = num(src?.pvKw);
  kacheln.push({ label: 'Solarstrom', wert: kw(pv), wort: null, gross: !mitSpeicher });
  const speicher = mitSpeicher ? speicherKachel(input.komponenten) : null;
  if (speicher) kacheln.push(speicher);
  kacheln.push(netzKachel(num(src?.powerKw)));
  kacheln.push({ label: 'Haus', wert: kw(num(src?.loadKw)), wort: 'abgeleitet' });

  const gesteuert = input.komponenten.filter((c) => c.control);
  if (gesteuert.length === 0) {
    return {
      titel: 'Jetzt',
      kacheln,
      satz: NUR_GELESEN,
      satzTon: 'off',
      hinweis: null,
      balken: null,
    };
  }
  // ⚠ DIESELBE Ableitung wie Cockpit und Befehle-Seite - drei Flächen, ein
  // Satz. Ein eigener hier wäre eine zweite Wahrheit über denselben Sollwert.
  const strip = controlStrip(input.control ?? null, new Date(input.now ?? Date.now()), true);
  return {
    titel: 'Jetzt',
    kacheln,
    satz: strip?.sentence ?? null,
    satzTon: strip?.tone === 'warn' ? 'warn' : strip?.tone === 'ok' ? 'ok' : 'off',
    hinweis: strip?.execution ?? strip?.reason ?? null,
    balken: null,
  };
}

/** Der Held der Gattung C - Erzeugung, Nennleistung, Drosselung. */
function heldPvMelder(input: GesichtInput): Held {
  const pv = num(input.src?.pvKw)
    ?? num(input.komponenten.find((c) => c.role === 'pv' && c.reading)?.reading?.value ?? null);
  const kwp = kwpVon(input.komponenten, input.entities);
  const kacheln: HeldKachel[] = [
    { label: 'Erzeugung jetzt', wert: kw(pv), wort: null, gross: true },
  ];
  if (kwp != null) {
    kacheln.push({ label: 'Nennleistung', wert: fmtNum(kwp, 'kWp'), wort: 'gepflegt' });
  }
  const satz = pv == null
    ? 'Dieses Gerät meldet gerade keine Erzeugung.'
    : kwp == null
      ? `Erzeugt gerade ${fmtNum(pv, 'kW')}.`
      : `Erzeugt gerade ${fmtNum(pv, 'kW')} von ${fmtNum(kwp, 'kWp')}.`;
  return {
    titel: 'Erzeugung',
    kacheln,
    satz,
    satzTon: pv == null ? 'off' : 'ok',
    // ⚠ Die Drosselung steht NICHT hier: die Sektion „Einspeise-Begrenzung"
    // direkt unter dem Held ist ihr Ort, und derselbe Satz zweimal auf einem
    // Bildschirm ist die dokumentierte Doppelung (im Browser aufgefallen).
    hinweis: null,
    // ⚠ Nur mit BELEGTEM Bezug: ohne gepflegte Nennleistung gäbe es keinen
    // Maßstab, und ein Balken ohne Maßstab ist eine erfundene Aussage.
    balken: pv != null && kwp != null && kwp > 0
      ? { pct: Math.max(0, Math.min(100, (pv / kwp) * 100)), label: 'Auslastung' }
      : null,
  };
}

/** Der Held der Gattung D - Bezug oder Einspeisung, und ob er maßgeblich ist. */
function heldZaehler(input: GesichtInput): Held {
  const grid = num(input.src?.powerKw)
    ?? num(input.komponenten.find((c) => c.role === 'grid' && c.reading)?.reading?.value ?? null);
  const massgeblich = input.komponenten.some((c) => c.role === 'grid' && c.primary);
  const richtung = grid == null ? null : grid < 0 ? 'Einspeisung' : grid > 0 ? 'Bezug' : null;
  const satz = grid == null
    ? 'Dieser Zähler meldet gerade keinen Wert.'
    : richtung == null
      ? 'Ihre Anlage ist gerade ausgeglichen — es fließt weder Bezug noch Einspeisung.'
      : richtung === 'Bezug'
        ? `Ihre Anlage bezieht gerade ${fmtNum(Math.abs(grid), 'kW')}.`
        : `Ihre Anlage speist gerade ${fmtNum(Math.abs(grid), 'kW')} ein.`;
  return {
    titel: 'Bezug & Einspeisung',
    kacheln: [netzKachel(grid, true)],
    satz,
    satzTon: grid == null ? 'off' : 'ok',
    hinweis: massgeblich
      ? 'Dieser Zähler ist maßgeblich für die Bilanz Ihrer Anlage.'
      : 'Die maßgebliche Messung Ihrer Bilanz liefert ein anderes Gerät.',
    balken: null,
  };
}

/** Der Held der Gattung E - läuft es, und warum? */
function heldVerbraucher(input: GesichtInput): Held {
  const eigen = input.komponenten.find((c) => c.role === 'consumer' && c.reading);
  const leistung = num(input.src?.loadKw) ?? num(eigen?.reading?.value ?? null);
  const laeuft = leistung == null ? null : leistung > LAEUFT_AB_KW;
  const regeln = input.regeln ?? [];
  const satz = laeuft == null
    ? 'Dieses Gerät meldet gerade keinen Wert.'
    : laeuft
      ? `Läuft gerade mit ${fmtNum(leistung as number, 'kW')}.`
      : 'Läuft gerade nicht.';
  // ⚠ Der GRUND wird nur genannt, wo eine Regel dieses Gerät wirklich anfasst -
  // „warum" ohne Beleg wäre eine Behauptung über eine Automatik, die es
  // vielleicht gar nicht gibt. Der Wohnort der Regel bleibt die Steuerung (D2).
  const hinweis = regeln.length === 0
    ? null
    : regeln.length === 1
      ? `Geschaltet von der Regel „${regeln[0]}".`
      : `Geschaltet von den Regeln „${regeln.join('", „')}".`;
  return {
    titel: 'Zustand',
    kacheln: [{
      label: 'Leistung',
      wert: kw(leistung),
      wort: laeuft == null ? null : laeuft ? 'läuft' : 'aus',
      ton: laeuft == null ? 'off' : laeuft ? 'ok' : null,
      gross: true,
    }],
    satz,
    satzTon: laeuft == null ? 'off' : 'ok',
    hinweis,
    balken: null,
  };
}

/** Der Held der Gattung F - welcher Stecker lädt, wer wartet. */
function heldLadepunkt(input: GesichtInput): Held {
  const charger = input.charger ?? null;
  const stecker: ChargeConnector[] = charger?.connectors ?? [];
  const kacheln: HeldKachel[] = stecker.map((k) => {
    const p = num(k.powerKw);
    const zugeteilt = num(k.allocatedKw);
    return {
      label: `Stecker ${k.connectorId}`,
      wert: k.charging ? kw(p) : (p != null && p > LAEUFT_AB_KW ? kw(p) : 'frei'),
      wort: k.charging
        ? (zugeteilt == null ? 'lädt' : `lädt · zugeteilt ${fmtNum(zugeteilt, 'kW')}`)
        : (k.status?.trim() ? k.status.trim() : 'bereit'),
      ton: k.charging ? 'ok' : null,
      gross: stecker.length <= 2,
    };
  });
  const ladend = stecker.filter((k) => k.charging);
  const satz = stecker.length === 0
    ? 'Diese Säule meldet noch keine Stecker.'
    : ladend.length === 0
      ? 'Gerade lädt kein Fahrzeug an dieser Säule.'
      : ladend.length === 1
        ? `Stecker ${ladend[0].connectorId} lädt gerade mit ${kw(num(ladend[0].powerKw))}.`
        : `${ladend.length} Fahrzeuge laden gerade an dieser Säule.`;
  return {
    titel: 'Stecker',
    kacheln,
    satz,
    satzTon: stecker.length === 0 ? 'off' : 'ok',
    // ⚠ Der Satz der BOX wird DURCHGEREICHT, nie neu formuliert: nur sie kennt
    // die Zahlen der Verteilung. Er wohnt am STECKER (dort entsteht er) - der
    // erste, der einen trägt, spricht für die Säule.
    hinweis: stecker.map((k) => k.reasonText?.trim()).find((t) => !!t)
      ?? (charger?.note?.trim() ? charger.note.trim() : null),
    balken: null,
  };
}

/** Der Held der Rückfall-Gattung: zeigen, was gemeldet wird - nichts deuten. */
function heldGeraet(input: GesichtInput): Held {
  const src = input.src ?? null;
  const kacheln: HeldKachel[] = [];
  const pv = num(src?.pvKw);
  const grid = num(src?.powerKw);
  const load = num(src?.loadKw);
  if (pv != null) kacheln.push({ label: 'Solarstrom', wert: kw(pv), wort: null, gross: true });
  if (grid != null) kacheln.push(netzKachel(grid, pv == null));
  if (load != null) {
    kacheln.push({ label: 'Verbrauch', wert: kw(load), wort: null, gross: pv == null && grid == null });
  }
  return {
    titel: 'Jetzt',
    kacheln,
    satz: kacheln.length === 0 ? 'Dieses Gerät hat noch keine Messwerte geliefert.' : null,
    satzTon: kacheln.length === 0 ? 'off' : 'ok',
    hinweis: null,
    balken: null,
  };
}

/**
 * Das Gesicht dieser Seite - EIN Aufruf, EIN Ergebnis.
 *
 * Die Gattung entscheidet den Held und die Sektions-Folge; die Sektionen selbst
 * bleiben die geteilten Bauteile.
 */
export function gesicht(input: GesichtInput): Gesicht {
  const gattung = gattungVon(input);
  const registerMoeglich = gattung !== 'ladepunkt'
    && !OHNE_REGISTER.has((input.communication ?? '').trim());
  const held = gattung === 'wechselrichter-speicher'
    ? heldWechselrichter(input, true)
    : gattung === 'wechselrichter'
      ? heldWechselrichter(input, false)
      : gattung === 'pv-melder'
        ? heldPvMelder(input)
        : gattung === 'zaehler'
          ? heldZaehler(input)
          : gattung === 'verbraucher'
            ? heldVerbraucher(input)
            : gattung === 'ladepunkt'
              ? heldLadepunkt(input)
              : heldGeraet(input);
  // ⚠ EINE Regel für JEDE Gattung: trägt keine Kachel einen Wert, wird der
  // Grund GENANNT - eine Reihe von „—" ist keine Auskunft.
  const stumm = held.kacheln.length === 0 || held.kacheln.every((k) => k.wert === NO_DATA);
  const ehrlich: Held = stumm && !held.hinweis
    ? { ...held, hinweis: KEINE_MESSWERTE }
    : held;
  return { gattung, held: ehrlich, sektionen: sektionenVon(gattung, registerMoeglich) };
}

/**
 * Der Satz, der die entfallene Register-Sektion ERSETZT - er verschwindet
 * nicht, er wandert in den Technik-Aufklapper (Regel 1).
 */
export const OHNE_REGISTER_SATZ =
  'Dieses Gerät wird über seine Web-Schnittstelle gelesen — Modbus-Register gibt es dort nicht.';
