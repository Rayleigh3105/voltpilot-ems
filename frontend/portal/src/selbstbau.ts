/**
 * Die SELBSTBAU-TÜR als REINE Ableitung (Einheitsmodell Stufe 3, Konzepte
 * `vp-modbus-baukasten-k6` §2.3/§2.6 und `vp-komponenten-einheit-h2` §4.1 Tür c).
 *
 * Diese Datei rechnet und formuliert; sie rendert nichts und ruft nichts ab -
 * dasselbe Muster wie `komponentenAssistent.ts`, `consumers/questions.ts` und
 * `regeln/`.
 *
 * **Die vier Regelgruppen sind ZWILLINGE des Servers**
 * (`services/api .../components/SelfBuildDefinition.java`), und das ist Absicht:
 * der Server ist der Zaun, hier stehen sie, damit der Kunde sie SIEHT, statt in
 * eine Ablehnung zu laufen. Wer eine Regel ändert, ändert beide Seiten.
 *
 * WORTSCHATZ: Set A („Komponente", „Gerät", „Messwert"). Kein „Entität", kein
 * „Kanal", kein „Register" außerhalb der Profi-Angaben.
 */

/** Höchstens so viele Messwerte je Gerät (§2.6 Poll-Budget). */
export const MAX_CHANNELS = 16;

/** Der kleinste erlaubte Abstand zwischen zwei Lesungen EINES Messwerts. */
export const MIN_INTERVAL_S = 5;

/** Die Vorgabe einer neuen Zeile. */
export const DEFAULT_INTERVAL_S = 10;

/** Die kuratierte Einheiten-Auswahl; `''` heißt ausdrücklich „ohne Einheit". */
export const UNITS = ['', 'kW', 'W', 'kWh', '°C', '%', 'A', 'V', 'Hz', 'bar', 'l/min'] as const;

export const REGISTER_KINDS = [
  { value: 'holding', label: 'Holding-Register (FC3)' },
  { value: 'input', label: 'Input-Register (FC4)' },
] as const;

export const DATA_TYPES = [
  { value: 'u16', label: 'Ganzzahl, 16 Bit (ohne Vorzeichen)' },
  { value: 's16', label: 'Ganzzahl, 16 Bit (mit Vorzeichen)' },
  { value: 'u32', label: 'Ganzzahl, 32 Bit (ohne Vorzeichen)' },
  { value: 's32', label: 'Ganzzahl, 32 Bit (mit Vorzeichen)' },
  { value: 'float32', label: 'Kommazahl, 32 Bit' },
] as const;

export const WORD_ORDERS = [
  { value: 'big', label: 'High-Word zuerst (AB CD)' },
  { value: 'little', label: 'Low-Word zuerst (CD AB)' },
] as const;

/** Der Hilfetext zur 0-basierten Adresse - die häufigste Handbuch-Falle. */
export const ADDRESS_HELP =
  'Protokoll-Adresse, 0-basiert. Steht im Handbuch 40001, ist es hier die 0.';

/**
 * Der Bilanz-Hinweis (§2.6): ein selbst gebautes Gerät ist ein Messgerät, kein
 * Teil der Energiebilanz. Ohne diesen Satz erwartet ein Kunde, dass sein
 * Wärmepumpen-Zähler den Hausverbrauch verändert - er steckt dort aber längst
 * drin, und ihn ein zweites Mal zu zählen wäre schlicht falsch.
 */
export const BILANZ_HINWEIS =
  'Dieses Gerät zeigt seine eigenen Messwerte - in der Energiebilanz Ihrer Anlage ändert '
  + 'sich dadurch nichts. Solarstrom, Netz und Hausverbrauch kommen weiterhin von Ihrem '
  + 'Wechselrichter und Ihrem Zähler.';

/** Der Satz zur LAN-Regel; er nennt den WEG, nicht nur die Ablehnung. */
export const HOST_NOT_PRIVATE =
  'Diese Adresse liegt nicht nachweisbar in Ihrem eigenen Netzwerk. VoltPilot liest nur '
  + 'Geräte im Heimnetz - bitte tragen Sie die IP-Adresse des Geräts ein (z. B. 192.168.1.50).';

/** Die Rollen-Auswahl aus Schritt 3. */
export type SelbstbauRolle = 'sensor' | 'verbraucher';

export type RolleOption = {
  id: SelbstbauRolle;
  label: string;
  hint: string;
  /** false = sichtbar, aber (noch) nicht wählbar. */
  verfuegbar: boolean;
  bald?: string;
};

/**
 * Beide Rollen sind seit Einheitsmodell Stufe 4 wählbar. Der schaltbare
 * Verbraucher entsteht dabei in ZWEI Schritten, und das ist Absicht: hier wird
 * er ANGELEGT (und ist zunächst ein Sensor), das Schalten gibt danach der
 * eigene Freigabe-Schritt an der fertigen Komponente frei. Ein Gerät anlegen
 * und ihm Schreibrechte auf ein fremdes Register geben sind zwei Entscheidungen
 * und sollen sich nicht wie eine anfühlen.
 */
export const ROLLEN: RolleOption[] = [
  {
    id: 'sensor',
    label: 'Nur messen (Sensor)',
    hint: 'Das Gerät liefert Messwerte - Diagramm, Historie und Regeln können sie nutzen.',
    verfuegbar: true,
  },
  {
    id: 'verbraucher',
    label: 'Schaltbarer Verbraucher',
    hint: 'Ein Gerät, das VoltPilot ein- und ausschalten darf. Zuerst wird es angelegt und liest '
      + 'nur; das Schalten geben Sie danach in einem eigenen Schritt frei.',
    verfuegbar: true,
  },
];

// -- Die Formularzeile eines Messwerts ---------------------------------------

/** Eine Kanal-Zeile, wie der Assistent sie hält (alles als Text - es ist ein Formular). */
export type MesswertZeile = {
  /** Stabil je Zeile, damit React beim Löschen nicht die falsche Zeile behält. */
  key: string;
  label: string;
  unit: string;
  registerKind: string;
  address: string;
  dataType: string;
  wordOrder: string;
  scale: string;
  offset: string;
  minReadIntervalS: string;
};

let zeilenZaehler = 0;

export function neueZeile(): MesswertZeile {
  zeilenZaehler += 1;
  return {
    key: `mw-${zeilenZaehler}`,
    label: '',
    unit: '',
    registerKind: 'holding',
    address: '',
    dataType: 'u16',
    wordOrder: 'big',
    scale: '1',
    offset: '0',
    minReadIntervalS: String(DEFAULT_INTERVAL_S),
  };
}

/** Braucht dieser Datentyp zwei Register - und damit eine Wortreihenfolge? */
export function istBreit(dataType: string): boolean {
  return dataType === 'u32' || dataType === 's32' || dataType === 'float32';
}

/** Die Verbindung, wie der Assistent sie hält. */
export type VerbindungForm = { host: string; port: string; unitId: string };

export function neueVerbindung(): VerbindungForm {
  return { host: '', port: '502', unitId: '1' };
}

// -- Prüfen (der Zwilling der Server-Regeln) ---------------------------------

function zahl(raw: string): number | null {
  const t = raw.trim();
  if (t === '') return null;
  // ⚠ Ein deutsches Komma ist die Normal-Eingabe; ohne diese Zeile wird aus
  // „0,1" ein NaN und der Kunde sieht eine Fehlermeldung über ein Feld, das er
  // korrekt ausgefüllt hat.
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** Was an EINER Zeile fehlt - leer heißt: diese Zeile ist vollständig. */
export function zeilenFehler(z: MesswertZeile): string[] {
  const out: string[] = [];
  if (z.label.trim() === '') out.push('Bitte einen Namen vergeben.');
  else if (z.label.trim().length > 80) out.push('Der Name ist zu lang (höchstens 80 Zeichen).');
  const addr = zahl(z.address);
  if (addr === null || !Number.isInteger(addr) || addr < 0 || addr > 65535) {
    out.push('Die Registeradresse muss zwischen 0 und 65535 liegen.');
  }
  const scale = zahl(z.scale);
  if (scale === null || scale === 0) out.push('Die Skalierung muss eine Zahl ungleich 0 sein.');
  if (zahl(z.offset) === null) out.push('Der Offset muss eine Zahl sein.');
  const iv = zahl(z.minReadIntervalS);
  if (iv === null || !Number.isInteger(iv) || iv < MIN_INTERVAL_S) {
    out.push(`Der Mindestabstand muss mindestens ${MIN_INTERVAL_S} Sekunden betragen.`);
  }
  return out;
}

/** Was am GERÄT fehlt (Schritt 1). */
export function geraetFehler(v: VerbindungForm): string[] {
  const out: string[] = [];
  if (v.host.trim() === '') out.push('Bitte tragen Sie die Adresse des Geräts ein.');
  else if (!isPrivateHost(v.host)) out.push(HOST_NOT_PRIVATE);
  const port = zahl(v.port);
  if (port === null || !Number.isInteger(port) || port < 1 || port > 65535) {
    out.push('Der Port muss zwischen 1 und 65535 liegen.');
  }
  const unit = zahl(v.unitId);
  if (unit === null || !Number.isInteger(unit) || unit < 0 || unit > 255) {
    out.push('Die Unit-ID muss zwischen 0 und 255 liegen.');
  }
  return out;
}

/** Ob die Messwert-Liste als Ganzes tragfähig ist. */
export function messwerteFehler(zeilen: MesswertZeile[]): string[] {
  const out: string[] = [];
  if (zeilen.length === 0) {
    out.push('Bitte legen Sie mindestens einen Messwert an.');
  }
  if (zeilen.length > MAX_CHANNELS) {
    out.push(`Höchstens ${MAX_CHANNELS} Messwerte je Gerät.`);
  }
  const gesehen = new Set<string>();
  for (const z of zeilen) {
    const addr = zahl(z.address);
    if (addr === null) continue;
    const key = `${z.registerKind}:${addr}:${z.dataType}`;
    if (gesehen.has(key)) {
      out.push('Zwei Messwerte lesen dasselbe Register - bitte eine andere Adresse wählen.');
      break;
    }
    gesehen.add(key);
  }
  return out;
}

/**
 * Die vorgerechnete Leselast (§2.6) - der Satz, den der Assistent zeigt, BEVOR
 * gespeichert wird. Der Zwilling von `SelfBuildDefinition.readLoadNote`.
 */
export function leselastHinweis(zeilen: MesswertZeile[]): string | null {
  if (zeilen.length === 0) return null;
  let proSekunde = 0;
  for (const z of zeilen) {
    const iv = zahl(z.minReadIntervalS) ?? DEFAULT_INTERVAL_S;
    if (iv > 0) proSekunde += 1 / iv;
  }
  const gerundet = proSekunde.toLocaleString('de-DE', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const kopf = `${zeilen.length} ${zeilen.length === 1 ? 'Messwert ergibt' : 'Messwerte ergeben'} `
    + `rund ${gerundet} Lesungen pro Sekunde.`;
  return proSekunde > 1
    ? `${kopf} Bei empfindlichen Geräten besser den Abstand erhöhen.`
    : kopf;
}

// -- „Jetzt lesen" ------------------------------------------------------------

/** Die Antwort des Servers auf „Jetzt lesen". */
export type LeseAntwort = {
  ok?: boolean;
  raw?: number | null;
  registers?: number[] | null;
  value?: number | null;
  unit?: string | null;
  hint?: string | null;
  errorCode?: string | null;
  message?: string | null;
  receipt?: boolean;
};

export type LeseErgebnis =
  | { zustand: 'bestanden'; roh: string; skaliert: string; register: string | null; hinweis: string | null }
  | { zustand: 'fehlgeschlagen'; text: string };

/**
 * Die deutschen Sätze zu den Fehlerklassen. Ein Code, den diese Tabelle nicht
 * kennt, bekommt KEINE erfundene Erklärung - dann gilt der Satz des Servers.
 */
const LESE_FEHLER: Record<string, string> = {
  unreachable: 'Unter dieser Adresse antwortet nichts. Bitte IP-Adresse und Netzwerk prüfen.',
  no_answer: 'Das Gerät ist erreichbar, antwortet aber nicht auf diese Anfrage. Bitte Unit-ID und Registerart prüfen.',
  invalid_response: 'Die Antwort ist nicht lesbar. Bitte Datentyp und Wortreihenfolge prüfen.',
  implausible: 'Das Gerät antwortet, der Wert ist aber unplausibel.',
  invalid_request: 'Die Angaben sind unvollständig.',
  not_supported: 'Diese Verbindungsart kann Ihre VoltPilot-Box noch nicht prüfen.',
  rate_limited: 'Ihre VoltPilot-Box prüft gerade schon. Bitte einen Moment warten.',
  timeout: 'Ihre VoltPilot-Box hat nicht rechtzeitig geantwortet. Bitte erneut versuchen.',
};

function fehlerText(code?: string | null, serverText?: string | null): string {
  const known = code ? LESE_FEHLER[code] : undefined;
  if (known) return known;
  if (serverText && serverText.trim() !== '') return serverText.trim();
  return 'Die Lesung ist fehlgeschlagen.';
}

function zahlText(n: number): string {
  return n.toLocaleString('de-DE', { maximumFractionDigits: 3 });
}

/**
 * Das Ergebnis EINER Lesung, für die Zeile aufbereitet.
 *
 * **Roh und skaliert stehen nebeneinander** - das ist der ganze Zweck: „13.750"
 * neben „1.375 °C" sagt in einer Sekunde, dass die Skalierung um den Faktor 10
 * danebenliegt. Die Registerwörter stehen daneben, damit auch eine falsche
 * Wortreihenfolge sichtbar wird und nicht bloß falsch ist.
 */
export function leseErgebnis(antwort: LeseAntwort | null | undefined): LeseErgebnis {
  if (!antwort || antwort.ok !== true) {
    return {
      zustand: 'fehlgeschlagen',
      text: fehlerText(antwort?.errorCode, antwort?.message),
    };
  }
  const einheit = antwort.unit && antwort.unit !== '' ? ` ${antwort.unit}` : '';
  return {
    zustand: 'bestanden',
    roh: typeof antwort.raw === 'number' ? zahlText(antwort.raw) : '—',
    skaliert: typeof antwort.value === 'number' ? `${zahlText(antwort.value)}${einheit}` : '—',
    register:
      Array.isArray(antwort.registers) && antwort.registers.length > 0
        ? antwort.registers.join(' · ')
        : null,
    hinweis: antwort.hint && antwort.hint.trim() !== '' ? antwort.hint : null,
  };
}

// -- Die Zusammenfassung (Schritt 4) -----------------------------------------

export type PruefZeile = { label: string; wert: string };

export function pruefen(
  name: string,
  verbindung: VerbindungForm,
  zeilen: MesswertZeile[],
  rolle: SelbstbauRolle = 'sensor',
): PruefZeile[] {
  const rows: PruefZeile[] = [
    { label: 'Name', wert: name.trim() === '' ? 'Eigenes Modbus-Gerät' : name.trim() },
    // ⚠ Auch ein „schaltbarer Verbraucher" entsteht ZUNAECHST nur lesend - die
    // Zusammenfassung darf kein Schalten versprechen, das erst der eigene
    // Freigabe-Schritt erteilt.
    {
      label: 'Art',
      wert: rolle === 'verbraucher'
        ? 'Schaltbarer Verbraucher - liest zunächst nur; Schalten geben Sie danach frei'
        : 'Nur messen (Sensor)',
    },
    {
      label: 'Adresse',
      wert: `${verbindung.host.trim()}:${verbindung.port.trim() || '502'} · Unit ${
        verbindung.unitId.trim() || '1'
      }`,
    },
    {
      label: 'Messwerte',
      wert: zeilen.map((z) => z.label.trim()).filter((l) => l !== '').join(', ') || '—',
    },
  ];
  return rows;
}

/** Der Rumpf, den `POST .../components/custom` erwartet. */
export function speicherRumpf(
  name: string,
  verbindung: VerbindungForm,
  zeilen: MesswertZeile[],
): Record<string, unknown> {
  return {
    label: name.trim() === '' ? undefined : name.trim(),
    connection: verbindungRumpf(verbindung),
    channels: zeilen.map((z) => ({
      label: z.label.trim(),
      unit: z.unit,
      registerKind: z.registerKind,
      address: zahl(z.address),
      dataType: z.dataType,
      wordOrder: istBreit(z.dataType) ? z.wordOrder : 'big',
      scale: zahl(z.scale),
      offset: zahl(z.offset),
      minReadIntervalS: zahl(z.minReadIntervalS),
    })),
  };
}

export function verbindungRumpf(v: VerbindungForm): Record<string, unknown> {
  return {
    host: v.host.trim(),
    port: zahl(v.port) ?? 502,
    unitId: zahl(v.unitId) ?? 1,
  };
}

/** Der Rumpf für „Jetzt lesen" EINER Zeile. */
export function leseRumpf(v: VerbindungForm, z: MesswertZeile): Record<string, unknown> {
  return {
    connection: verbindungRumpf(v),
    channel: {
      label: z.label.trim() === '' ? 'Probe' : z.label.trim(),
      unit: z.unit,
      registerKind: z.registerKind,
      address: zahl(z.address),
      dataType: z.dataType,
      wordOrder: istBreit(z.dataType) ? z.wordOrder : 'big',
      scale: zahl(z.scale),
      offset: zahl(z.offset),
    },
  };
}

// -- LAN-only -----------------------------------------------------------------

const LAN_SUFFIXES = ['.local', '.lan', '.home', '.home.arpa', '.internal', '.intern'];

function parseIpv4(h: string): number[] | null {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return null;
  const parts = h.split('.').map((p) => Number(p));
  return parts.every((p) => p >= 0 && p <= 255) ? parts : null;
}

/**
 * Der TS-Zwilling von `SelfBuildDefinition.isPrivateHost` (Java) und
 * `probe.IsPrivateHost` (Go) - alle drei lesen die GETEILTEN Vektoren in
 * `docs/contracts/lan-host-vectors.json`.
 *
 * **Es ist eine WHITELIST dessen, was sich aus der Zeichenkette BELEGEN lässt.**
 * Ein nackter Hostname wird deshalb abgelehnt, obwohl das etwas Bequemlichkeit
 * kostet: er wird über die Suchdomänen der Box aufgelöst, ist also nicht
 * nachweisbar privat - und eine Regel, die ihr eigenes Versprechen nicht prüfen
 * kann, ist keine.
 */
export function isPrivateHost(host: string): boolean {
  let h = (host ?? '').trim();
  if (h === '') return false;
  if (h.startsWith('[')) h = h.slice(1);
  if (h.endsWith(']')) h = h.slice(0, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h === '') return false;

  const v4 = parseIpv4(h);
  if (v4) return isPrivateV4(v4);
  if (h.includes(':')) return isPrivateV6(h);

  const lower = h.toLowerCase();
  if (/[ /\\@:]/.test(lower)) return false;
  return LAN_SUFFIXES.some((s) => lower.endsWith(s));
}

function isPrivateV4([a, b]: number[]): boolean {
  if (a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  // CGNAT 100.64.0.0/10 - nicht öffentlich routbar, und echte Kunden-Router
  // vergeben sie.
  return a === 100 && b >= 64 && b <= 127;
}

function isPrivateV6(raw: string): boolean {
  const h = raw.toLowerCase();
  if (!/^[0-9a-f:.]+$/.test(h)) return false;
  // Eine IPv4-abgebildete Adresse wird nach ihrer v4-Hälfte beurteilt.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (mapped) {
    const v4 = parseIpv4(mapped[1]);
    return v4 ? isPrivateV4(v4) : false;
  }
  if (h === '::1') return true;
  const head = h.split(':')[0];
  if (head === '') return false;
  const first = parseInt(head.padStart(4, '0').slice(0, 2), 16);
  if (Number.isNaN(first)) return false;
  if ((first & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  const second = parseInt(head.padStart(4, '0').slice(2, 4), 16);
  return first === 0xfe && (second & 0xc0) === 0x80; // fe80::/10 link local
}
