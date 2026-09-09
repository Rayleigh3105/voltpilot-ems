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
 * ⚠ HTTP und Modbus stehen SICHTBAR da, obwohl nur MQTT gebaut ist. Das ist
 * kein Schmuck: „ich habe ein BMS mit Web-Oberfläche" ist die zweithäufigste
 * Ausgangslage, und eine Liste, die nur MQTT kennt, lässt den Kunden raten, ob
 * VoltPilot seinen Fall grundsätzlich nicht kann oder nur noch nicht. Der Satz
 * an der gesperrten Karte sagt genau das - und Modbus ist keine Ankündigung,
 * sondern ein WEGWEISER: dafür gibt es die Selbstbau-Tür längst.
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
    hint: 'VoltPilot ruft die JSON-Auskunft Ihres BMS regelmäßig ab.',
    verfuegbar: false,
    bald: 'Kommt als Nächstes. Bis dahin: viele BMS können ihre Werte zusätzlich per MQTT senden.',
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

/** Was an EINER Zuordnung fehlt - leer heißt: diese Zeile ist vollständig. */
export function zuordnungFehler(z: ZuordnungZeile): string[] {
  const out: string[] = [];
  if (z.channel.trim() === '') {
    out.push('Bitte wählen Sie, welchen Messwert dieses Feld liefert.');
  } else if (!zielKanal(z.channel)) {
    out.push('Diesen Messwert kennen wir nicht.');
  }
  if (z.topic.trim() === '') out.push('Bitte tragen Sie das Topic ein, auf dem der Wert kommt.');
  else if (!istTopicFilter(z.topic.trim())) {
    out.push(
      'Dieses Topic ist kein gültiger Filter. „+" steht für genau eine Ebene, „#" nur ganz am Ende.',
    );
  }
  if (!istWertePfad(z.path.trim())) {
    out.push('Der Wertepfad darf nur Punkte, Buchstaben, Ziffern, „_" und „-" enthalten.');
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
  const stale = zahl(z.staleS);
  if (stale === null || !Number.isInteger(stale) || stale < MIN_STALE_S || stale > MAX_STALE_S) {
    out.push(`Die Haltbarkeit muss zwischen ${MIN_STALE_S} und ${MAX_STALE_S} Sekunden liegen.`);
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

function mappingRumpf(z: ZuordnungZeile): Record<string, unknown> {
  const bool = z.valueType === 'bool';
  const body: Record<string, unknown> = {
    channel: z.channel.trim(),
    topic: z.topic.trim(),
    path: z.path.trim(),
    aggregate: z.aggregate,
    valueType: z.valueType,
    staleS: zahl(z.staleS) ?? DEFAULT_STALE_S,
  };
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

/** Der Rumpf von `POST/PUT /components/battery`. */
export function speicherRumpf(
  name: string,
  broker: BrokerForm,
  zeilen: ZuordnungZeile[],
  soc: SocForm,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    label: name.trim(),
    broker: { host: broker.host.trim(), port: zahl(broker.port) ?? DEFAULT_PORT },
    mappings: zeilen.map(mappingRumpf),
    publishIntervalS: zahl(broker.publishIntervalS) ?? DEFAULT_INTERVAL_S,
  };
  const derivation = socRumpf(soc, zeilen);
  if (derivation) body.socDerivation = derivation;
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
): Record<string, unknown> {
  return {
    broker: { host: broker.host.trim(), port: zahl(broker.port) ?? DEFAULT_PORT },
    mappings: zeilen.map(mappingRumpf),
    publishIntervalS: zahl(broker.publishIntervalS) ?? DEFAULT_INTERVAL_S,
  };
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
): { broker: BrokerForm; zeilen: ZuordnungZeile[]; soc: SocForm } | null {
  if (!connection || connection.transport !== 'mqtt_local') return null;
  const b = (connection.broker ?? {}) as Roh;
  const broker: BrokerForm = {
    host: str(b.host),
    port: typeof b.port === 'number' ? String(b.port) : String(DEFAULT_PORT),
    publishIntervalS:
      typeof connection.publish_interval_s === 'number'
        ? String(connection.publish_interval_s)
        : String(DEFAULT_INTERVAL_S),
  };
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
  return { broker, zeilen, soc };
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
 * Der Satz zu einer Probe-Antwort.
 *
 * ⚠ `not_supported` ist eine Aussage über die BOX, nie über die Zuordnung -
 * und ausdrücklich kein Fehlschlag: die Vorschau ist ein Angebot, keine
 * Pflicht (es gibt hier keinen Verbindungstest-Zwang). Ein Ausbleiben der
 * Antwort ist nie ein bewiesener Fehlschlag.
 */
export function vorschauFehlerText(code?: string | null, serverText?: string | null): string {
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
): VorschauErgebnis {
  const zugeordnet = zeilen.filter((z) => z.channel.trim() !== '');
  if (!antwort) {
    return { zustand: 'fehlgeschlagen', text: vorschauFehlerText(), zeilen: [] };
  }
  if (antwort.errorCode) {
    return {
      zustand: antwort.errorCode === 'not_supported' ? 'nicht_moeglich' : 'fehlgeschlagen',
      text: vorschauFehlerText(antwort.errorCode, antwort.message),
      zeilen: [],
    };
  }
  const line = antwort.results?.[0];
  if (!line) {
    return { zustand: 'fehlgeschlagen', text: vorschauFehlerText(), zeilen: [] };
  }
  const samples = line.samples ?? null;
  if (samples == null) {
    // Der Block FEHLT: diese Box kann (noch) nicht mithören. Das ist eine
    // Aussage über die Box - „es kam nichts an" wäre eine andere, und sie
    // wäre unbelegt.
    return {
      zustand: 'nicht_moeglich',
      text: vorschauFehlerText(line.errorCode ?? 'not_supported', line.message),
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
      text: vorschauFehlerText(line.errorCode ?? 'no_answer', line.message),
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
): PruefZeile[] {
  const zugeordnet = zeilen.filter((z) => z.channel.trim() !== '');
  const methode = SOC_METHODEN.find((m) => m.id === soc.methode);
  const ladestand =
    soc.methode === 'direct' && !zugeordnet.some((z) => z.channel.trim() === 'soc_pct')
      ? 'keiner - diese Batterie meldet vorerst keinen Ladestand'
      : (methode?.label ?? soc.methode);
  return [
    { label: 'Name', wert: name.trim() === '' ? 'Batterie' : name.trim() },
    { label: 'Broker', wert: `${broker.host.trim()}:${broker.port.trim()}` },
    { label: 'Sende-Abstand', wert: `alle ${broker.publishIntervalS.trim()} s` },
    {
      label: 'Zugeordnete Messwerte',
      wert:
        zugeordnet.length === 0
          ? 'noch keine'
          : zugeordnet.map((z) => zielKanal(z.channel.trim())?.label ?? z.channel).join(', '),
    },
    { label: 'Ladestand', wert: ladestand },
  ];
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
