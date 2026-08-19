// Die REINE Ableitung des Register-Drawers (Konzept `vp-reg-schreib-konzept-p8`
// §2.3, Stufe 1 „Der Portal-Trigger").
//
// Sie ENTSCHEIDET nichts: ob eine Adresse freigegeben ist, ob der Wert im Band
// liegt und ob die laufende Steuerung das Register gerade besitzt, entscheidet
// das GERÄT; welche Warnklasse gilt und ob eine Notiz Pflicht ist, entscheidet
// der Server. Hier entstehen ausschließlich SÄTZE und die Frage, ob ein Knopf
// überhaupt etwas bewirken kann - das RolloutStates-Konsumenten-Muster.
//
// Vier Ehrlichkeitsregeln tragen jede Funktion:
//  1. Ein Wert, den niemand gemessen hat, wird nicht gezeigt - nie eine
//     erfundene 0 (bei einer Einspeisegrenze wäre 0 ein WERT: „gar keine
//     Einspeisung erlaubt").
//  2. Schweigen heißt „Zustand unbekannt", NIE „nicht geschrieben" - und danach
//     verlangt die Fläche eine neue Ist-Lesung, bevor sie erneut schreiben
//     lässt (die PR-280-Lehre).
//  3. Was den Schreibvorgang verhindern WIRD, steht VOR dem Klick.
//  4. Ein Wort außerhalb des Vokabulars erzeugt KEINE Behauptung.
import type { RegisterWriteEvent, RegisterWriteOutcome } from './api';

/** Die drei Warnklassen des Register-Wissens. */
export type RegisterKlasse = 'netz_compliance' | 'bekannt' | 'unbekannt';

/**
 * Der WARN-Satz je Klasse. Er sperrt nichts (Captain-Entscheid D3: reine
 * Warnung, kein Bestätigungs-Häkchen) - er sagt, was auf dem Spiel steht.
 */
export function klasseWarnung(klasse: string | null | undefined): string | null {
  switch (klasse) {
    case 'netz_compliance':
      return 'Dieses Register betrifft die Netz-Anmeldung Ihrer Anlage. '
        + 'Änderungen nur mit Freigabe des Netzbetreibers.';
    case 'unbekannt':
      return 'VoltPilot kennt dieses Register nicht. Es wird nur der Rohwert '
        + 'angezeigt. Ein falsches Register kann das Gerät fehlkonfigurieren.';
    case 'bekannt':
      return null;
    default:
      // Eine Klasse, die dieser Portal-Stand nicht kennt, behauptet nichts.
      return null;
  }
}

/** Der Ton der Warnklasse - Farbe UND Wort, nie Farbe allein. */
export function klasseTon(klasse: string | null | undefined): 'warn' | 'danger' | 'ruhig' {
  if (klasse === 'netz_compliance') return 'warn';
  if (klasse === 'unbekannt') return 'danger';
  return 'ruhig';
}

/** Das Wort zur Klasse (steht neben der Farbe). */
export function klasseWort(klasse: string | null | undefined): string | null {
  switch (klasse) {
    case 'netz_compliance':
      return 'Netz-Anmeldung';
    case 'bekannt':
      return 'Bekanntes Register';
    case 'unbekannt':
      return 'Unbekanntes Register';
    default:
      return null;
  }
}

/**
 * Der EEPROM-Satz. Er steht IMMER über dem Bestätigen-Knopf, weil die
 * Einmaligkeit die tragende Eigenschaft dieses Pfades ist.
 */
export const EEPROM_HINWEIS =
  'Dieses Register wird dauerhaft im Gerät gespeichert. Es wird genau EINMAL '
  + 'geschrieben - kein automatisches Auffrischen, kein zweiter Versuch.';

/** Der Verantwortungs-Satz. */
export const VERANTWORTUNG =
  'Sie schreiben auf eigene Verantwortung in Ihr Gerät. Ein falsches Register '
  + 'kann das Gerät fehlkonfigurieren. VoltPilot prüft diesen Wert nicht.';

/** Der Satz, der nach einer ausgebliebenen Quittung gilt. */
export const ZUSTAND_UNBEKANNT =
  'Zustand unbekannt - bitte den Ist-Wert neu lesen, bevor Sie erneut schreiben.';

/** Was eine Adresse sein darf: dezimal oder 0x-hexadezimal, 0..65535. */
export function adresseFehler(eingabe: string): string | null {
  const t = eingabe.trim();
  if (!t) return 'Bitte eine Registeradresse eintragen.';
  const zahl = parseRegisterZahl(t);
  if (zahl == null) {
    return 'Erlaubt sind 0 bis 65535 - dezimal (231) oder hexadezimal (0x00E7).';
  }
  return null;
}

/** Dieselbe Regel für den Rohwert. */
export function wertFehler(eingabe: string): string | null {
  const t = eingabe.trim();
  if (!t) return 'Bitte den neuen Rohwert eintragen.';
  if (parseRegisterZahl(t) == null) {
    return 'Der Wert ist keine Registerzahl (0 bis 65535, dezimal oder 0x-hexadezimal).';
  }
  return null;
}

/**
 * Die Zahl hinter der Eingabe - oder null. Ein NACKTES Hex-Wort („E7") wird
 * bewusst NICHT geraten: „231" wäre dann mehrdeutig, und ein geratenes Register
 * ist genau der Fehler, gegen den die ganze Zwei-Schritt-Strecke gebaut ist.
 */
export function parseRegisterZahl(eingabe: string): number | null {
  const t = eingabe.trim().toLowerCase().replace(/_/g, '');
  if (!t) return null;
  const hex = t.startsWith('0x');
  const koerper = hex ? t.slice(2) : t;
  if (!koerper) return null;
  if (!(hex ? /^[0-9a-f]+$/ : /^[0-9]+$/).test(koerper)) return null;
  const n = Number.parseInt(koerper, hex ? 16 : 10);
  return Number.isFinite(n) && n >= 0 && n <= 0xffff ? n : null;
}

/** Die Anzeige einer Adresse in BEIDEN Schreibweisen - live beim Tippen. */
export function adresseEcho(eingabe: string): string | null {
  const n = parseRegisterZahl(eingabe);
  if (n == null) return null;
  return `0x${n.toString(16).padStart(4, '0')} · dezimal ${n}`;
}

/** Ein Rohwert samt seiner Umrechnung, wo eine Skala bekannt ist. */
export function wertAnzeige(raw: number | null, skaliert: number | null,
  einheit = 'kW'): string | null {
  if (raw == null) return null;
  if (skaliert == null) return String(raw);
  return `${raw} (${skaliert.toLocaleString('de-DE', {
    minimumFractionDigits: 1, maximumFractionDigits: 1,
  })} ${einheit})`;
}

/** Der Zustand der Vorschau, aus dem der zweite Schritt folgt. */
export interface VorschauSicht {
  /** Konnte gelesen werden? Nur dann gibt es einen zweiten Schritt. */
  gelesen: boolean;
  /** „3300 (33,0 kW)" - oder null, wenn nichts gelesen wurde. */
  istText: string | null;
  /** Der Satz, den der Kunde liest. */
  satz: string;
  ton: 'ok' | 'warn' | 'info';
  /** Ist eine Notiz Pflicht (D5)? */
  notizPflicht: boolean;
  klasse: string;
  klasseWort: string | null;
  warnung: string | null;
  /** Der Ist-Wert, der als Wächter mitreist. */
  expectedBefore: number | null;
}

/**
 * Die Vorschau-Karte aus der Antwort der Box.
 *
 * ⚠ Ohne gelungene Lesung gibt es KEINEN Schreib-Schritt - das ist Reihenfolge,
 * keine Hürde: die Lesung IST der erste Schritt, und sie beweist zugleich, dass
 * der Schreibweg offen ist (Gate an? Lane erreichbar? Selbstkonflikt?).
 */
export function vorschau(out: RegisterWriteOutcome): VorschauSicht {
  const gelesen = out.ok && out.beforeRaw != null;
  const klasse = out.registerClass ?? 'unbekannt';
  return {
    gelesen,
    istText: wertAnzeige(out.beforeRaw, out.beforeScaled),
    satz: gelesen
      ? `Ist-Wert: ${wertAnzeige(out.beforeRaw, out.beforeScaled)}`
      : (out.message ?? 'Der Ist-Wert konnte nicht gelesen werden.'),
    ton: gelesen ? 'ok' : fehlerTon(out.errorCode),
    notizPflicht: out.noteRequired,
    klasse,
    klasseWort: klasseWort(klasse),
    warnung: klasseWarnung(klasse),
    expectedBefore: out.beforeRaw,
  };
}

/**
 * Der Bestätigen-Knopf trägt den VOLLEN Satz - was genau gleich passiert, steht
 * darauf, nicht daneben.
 */
export function bestaetigenLabel(adresse: string, wert: string,
  skaliert: number | null): string {
  const n = parseRegisterZahl(adresse);
  const hex = n == null ? adresse.trim() : `0x${n.toString(16).padStart(4, '0')}`;
  const w = parseRegisterZahl(wert);
  const roh = w == null ? wert.trim() : String(w);
  const einheit = skaliert == null
    ? ''
    : ` (${skaliert.toLocaleString('de-DE', {
      minimumFractionDigits: 1, maximumFractionDigits: 1,
    })} kW)`;
  return `Jetzt schreiben: ${hex} = ${roh}${einheit}`;
}

/** Der Beleg nach dem Schreibvorgang. */
export interface BelegSicht {
  satz: string;
  ton: 'ok' | 'warn' | 'info';
  /** Muss vor einem erneuten Schreibvorgang neu gelesen werden? */
  neuLesen: boolean;
  detail: string | null;
}

/**
 * Der Beleg - fünf ehrliche Ausgänge, und „unbekannt" ist ausdrücklich NICHT
 * „nicht geschrieben".
 */
export function beleg(out: RegisterWriteOutcome): BelegSicht {
  const vorher = wertAnzeige(out.beforeRaw, out.beforeScaled);
  const nachher = wertAnzeige(out.afterRaw, out.afterScaled);
  switch (out.outcome) {
    case 'uebernommen':
      return {
        satz: `Übernommen ✓ ${nachher}`,
        ton: 'ok',
        neuLesen: false,
        detail: vorher ? `vorher ${vorher}` : null,
      };
    case 'nicht_uebernommen':
      return {
        satz: out.afterRaw == null
          ? 'Der Schreibbefehl ging hinaus, das Register konnte danach aber nicht '
            + 'zurückgelesen werden - der Wert ist unbestätigt.'
          : `Das Gerät hat den Wert angenommen, aber nicht übernommen - `
            + `zurückgelesen: ${nachher}.`,
        ton: 'warn',
        neuLesen: true,
        detail: out.message,
      };
    case 'unbekannt':
      return {
        satz: ZUSTAND_UNBEKANNT,
        ton: 'warn',
        neuLesen: true,
        detail: out.message,
      };
    case 'abgelehnt':
      return {
        satz: out.message ?? 'Der Schreibvorgang wurde abgelehnt.',
        ton: 'info',
        // Eine Ablehnung hat NICHTS geschrieben - der Ist-Wert steht noch.
        neuLesen: false,
        detail: null,
      };
    default:
      return {
        satz: out.message ?? 'Der Schreibvorgang ist fehlgeschlagen.',
        ton: 'warn',
        neuLesen: true,
        detail: null,
      };
  }
}

function fehlerTon(code: string | null): 'warn' | 'info' {
  // Eine Ablehnung ist eine Auskunft, kein Defekt.
  if (code === 'refused_control_owned' || code === 'gate_disabled'
    || code === 'refused_policy' || code === 'not_supported'
    || code === 'rate_limited' || code === 'refused_expected_before') {
    return 'info';
  }
  return 'warn';
}

/** Die Herkunft in Kundendeutsch. Ein unbekanntes Wort bleibt ohne Behauptung. */
export function herkunftWort(origin: string | null | undefined): string | null {
  switch (origin) {
    case 'kunde':
      return 'vom Kunden';
    case 'voltpilot':
      return 'durch VoltPilot';
    case 'geraet':
      return 'vor Ort am Gerät';
    default:
      return null;
  }
}

/**
 * EINE Journal-Zeile als Satz - derselbe Text im Drawer-Verlauf und im vierten
 * Strom der Befehle-Seite, damit die zwei Flächen über denselben Vorgang nie
 * Verschiedenes behaupten.
 */
export function journalSatz(e: RegisterWriteEvent): string {
  const register = e.addressHex ?? (e.address == null ? 'Ein Register' : String(e.address));
  const name = e.registerLabel ? ` „${e.registerLabel}"` : '';
  const von = e.beforeRaw == null ? null : String(e.beforeRaw);
  const auf = e.valueRaw == null ? null : String(e.valueRaw);
  const kern = von && auf
    ? `Register ${register}${name} von ${von} auf ${auf} geschrieben`
    : auf
      ? `Register ${register}${name} auf ${auf} geschrieben`
      : `Register ${register}${name} geschrieben`;
  return `${kern}${urteilZusatz(e)}${urheberZusatz(e)}.`;
}

function urteilZusatz(e: RegisterWriteEvent): string {
  switch (e.outcome) {
    case 'uebernommen':
      return ' - vom Gerät bestätigt';
    case 'nicht_uebernommen':
      return ' - vom Gerät nicht übernommen';
    case 'unbekannt':
      return ' - ohne Rückmeldung, Zustand unbekannt';
    case 'abgelehnt':
      return ' - abgelehnt';
    case 'fehler':
      return ' - fehlgeschlagen';
    default:
      // Ohne Ergebniszeile ist der Vorgang noch offen - das ist keine Aussage
      // über sein Ergebnis.
      return '';
  }
}

function urheberZusatz(e: RegisterWriteEvent): string {
  const wort = herkunftWort(e.origin);
  if (!wort) return '';
  return e.actorName ? ` · ${wort} (${e.actorName})` : ` · ${wort}`;
}

/** Der Ton einer Journal-Zeile. */
export function journalTon(e: RegisterWriteEvent): 'ok' | 'warn' | 'info' | 'ruhig' {
  switch (e.outcome) {
    case 'uebernommen':
      return 'ok';
    case 'nicht_uebernommen':
    case 'fehler':
      return 'warn';
    case 'unbekannt':
      return 'info';
    case 'abgelehnt':
      return 'info';
    default:
      return 'ruhig';
  }
}

/** Ob die Register-Strecke für dieses Gerät überhaupt etwas bewirken kann. */
export interface RegisterZugang {
  moeglich: boolean;
  /** Der Grund, wenn nicht - nie ein Knopf, der strukturell nichts tut. */
  grund: string | null;
  siteId: string | null;
  deviceId: string | null;
  tenantId: string | null;
}

/**
 * Der Zugang zur Register-Strecke einer Geräte-Zeile.
 *
 * ⚠ Ein Knopf, der strukturell nichts bewirken kann, wird NICHT angeboten (die
 * `applyView`-Regel der Edge-Updates): eine gedruckte, noch nicht verbundene
 * Aufkleber-ID hat kein Gerät, an das ein Auftrag gehen könnte, und ohne
 * Mandant erreicht die mandantenbezogene Route sie nicht.
 */
export function registerZugang(row: {
  deviceId?: string | null;
  siteId?: string | null;
  tenantId?: string | null;
}): RegisterZugang {
  const deviceId = row.deviceId ?? null;
  const siteId = row.siteId ?? null;
  const tenantId = row.tenantId ?? null;
  if (!deviceId) {
    return {
      moeglich: false,
      grund: 'Diese Geräte-ID ist gedruckt, aber noch mit keinem Gerät verbunden.',
      siteId, deviceId, tenantId,
    };
  }
  if (!siteId || !tenantId) {
    return {
      moeglich: false,
      grund: 'Zu diesem Gerät ist keine Anlage bekannt.',
      siteId, deviceId, tenantId,
    };
  }
  return { moeglich: true, grund: null, siteId, deviceId, tenantId };
}
