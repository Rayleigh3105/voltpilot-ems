/**
 * Der BMS-UNABHÄNGIGE BATTERIE-ANSCHLUSS im Portal - die REGELN der Fläche
 * (Konzept `vp-deye-diybms-luecke-l5` §3.2b, Bauplan-Paket P5d).
 *
 * Die Fläche stellt vier Fragen: **Wie ist die Batterie erreichbar?** → **Was
 * kommt wo an?** (Feld-Zuordnung mit Live-Vorschau) → **Wie entsteht der
 * Ladestand?** (Methode, Vorlage, Kurven-Editor) → **Prüfen & anlegen**. Diese
 * Datei beantwortet sie ohne DOM; `components/BatterieAssistent.tsx` zeichnet
 * sie nur.
 *
 * ⚠ **Jede Prüfung hier ist ein ZWILLING einer Server-Regel**
 * (`UserDefinedBatteryDefinition`), nie eine zweite Wahrheit: sie existiert,
 * damit der Kunde seinen Tippfehler SIEHT statt ihn abzuschicken. Der Server
 * prüft unverändert selbst und hat das letzte Wort - was er ablehnt, wird hier
 * nie durchgewunken, und was hier durchkommt, ist nie eine Erlaubnis.
 */

import { HOST_NOT_PRIVATE, isPrivateHost } from './selbstbau';

// -- Anschlussart (Schritt 1) -------------------------------------------------

export type AnschlussartId = 'mqtt' | 'http' | 'modbus';

export type Anschlussart = {
  id: AnschlussartId;
  label: string;
  hint: string;
  /** false = sichtbar, aber (noch) nicht begehbar. */
  verfuegbar: boolean;
  /** Der ehrliche Satz an einer nicht begehbaren Art. */
  bald?: string;
};

/**
 * Die Anschlussarten der Ebene 1.
 *
 * ⚠ Seit P5-HTTP sind ZWEI davon begehbar - „ich habe ein BMS mit
 * Web-Oberfläche" war die zweithäufigste Ausgangslage und ist es jetzt nicht
 * mehr. Modbus bleibt SICHTBAR und gesperrt, und das ist keine Ankündigung,
 * sondern ein WEGWEISER: dafür gibt es die Selbstbau-Tür längst. Eine Liste,
 * die einen Fall gar nicht nennt, ließe den Kunden raten, ob VoltPilot ihn
 * grundsätzlich nicht kann oder nur woanders.
 */
export const ANSCHLUSSARTEN: Anschlussart[] = [
  {
    id: 'mqtt',
    label: 'MQTT-Broker in Ihrem Netzwerk',
    hint:
      'Ihr BMS (DIYBMS, Seplos, JK, ein ESP am Shunt …) veröffentlicht seine Werte auf einem '
      + 'lokalen Broker. VoltPilot hört zu und ordnet die Felder zu.',
    verfuegbar: true,
  },
  {
    id: 'http',
    label: 'Web-Schnittstelle des BMS (HTTP/JSON)',
    hint:
      'Ihr BMS hat eine Web-Auskunft im Heimnetz (beim DIYBMS v4 zum Beispiel /ha). VoltPilot '
      + 'ruft sie im Takt ab und ordnet die Felder zu.',
    verfuegbar: true,
  },
  {
    id: 'modbus',
    label: 'Modbus TCP',
    hint: 'Ein BMS mit Modbus-Register-Tabelle.',
    verfuegbar: false,
    bald:
      'Dafür gibt es bereits den Weg „Eigenbau (Modbus)": dort beschreiben Sie die Register '
      + 'direkt und lesen sie sofort.',
  },
];

// -- Das Ziel-Vokabular (der Typkatalog, wörtlich) ----------------------------

export type ZielKanal = {
  channel: string;
  label: string;
  unit: string;
  /** Womit dieser Kanal normalerweise gefüllt wird. */
  valueType: 'number' | 'bool';
  hint: string;
};

/**
 * Die GESCHLOSSENE Ziel-Abbildung: worauf eine selbstgebaute Batterie ihre
 * Felder abbilden darf - wörtlich das `default_measure` des Typkatalogs
 * (`entitytypes/catalog.json`, Typ `user-defined-battery`).
 *
 * ⚠ `soc_source_code` fehlt mit Absicht: das ist der EINZIGE Kanal, den
 * niemand zuordnet. Er entsteht in der Ebene 2 zusammen mit dem abgeleiteten
 * Ladestand und trägt dessen HERKUNFT (siehe `socHerkunft.ts`).
 */
export const ZIEL_KANAELE: ZielKanal[] = [
  {
    channel: 'soc_pct',
    label: 'Ladestand',
    unit: '%',
    valueType: 'number',
    hint: 'Der GEMESSENE Ladestand, wenn Ihr BMS einen kennt (Shunt / Strommonitor).',
  },
  {
    channel: 'voltage_v',
    label: 'Packspannung',
    unit: 'V',
    valueType: 'number',
    hint: 'Die Gesamtspannung des Packs.',
  },
  {
    channel: 'current_a',
    label: 'Strom',
    unit: 'A',
    valueType: 'number',
    hint: 'Positiv beim Laden, negativ beim Entladen.',
  },
  {
    channel: 'power_kw',
    label: 'Leistung',
    unit: 'kW',
    valueType: 'number',
    hint: 'Positiv beim Laden, negativ beim Entladen.',
  },
  {
    channel: 'cell_min_mv',
    label: 'Niedrigste Zellspannung',
    unit: 'mV',
    valueType: 'number',
    hint: 'Über viele Zell-Topics mit dem Aggregat „Kleinster Wert" - der DIYBMS-Fall.',
  },
  {
    channel: 'cell_max_mv',
    label: 'Höchste Zellspannung',
    unit: 'mV',
    valueType: 'number',
    hint: 'Über dieselben Zell-Topics mit dem Aggregat „Größter Wert".',
  },
  {
    channel: 'temp_max_c',
    label: 'Höchste Zelltemperatur',
    unit: '°C',
    valueType: 'number',
    hint: 'Die wärmste gemessene Stelle des Packs.',
  },
  {
    channel: 'charge_allowed',
    label: 'Laden erlaubt',
    unit: '',
    valueType: 'bool',
    hint: 'Die Freigabe des BMS. Über mehrere Bänke mit „Kleinster Wert" (alle müssen ja sagen).',
  },
  {
    channel: 'discharge_allowed',
    label: 'Entladen erlaubt',
    unit: '',
    valueType: 'bool',
    hint: 'Dieselbe Regel wie beim Laden.',
  },
  {
    channel: 'charge_limit_a',
    label: 'Ladestrom-Grenze',
    unit: 'A',
    valueType: 'number',
    hint: 'Der höchste Ladestrom, den das BMS gerade zulässt.',
  },
  {
    channel: 'discharge_limit_a',
    label: 'Entladestrom-Grenze',
    unit: 'A',
    valueType: 'number',
    hint: 'Der höchste Entladestrom, den das BMS gerade zulässt.',
  },
];

export function zielKanal(channel: string): ZielKanal | null {
  return ZIEL_KANAELE.find((k) => k.channel === channel) ?? null;
}

export const AGGREGATE = [
  { value: 'last', label: 'Letzter Wert' },
  { value: 'min', label: 'Kleinster Wert' },
  { value: 'max', label: 'Größter Wert' },
  { value: 'avg', label: 'Mittelwert' },
  { value: 'sum', label: 'Summe' },
  { value: 'count', label: 'Anzahl' },
] as const;

/**
 * Die Aggregate, die einen JA/NEIN-Wert zusammenfassen dürfen - der Zwilling
 * von `UserDefinedBatteryDefinition.BOOL_AGGREGATES`.
 *
 * `min` ist das konservative UND („jede Bank erlaubt es"), `max` das ODER,
 * `last` die einzelne Quelle. Summe/Mittel/Anzahl fehlen mit Absicht: die
 * SUMME von Freigaben ist keine Freigabe, und ein Mittel von 0,5 wäre eine
 * Zahl, die kein Gerät je gemeldet hat.
 */
export const BOOL_AGGREGATE = ['last', 'min', 'max'];

export const WERT_TYPEN = [
  { value: 'number', label: 'Zahl' },
  { value: 'bool', label: 'Ja / Nein' },
] as const;

export const MAX_ZUORDNUNGEN = 16;
export const MIN_STALE_S = 5;
export const MAX_STALE_S = 86400;
export const DEFAULT_STALE_S = 300;
export const MIN_INTERVAL_S = 5;
export const MAX_INTERVAL_S = 3600;
export const DEFAULT_INTERVAL_S = 15;
export const DEFAULT_PORT = 1883;

export const MIN_KURVEN_PUNKTE = 2;
export const MAX_KURVEN_PUNKTE = 64;
export const MIN_ZELL_V = 0.5;
export const MAX_ZELL_V = 5;
export const MIN_HOLD_S = 60;
export const MAX_HOLD_S = 86400;
export const DEFAULT_HOLD_S = 900;
export const DEFAULT_ROUND_PCT = 0.1;

/** Die Standard-Wahrheitswörter - was ein BMS üblicherweise als „ja"/„nein" sendet. */
export const TRUE_VALUES = ['true', '1', 'on', 'yes'];
export const FALSE_VALUES = ['false', '0', 'off', 'no'];

// -- Formulare ----------------------------------------------------------------

export type BrokerForm = {
  host: string;
  port: string;
  publishIntervalS: string;
};

export function neuerBroker(): BrokerForm {
  return { host: '', port: String(DEFAULT_PORT), publishIntervalS: String(DEFAULT_INTERVAL_S) };
}

/** EINE Zeile der Feld-Zuordnung, wie sie im Formular steht (alles Text). */
export type ZuordnungZeile = {
  key: string;
  channel: string;
  topic: string;
  path: string;
  aggregate: string;
  valueType: string;
  scale: string;
  offset: string;
  sentinel: string;
  staleS: string;
  trueValues: string;
  falseValues: string;
};

let laufend = 0;

export function neueZuordnung(channel = ''): ZuordnungZeile {
  const ziel = zielKanal(channel);
  laufend += 1;
  return {
    key: `zu-${laufend}`,
    channel,
    topic: '',
    path: '',
    aggregate: ziel?.valueType === 'bool' ? 'min' : 'last',
    valueType: ziel?.valueType ?? 'number',
    scale: '1',
    offset: '0',
    sentinel: '',
    staleS: String(DEFAULT_STALE_S),
    trueValues: '',
    falseValues: '',
  };
}

/**
 * Der VORSCHLAG beim Wechsel des Ziel-Kanals: Wert-Art und Aggregat folgen dem
 * Kanal, solange der Kunde sie nicht selbst angefasst hat.
 *
 * ⚠ Er überschreibt eine bereits eingetippte Skalierung NICHT - der einzige
 * Grund, warum jemand `cell_min_mv` mit Faktor 1000 füllt, ist, dass sein BMS
 * Volt sendet, und diese Kenntnis darf ihm keine Auswahl wieder wegnehmen.
 */
export function kanalGewaehlt(z: ZuordnungZeile, channel: string): ZuordnungZeile {
  const ziel = zielKanal(channel);
  if (!ziel) return { ...z, channel };
  const bleibt = BOOL_AGGREGATE.includes(z.aggregate);
  return {
    ...z,
    channel,
    valueType: ziel.valueType,
    aggregate: ziel.valueType === 'bool' && !bleibt ? 'min' : z.aggregate,
  };
}

function zahl(raw: string): number | null {
  const t = raw.trim();
  if (t === '') return null;
  // Ein deutsches Komma ist die Normal-Eingabe (dieselbe Regel wie im
  // Modbus-Baukasten): ohne diese Zeile würde aus „0,1" ein NaN.
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function liste(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * Ein MQTT-Topic-Filter: `+` steht für GENAU eine Ebene, `#` nur als letzte.
 * Der Zwilling von `UserDefinedBatteryDefinition.isValidTopicFilter`.
 */
export function istTopicFilter(filter: string): boolean {
  if (filter === '' || filter.length > 200) return false;
  if (/\s/.test(filter)) return false;
  const teile = filter.split('/');
  for (let i = 0; i < teile.length; i += 1) {
    const seg = teile[i];
    if (seg === '#') {
      if (i !== teile.length - 1) return false;
    } else if (seg.includes('#') || (seg.includes('+') && seg !== '+')) {
      return false;
    }
  }
  return true;
}

const PFAD_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
const VERBOTENE_SEGMENTE = ['__proto__', 'constructor', 'prototype'];

/**
 * Ein Wertepfad ist punkt-getrennt (`voltage`, `bms.soc`); leer heißt „die
 * Nutzlast IST der Wert". Der Zwilling von `isValidValuePath`.
 */
export function istWertePfad(path: string): boolean {
  if (path === '') return true;
  if (path.length > 200) return false;
  return path
    .split('.')
    .every((seg) => PFAD_SEGMENT.test(seg) && !VERBOTENE_SEGMENTE.includes(seg));
}

/**
 * Was an EINER Zuordnung fehlt - leer heißt: diese Zeile ist vollständig.
 *
 * ⚠ Der Transport entscheidet, WAS eine Zeile überhaupt braucht: MQTT einen
 * Topic-Filter samt Haltbarkeit, HTTP einen WERTEPFAD (der dort Pflicht ist -
 * eine HTTP-Antwort ist ein Dokument, kein nackter Wert) und keine
 * Haltbarkeit, denn eine Antwort ist EIN Zeitpunkt.
 */
export function zuordnungFehler(z: ZuordnungZeile, art: AnschlussartId = 'mqtt'): string[] {
  const out: string[] = [];
  const http = art === 'http';
  if (z.channel.trim() === '') {
    out.push('Bitte wählen Sie, welchen Messwert dieses Feld liefert.');
  } else if (!zielKanal(z.channel)) {
    out.push('Diesen Messwert kennen wir nicht.');
  }
  if (http) {
    if (z.path.trim() === '') {
      out.push(
        'Bitte tragen Sie ein, wo der Wert in der Antwort steht - zum Beispiel soc oder '
        + 'bms.soc; „*“ steht für jede Ebene.',
      );
    } else if (!istHttpWertePfad(z.path.trim())) {
      out.push('Dieser Wertepfad ist nicht gültig. Beispiele: soc, bms.soc, cells.*.v.');
    }
  } else {
    if (z.topic.trim() === '') out.push('Bitte tragen Sie das Topic ein, auf dem der Wert kommt.');
    else if (!istTopicFilter(z.topic.trim())) {
      out.push(
        'Dieses Topic ist kein gültiger Filter. „+" steht für genau eine Ebene, „#" nur ganz am Ende.',
      );
    }
    if (!istWertePfad(z.path.trim())) {
      out.push('Der Wertepfad darf nur Punkte, Buchstaben, Ziffern, „_" und „-" enthalten.');
    }
  }
  if (!AGGREGATE.some((a) => a.value === z.aggregate)) {
    out.push('Diese Zusammenfassung kennen wir nicht.');
  }
  if (z.valueType === 'bool' && !BOOL_AGGREGATE.includes(z.aggregate)) {
    // Der Grund steht im Satz, nicht nur die Ablehnung: die SUMME von
    // Freigaben ist keine Freigabe.
    out.push(
      'Ein Ja/Nein-Wert lässt sich nur mit „Letzter Wert", „Kleinster Wert" (alle müssen ja '
      + 'sagen) oder „Größter Wert" zusammenfassen.',
    );
  }
  if (z.valueType === 'number') {
    const scale = zahl(z.scale);
    if (scale === null || scale === 0) out.push('Die Skalierung muss eine Zahl ungleich 0 sein.');
    if (zahl(z.offset) === null) out.push('Der Offset muss eine Zahl sein.');
    if (z.sentinel.trim() !== '' && zahl(z.sentinel) === null) {
      out.push('Der Wert für „nicht gemessen" muss eine Zahl sein.');
    }
  }
  if (!http) {
    const stale = zahl(z.staleS);
    if (stale === null || !Number.isInteger(stale) || stale < MIN_STALE_S || stale > MAX_STALE_S) {
      out.push(`Die Haltbarkeit muss zwischen ${MIN_STALE_S} und ${MAX_STALE_S} Sekunden liegen.`);
    }
  }
  return out;
}

/** Ob die Zuordnungs-Liste als GANZES tragfähig ist. */
export function zuordnungenFehler(zeilen: ZuordnungZeile[]): string[] {
  const out: string[] = [];
  if (zeilen.length === 0) {
    out.push(
      'Bitte ordnen Sie mindestens ein Feld zu - ohne Zuordnung liest VoltPilot von dieser '
      + 'Batterie nichts.',
    );
  }
  if (zeilen.length > MAX_ZUORDNUNGEN) {
    out.push(`Höchstens ${MAX_ZUORDNUNGEN} Zuordnungen je Batterie.`);
  }
  const gesehen = new Set<string>();
  for (const z of zeilen) {
    const c = z.channel.trim();
    if (c === '') continue;
    if (gesehen.has(c)) {
      out.push(
        `„${zielKanal(c)?.label ?? c}" ist zweimal zugeordnet - jeder Messwert hat genau eine Quelle.`,
      );
      break;
    }
    gesehen.add(c);
  }
  return out;
}

/** Was am BROKER fehlt (Schritt 1). */
export function brokerFehler(b: BrokerForm): string[] {
  const out: string[] = [];
  if (b.host.trim() === '') out.push('Bitte tragen Sie die Adresse Ihres MQTT-Brokers ein.');
  else if (!isPrivateHost(b.host)) out.push(HOST_NOT_PRIVATE);
  const port = zahl(b.port);
  if (port === null || !Number.isInteger(port) || port < 1 || port > 65535) {
    out.push('Der Port muss zwischen 1 und 65535 liegen.');
  }
  const iv = zahl(b.publishIntervalS);
  if (iv === null || !Number.isInteger(iv) || iv < MIN_INTERVAL_S || iv > MAX_INTERVAL_S) {
    out.push(
      `Der Sende-Abstand muss zwischen ${MIN_INTERVAL_S} und ${MAX_INTERVAL_S} Sekunden liegen.`,
    );
  }
  return out;
}

// -- Der HTTP-Anschluss (Schritt 1, zweite Anschlussart) ----------------------

export const DEFAULT_HTTP_PORT = 80;
export const DEFAULT_HTTPS_PORT = 443;
export const DEFAULT_TIMEOUT_MS = 5000;
export const MIN_TIMEOUT_MS = 500;
export const MAX_TIMEOUT_MS = 30000;

export type AnmeldeArt = 'none' | 'header' | 'bearer' | 'basic';

export type AnmeldeArtOption = {
  id: AnmeldeArt;
  label: string;
  hint: string;
};

/**
 * Die Anmelde-Arten - der Zwilling von `UserDefinedBatteryDefinition.AUTH_MODES`.
 *
 * ⚠ Die Reihenfolge ist die HÄUFIGKEIT im Heimnetz: die meisten BMS verlangen
 * gar nichts, und wer eine Anmeldung hat, hat fast immer einen Kopfzeilen-
 * Schlüssel (beim DIYBMS heißt er `ApiKey`).
 */
export const ANMELDE_ARTEN: AnmeldeArtOption[] = [
  {
    id: 'none',
    label: 'Keine',
    hint: 'Die Auskunft ist im Heimnetz frei abrufbar - der häufigste Fall.',
  },
  {
    id: 'header',
    label: 'Schlüssel in einer Kopfzeile',
    hint: 'Ihr BMS erwartet den Schlüssel in einer eigenen Kopfzeile - beim DIYBMS „ApiKey“.',
  },
  {
    id: 'bearer',
    label: 'Bearer-Token',
    hint: 'Der Schlüssel reist als „Authorization: Bearer …“.',
  },
  {
    id: 'basic',
    label: 'Benutzername und Kennwort',
    hint: 'Das klassische HTTP-Basic.',
  },
];

/** Die feste Maske, hinter der ein gespeichertes Geheimnis steht (Server-Zwilling). */
export const GEHEIMNIS_MASKE = '••••••••';

export type EndpunktForm = {
  host: string;
  port: string;
  path: string;
  tls: boolean;
  timeoutMs: string;
  publishIntervalS: string;
};

export function neuerEndpunkt(): EndpunktForm {
  return {
    host: '',
    port: String(DEFAULT_HTTP_PORT),
    path: '',
    tls: false,
    timeoutMs: String(DEFAULT_TIMEOUT_MS),
    publishIntervalS: String(DEFAULT_INTERVAL_S),
  };
}

export type AnmeldungForm = {
  art: AnmeldeArt;
  header: string;
  username: string;
  /**
   * Das Geheimnis. Leer heißt beim BEARBEITEN „unverändert" - der Server setzt
   * dann den gespeicherten Wert wieder ein. Er kommt nie in den Browser
   * zurück; das Formular zeigt an seiner Stelle {@link GEHEIMNIS_MASKE}.
   */
  secret: string;
};

export function neueAnmeldung(): AnmeldungForm {
  return { art: 'none', header: '', username: '', secret: '' };
}

/**
 * Ein URL-Pfad ist ein Pfad, keine zweite Adresse - der Zwilling von
 * `UserDefinedBatteryDefinition.isValidUrlPath`.
 *
 * Ein Pfad, der mit `//` beginnt, wäre eine protokoll-relative URL: ein
 * anderes Ziel als das geprüfte, und damit ein Weg an der Heimnetz-Regel
 * vorbei.
 */
export function istUrlPfad(path: string): boolean {
  if (path === '' || path.length > 200) return false;
  if (!path.startsWith('/') || path.startsWith('//')) return false;
  const VERBOTEN = ['<', '>', '"', "'", '`', '\\'];
  return ![...path].some((c) => /\s/.test(c) || c < ' ' || VERBOTEN.includes(c));
}

const HTTP_PFAD_SEGMENT = /^(\*|[A-Za-z0-9_][A-Za-z0-9_-]{0,63})$/;

/**
 * Ein WERTEPFAD des HTTP-Lesetyps: punkt-getrennt, mit `*` als GANZEM Segment -
 * der Zwilling von `UserDefinedBatteryDefinition.isValidHttpValuePath`.
 *
 * ⚠ Er darf - anders als beim MQTT-Lesetyp - nicht leer sein. Bei MQTT heißt
 * ein leerer Pfad „die Nachricht IST der Wert"; eine HTTP-Antwort ist dagegen
 * ein Dokument, und ein leerer Pfad wäre die Aufforderung, es als Zahl zu
 * lesen.
 *
 * Der Platzhalter ist das Gegenstück zum Topic-Filter: `cells.*.v` trifft jede
 * Zelle einer Liste, so wie `emon/diybms/+/+` jedes Zell-Topic trifft - und
 * erst dadurch bekommt „Kleinster Wert" hier überhaupt eine Bedeutung.
 */
export function istHttpWertePfad(path: string): boolean {
  if (path === '' || path.length > 200) return false;
  return path
    .split('.')
    .every((seg) => HTTP_PFAD_SEGMENT.test(seg) && !VERBOTENE_SEGMENTE.includes(seg));
}

/** Ein Kopfzeilen-Name ist ein RFC-7230-Token - alles andere schmuggelte eine zweite ein. */
export function istKopfzeilenName(name: string): boolean {
  return /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(name);
}

/** Was am ENDPUNKT fehlt (Schritt 1 der HTTP-Anschlussart). */
export function endpunktFehler(e: EndpunktForm): string[] {
  const out: string[] = [];
  if (e.host.trim() === '') {
    out.push('Bitte tragen Sie die Adresse ein, unter der die Web-Auskunft erreichbar ist.');
  } else if (!isPrivateHost(e.host)) {
    out.push(HOST_NOT_PRIVATE);
  }
  const port = zahl(e.port);
  if (port === null || !Number.isInteger(port) || port < 1 || port > 65535) {
    out.push('Der Port muss zwischen 1 und 65535 liegen.');
  }
  if (e.path.trim() === '') {
    out.push('Bitte tragen Sie den Pfad der JSON-Auskunft ein, zum Beispiel /ha.');
  } else if (!istUrlPfad(e.path.trim())) {
    out.push(
      'Dieser Pfad ist nicht gültig. Er beginnt mit „/“ und enthält keine Leerzeichen - '
      + 'zum Beispiel /ha oder /api/status?filter=soc.',
    );
  }
  const timeout = zahl(e.timeoutMs);
  if (
    timeout === null
    || !Number.isInteger(timeout)
    || timeout < MIN_TIMEOUT_MS
    || timeout > MAX_TIMEOUT_MS
  ) {
    out.push(
      `Die Zeitgrenze muss zwischen ${MIN_TIMEOUT_MS} und ${MAX_TIMEOUT_MS} Millisekunden liegen.`,
    );
  }
  const iv = zahl(e.publishIntervalS);
  if (iv === null || !Number.isInteger(iv) || iv < MIN_INTERVAL_S || iv > MAX_INTERVAL_S) {
    out.push(
      `Der Abruf-Abstand muss zwischen ${MIN_INTERVAL_S} und ${MAX_INTERVAL_S} Sekunden liegen.`,
    );
  }
  return out;
}

/**
 * Was an der ANMELDUNG fehlt.
 *
 * @param bestehtSchon ob ein Geheimnis bereits gespeichert ist (Bearbeiten).
 *     Dann ist ein leeres Feld „unverändert" und kein Mangel - der Server setzt
 *     den gespeicherten Wert wieder ein, und ein Zwang, ihn neu zu tippen, wäre
 *     nur eine Einladung, ihn falsch zu tippen.
 */
export function anmeldungFehler(a: AnmeldungForm, bestehtSchon = false): string[] {
  if (a.art === 'none') return [];
  const out: string[] = [];
  if (a.art === 'header' && a.header.trim() === '') {
    out.push('Bitte tragen Sie den Namen der Kopfzeile ein - beim DIYBMS zum Beispiel „ApiKey“.');
  } else if (a.art === 'header' && !istKopfzeilenName(a.header.trim())) {
    out.push('Dieser Name ist für eine Kopfzeile nicht gültig.');
  }
  if (a.art === 'basic' && a.username.trim() === '') {
    out.push('Bitte tragen Sie den Benutzernamen ein, mit dem sich VoltPilot anmelden soll.');
  }
  if (a.secret.trim() === '' && !bestehtSchon) {
    out.push(
      'Für diese Art der Anmeldung fehlt der Schlüssel bzw. das Kennwort - ohne ihn würde '
      + 'VoltPilot von dieser Batterie nichts lesen.',
    );
  }
  return out;
}

/** Eine fertige HTTP-Vorlage: Endpunkt, Anmeldung und Feld-Zuordnung in einem. */
export type HttpVorlage = {
  id: string;
  label: string;
  hint: string;
  path: string;
  authArt: AnmeldeArt;
  header?: string;
  mappings: {
    channel: string;
    path: string;
    scale?: number;
    aggregate?: string;
    valueType?: 'number' | 'bool';
    sentinel?: number;
  }[];
};

/**
 * Die Vorlage, an der dieses Paket gebaut wurde: DIYBMS v4 beantwortet
 * `GET /ha` mit dem Kopfzeilen-Schlüssel `ApiKey` und einem FLACHEN Dokument.
 *
 * ⚠ Sie ist ein VORSCHLAG, kein Vertrag: eine andere Firmware kann andere
 * Feldnamen haben - deshalb steht die Live-Vorschau daneben, und deshalb nimmt
 * die Vorlage niemandem eine schon getippte Zuordnung weg.
 */
export const HTTP_VORLAGEN: HttpVorlage[] = [
  {
    id: 'diybms-v4-ha',
    label: 'DIYBMS v4 – /ha',
    hint:
      'Die Home-Assistant-Auskunft des DIYBMS-Controllers: ein flaches JSON mit Ladestand, '
      + 'Pack-Spannung, Strom, Leistung und den beiden Zellspannungs-Grenzen.',
    path: '/ha',
    authArt: 'header',
    header: 'ApiKey',
    mappings: [
      { channel: 'soc_pct', path: 'soc' },
      { channel: 'voltage_v', path: 'v' },
      { channel: 'current_a', path: 'c' },
      { channel: 'power_kw', path: 'pwr', scale: 0.001 },
      { channel: 'cell_min_mv', path: 'lowcellv' },
      { channel: 'cell_max_mv', path: 'highcellv' },
      { channel: 'charge_allowed', path: 'chargeallowed', valueType: 'bool' },
      { channel: 'discharge_allowed', path: 'dischargeallowed', valueType: 'bool' },
    ],
  },
];

export function httpVorlage(id: string): HttpVorlage | null {
  return HTTP_VORLAGEN.find((v) => v.id === id) ?? null;
}

/**
 * Eine Vorlage ANWENDEN: Endpunkt, Anmelde-Art und die Zuordnungs-Zeilen.
 *
 * ⚠ Sie ersetzt eine bereits eingetippte Zuordnung NICHT: wer schon Zeilen
 * gebaut hat, hat einen Grund dafür, und eine Vorlage, die ihm die wegnimmt,
 * wäre ein Datenverlust mit freundlicher Absicht.
 */
export function vorlageAnwenden(
  v: HttpVorlage,
  endpunkt: EndpunktForm,
  anmeldung: AnmeldungForm,
  zeilen: ZuordnungZeile[],
): { endpunkt: EndpunktForm; anmeldung: AnmeldungForm; zeilen: ZuordnungZeile[] } {
  const getippt = zeilen.filter((z) => z.channel.trim() !== '' && z.path.trim() !== '');
  return {
    endpunkt: { ...endpunkt, path: endpunkt.path.trim() === '' ? v.path : endpunkt.path },
    anmeldung: {
      ...anmeldung,
      art: anmeldung.art === 'none' ? v.authArt : anmeldung.art,
      header: anmeldung.header.trim() === '' ? (v.header ?? '') : anmeldung.header,
    },
    zeilen:
      getippt.length > 0
        ? zeilen
        : v.mappings.map((m) => ({
          ...neueZuordnung(m.channel),
          path: m.path,
          scale: feldZahl(m.scale ?? 1),
          aggregate: m.aggregate ?? (m.valueType === 'bool' ? 'min' : 'last'),
          valueType: m.valueType ?? 'number',
          sentinel: m.sentinel === undefined ? '' : feldZahl(m.sentinel),
        })),
  };
}

// -- Der Ladestand (Ebene 2) --------------------------------------------------

export type SocMethode = 'direct' | 'ocv_curve' | 'coulomb';

export type SocMethodeOption = {
  id: SocMethode;
  label: string;
  hint: string;
};

/**
 * Die drei Methoden aus §3.2b - alle drei sind auf der Box gebaut (P5b).
 *
 * ⚠ Die Reihenfolge ist die EMPFEHLUNG: ein gemessener Ladestand schlägt jede
 * Rechnung. Sie ist zugleich die Laufzeit-Vorrangregel der Box (eine frische
 * Messung gewinnt), nicht nur eine Sortierung der Liste.
 */
export const SOC_METHODEN: SocMethodeOption[] = [
  {
    id: 'direct',
    label: 'Gemessen übernehmen',
    hint:
      'Ihr BMS kennt den Ladestand selbst (Shunt / Strommonitor). Die ehrlichste Quelle - '
      + 'VoltPilot rechnet nichts nach.',
  },
  {
    id: 'ocv_curve',
    label: 'Aus der Spannungskennlinie',
    hint:
      'Aus der niedrigsten und der höchsten Zellspannung, über die Kennlinie Ihrer Zelle. '
      + 'Das konservative Minimum gewinnt - genau das Verfahren, das Sie heute in Home '
      + 'Assistant sehen.',
  },
  {
    id: 'coulomb',
    label: 'Aus der Ladungszählung',
    hint:
      'VoltPilot zählt ab einem Startpunkt Leistung bzw. Strom mit. Braucht einen Anker und '
      + 'läuft ohne Nachkalibrierung mit der Zeit auseinander.',
  },
];

/** EIN Stützpunkt des Kurven-Editors, wie er im Formular steht (Text). */
export type KurvenPunkt = { key: string; v: string; soc: string };

let kurvenLaufend = 0;

export function neuerPunkt(v = '', soc = ''): KurvenPunkt {
  kurvenLaufend += 1;
  return { key: `kp-${kurvenLaufend}`, v, soc };
}

export type SocForm = {
  methode: SocMethode;
  /** Die Kurven-Vorlage, aus der die Punkte kamen; '' = eigene Punkte. */
  template: string;
  preferDirect: boolean;
  holdS: string;
  kurveLaden: KurvenPunkt[];
  kurveEntladen: KurvenPunkt[];
  cellsInSeries: string;
  conservativeMin: boolean;
  roundPct: string;
  capacityKwh: string;
  efficiencyPct: string;
  nominalVoltageV: string;
  refTempC: string;
  anchorSocPct: string;
  anchorAt: string;
};

export function neueSoc(): SocForm {
  return {
    methode: 'direct',
    template: '',
    preferDirect: true,
    holdS: String(DEFAULT_HOLD_S),
    kurveLaden: [],
    kurveEntladen: [],
    cellsInSeries: '',
    conservativeMin: true,
    roundPct: String(DEFAULT_ROUND_PCT).replace('.', ','),
    capacityKwh: '',
    efficiencyPct: '',
    nominalVoltageV: '',
    refTempC: '',
    anchorSocPct: '',
    anchorAt: '',
  };
}

/** Eine Kurven-Vorlage, wie `GET /api/v1/soc-curve-templates` sie liefert. */
export type SocCurveTemplate = {
  id: string;
  label: string;
  description?: string | null;
  chemistry?: string | null;
  cellsInSeries?: number | null;
  refTempC?: number | null;
  cellMinV?: number | null;
  cellMaxV?: number | null;
  source?: string | null;
  curveCharge?: number[][] | null;
  curveDischarge?: number[][] | null;
};

/** Die CHEMIE als Wort - sie muss dastehen, damit niemand die falsche Kurve nimmt. */
export function chemieWort(chemistry: string | null | undefined): string | null {
  switch ((chemistry ?? '').toLowerCase()) {
    case 'nmc':
      return 'NMC / NCA';
    case 'nca':
      return 'NCA';
    case 'lfp':
    case 'lifepo4':
      return 'LiFePO₄';
    default:
      return chemistry ? chemistry.toUpperCase() : null;
  }
}

/**
 * Der Warnsatz zu einer Vorlage - die halbe Aussage einer Kennlinie.
 *
 * ⚠ Dieselbe Spannung bedeutet an einer LiFePO₄-Zelle einen völlig anderen
 * Ladestand als an einer NMC-Zelle. Eine Vorlagen-Liste ohne diesen Satz wäre
 * ein Angebot, sich mit Nachkommastellen zu irren.
 */
export function vorlageWarnung(t: SocCurveTemplate): string {
  const chemie = chemieWort(t.chemistry);
  const fenster =
    t.cellMinV != null && t.cellMaxV != null
      ? ` (Zellfenster ${fmt(t.cellMinV)}–${fmt(t.cellMaxV)} V)`
      : '';
  return chemie
    ? `Gemessen an einer ${chemie}-Zelle${fenster}. Passt Ihre Zellchemie nicht dazu, ist der `
      + 'errechnete Ladestand falsch - dann tragen Sie Ihre eigenen Stützpunkte ein.'
    : 'Prüfen Sie, ob diese Kennlinie zu Ihrer Zellchemie passt - sonst ist der errechnete '
      + 'Ladestand falsch.';
}

/** Eine Zahl für einen SATZ - mit Tausenderpunkt, wie der Kunde sie liest. */
function fmt(n: number): string {
  return n.toLocaleString('de-DE', { maximumFractionDigits: 3 });
}

/**
 * Eine Zahl für ein EINGABEFELD - Komma als Dezimalzeichen, aber OHNE
 * Tausenderpunkt.
 *
 * ⚠ Der Unterschied ist nicht kosmetisch: aus einer Skalierung 1000 würde mit
 * Gruppierung „1.000", und beim Zurücklesen daraus die Zahl 1. Eine Batterie,
 * die man nur ANSIEHT, hätte danach den Faktor 1000 verloren - stillschweigend
 * und mit plausibel aussehenden Werten.
 */
function feldZahl(n: number): string {
  return n.toLocaleString('de-DE', { maximumFractionDigits: 6, useGrouping: false });
}

/** Eine Vorlage in die Formular-Felder - sie FÜLLT VOR, mehr nicht. */
export function ausVorlage(t: SocCurveTemplate): Partial<SocForm> {
  return {
    template: t.id,
    kurveLaden: (t.curveCharge ?? []).map(([v, soc]) => neuerPunkt(feldZahl(v), feldZahl(soc))),
    kurveEntladen: (t.curveDischarge ?? []).map(([v, soc]) =>
      neuerPunkt(feldZahl(v), feldZahl(soc)),
    ),
    cellsInSeries: t.cellsInSeries != null ? String(t.cellsInSeries) : '',
    refTempC: t.refTempC != null ? feldZahl(t.refTempC) : '',
  };
}

/**
 * Was an einer KENNLINIE nicht stimmt - der Zwilling von `checkCurve`.
 *
 * ⚠ Die Monotonie ist keine Formalie: eine Kurve, die bei STEIGENDER Spannung
 * fällt, beschreibt keine Lithium-Zelle. Sie ist ein Tippfehler, der
 * stillschweigend einen falschen Ladestand ausgerechnet hätte.
 */
export function kurveFehler(punkte: KurvenPunkt[], was: string): string[] {
  if (punkte.length === 0) return [];
  const out: string[] = [];
  if (punkte.length < MIN_KURVEN_PUNKTE || punkte.length > MAX_KURVEN_PUNKTE) {
    out.push(`${was}: es braucht ${MIN_KURVEN_PUNKTE} bis ${MAX_KURVEN_PUNKTE} Stützpunkte.`);
    return out;
  }
  const paare: number[][] = [];
  for (const p of punkte) {
    const v = zahl(p.v);
    const soc = zahl(p.soc);
    if (v === null || soc === null) {
      out.push(`${was}: ein Stützpunkt braucht Spannung UND Ladestand.`);
      return out;
    }
    if (v < MIN_ZELL_V || v > MAX_ZELL_V) {
      out.push(`${was}: die Zellspannung muss zwischen ${MIN_ZELL_V} und ${MAX_ZELL_V} V liegen.`);
      return out;
    }
    if (soc < 0 || soc > 100) {
      out.push(`${was}: der Ladestand muss zwischen 0 und 100 % liegen.`);
      return out;
    }
    paare.push([v, soc]);
  }
  paare.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < paare.length; i += 1) {
    if (paare[i][0] === paare[i - 1][0]) {
      out.push(`${was}: die Zellspannung ${fmt(paare[i][0])} V steht zweimal in der Tabelle.`);
      return out;
    }
    if (paare[i][1] < paare[i - 1][1]) {
      out.push(
        `${was}: bei ${fmt(paare[i][0])} V steht ein KLEINERER Ladestand als bei der `
        + 'niedrigeren Spannung davor - eine Kennlinie steigt.',
      );
      return out;
    }
  }
  return out;
}

/**
 * Was der gewählten Methode fehlt - der Zwilling von `checkSoc`.
 *
 * Die Regel dahinter ist eine einzige: **kein Ladestand ohne Eingang.** Eine
 * Batterie ganz ohne SoC-Quelle ist ein legitimer Zustand (der Optimierer
 * plant sie dann nicht, P7) - eine Methode ohne ihre Eingaben ist es nicht.
 */
export function socFehler(soc: SocForm, zeilen: ZuordnungZeile[]): string[] {
  const out: string[] = [];
  const hat = (channel: string) => zeilen.some((z) => z.channel.trim() === channel);
  const hold = zahl(soc.holdS);
  if (hold === null || !Number.isInteger(hold) || hold < MIN_HOLD_S || hold > MAX_HOLD_S) {
    out.push(`Die Haltefrist muss zwischen ${MIN_HOLD_S} und ${MAX_HOLD_S} Sekunden liegen.`);
  }
  if (soc.methode === 'direct') {
    if (!hat('soc_pct')) {
      out.push(
        'Für einen übernommenen Ladestand muss „Ladestand" zugeordnet sein - ohne Eingang '
        + 'gibt es keinen Ladestand.',
      );
    }
    return out;
  }
  if (soc.methode === 'ocv_curve') {
    out.push(...kurveFehler(soc.kurveLaden, 'Ladekurve'));
    out.push(...kurveFehler(soc.kurveEntladen, 'Entladekurve'));
    if (soc.kurveLaden.length === 0) {
      out.push(
        'Für die Spannungskennlinie fehlt die Ladekurve. Wählen Sie eine Vorlage oder tragen '
        + 'Sie die Stützpunkte Ihrer Zelle ein.',
      );
    }
    const zellen = hat('cell_min_mv') || hat('cell_max_mv');
    const pack = hat('voltage_v') && zahl(soc.cellsInSeries) !== null;
    if (!zellen && !pack) {
      out.push(
        'Für die Spannungskennlinie braucht VoltPilot eine Zellspannung („Niedrigste" '
        + 'und/oder „Höchste Zellspannung") oder die Packspannung samt Zellzahl in Reihe.',
      );
    }
    return out;
  }
  // coulomb
  if (zahl(soc.capacityKwh) === null) {
    out.push('Für die Ladungszählung fehlt die nutzbare Kapazität in kWh.');
  }
  const leistung = hat('power_kw');
  const strom = hat('current_a') && (hat('voltage_v') || zahl(soc.nominalVoltageV) !== null);
  if (!leistung && !strom) {
    out.push(
      'Für die Ladungszählung braucht VoltPilot die Batterie-Leistung („Leistung") oder den '
      + 'Strom samt Spannung.',
    );
  }
  if (zahl(soc.anchorSocPct) === null && !hat('soc_pct')) {
    out.push(
      'Die Ladungszählung braucht einen Startwert: entweder einen Anker (Ladestand samt '
      + 'Zeitpunkt) oder einen zugeordneten gemessenen Ladestand, an dem sie sich ausrichtet.',
    );
  }
  const anker = zahl(soc.anchorSocPct);
  if (anker !== null && (anker < 0 || anker > 100)) {
    out.push('Der Anker-Ladestand muss zwischen 0 und 100 Prozent liegen.');
  }
  return out;
}

// -- Was an den Server geht ---------------------------------------------------

function mappingRumpf(z: ZuordnungZeile, art: AnschlussartId = 'mqtt'): Record<string, unknown> {
  const bool = z.valueType === 'bool';
  const body: Record<string, unknown> = {
    channel: z.channel.trim(),
    path: z.path.trim(),
    aggregate: z.aggregate,
    valueType: z.valueType,
  };
  // Topic und Haltbarkeit gehören dem MQTT-Lesetyp. Sie an einem
  // HTTP-Anschluss mitzuschicken hieße, ein Feld zu füllen, das dort nichts
  // bedeutet - und der Server lehnte es zu Recht ab.
  if (art !== 'http') {
    body.topic = z.topic.trim();
    body.staleS = zahl(z.staleS) ?? DEFAULT_STALE_S;
  }
  if (!bool) {
    body.scale = zahl(z.scale) ?? 1;
    body.offset = zahl(z.offset) ?? 0;
    const sentinel = zahl(z.sentinel);
    // Ein „nicht gemessen"-Rohwert reist NUR, wenn einer genannt wurde: eine
    // stillschweigende 0 wäre genau der Wert, den er ausschließen soll.
    if (sentinel !== null) body.sentinel = sentinel;
  }
  const t = liste(z.trueValues);
  const f = liste(z.falseValues);
  if (bool && t.length > 0) body.trueValues = t;
  if (bool && f.length > 0) body.falseValues = f;
  return body;
}

function kurveRumpf(punkte: KurvenPunkt[]): number[][] | null {
  if (punkte.length === 0) return null;
  const out: number[][] = [];
  for (const p of punkte) {
    const v = zahl(p.v);
    const soc = zahl(p.soc);
    if (v === null || soc === null) return null;
    out.push([v, soc]);
  }
  return out;
}

/**
 * Der Anker-Zeitpunkt als eindeutiger Augenblick.
 *
 * ⚠ Das Feld ist ein `datetime-local` und trägt damit KEINE Zeitzone. Es
 * unverändert weiterzureichen hieße, die Box raten zu lassen, welche Stunde
 * gemeint war - und ein um zwei Stunden verschobener Anker verschiebt jede
 * gezählte Kilowattstunde danach. Deshalb wird die Eingabe hier als ORTSZEIT
 * des Kunden gelesen und als Augenblick verschickt. Leer heißt „ab jetzt"
 * (das Feld ist optional) und reist gar nicht mit.
 */
function ankerZeitpunkt(raw: string): string | null {
  const t = raw.trim();
  if (t === '') return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Ein gespeicherter Augenblick zurück ins `datetime-local`-Feld (Ortszeit). */
function ankerFeld(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function socRumpf(soc: SocForm, zeilen: ZuordnungZeile[]): Record<string, unknown> | null {
  // Ohne jede SoC-Quelle wird KEIN Block geschickt - eine Ableitung ohne
  // Eingang wäre eine Behauptung, und der Server lehnte sie zu Recht ab.
  if (soc.methode === 'direct' && !zeilen.some((z) => z.channel.trim() === 'soc_pct')) {
    return null;
  }
  const params: Record<string, unknown> = { conservativeMin: soc.conservativeMin };
  const round = zahl(soc.roundPct);
  if (round !== null) params.roundPct = round;
  if (soc.methode === 'ocv_curve') {
    const laden = kurveRumpf(soc.kurveLaden);
    const entladen = kurveRumpf(soc.kurveEntladen);
    if (laden) params.curveCharge = laden;
    if (entladen) params.curveDischarge = entladen;
    const zellen = zahl(soc.cellsInSeries);
    if (zellen !== null) params.cellsInSeries = zellen;
  }
  if (soc.methode === 'coulomb') {
    const kwh = zahl(soc.capacityKwh);
    if (kwh !== null) params.capacityKwh = kwh;
    const eff = zahl(soc.efficiencyPct);
    if (eff !== null) params.efficiencyPct = eff;
    const nenn = zahl(soc.nominalVoltageV);
    if (nenn !== null) params.nominalVoltageV = nenn;
    const anker = zahl(soc.anchorSocPct);
    if (anker !== null) {
      const at = ankerZeitpunkt(soc.anchorAt);
      params.anchor = at === null ? { socPct: anker } : { socPct: anker, at };
    }
  }
  const ref = zahl(soc.refTempC);
  if (ref !== null) params.refTempC = ref;
  const body: Record<string, unknown> = {
    method: soc.methode,
    preferDirect: soc.preferDirect,
    holdS: zahl(soc.holdS) ?? DEFAULT_HOLD_S,
    params,
  };
  // Die Vorlagen-Kennung reist NUR bei der Kennlinie mit - sie beschreibt eine
  // Kurve, und an einer Ladungszählung wäre sie eine Herkunftsangabe für
  // etwas, das gar nicht benutzt wird.
  if (soc.methode === 'ocv_curve' && soc.template.trim() !== '') body.template = soc.template.trim();
  return body;
}

/**
 * Der Rumpf von `POST/PUT /components/battery` - für BEIDE Anschlussarten.
 *
 * ⚠ Es reist immer nur EINE Hälfte: der Broker ODER der Endpunkt. Beide
 * gleichzeitig wären eine Anbindung mit zwei Adressen, und welche die Box
 * benutzte, hinge daran, welche der Server zuerst liest.
 *
 * ⚠ Das GEHEIMNIS reist nur, wenn wirklich eines eingetippt wurde: ein leeres
 * Feld heißt „unverändert", und der Server setzt dann den gespeicherten Wert
 * wieder ein.
 */
export function speicherRumpf(
  name: string,
  broker: BrokerForm,
  zeilen: ZuordnungZeile[],
  soc: SocForm,
  bindung: BindungForm = neueBindung(),
  art: AnschlussartId = 'mqtt',
  endpunkt: EndpunktForm = neuerEndpunkt(),
  anmeldung: AnmeldungForm = neueAnmeldung(),
): Record<string, unknown> {
  const http = art === 'http';
  const body: Record<string, unknown> = {
    label: name.trim(),
    transport: http ? 'http_local' : 'mqtt_local',
    mappings: zeilen.map((z) => mappingRumpf(z, art)),
    publishIntervalS: http
      ? (zahl(endpunkt.publishIntervalS) ?? DEFAULT_INTERVAL_S)
      : (zahl(broker.publishIntervalS) ?? DEFAULT_INTERVAL_S),
  };
  if (http) {
    body.endpoint = {
      host: endpunkt.host.trim(),
      port: zahl(endpunkt.port) ?? (endpunkt.tls ? DEFAULT_HTTPS_PORT : DEFAULT_HTTP_PORT),
      path: endpunkt.path.trim(),
      tls: endpunkt.tls,
      timeoutMs: zahl(endpunkt.timeoutMs) ?? DEFAULT_TIMEOUT_MS,
    };
    body.auth = anmeldungRumpf(anmeldung);
  } else {
    body.broker = { host: broker.host.trim(), port: zahl(broker.port) ?? DEFAULT_PORT };
  }
  const derivation = socRumpf(soc, zeilen);
  if (derivation) body.socDerivation = derivation;
  // Die Bindung reist IMMER mit - auch als „unbound". Sie ist eine ANTWORT des
  // Kunden, und ein fehlender Block hiesse „nicht gefragt": eine einmal
  // gelöste Bindung liesse sich sonst nie wieder lösen.
  body.binding = bindung.modus === 'feeds_inverter'
    ? { mode: bindung.modus, inverterEntityId: bindung.inverterEntityId.trim() }
    : { mode: bindung.modus };
  return body;
}

/**
 * Der Rumpf der VORSCHAU - dieselbe Form wie beim Speichern, ohne den
 * Ladestands-Block: die Vorschau fragt, was ANKOMMT, nicht was daraus
 * gerechnet wird.
 */
export function vorschauRumpf(
  broker: BrokerForm,
  zeilen: ZuordnungZeile[],
  art: AnschlussartId = 'mqtt',
  endpunkt: EndpunktForm = neuerEndpunkt(),
  anmeldung: AnmeldungForm = neueAnmeldung(),
): Record<string, unknown> {
  const body = speicherRumpf('', broker, zeilen, neueSoc(), neueBindung(), art, endpunkt,
    anmeldung);
  // Die Vorschau fragt, was ANKOMMT - nicht, was daraus gerechnet oder wem es
  // zugeordnet wird. Label, Ladestand und Bindung gehören zum Speichern.
  delete body.label;
  delete body.socDerivation;
  delete body.binding;
  return body;
}

/**
 * Die Anmeldung als Anfrage-Block.
 *
 * ⚠ `secret` fehlt, wenn nichts eingetippt wurde. Das ist die halbe Regel des
 * Geheimnis-Wegs: ein leeres Feld heißt „unverändert", und ein mitgeschicktes
 * leeres Geheimnis hieße „lösch es".
 */
function anmeldungRumpf(a: AnmeldungForm): Record<string, unknown> {
  const body: Record<string, unknown> = { mode: a.art };
  if (a.art === 'header') body.header = a.header.trim();
  if (a.art === 'basic') body.username = a.username.trim();
  if (a.art !== 'none' && a.secret.trim() !== '') body.secret = a.secret;
  return body;
}

// -- Die SPEISER-BINDUNG (P6) -------------------------------------------------

/**
 * Wozu diese Batterie in der Anlage GEHÖRT - der Captain-Entscheid E6 (a) vom
 * 09.09.2026: eine AUSDRÜCKLICHE Bindung im Assistenten, nie eine
 * Namens-Heuristik.
 *
 * ⚠ Warum das eine eigene Frage ist und nicht aus den Daten folgt: der
 * Kanalname `soc_pct` sagt NICHT, wessen Ladestand er ist. Ein DIYBMS an einem
 * Hybrid-Wechselrichter, ein zweiter Speicher im Keller und ein Prüfaufbau auf
 * dem Tisch schicken denselben Kanal - und nur der Kunde weiß, welcher davon
 * der Speicher SEINER Anlage ist. Wer das rät, schreibt eine Zahl in die
 * Speicher-Kachel, für die niemand geradesteht.
 */
export type BindungModus = 'unbound' | 'feeds_inverter' | 'standalone';

export type BindungOption = {
  id: BindungModus;
  label: string;
  hint: string;
};

export const BINDUNGEN: BindungOption[] = [
  {
    id: 'unbound',
    label: 'Sie steht für sich',
    hint:
      'VoltPilot zeichnet ihre Messwerte auf, mehr nicht: sie speist weder die '
      + 'Speicher-Kachel noch die Energiebilanz. Das ist die Vorgabe.',
  },
  {
    id: 'feeds_inverter',
    label: 'Sie hängt an einem Wechselrichter',
    hint:
      'Ladestand, Grenzen und Freigaben des Speichers kommen dann von dieser Batterie. '
      + 'Die Batterieleistung bleibt beim Wechselrichter - dort wird sie gemessen.',
  },
  {
    id: 'standalone',
    label: 'Sie IST der Speicher',
    hint:
      'Es gibt keinen Hybrid-Wechselrichter, der sie misst. Dann liefert diese Batterie '
      + 'auch die Speicherleistung.',
  },
];

export type BindungForm = {
  modus: BindungModus;
  /** Der Wechselrichter, an dem sie hängt; '' = keiner gewählt. */
  inverterEntityId: string;
};

export function neueBindung(): BindungForm {
  return { modus: 'unbound', inverterEntityId: '' };
}

/**
 * Die Kanäle, die eine gebundene Batterie in den Speicher-Knoten einspeist -
 * der Zwilling von `UserDefinedBatteryDefinition.BOUND_CHANNELS`.
 *
 * ⚠ `power_kw` steht bewusst NICHT dabei: es ist der eine Kanal, über den sich
 * die beiden Fälle unterscheiden. Beim Speiser misst der Wechselrichter die
 * Batterieleistung ohnehin, und dieselben Kilowatt zweimal zu zählen wäre
 * schlicht falsch.
 */
export const BINDUNGS_KANAELE = [
  'soc_pct',
  'charge_limit_a',
  'discharge_limit_a',
  'charge_allowed',
  'discharge_allowed',
];

export const BINDUNGS_LEISTUNGS_KANAL = 'power_kw';

/**
 * Welche Kanäle diese Batterie WIRKLICH einspeisen würde - nur die, die sie
 * auch liefert. Eine Rolle für einen Kanal, den niemand meldet, verspräche
 * einen Messwert, den es nicht gibt.
 *
 * Der abgeleitete Ladestand zählt mit: rechnet eine Kennlinie ihn aus, dann
 * LIEFERT diese Batterie `soc_pct` - er steht nur nicht in der Zuordnung, weil
 * ihn niemand sendet.
 */
export function bindungsKanaele(
  bindung: BindungForm,
  zeilen: ZuordnungZeile[],
  soc: SocForm,
): string[] {
  if (bindung.modus === 'unbound') return [];
  const da = new Set(zeilen.map((z) => z.channel.trim()).filter((c) => c !== ''));
  if (soc.methode !== 'direct') da.add('soc_pct');
  const out = BINDUNGS_KANAELE.filter((c) => da.has(c));
  if (bindung.modus === 'standalone' && da.has(BINDUNGS_LEISTUNGS_KANAL)) {
    out.push(BINDUNGS_LEISTUNGS_KANAL);
  }
  return out;
}

/**
 * Was einer Bindung noch fehlt - der Zwilling von
 * `UserDefinedBatteryDefinition.checkBinding`.
 */
export function bindungFehler(
  bindung: BindungForm,
  zeilen: ZuordnungZeile[],
  soc: SocForm,
): string[] {
  if (bindung.modus === 'unbound') return [];
  const out: string[] = [];
  if (bindung.modus === 'feeds_inverter' && bindung.inverterEntityId.trim() === '') {
    out.push(
      'Bitte wählen Sie den Wechselrichter, an dem diese Batterie hängt - ohne ihn bleibt '
      + 'offen, wessen Ladestand sie liefert.',
    );
  }
  if (bindungsKanaele(bindung, zeilen, soc).length === 0) {
    out.push(
      'Diese Batterie kann den Speicher noch nicht speisen: dafür braucht sie einen '
      + 'Ladestand oder wenigstens eine Grenze bzw. Freigabe. Ordnen Sie einen dieser '
      + 'Messwerte zu - oder lassen Sie die Batterie für sich stehen.',
    );
  }
  return out;
}

/** Ein Wechselrichter, an den sich eine Batterie hängen lässt. */
export type SpeicherZiel = { id: string; label: string };

/**
 * Die WÄHLBAREN Wechselrichter aus der Komponenten-Liste einer Anlage: die
 * Speicher-Rolle, ohne die selbst angebundenen Batterien - eine Batterie an
 * eine Batterie zu hängen wäre keine Bindung, sondern eine Schleife.
 */
export function speicherZiele(
  rows: { id: string; role?: string | null; entityType?: string | null; label?: string | null }[]
    | null | undefined,
  ohneId?: string | null,
): SpeicherZiel[] {
  if (!rows) return [];
  return rows
    .filter((r) => r.role === 'storage'
      && r.entityType !== 'user-defined-battery'
      && r.id !== ohneId)
    .map((r) => ({ id: r.id, label: (r.label ?? '').trim() || 'Wechselrichter' }));
}

/**
 * Der Satz „Ladestand von: <Batterie>" - die EINE Formulierung, damit Cockpit
 * und Geräteseite sie nicht zweimal verschieden erfinden (P6).
 */
export function ladestandVon(label: string | null | undefined): string | null {
  const name = (label ?? '').trim();
  return name === '' ? null : `Ladestand von: ${name}`;
}

// -- Was vom Server zurückkommt (Bearbeiten) ----------------------------------

type Roh = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Ein gespeicherter Zahlenwert als FELD-Text (siehe {@link feldZahl}). */
function num(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? feldZahl(v) : '';
}

/**
 * Die GESPEICHERTE Anbindung zurück ins Formular (Bearbeiten).
 *
 * ⚠ Sie liest die Server-Form (`connection_json`, snake_case), nicht die
 * Anfrage-Form: was gespeichert wurde, ist die geprüfte und normalisierte
 * Fassung - das Formular mit der ROHEN Eingabe zu füllen hieße, dem Kunden
 * etwas anderes zu zeigen, als seine Box wirklich liest.
 */
export function ausConnection(
  connection: Record<string, unknown> | null | undefined,
): {
  art: AnschlussartId;
  broker: BrokerForm;
  endpunkt: EndpunktForm;
  anmeldung: AnmeldungForm;
  /** Ob der Server ein Geheimnis GESPEICHERT hat - er gibt nur die Maske zurück. */
  geheimnisBesteht: boolean;
  zeilen: ZuordnungZeile[];
  soc: SocForm;
  bindung: BindungForm;
} | null {
  if (!connection) return null;
  const art: AnschlussartId | null =
    connection.transport === 'mqtt_local'
      ? 'mqtt'
      : connection.transport === 'http_local'
        ? 'http'
        : null;
  if (!art) return null;
  const intervall =
    typeof connection.publish_interval_s === 'number'
      ? String(connection.publish_interval_s)
      : String(DEFAULT_INTERVAL_S);
  const b = (connection.broker ?? {}) as Roh;
  const broker: BrokerForm = {
    host: str(b.host),
    port: typeof b.port === 'number' ? String(b.port) : String(DEFAULT_PORT),
    publishIntervalS: intervall,
  };

  // Die HTTP-Hälfte. ⚠ Das Geheimnis kommt NIE zurück - der Server maskiert es
  // (`auth_secret` wird zu ••••••••). Das Formular merkt sich nur, DASS eines
  // besteht, und ein leeres Feld heißt dann „unverändert".
  const ep = (connection.endpoint ?? {}) as Roh;
  const auth = (connection.auth ?? {}) as Roh;
  const artWort = str(auth.mode);
  const endpunkt: EndpunktForm = {
    host: str(ep.host),
    port:
      typeof ep.port === 'number'
        ? String(ep.port)
        : String(ep.tls === true ? DEFAULT_HTTPS_PORT : DEFAULT_HTTP_PORT),
    path: str(ep.path),
    tls: ep.tls === true,
    timeoutMs:
      typeof connection.timeout_ms === 'number'
        ? String(connection.timeout_ms)
        : String(DEFAULT_TIMEOUT_MS),
    publishIntervalS: intervall,
  };
  const anmeldung: AnmeldungForm = {
    art:
      artWort === 'header' || artWort === 'bearer' || artWort === 'basic' ? artWort : 'none',
    header: str(auth.header),
    username: str(auth.username),
    secret: '',
  };
  const geheimnisBesteht = typeof connection.auth_secret === 'string'
    && connection.auth_secret !== '';

  const raw = Array.isArray(connection.mappings) ? (connection.mappings as Roh[]) : [];
  const zeilen: ZuordnungZeile[] = raw.map((m) => ({
    ...neueZuordnung(),
    channel: str(m.channel),
    topic: str(m.topic),
    path: str(m.path),
    aggregate: str(m.aggregate) || 'last',
    valueType: str(m.value_type) || 'number',
    scale: num(m.scale) || '1',
    offset: num(m.offset) || '0',
    sentinel: num(m.sentinel),
    staleS: typeof m.stale_s === 'number' ? String(m.stale_s) : String(DEFAULT_STALE_S),
    trueValues: Array.isArray(m.true_values) ? (m.true_values as string[]).join(', ') : '',
    falseValues: Array.isArray(m.false_values) ? (m.false_values as string[]).join(', ') : '',
  }));

  const soc = neueSoc();
  const d = connection.soc_derivation as Roh | undefined;
  if (d) {
    const methode = str(d.method);
    if (methode === 'ocv_curve' || methode === 'coulomb' || methode === 'direct') {
      soc.methode = methode;
    }
    soc.template = str(d.template);
    soc.preferDirect = d.prefer_direct !== false;
    if (typeof d.hold_s === 'number') soc.holdS = String(d.hold_s);
    const p = (d.params ?? {}) as Roh;
    soc.kurveLaden = punkteAus(p.curve_charge);
    soc.kurveEntladen = punkteAus(p.curve_discharge);
    soc.cellsInSeries = typeof p.cells_in_series === 'number' ? String(p.cells_in_series) : '';
    soc.conservativeMin = p.conservative_min !== false;
    soc.roundPct = num(p.round_pct) || soc.roundPct;
    soc.capacityKwh = num(p.capacity_kwh);
    soc.efficiencyPct = num(p.efficiency_pct);
    soc.nominalVoltageV = num(p.nominal_voltage_v);
    soc.refTempC = num(p.ref_temp_c);
    const anchor = p.anchor as Roh | undefined;
    if (anchor) {
      soc.anchorSocPct = num(anchor.soc_pct);
      soc.anchorAt = ankerFeld(anchor.at);
    }
  }

  // P6: die gespeicherte Bindung. Ein Anschluss von VOR P6 trägt keinen Block -
  // er ist ungebunden, und das ist die richtige Lesart: bis P6 gab es die Frage
  // nicht, also hat sie niemand beantwortet.
  const bindung = neueBindung();
  const b2 = connection.binding as Roh | undefined;
  if (b2) {
    const modus = str(b2.mode);
    if (modus === 'feeds_inverter' || modus === 'standalone' || modus === 'unbound') {
      bindung.modus = modus;
    }
    bindung.inverterEntityId = str(b2.inverter_entity_id);
  }
  return { art, broker, endpunkt, anmeldung, geheimnisBesteht, zeilen, soc, bindung };
}

function punkteAus(v: unknown): KurvenPunkt[] {
  if (!Array.isArray(v)) return [];
  return (v as unknown[])
    .filter((p): p is number[] => Array.isArray(p) && p.length >= 2)
    .map((p) => neuerPunkt(feldZahl(p[0]), feldZahl(p[1])));
}

// -- Die Live-Vorschau --------------------------------------------------------

/** EINE Zeile der Probe-Antwort, wie der Server sie durchreicht. */
export type VorschauProbe = {
  channel: string;
  topic?: string | null;
  raw?: number | null;
  value?: number | null;
  count: number;
  at?: string | null;
};

export type VorschauAntwort = {
  requestId?: string;
  errorCode?: string | null;
  message?: string | null;
  results?:
    | {
        id?: string;
        ok?: boolean;
        errorCode?: string | null;
        message?: string | null;
        samples?: VorschauProbe[] | null;
      }[]
    | null;
};

export type VorschauZeile = {
  channel: string;
  label: string;
  /** `empfangen` = Zahlen da · `leer` = nichts gekommen · `unklar` = empfangen, nicht auswertbar. */
  zustand: 'empfangen' | 'leer' | 'unklar';
  roh: string | null;
  wert: string | null;
  topic: string | null;
  count: number;
};

export type VorschauErgebnis = {
  zustand: 'bestanden' | 'leer' | 'nicht_moeglich' | 'fehlgeschlagen';
  text: string;
  zeilen: VorschauZeile[];
};

const VORSCHAU_FEHLER: Record<string, string> = {
  invalid_request: 'Ihre Box konnte mit dieser Zuordnung nichts anfangen.',
  unreachable: 'Ihre Box erreicht diesen Broker nicht. Bitte Adresse und Port prüfen.',
  no_answer: 'Im Lauschfenster kam auf keinem der Topics eine Nachricht an.',
  invalid_response: 'Die Nachrichten waren nicht lesbar - passt der Wertepfad zum Format?',
  timeout: 'Ihre Anlage hat nicht rechtzeitig geantwortet. Bitte erneut versuchen.',
  rate_limited: 'Es laufen gerade zu viele Prüfungen. Bitte einen Moment warten.',
  not_supported:
    'Ihre Box kann noch nicht mithören - dafür braucht sie das neuere Edge-Release. '
    + 'Die Zuordnung lässt sich trotzdem speichern; die Werte erscheinen dann auf der Geräteseite.',
};

/**
 * Dieselben Klassen, für die Web-Auskunft ausgesprochen.
 *
 * ⚠ Es sind DIESELBEN Wörter des Probe-Kanals - nur der Satz ändert sich, denn
 * „im Lauschfenster kam nichts an" wäre über einen einmaligen Abruf schlicht
 * falsch. Eine zweite Fehlerklasse gibt es NICHT: die Box benennt ihren
 * Fehlschlag, und das Portal übersetzt ihn.
 */
const VORSCHAU_FEHLER_HTTP: Record<string, string> = {
  unreachable: 'Ihre Box erreicht diese Adresse nicht. Bitte Adresse, Port und Pfad prüfen.',
  no_answer: 'Die Web-Auskunft hat nicht rechtzeitig geantwortet.',
  invalid_response:
    'Die Antwort war nicht auswertbar - sie war kein JSON, oder die Anmeldung wurde '
    + 'abgelehnt. Bitte Pfad und Schlüssel prüfen.',
  not_supported:
    'Ihre Box kann diese Auskunft noch nicht abrufen - dafür braucht sie das neuere '
    + 'Edge-Release. Die Zuordnung lässt sich trotzdem speichern; die Werte erscheinen dann '
    + 'auf der Geräteseite.',
};

/**
 * Der Satz zu einer Probe-Antwort.
 *
 * ⚠ `not_supported` ist eine Aussage über die BOX, nie über die Zuordnung -
 * und ausdrücklich kein Fehlschlag: die Vorschau ist ein Angebot, keine
 * Pflicht (es gibt hier keinen Verbindungstest-Zwang). Ein Ausbleiben der
 * Antwort ist nie ein bewiesener Fehlschlag.
 */
export function vorschauFehlerText(
  code?: string | null,
  serverText?: string | null,
  art: AnschlussartId = 'mqtt',
): string {
  if (code && art === 'http' && VORSCHAU_FEHLER_HTTP[code]) return VORSCHAU_FEHLER_HTTP[code];
  if (code && VORSCHAU_FEHLER[code]) return VORSCHAU_FEHLER[code];
  const t = (serverText ?? '').trim();
  return t !== '' ? t : 'Die Vorschau ist fehlgeschlagen.';
}

function zahlText(n: number): string {
  return n.toLocaleString('de-DE', { maximumFractionDigits: 3 });
}

/**
 * Die Probe-Antwort in Tabellenzeilen - EINE je Zuordnung, in der Reihenfolge
 * des Formulars.
 *
 * ⚠ Eine Zuordnung, für die die Box nichts gemeldet hat, steht als `leer` da,
 * NICHT als 0: „nicht gemessen" ist nie „gemessen 0". Und eine Zeile mit
 * Empfang, aber ohne auswertbare Zahl, sagt genau das - sie behauptet weder
 * einen Wert noch ein Schweigen.
 */
export function vorschauErgebnis(
  antwort: VorschauAntwort | null | undefined,
  zeilen: ZuordnungZeile[],
  art: AnschlussartId = 'mqtt',
): VorschauErgebnis {
  const zugeordnet = zeilen.filter((z) => z.channel.trim() !== '');
  if (!antwort) {
    return { zustand: 'fehlgeschlagen', text: vorschauFehlerText(null, null, art), zeilen: [] };
  }
  if (antwort.errorCode) {
    return {
      zustand: antwort.errorCode === 'not_supported' ? 'nicht_moeglich' : 'fehlgeschlagen',
      text: vorschauFehlerText(antwort.errorCode, antwort.message, art),
      zeilen: [],
    };
  }
  const line = antwort.results?.[0];
  if (!line) {
    return { zustand: 'fehlgeschlagen', text: vorschauFehlerText(null, null, art), zeilen: [] };
  }
  const samples = line.samples ?? null;
  if (samples == null) {
    // Der Block FEHLT: diese Box kann (noch) nicht mithören. Das ist eine
    // Aussage über die Box - „es kam nichts an" wäre eine andere, und sie
    // wäre unbelegt.
    return {
      zustand: 'nicht_moeglich',
      text: vorschauFehlerText(line.errorCode ?? 'not_supported', line.message, art),
      zeilen: [],
    };
  }
  const beiKanal = new Map(samples.map((s) => [s.channel, s]));
  const tabelle: VorschauZeile[] = zugeordnet.map((z) => {
    const c = z.channel.trim();
    const s = beiKanal.get(c);
    const ziel = zielKanal(c);
    const label = ziel?.label ?? c;
    if (!s || s.count <= 0) {
      return { channel: c, label, zustand: 'leer', roh: null, wert: null, topic: null, count: 0 };
    }
    if (s.raw == null || s.value == null) {
      return {
        channel: c,
        label,
        zustand: 'unklar',
        roh: null,
        wert: null,
        topic: s.topic ?? null,
        count: s.count,
      };
    }
    const einheit = ziel?.unit ?? '';
    return {
      channel: c,
      label,
      zustand: 'empfangen',
      roh: zahlText(s.raw),
      wert: einheit === '' ? zahlText(s.value) : `${zahlText(s.value)} ${einheit}`,
      topic: s.topic ?? null,
      count: s.count,
    };
  });
  const getroffen = tabelle.filter((t) => t.zustand !== 'leer').length;
  if (getroffen === 0) {
    return {
      zustand: 'leer',
      text: vorschauFehlerText(line.errorCode ?? 'no_answer', line.message, art),
      zeilen: tabelle,
    };
  }
  return {
    zustand: 'bestanden',
    text:
      getroffen === tabelle.length
        ? 'Alle Zuordnungen haben Werte empfangen.'
        : `${getroffen} von ${tabelle.length} Zuordnungen haben Werte empfangen.`,
    zeilen: tabelle,
  };
}

// -- Prüfen & anlegen ---------------------------------------------------------

export type PruefZeile = { label: string; wert: string };

/** Die Zusammenfassung des letzten Schritts - was gleich gespeichert wird. */
export function pruefen(
  name: string,
  broker: BrokerForm,
  zeilen: ZuordnungZeile[],
  soc: SocForm,
  bindung: BindungForm = neueBindung(),
  ziele: SpeicherZiel[] = [],
  art: AnschlussartId = 'mqtt',
  endpunkt: EndpunktForm = neuerEndpunkt(),
  anmeldung: AnmeldungForm = neueAnmeldung(),
): PruefZeile[] {
  const http = art === 'http';
  const zugeordnet = zeilen.filter((z) => z.channel.trim() !== '');
  const methode = SOC_METHODEN.find((m) => m.id === soc.methode);
  const ladestand =
    soc.methode === 'direct' && !zugeordnet.some((z) => z.channel.trim() === 'soc_pct')
      ? 'keiner - diese Batterie meldet vorerst keinen Ladestand'
      : (methode?.label ?? soc.methode);
  const anmeldeWort =
    ANMELDE_ARTEN.find((a) => a.id === anmeldung.art)?.label ?? anmeldung.art;
  return [
    { label: 'Name', wert: name.trim() === '' ? 'Batterie' : name.trim() },
    http
      ? {
        label: 'Web-Auskunft',
        wert: `${endpunkt.tls ? 'https' : 'http'}://${endpunkt.host.trim()}`
          + `:${endpunkt.port.trim()}${endpunkt.path.trim()}`,
      }
      : { label: 'Broker', wert: `${broker.host.trim()}:${broker.port.trim()}` },
    ...(http
      ? [{
        label: 'Anmeldung',
        wert: anmeldung.art === 'header'
          ? `${anmeldeWort} (${anmeldung.header.trim()})`
          : anmeldeWort,
      }]
      : []),
    http
      ? { label: 'Abruf-Abstand', wert: `alle ${endpunkt.publishIntervalS.trim()} s` }
      : { label: 'Sende-Abstand', wert: `alle ${broker.publishIntervalS.trim()} s` },
    {
      label: 'Zugeordnete Messwerte',
      wert:
        zugeordnet.length === 0
          ? 'noch keine'
          : zugeordnet.map((z) => zielKanal(z.channel.trim())?.label ?? z.channel).join(', '),
    },
    { label: 'Ladestand', wert: ladestand },
    { label: 'Speicher-Zuordnung', wert: bindungWort(bindung, ziele) },
  ];
}

/**
 * Wie die Bindung im letzten Schritt DASTEHT. Sie nennt beim Speiser den
 * Wechselrichter beim Namen - „gebunden" allein liesse den Kunden raten, woran.
 */
export function bindungWort(bindung: BindungForm, ziele: SpeicherZiel[]): string {
  if (bindung.modus === 'standalone') return 'Diese Batterie IST der Speicher der Anlage';
  if (bindung.modus === 'feeds_inverter') {
    const ziel = ziele.find((z) => z.id === bindung.inverterEntityId.trim());
    return ziel
      ? `Ladestand, Grenzen und Freigaben für „${ziel.label}“`
      : 'Ladestand, Grenzen und Freigaben für den gewählten Wechselrichter';
  }
  return 'steht für sich - geht nicht in die Energiebilanz ein';
}

/**
 * Der ehrliche Satz unter dem letzten Schritt.
 *
 * Er sagt zwei Dinge, die sonst niemand sagt: dass diese Batterie GELESEN und
 * nicht gesteuert wird, und dass ein BERECHNETER Ladestand als berechnet
 * gekennzeichnet bleibt - überall, wo er auftaucht.
 */
export const BATTERIE_HINWEIS =
  'VoltPilot liest diese Batterie - es steuert sie nicht. Ein errechneter Ladestand wird '
  + 'überall als „berechnet" gekennzeichnet: im Cockpit, auf der Geräteseite und im Fahrplan.';
