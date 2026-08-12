/**
 * „Steuern freigeben" - die reinen Regeln und der ganze Wortlaut des
 * Freigabe-Assistenten (Einheitsmodell Stufe 4, Konzept
 * `vp-modbus-baukasten-k6` §2.4; Server-Zwilling `SwitchDefinition.java`).
 *
 * Der Server ist der Zaun - er prüft jede dieser Regeln noch einmal. Sie stehen
 * hier, damit der Kunde sie SIEHT, statt in eine Ablehnung zu laufen: dieselbe
 * Arbeitsteilung wie bei `selbstbau.ts` eine Ebene tiefer.
 *
 * ⚠ Die Freigabe ist bewusst ein EIGENER Schritt an der fertigen Komponente,
 * nicht der fünfte Schritt des Anlege-Assistenten. Vor ihr ist das Gerät ein
 * Sensor, und diese Trennung IST die Aussage: man legt ein Gerät an, und man
 * gibt danach - in einem zweiten, bewussten Moment - das Schalten frei.
 */

import type { ProbeSwitched } from './api';

// -- Die zwei Schalt-Arten ---------------------------------------------------

export type SchaltArt = 'on_off' | 'setpoint';

export type SchaltArtOption = {
  id: SchaltArt;
  label: string;
  hint: string;
};

export const SCHALT_ARTEN: SchaltArtOption[] = [
  {
    id: 'on_off',
    label: 'Ein und Aus',
    hint: 'VoltPilot schreibt nur die zwei Werte, die Sie hier festlegen - nie einen dritten.',
  },
  {
    id: 'setpoint',
    label: 'Sollwert',
    hint: 'VoltPilot schreibt nur Werte innerhalb der Grenzen, die Sie hier festlegen.',
  },
];

export const REGISTER_ARTEN = [
  { id: 'coil', label: 'Relais-Spule (Coil)', hint: 'Die häufigste Form bei Relaiskarten.' },
  { id: 'holding', label: 'Register (Holding)', hint: 'Für Sollwerte und für Geräte ohne Spule.' },
];

/**
 * Die Funktionscodes. FC16 ist die Vorauswahl fürs Register, NICHT FC6: ein
 * Einzelregister-Schreibvorgang wird auf mehreren realen Geräten angenommen und
 * dann nicht übernommen (die belegte Fronius-/Deye-Lektion). FC6 bleibt der
 * ausdrückliche Rückfall für Geräte, die nur ihn beherrschen.
 */
export const REGISTER_FCS = [
  { id: 16, label: 'FC16 (empfohlen)', hint: 'Funktioniert auch auf Geräten, die FC6 stillschweigend ignorieren.' },
  { id: 6, label: 'FC6', hint: 'Nur wählen, wenn Ihr Gerät ausdrücklich FC6 verlangt.' },
];

export const EINHEITEN = ['kW', 'W', '%', '°C', 'A', 'V'];

/** Die Dauer des geführten Tests - dieselbe Zahl wie im Vertrag. */
export const TEST_SEKUNDEN = 30;

// -- Das Formular ------------------------------------------------------------

export type SchaltForm = {
  art: SchaltArt;
  registerArt: string;
  adresse: string;
  fc: string;
  einWert: string;
  ausWert: string;
  minWert: string;
  maxWert: string;
  sicherWert: string;
  skalierung: string;
  offset: string;
  einheit: string;
  rueckleseAdresse: string;
  watchdogAdresse: string;
  watchdogWert: string;
  /** Die Verbraucher-Eckdaten (Leitplanke 4). */
  nennleistung: string;
  mindestlaufzeit: string;
  mindestpause: string;
  maxStarts: string;
  leistungsKanal: string;
};

export function neueSchaltForm(): SchaltForm {
  return {
    art: 'on_off',
    registerArt: 'coil',
    adresse: '',
    fc: '16',
    einWert: '1',
    ausWert: '0',
    minWert: '',
    maxWert: '',
    sicherWert: '0',
    skalierung: '1',
    offset: '0',
    einheit: 'kW',
    rueckleseAdresse: '',
    watchdogAdresse: '',
    watchdogWert: '',
    nennleistung: '',
    mindestlaufzeit: '',
    mindestpause: '',
    maxStarts: '',
    leistungsKanal: '',
  };
}

/** Ein deutsches Komma ist die Normal-Eingabe (die `selbstbau.ts`-Lehre). */
export function zahl(text: string): number | null {
  const t = (text ?? '').trim().replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function ganz(text: string): number | null {
  const n = zahl(text);
  return n === null ? null : Math.round(n);
}

/** Nur eine Spule kennt FC5 - die Wahl der Registerart entscheidet ihn mit. */
export function effektiverFc(f: SchaltForm): number {
  return f.registerArt === 'coil' ? 5 : (ganz(f.fc) === 6 ? 6 : 16);
}

/**
 * Die Fehler des Formulars - ALLE auf einmal, nie fail-fast: der Kunde soll
 * einmal korrigieren, nicht fünfmal.
 */
export function schaltFehler(f: SchaltForm): string[] {
  const e: string[] = [];
  const addr = ganz(f.adresse);
  if (addr === null || addr < 0 || addr > 65535) {
    e.push('Die Registeradresse muss zwischen 0 und 65535 liegen (0-basiert - 40001 aus dem '
      + 'Handbuch ist Adresse 0).');
  }
  if (f.art === 'on_off') {
    const on = ganz(f.einWert);
    const off = ganz(f.ausWert);
    if (on === null || off === null || on < 0 || on > 65535 || off < 0 || off > 65535) {
      e.push('Bitte tragen Sie den Ein- und den Aus-Wert ein (0 bis 65535).');
    } else if (on === off) {
      e.push('Ein- und Aus-Wert sind gleich - so ließe sich das Gerät nie wieder ausschalten.');
    } else if (f.registerArt === 'coil' && ![0, 1].includes(on)) {
      e.push('Eine Relais-Spule kennt nur 0 und 1.');
    } else if (f.registerArt === 'coil' && ![0, 1].includes(off)) {
      e.push('Eine Relais-Spule kennt nur 0 und 1.');
    }
  } else {
    if (f.registerArt === 'coil') {
      e.push('Ein Sollwert braucht ein Register - eine Relais-Spule kennt nur ein und aus.');
    }
    const min = zahl(f.minWert);
    const max = zahl(f.maxWert);
    const safe = zahl(f.sicherWert);
    const scale = zahl(f.skalierung);
    if (min === null || max === null) {
      e.push('Bitte tragen Sie den kleinsten und den größten erlaubten Sollwert ein - außerhalb '
        + 'dieser Klemme schaltet VoltPilot nie.');
    } else if (min >= max) {
      e.push('Der kleinste Sollwert muss unter dem größten liegen.');
    }
    if (safe === null) {
      e.push('Bitte tragen Sie den Sicherheitswert ein - er wird geschrieben, wenn die Steuerung '
        + 'endet oder die Verbindung abbricht.');
    }
    if (scale === null || scale === 0) e.push('Die Skalierung muss eine Zahl ungleich 0 sein.');
    if (!f.einheit.trim()) e.push('Bitte wählen Sie die Einheit des Sollwerts.');
  }
  const rated = zahl(f.nennleistung);
  if (rated === null || rated <= 0) {
    e.push('Bitte tragen Sie die Nennleistung des Geräts ein - aus ihr entsteht die '
      + 'Leistungsgrenze, die VoltPilot nie überschreitet.');
  }
  return e;
}

/** Der Rumpf des Schalt-Teils, wie ihn die Route erwartet. */
export function schaltRumpf(f: SchaltForm): Record<string, unknown> {
  const setpoint = f.art === 'setpoint';
  return {
    kind: f.art,
    registerKind: f.registerArt,
    address: ganz(f.adresse),
    writeFc: effektiverFc(f),
    onValue: setpoint ? null : ganz(f.einWert),
    offValue: setpoint ? null : ganz(f.ausWert),
    minValue: setpoint ? zahl(f.minWert) : null,
    maxValue: setpoint ? zahl(f.maxWert) : null,
    safeValue: setpoint ? zahl(f.sicherWert) : null,
    scale: setpoint ? zahl(f.skalierung) : null,
    offset: setpoint ? zahl(f.offset) : null,
    unit: setpoint ? f.einheit : null,
    readbackAddress: ganz(f.rueckleseAdresse),
    watchdogAddress: ganz(f.watchdogAdresse),
    watchdogValue: ganz(f.watchdogWert),
  };
}

export function verbraucherRumpf(f: SchaltForm): Record<string, unknown> {
  return {
    ratedPowerKw: zahl(f.nennleistung),
    minOnSeconds: ganz(f.mindestlaufzeit),
    minOffSeconds: ganz(f.mindestpause),
    maxStartsPerDay: ganz(f.maxStarts),
    powerChannel: f.leistungsKanal.trim() || null,
  };
}

/**
 * Der Testwert eines Sollwert-Tests muss IN der Klemme liegen. Er wird bewusst
 * nicht hineingeklemmt - wer 30 eintippt und stillschweigend 10 bekäme, hätte
 * einen anderen Test gefahren als den, den er danach bestätigt.
 */
export function testWertFehler(f: SchaltForm, testWert: string): string | null {
  if (f.art === 'on_off') return null;
  const v = zahl(testWert);
  const min = zahl(f.minWert);
  const max = zahl(f.maxWert);
  if (v === null) return 'Bitte wählen Sie einen Testwert innerhalb der Grenzen.';
  if (min === null || max === null) return null;
  if (v < min || v > max) {
    return `Der Testwert muss zwischen ${min} und ${max} ${f.einheit} liegen - außerhalb der `
      + 'Grenzen schaltet VoltPilot nie.';
  }
  return null;
}

// -- Was der Assistent SAGT --------------------------------------------------

/**
 * Der wörtliche Totmann-Hinweis (Leitplanke 3c) - Zwilling von
 * `SwitchDefinition.DEADMAN_NOTE`. Er steht hier, weil er eine ZUSAGE ist:
 * ein generisches Modbus-Gerät hat keinen eingebauten Geräte-Totmann, und wer
 * das nicht sagt, verspricht eine Sicherheit, die es nicht gibt.
 */
export const TOTMANN_HINWEIS =
  'Fällt die VoltPilot-Box aus, bleibt das Gerät im letzten Zustand - geben Sie nur Geräte frei, '
  + 'die dafür unkritisch sind oder eine eigene Sicherheitsabschaltung haben.';

/** Was die Freigabe bedeutet - die Liste VOR dem Test, nicht danach. */
export function folgen(f: SchaltForm): string[] {
  const out: string[] = [];
  if (f.art === 'on_off') {
    out.push(`VoltPilot schreibt auf Register ${f.adresse || '?'} nur die Werte `
      + `${f.einWert || '?'} (ein) und ${f.ausWert || '?'} (aus) - nie einen dritten.`);
  } else {
    out.push(`VoltPilot schreibt auf Register ${f.adresse || '?'} nur Werte zwischen `
      + `${f.minWert || '?'} und ${f.maxWert || '?'} ${f.einheit} - nie darüber oder darunter.`);
    out.push(`Endet die Steuerung oder bricht die Verbindung ab, schreibt VoltPilot `
      + `${f.sicherWert || '?'} ${f.einheit}.`);
  }
  out.push(`Die Leistung bleibt auf ${f.nennleistung || '?'} kW begrenzt.`);
  if (f.mindestlaufzeit.trim() || f.mindestpause.trim()) {
    out.push('Mindestlaufzeit und Mindestpause werden eingehalten, auch wenn eine Regel öfter '
      + 'schalten möchte.');
  }
  out.push(TOTMANN_HINWEIS);
  return out;
}

/** Die Folgen der Rücknahme - Zwilling von `SwitchDefinition.revokeConsequences`. */
export const RUECKNAHME_FOLGEN = [
  'VoltPilot schaltet dieses Gerät nicht mehr.',
  'Ihre Regeln für dieses Gerät stoppen.',
  'Die Messwerte des Geräts werden weiter aufgezeichnet.',
  'Sie können das Schalten jederzeit wieder freigeben - mit einem neuen Test.',
];

// -- Der Test und seine Evidenz ----------------------------------------------

export type TestErgebnis =
  | { zustand: 'laeuft'; satz: string }
  | { zustand: 'bestanden'; satz: string; belege: string[] }
  | { zustand: 'fehlgeschlagen'; satz: string }
  | { zustand: 'unklar'; satz: string };

const FEHLER_TEXT: Record<string, string> = {
  unreachable: 'Das Gerät ist unter dieser Adresse nicht erreichbar.',
  no_answer: 'Das Gerät antwortet nicht auf den Schaltbefehl - bitte Unit-ID und Register prüfen.',
  invalid_response: 'Die Antwort des Geräts war nicht lesbar.',
  invalid_request: 'Die Angaben passen nicht zusammen.',
  not_supported: 'Diese VoltPilot-Box kann noch nicht schalten - bitte zuerst aktualisieren.',
  rate_limited: 'Gerade wurde schon geprüft. Bitte einen Moment warten.',
};

/**
 * Das Ergebnis eines Schalt-Tests in einem Satz - und die BELEGE getrennt
 * davon, weil sie verschiedene Dinge sagen: der Satz sagt, ob geschrieben
 * wurde, die Belege sagen, was danach messbar war.
 *
 * ⚠ Ein TIMEOUT ist ausdrücklich „unklar", nie „fehlgeschlagen": der
 * Schreibvorgang kann sehr wohl angekommen sein und nur seine Antwort verloren
 * gegangen - genau dafür gibt es das automatische Aus auf der Box.
 */
export function testErgebnis(res: {
  passed: boolean;
  errorCode?: string | null;
  message?: string | null;
  switched?: ProbeSwitched | null;
} | null): TestErgebnis {
  if (!res) return { zustand: 'laeuft', satz: 'Der Test läuft …' };
  if (res.errorCode === 'timeout') {
    return {
      zustand: 'unklar',
      satz: 'Die Anlage hat nicht rechtzeitig geantwortet. Falls das Gerät doch geschaltet hat, '
        + 'fällt es von selbst wieder zurück.',
    };
  }
  if (!res.passed) {
    const known = res.errorCode ? FEHLER_TEXT[res.errorCode] : undefined;
    return { zustand: 'fehlgeschlagen', satz: known ?? res.message ?? 'Der Schaltbefehl hat das Gerät nicht erreicht.' };
  }
  const belege: string[] = [];
  const sw = res.switched;
  if (sw?.readback !== undefined && sw?.readback !== null) {
    belege.push(sw.readbackMatches
      ? `Das Gerät meldet den geschriebenen Wert zurück (${sw.readback}).`
      : `Achtung: das Gerät meldet ${sw.readback} zurück, geschrieben wurde ${sw.written}.`);
  }
  return {
    zustand: 'bestanden',
    satz: `Geschrieben. Das Gerät fällt in ${sw?.offAfterS ?? TEST_SEKUNDEN} Sekunden von selbst `
      + 'zurück - schauen Sie jetzt hin.',
    belege,
  };
}

/**
 * Die gemessene Leistungsänderung als EVIDENZ - nur wenn beide Werte wirklich
 * gemessen wurden. Ohne Leistungs-Kanal gibt es sie nicht, und eine erfundene
 * Zahl wäre schlimmer als keine.
 */
export function leistungsBeleg(vorher: number | null, nachher: number | null): string | null {
  if (vorher === null || nachher === null) return null;
  const d = nachher - vorher;
  if (Math.abs(d) < 0.05) {
    return `Die gemessene Leistung hat sich nicht verändert (${nachher.toLocaleString('de-DE')} kW).`;
  }
  const richtung = d > 0 ? 'gestiegen' : 'gefallen';
  return `Die gemessene Leistung ist von ${vorher.toLocaleString('de-DE')} auf `
    + `${nachher.toLocaleString('de-DE')} kW ${richtung}.`;
}

// -- Der Freigabe-ZUSTAND an der Komponente ----------------------------------

/**
 * Die drei Vertrauens-Stufen (Konzept `vp-komponenten-einheit-h2` §3.3) - EINE
 * Anzeige. „Gesperrt" ist dabei ein ZUSTAND, kein Fehler: ein Gerät, das nur
 * misst, ist vollständig in Ordnung.
 */
export type FreigabeStufe = 'pruefstand' | 'vorlage' | 'selbst' | 'gesperrt';

export type FreigabeZustand = {
  stufe: FreigabeStufe;
  wort: string;
  satz: string;
  ton: 'ok' | 'unbekannt';
};

export type FreigabeEingang = {
  /** Trägt die Komponente eine Schreib-Fähigkeit? */
  schaltbar: boolean;
  /** Woher die Freigabe kommt - der Selbstbau ist `selbst`. */
  quelle?: 'pruefstand' | 'vorlage' | 'selbst' | null;
  releasedAt?: string | null;
};

export function freigabeZustand(e: FreigabeEingang): FreigabeZustand {
  if (!e.schaltbar) {
    return {
      stufe: 'gesperrt',
      wort: 'Nur messen',
      satz: 'Dieses Gerät liefert Messwerte. Schalten ist nicht freigegeben.',
      ton: 'unbekannt',
    };
  }
  switch (e.quelle) {
    case 'pruefstand':
      return {
        stufe: 'pruefstand',
        wort: 'Von VoltPilot freigegeben',
        satz: 'VoltPilot hat dieses Modell am Prüfstand freigegeben.',
        ton: 'ok',
      };
    case 'vorlage':
      return {
        stufe: 'vorlage',
        wort: 'Geprüfte Vorlage',
        satz: 'Die Schalt-Angaben stammen aus einer von VoltPilot geprüften Vorlage.',
        ton: 'ok',
      };
    default:
      return {
        stufe: 'selbst',
        wort: 'Von Ihnen freigegeben',
        satz: e.releasedAt
          ? `Sie haben das Schalten am ${datum(e.releasedAt)} nach einem Schalt-Test freigegeben.`
          : 'Sie haben das Schalten nach einem Schalt-Test freigegeben.',
        ton: 'ok',
      };
  }
}

function datum(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

/**
 * Die BRÜCKE (Anforderung 9): ein freigegebener Schalter ist die Aktion des
 * vorbefüllten Regel-Einstiegs. Ohne Freigabe gibt es sie nicht - eine Aktion
 * anzubieten, die nichts bewirken kann, wäre ein Knopf ins Leere.
 */
export function regelAktion(e: FreigabeEingang, art: SchaltArt): 'onoff' | 'setpoint' | null {
  if (!e.schaltbar) return null;
  return art === 'setpoint' ? 'setpoint' : 'onoff';
}
