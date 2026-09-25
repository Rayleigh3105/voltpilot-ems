// Die REINE Ableitung des Register-Drawers (Konzept `vp-reg-schreib-konzept-p8`
// §2.3, Stufen 1-3 - seit Stufe 3 „Bis zum Endkunden" auch die Kunden-Fläche).
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
import type { RegisterWriteEvent, RegisterWriteOutcome, RegisterWriteTarget } from './api';
import { AUFBAU_REITER } from './anlageNav';

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

/**
 * Der VERANTWORTUNGS-SATZ (Stufe 3 „Bis zum Endkunden", Konzept §2.3).
 *
 * ⚠ Er ist die Gegenleistung für die Freiheit, nicht ihr Kleingedrucktes: der
 * Kunde darf JEDES Register seines Geräts beschreiben, weil die Abstufung eine
 * der Reichweite ist und keine der Register - und genau deshalb muss VOR dem
 * Klick stehen, dass niemand diesen Wert für ihn prüft. Er gilt für JEDE
 * Herkunft (auch VoltPilot schreibt auf eigene Verantwortung ins Kundengerät);
 * ein zweiter, milderer Satz für die eigene Mannschaft wäre die gefährlichere
 * Variante.
 */
export const VERANTWORTUNG =
  'Sie schreiben auf eigene Verantwortung in Ihr Gerät. Ein falsches Register '
  + 'kann das Gerät fehlkonfigurieren. VoltPilot prüft diesen Wert nicht.';

/**
 * Die FOLGENLISTE der Rückfrage - das Haus-Muster des `ConfirmDialog`.
 *
 * ⚠ Der Verantwortungs-Satz steht HIER und nicht nur als Kleingedrucktes im
 * Formular: die Rückfrage ist der Moment, in dem ein Mensch die Folgen
 * abwägt, und eine Eigenverantwortungs-Erklärung, die er beim Scrollen
 * überliest, ist keine. Er kommt ZULETZT, weil er die Zusammenfassung der drei
 * Zeilen darüber ist, nicht eine vierte Einzelheit.
 *
 * Sie nennt auch, was GLEICH bleibt (die Papier-Spur) - eine Folgenliste, die
 * nur Gefahren aufzählt, liest sich wie ein Formular zum Wegklicken.
 */
export function bestaetigungsFolgen(): string[] {
  return [
    'Das Register wird GENAU EINMAL beschrieben - kein zweiter Versuch.',
    'Der Wert bleibt dauerhaft im Gerät gespeichert, bis ihn jemand ändert.',
    'Hat sich der Ist-Wert seit der Vorschau geändert, verweigert das Gerät.',
    'Der Vorgang wird mit Ihrem Namen und Ihrem Grund dauerhaft protokolliert.',
    VERANTWORTUNG,
  ];
}

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

/**
 * Ein Rohwert samt seiner Umrechnung, wo eine Skala bekannt ist.
 *
 * ⚠ Die EINHEIT kommt vom Server (`scaleUnit`) und wird NIE geraten: ein
 * Register ohne bekannte Skala zeigt nur die rohe Zahl, denn ein „kW" hinter
 * einem Wert, der Ampere oder Prozent bedeutet, wäre die gefährlichste
 * Beschriftung dieses ganzen Pfades.
 */
export function wertAnzeige(raw: number | null, skaliert: number | null,
  einheit: string | null = null): string | null {
  if (raw == null) return null;
  if (skaliert == null || !einheit) return String(raw);
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
  /** Der Betreiber-Hinweis des Register-Wissens, oder null. */
  hinweis: string | null;
  /** „heute bereits 2× geschrieben" - oder null, wenn heute noch nichts war. */
  schreibzaehler: string | null;
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
  const einheit = out.scaleUnit ?? null;
  return {
    gelesen,
    istText: wertAnzeige(out.beforeRaw, out.beforeScaled, einheit),
    satz: gelesen
      ? `Ist-Wert: ${wertAnzeige(out.beforeRaw, out.beforeScaled, einheit)}`
      : (out.message ?? 'Der Ist-Wert konnte nicht gelesen werden.'),
    ton: gelesen ? 'ok' : fehlerTon(out.errorCode),
    notizPflicht: out.noteRequired,
    klasse,
    klasseWort: klasseWort(klasse),
    warnung: klasseWarnung(klasse),
    hinweis: out.registerNote ?? null,
    schreibzaehler: schreibzaehler(out.writesToday),
    expectedBefore: out.beforeRaw,
  };
}

/**
 * Der Bestätigen-Knopf trägt den VOLLEN Satz - was genau gleich passiert, steht
 * darauf, nicht daneben.
 */
export function bestaetigenLabel(adresse: string, wert: string,
  skaliert: number | null, einheit: string | null = null): string {
  const n = parseRegisterZahl(adresse);
  const hex = n == null ? adresse.trim() : `0x${n.toString(16).padStart(4, '0')}`;
  const w = parseRegisterZahl(wert);
  const roh = w == null ? wert.trim() : String(w);
  const umgerechnet = skaliert == null || !einheit
    ? ''
    : ` (${skaliert.toLocaleString('de-DE', {
      minimumFractionDigits: 1, maximumFractionDigits: 1,
    })} ${einheit})`;
  return `Jetzt schreiben: ${hex} = ${roh}${umgerechnet}`;
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
  const einheit = out.scaleUnit ?? null;
  const vorher = wertAnzeige(out.beforeRaw, out.beforeScaled, einheit);
  const nachher = wertAnzeige(out.afterRaw, out.afterScaled, einheit);
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

// ── Stufe 2: das ZIEL wird gewählt ───────────────────────────────────────────

/**
 * ⚠ DER SCHREIBZÄHLER IST EINE INFORMATION, KEINE SPERRE (Konzept §2.9 Punkt 3).
 * Ein Installateur-Register liegt im EEPROM, und jeder Schreibvorgang kostet
 * einen Schreibzyklus - wer das weiß, schreibt nicht dreimal probeweise. Ist
 * heute noch nichts geschehen, wird auch nichts gesagt: eine „0×"-Zeile wäre
 * Lärm ohne Aussage.
 */
export function schreibzaehler(anzahl: number | null | undefined): string | null {
  if (anzahl == null || anzahl <= 0) return null;
  return anzahl === 1
    ? 'Dieses Register wurde heute bereits einmal geschrieben.'
    : `Dieses Register wurde heute bereits ${anzahl}× geschrieben.`;
}

/** Ein Ziel des Pickers, wie die Fläche es zeigt. */
export interface ZielSicht {
  lane: string;
  /** Der Schlüssel, unter dem die Fläche das Ziel wiederfindet. */
  key: string;
  titel: string;
  /** „Deye · 192.168.0.28:8899 · Unit 1" - was davon bekannt ist. */
  unterzeile: string | null;
  /** Der Satz der Lane („Der Wechselrichter, den die Anlage selbst kennt"). */
  laneWort: string;
  waehlbar: boolean;
  /** Warum nicht - immer gesetzt, wenn nicht wählbar. */
  grund: string | null;
  /** Ob die Plattform die Bedeutung der Register dieses Ziels kennt. */
  kenntRegister: boolean;
}

/** Das Lane-Wort in Kundendeutsch. Ein unbekanntes bleibt ohne Behauptung. */
export function laneWort(lane: string): string {
  switch (lane) {
    case 'primary':
      return 'Wechselrichter der Anlage';
    case 'entity':
      return 'Komponente';
    case 'lan':
      return 'Gerät im Netzwerk';
    default:
      return 'Ziel';
  }
}

/** Der Schlüssel eines Ziels - stabil über einen Neu-Abruf hinweg. */
export function zielKey(t: RegisterWriteTarget): string {
  // ⚠ Ein Alias hat einen EIGENEN Schlüssel, obwohl es auf die primäre Lane
  // zeigt: sonst fiele es mit dem Wechselrichter-Ziel derselben Box zusammen,
  // und der Picker verlöre die Komponente, nach der ein Mensch sucht.
  if (t.primaryAlias && t.entityId) return `alias:${t.entityId}`;
  if (t.lane === 'entity' && t.entityId) return `entity:${t.entityId}`;
  if (t.lane === 'lan') return `lan:${t.host ?? ''}:${t.port ?? 502}#${t.unitId ?? 1}`;
  return `primary:${t.deviceId}`;
}

/**
 * Die Ziel-Liste des Pickers.
 *
 * ⚠ EIN ZIEL OHNE SCHREIBWEG WIRD GEZEIGT, NICHT VERSTECKT - mit seinem Grund.
 * Es wegzulassen erzeugte die Frage „warum fehlt mein Gerät?" und beantwortete
 * sie nirgends; das ist derselbe Schutz-durch-Information, aus dem auch die
 * Warnklassen nichts sperren.
 */
export function ziele(targets: RegisterWriteTarget[]): ZielSicht[] {
  return targets.map((t) => ({
    lane: t.lane,
    key: zielKey(t),
    titel: t.label,
    unterzeile: zielUnterzeile(t),
    // ⚠ Der Benutzer sieht KEINE Lane (E4): ein Alias ist für ihn die
    // Komponente, die er angeklickt hat - dass sie über den Wechselrichter
    // erreicht wird, ist eine Tatsache unserer Box.
    laneWort: t.primaryAlias ? laneWort('entity') : laneWort(t.lane),
    waehlbar: t.writable,
    grund: t.writable ? null : t.reason,
    kenntRegister: !!t.family,
  }));
}

function zielUnterzeile(t: RegisterWriteTarget): string | null {
  const teile: string[] = [];
  const geraet = [t.brand, t.model].filter(Boolean).join(' ').trim();
  if (geraet) teile.push(geraet);
  if (t.host) {
    teile.push(t.port ? `${t.host}:${t.port}` : t.host);
  }
  if (t.unitId != null) teile.push(`Unit ${t.unitId}`);
  return teile.length ? teile.join(' · ') : null;
}

/**
 * Der Satz über die Registerkenntnis EINES Ziels.
 *
 * ⚠ „VoltPilot kennt die Register dieses Geräts nicht" ist eine AUSSAGE und
 * keine Warnung vor dem Schreiben: geschrieben werden darf trotzdem (die
 * Freiheit IST der Kern dieser Stufe), nur eben ohne Klartext-Namen und ohne
 * Umrechnung. Ein erfundener Name wäre die Alternative - und die gefährlichere.
 */
export function registerKenntnis(ziel: ZielSicht | null): string | null {
  if (!ziel) return null;
  if (ziel.kenntRegister) return null;
  return 'VoltPilot kennt die Register dieses Geräts nicht. Sie sehen nur den '
    + 'Rohwert - Name und Umrechnung fehlen, geschrieben werden kann trotzdem.';
}

/**
 * Was der Aufruf als Ziel mitschickt - aus dem gewählten Eintrag abgeleitet.
 *
 * ⚠ Die GERÄTE-KENNUNG reist seit Stufe 3 mit (jedes Ziel trägt sie). Auf der
 * Geräteseite war sie überflüssig - dort IST das Gerät die Seite -, auf der
 * Anlagen-Fläche des Kunden ist sie tragend: eine Anlage kann mehrere Boxen
 * haben, und welche den Auftrag ausführt, darf nicht davon abhängen, welche
 * die Fläche zufällig als erste geladen hat.
 */
export function zielInput(t: RegisterWriteTarget | null): {
  deviceId?: string; lane?: string; entityId?: string;
  host?: string; port?: number; unitId?: number;
} {
  if (!t) return {};
  const geraet = t.deviceId ? { deviceId: t.deviceId } : {};
  if (t.primaryAlias && t.entityId) {
    // ⚠ Die Komponente reist MIT, obwohl der Auftrag primär ist: der Umschlag
    // der primären Lane trägt gar kein `entity_id` (die Box bekommt also
    // zeichengleich, was sie immer bekam), das JOURNAL aber schon - und nur so
    // gehört der Vorgang der Komponente, auf deren Seite er ausgelöst wurde.
    return { ...geraet, lane: 'primary', entityId: t.entityId };
  }
  if (t.lane === 'entity' && t.entityId) {
    return { ...geraet, lane: 'entity', entityId: t.entityId };
  }
  if (t.lane === 'lan') {
    return {
      ...geraet,
      lane: 'lan',
      ...(t.host ? { host: t.host } : {}),
      ...(t.port != null ? { port: t.port } : {}),
      ...(t.unitId != null ? { unitId: t.unitId } : {}),
    };
  }
  return { ...geraet, lane: 'primary' };
}

/** Die Eingabe einer FREI getippten LAN-Adresse - Form, nie Netz-Wahrheit. */
export function freieAdresseFehler(host: string): string | null {
  const t = host.trim();
  if (!t) return 'Bitte die IP-Adresse des Geräts eintragen.';
  if (/\s/.test(t)) return 'Eine Adresse enthält keine Leerzeichen.';
  // ⚠ Ob sie belegbar PRIVAT ist, prüft die BOX - hier steht keine zweite
  // Wahrheit über ein Netz, das dieses Portal nie gesehen hat.
  return null;
}

// ── Stufe 3: die KUNDEN-Fläche ───────────────────────────────────────────────

/**
 * Der Zugang der KUNDEN-Fläche: an welches Gerät dieser Anlage ginge ein
 * Auftrag, wenn der Kunde nichts weiter wählt?
 *
 * ⚠ Sie ist die anlagen-scharfe Schwester von {@link registerZugang} (dort ist
 * das Gerät die Seite, hier ist es die Anlage) und folgt derselben Regel: ein
 * Knopf, der strukturell nichts bewirken kann, wird NICHT angeboten - er trägt
 * stattdessen seinen Grund.
 *
 * ⚠ Der Mandant reist hier bewusst NICHT mit. Ein Kunde erreicht seine eigene
 * Anlage über den RLS-Zaun; der `X-Tenant-Id`-Umschalter gilt nur einem
 * Portal-Admin, und ihn hier zu stempeln hieße, einen Kopf zu schicken, den der
 * Server für dieses Token ohnehin ignoriert.
 */
export interface KundenRegisterZugang {
  moeglich: boolean;
  /** Der Grund, wenn nicht - nie ein stiller leerer Bereich. */
  grund: string | null;
  /**
   * Das VORGEWÄHLTE Gerät. Auf einer Anlage mit mehreren Boxen entscheidet
   * danach der Ziel-Picker (jedes Ziel trägt seine eigene Geräte-Kennung mit,
   * siehe {@link zielInput}) - dieses hier ist nur der Ausgangspunkt.
   */
  deviceId: string | null;
  geraetName: string | null;
}

export function kundenRegisterZugang(
  devices: { id: string; siteId: string; name?: string | null; externalRef: string }[] | undefined,
  siteId: string,
): KundenRegisterZugang {
  const eigene = (devices ?? []).filter((d) => d.siteId === siteId);
  const erstes = eigene[0];
  if (!erstes) {
    return {
      moeglich: false,
      grund: 'Sobald ein Gerät mit dieser Anlage verbunden ist, können Sie hier '
        + 'einzelne Geräte-Register lesen und schreiben.',
      deviceId: null,
      geraetName: null,
    };
  }
  return {
    moeglich: true,
    grund: null,
    deviceId: erstes.id,
    geraetName: erstes.name?.trim() || erstes.externalRef,
  };
}

/**
 * ⚠ EIN LANGER VORGANG MUSS SICH ANSAGEN (Produktionsvorfall 20.08.2026).
 *
 * Die Box darf für EINE Lesung bis zu einer halben Minute brauchen: ihr
 * Modbus-Knoten hängt hinter der EINEN Warteschlange je Ziel und muss erst den
 * laufenden Poll abwarten. Das Portal wartet deshalb länger als der Reflex
 * vermuten lässt - und eine Fläche, die dabei nur einen ausgegrauten Knopf
 * zeigt, wirkt kaputt. Genau dieser Eindruck ist entstanden, als das Budget
 * noch ZU KURZ war: der Vorgang sah wie ein Fehler aus, während er in Wahrheit
 * gerade lief.
 */
export const LESE_LAEUFT = 'Wird gelesen …';
export const LESE_DAUER_HINWEIS =
  'Das kann bis zu einer halben Minute dauern - der Wechselrichter wird gerade '
  + 'ausgelesen, und Ihre Anfrage stellt sich dahinter an.';

/** Der ruhige Einleitungssatz des Experten-Aufklappers. */
export const EXPERTE_INTRO =
  'Für Fachleute: ein einzelnes Register Ihres Geräts aus der Ferne lesen und - '
  + 'nach einer Vorschau - genau einmal beschreiben. Jeder Schreibvorgang wird '
  + 'dauerhaft protokolliert.';

// ── Anlagen-Zentrale Stufe 1: das Register auf der GERÄTESEITE ───────────────

/**
 * Der Zugang der GERÄTESEITE (Konzept `vp-anlagen-zentrale-konzept-h6` §7.5,
 * geschärft von `vp-geraeteseite-rev-b8` §7 / Captain-Entscheid E4):
 * hat GENAU DIESES Gerät einen Schreibweg - und welches Ziel ist dann
 * vorgewählt?
 *
 * ⚠ Die Vorwahl ist der ganze Zweck: auf einer Anlage mit mehreren Geräten
 * ist „Register schreiben" ohne sie eine Einladung, das falsche zu treffen.
 * Vorgewählt wird nur, was BELEGT zu diesem Gerät gehört - die primäre Lane
 * auf dem HAUPTGERÄT, die Komponente eines Geräts dahinter. **Geraten wird
 * nie:** ohne passendes Ziel gibt es keine Vorwahl.
 *
 * ⚠ **DER BENUTZER SIEHT KEINE LANE (E4).** Das Hauptgerät IST die primäre
 * Lane dieser Box - vorher wurde ihm die Komponenten-Lane vorgewählt, und weil
 * die Komponenten eines Solarman-Wechselrichters dort nicht schreibbar sind,
 * empfahl seine eigene Seite ihm, „den primären Wechselrichter als Ziel zu
 * wählen". Ein Hinweis, der auf dieselbe Seite führt, erklärt einen Begriff,
 * den ein Kunde nie braucht.
 *
 * ⚠ Und ein Knopf, der strukturell nichts bewirken kann, wird NICHT angeboten
 * (die `applyView`-Regel des Hauses) - er trägt stattdessen den Grund, den der
 * Server nennt (`targets.reason`), nie einen erfundenen.
 */
export interface GeraetRegisterZugang {
  moeglich: boolean;
  /** Der Grund, wenn nicht - nie ein stiller leerer Bereich. */
  grund: string | null;
  /** Der Schlüssel des vorgewählten Ziels, oder null. */
  vorwahl: string | null;
  /**
   * Der WEG, den der Grund nennt - die Fläche verlinkt ihn. `null` = der Grund
   * nennt keinen (dann gibt es auch keinen Knopf ins Leere).
   */
  weg: 'anlagen-modell' | null;
}

/** Der Satz, wenn zu diesem Gerät gar kein Ziel bekannt ist. */
export const KEIN_SCHREIBWEG =
  'Für dieses Gerät kennt VoltPilot keinen Schreibweg. Register lassen sich nur '
  + 'an Geräten schreiben, deren Anbindung die Anlage kennt.';

/**
 * Der Satz für ein Gerät, das die Box zwar MELDET, das aber noch keine
 * Komponente ist (§7): er nennt den WEG statt nur des Fehlens.
 *
 * ⚠ Eine Vorwahl auf die freie Adresse dieses Geräts wäre eine Behauptung -
 * dass unter dieser Adresse GENAU dieses Gerät antwortet, weiß nur die Box.
 * Deshalb der Weg über die Übernahme, nach der die Anlage die Anbindung kennt.
 */
export const ERST_ALS_KOMPONENTE =
  'Dieses Gerät ist noch keine Komponente Ihrer Anlage - deshalb kennt VoltPilot '
  + `seinen Schreibweg nicht. Übernehmen Sie es unter „${AUFBAU_REITER}", danach lassen `
  + 'sich seine Register lesen und schreiben.';

export function geraetRegisterZugang(
  targets: RegisterWriteTarget[],
  opts: { art: 'hauptgeraet' | 'quelle' | 'ladepunkt'; deviceId: string | null;
    entityIds: string[] },
): GeraetRegisterZugang {
  // Die Komponenten DIESES Geräts - egal, über welchen Weg die Box sie
  // erreicht: eine Lane ist eine Transport-Tatsache, keine Zugehörigkeit.
  const eigene = targets.filter((t) => t.entityId && opts.entityIds.includes(t.entityId)
    && (t.lane === 'entity' || t.primaryAlias === true));
  // Das HAUPTGERÄT ist die primäre Lane seiner Box - sie führt vor jeder
  // Komponente, denn sie meint genau dieses Gerät.
  const primaer = opts.art === 'hauptgeraet'
    ? targets.filter((t) => t.lane === 'primary' && !t.primaryAlias
        && (!opts.deviceId || t.deviceId === opts.deviceId))
    : [];
  const passend = [...primaer, ...eigene];
  if (passend.length === 0) {
    // Ohne eine einzige Komponente ist dieses Gerät noch nicht übernommen -
    // der Grund nennt den Weg dorthin statt nur sein eigenes Fehlen.
    const grund = opts.entityIds.length === 0 && opts.art === 'quelle'
      ? ERST_ALS_KOMPONENTE : KEIN_SCHREIBWEG;
    return {
      moeglich: false,
      grund,
      vorwahl: null,
      weg: grund === ERST_ALS_KOMPONENTE ? 'anlagen-modell' : null,
    };
  }
  const schreibbar = passend.find((t) => t.writable);
  if (!schreibbar) {
    // Der Server sagt, warum - und nur er. Ein selbst formulierter Grund wäre
    // eine zweite Wahrheit über eine Fähigkeit, die die Box meldet.
    return {
      moeglich: false,
      grund: passend[0].reason ?? KEIN_SCHREIBWEG,
      vorwahl: null,
      weg: null,
    };
  }
  return { moeglich: true, grund: null, vorwahl: zielKey(schreibbar), weg: null };
}

/**
 * Der VERLAUF dieses Geräts aus dem Journal der Anlage.
 *
 * ⚠ Die Grenze ist wörtlich die des Kommando-Verlaufs und seit der
 * Ziel-Attribution (Konzept `vp-geraeteseite-rev-b8` §5) auf BEIDEN Seiten
 * dieselbe: die **BOX** trägt die ANLAGENWEITEN Vorgänge - die ohne Komponente,
 * also die primäre Lane und eine frei getippte Adresse -, ein Gerät
 * **dahinter** die Vorgänge SEINER Komponenten. Denselben Schreibvorgang an
 * zwei Orten zu zeigen wäre eine zweite Wahrheit; ihn einem einzelnen Gerät
 * anzulasten, dem er nicht gehört, eine erfundene Zuordnung.
 *
 * <p>Gefiltert wird hier, weil die Route je GERÄT liefert (die Box) - und die
 * Box ist bei einem Gerät dahinter genau die richtige Abfrage.
 */
export function geraeteVerlauf(
  rows: RegisterWriteEvent[],
  opts: { box: boolean; entityIds: string[] },
): RegisterWriteEvent[] {
  if (opts.box) return rows.filter((r) => !r.entityId);
  return rows.filter((r) => !!r.entityId && opts.entityIds.includes(r.entityId));
}

/**
 * Der Verweis, der die Zentrale entlastet: das Register-Werkzeug wohnt seit der
 * Geräteseite DORT, wo das Gerät wohnt.
 *
 * ⚠ Er ERSETZT den Aufklapper der Zentrale, statt ihn zu verdoppeln - zwei
 * Einstiege in dieselbe Zwei-Schritt-Strecke wären zwei Orte, an denen dieselbe
 * Sicherheits-Zusage gepflegt werden müsste.
 */
export const REGISTER_AUF_DER_GERAETESEITE =
  'Einzelne Geräte-Register lesen und schreiben: auf der Seite des jeweiligen '
  + 'Geräts („Geräteseite").';
