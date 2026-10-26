'use strict';

/**
 * kaco-serial-decode - die dritte KACO-Plattform: die Powador-Generation VOR
 * der TL3/Ethernet-Generation (z. B. Powador 2500xi...8000xi und die
 * aelteren, nicht-"xi" Einphaser wie der Powador 3200 - INT), die ihre
 * Messwerte NICHT ueber Modbus, sondern ueber ein eigenes, serielles
 * ASCII-Protokoll (RS232/RS485, 9600 8N1, Adresspolling 0-31) herausgibt.
 *
 * Diese Geraete haben keinen Netzwerk-Anschluss. VoltPilot erreicht sie ueber
 * einen TRANSPARENTEN RS485-zu-Ethernet-Wandler (z. B. Waveshare "RS485 TO
 * ETH" oder ein USR-TCP232-aehnliches Geraet im TCP-Server-Modus): der
 * Wandler reicht die seriellen Bytes 1:1 durch einen TCP-Raw-Socket - fuer
 * dieses Modul und den Treiber ist das Protokoll UNVERAENDERT dasselbe, nur
 * der Transport ist TCP statt eines lokalen /dev/ttyUSB*.
 *
 * Quelle des Protokolls: oeffentlich dokumentiert und in mehreren offenen
 * Projekten gegen reale Powador-Geraete verifiziert (plieningerweb/kacors485,
 * dessen README das Frame woertlich mit Beispiel-Bytes zeigt; g4bri3lDev/
 * kaco-rs485, das zusaetzlich die Pruefsumme und die feste Feldbreite gegen
 * echte 6400xi/8000xi-Aufzeichnungen dokumentiert und auf KACOs eigenes
 * "APL_RS485protocol_KACO"-Dokument verweist). Nichts davon wurde an einem
 * echten Geraet dieser Anlage gemessen - siehe KACO.md fuer die
 * VERIFY-on-device-Liste und die Feld-Checkliste
 * (POWADOR-RS485-CHECKLISTE.md).
 *
 * ⚠ NUR LESEN. Diese Geraetegeneration hat keine Fernsteuerung (keine
 * Wirkleistungsbegrenzung, kein Sollwert) - es gibt nichts zu schreiben, nicht
 * einmal gesperrt vorbereitet.
 *
 * Dieses Modul ist - wie kaco/kaco-http.js - abhaengigkeitsfrei (kein
 * `require`) und deshalb offline vollstaendig testbar
 * (kaco-serial-decode.test.js). Ein TCP-Client/Framing-Teil kommt separat im
 * Node-RED-Funktionsknoten (siehe build-flows.js), der eine SYNCHRONISIERTE
 * Kopie dieser Decodierung traegt (flows-sync.test.js).
 */

// --- Protokoll-Konstanten -----------------------------------------------------

/** Adresspolling: 0 bis 31 (5 Bit auf dem Bus). */
const MIN_ADDRESS = 0;
const MAX_ADDRESS = 31;

/** 9600 8N1 - informativ fuer die Doku/den Verbindungstest, kein Codepfad hier. */
const SERIAL_PARAMS = { baud: 9600, dataBits: 8, parity: 'none', stopBits: 1 };

/**
 * Der uebliche TCP-Port transparenter RS485-zu-Ethernet-Wandler im
 * "Server"-/"Transparent"-Modus (USR-TCP232-Klasse). KEINE Normierung durch
 * KACO - jeder Wandler konfiguriert seinen eigenen Port, deshalb bleibt das
 * Feld im Formular frei editierbar und dies ist nur der Vorschlagswert.
 */
const DEFAULT_PORT = 8899;

const LF = 0x0a;
const CR = 0x0d;

/** Kommando "0": die Momentanwerte (Status, Spannung/Strom/Leistung, Temperatur, Tagesertrag). */
const CMD_MEASURE = '0';

// Eine einzige Familie: die Geraetegeneration hat keinen Speicher, die
// AC-Ausgangsleistung IST die Erzeugung - dieselbe Lehre wie bei einem
// String-Geraet der kaco_http-Plattform (kaco/kaco-http.js FAMILIES).
const FAMILIES = {
  kaco_serial: {
    label: 'KACO Powador (seriell, vor der Ethernet-Generation)',
    hasBattery: false,
    pvSource: 'ac',
  },
};

/**
 * Die Antwort beginnt mit einem Byte, das Kommando-Antwort-Byte sagt, welche
 * Protokoll-Variante antwortet (KACOs "APL_RS485protocol_KACO" Abschnitt 1.4,
 * Tabelle 3). Kommando `0` ist die hier implementierte, feste 1-Byte-Summen-
 * Pruefsumme - die Variante, die die xi-Serie und (laut Bericht/Aufgabe)
 * diese Altgeraete-Generation sprechen. Antwortet ein Geraet mit einem
 * ANDEREN Kommando-Byte (z. B. `n` fuer die neuere CRC16-Variante der
 * blueplanet/TL/TR-Linie, oder `4` fuer die groesseren "000xi"-Park-
 * Wechselrichter), ist das NICHT diese Familie - der Decoder weigert sich,
 * das zu raten, und meldet den Mismatch statt falsch zu parsen.
 */
const KNOWN_REPLY_COMMANDS = new Set(['0', '3', '8', '9', 's']);

function replyCommandByte(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < 5) return null;
  if (raw[0] !== LF || raw[1] !== 0x2a /* '*' */) return null;
  return String.fromCharCode(raw[4]);
}

/**
 * protocolMismatch - true, wenn eine Antwort zwar ein LF*-Kopf hat, aber ein
 * Kommando-Byte traegt, das diese Decodierung NICHT kennt (ein anderes
 * Protokoll der Marke, siehe KNOWN_REPLY_COMMANDS). `null` heisst „kein
 * erkennbarer Kopf ueberhaupt" (Rauschen/Timeout/zu kurz) - das ist KEIN
 * Mismatch, sondern einfach keine Antwort.
 */
function protocolMismatch(raw) {
  const cmd = replyCommandByte(raw);
  return cmd !== null && !KNOWN_REPLY_COMMANDS.has(cmd);
}

// --- Anfrage -------------------------------------------------------------------

/**
 * buildRequest - `#<2-stellige Adresse><Kommando>\r`, z. B. `#000\r` fuer
 * Adresse 0, Kommando "Momentanwerte". Adresse 0..31 (Bus-Grenze), Kommando
 * genau ein ASCII-Zeichen.
 */
function buildRequest(address, command) {
  if (typeof address !== 'number' || !Number.isInteger(address) ||
      address < MIN_ADDRESS || address > MAX_ADDRESS) {
    throw new RangeError('address must be an integer 0..31, got ' + address);
  }
  if (typeof command !== 'string' || command.length !== 1) {
    throw new RangeError('command must be exactly one character, got ' + JSON.stringify(command));
  }
  const addr2 = String(address).padStart(2, '0');
  return Buffer.from('#' + addr2 + command + '\r', 'ascii');
}

// --- Pruefsumme (Kommando "0") -------------------------------------------------

/**
 * kacoChecksum - die 1-Byte-Summenpruefsumme: die ASCII-Werte der Zeichen
 * EINER Zeile werden addiert, bis und mit dem Leerzeichen nach dem
 * Tagesertrag (KACOs eigene Formulierung, Abschnitt 2.2). Das Ergebnis ist
 * ein ROHES Byte (0..255) - KEIN ASCII-Hex, keine zwei Zeichen.
 */
function kacoChecksum(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) sum += bytes[i];
  return sum & 0xff;
}

// Feste Feldbreite der Kommando-"0"-Antwort, vom LF aus gezaehlt (siehe
// Bericht/kaco-rs485 framing.py + protocol.py, selbst an echten
// 6400xi/8000xi-Aufzeichnungen verifiziert). Jede Position ist nach ASCII +
// Leerzeichen-Trennern fest, DESHALB kann die Pruefsumme ein beliebiges Byte
// sein (auch 0x0A/0x0D) ohne das Frame zu verwechseln.
const CMD0_OFFSETS = {
  header: [0, 5], // LF * AA 0 <space>
  status: [6, 9],
  dcVoltage: [10, 15],
  dcCurrent: [16, 21],
  dcPower: [22, 27],
  acVoltage: [28, 33],
  acCurrent: [34, 39],
  acPower: [40, 45],
  temperature: [46, 49],
  dailyYieldWh: [50, 56],
  checksumSpace: 56, // letztes Byte, das in die Summe eingeht
  checksum: 57, // die Pruefsumme selbst - danach optional " <Typ>\r"
};

const CMD0_MIN_LEN = CMD0_OFFSETS.checksum + 1; // 58

/**
 * trimLeadingJunk - Bus-Umschalt-Stoerbytes vor dem Frame verwerfen. Jede
 * Antwortform dieses Protokolls beginnt mit LF; alles davor ist Rauschen.
 * Liefert einen leeren Buffer, wenn (noch) kein LF angekommen ist.
 */
function trimLeadingJunk(raw) {
  if (!Buffer.isBuffer(raw)) return Buffer.alloc(0);
  const idx = raw.indexOf(LF);
  return idx < 0 ? Buffer.alloc(0) : raw.subarray(idx);
}

/**
 * isCmd0Complete - true, sobald `raw` (bereits mit trimLeadingJunk bereinigt)
 * ein VOLLSTAENDIGES Kommando-"0"-Frame enthaelt und das Lesen frueh beenden
 * darf.
 *
 * Erst die Laenge pruefen, DANN nach CR suchen - nie umgekehrt: die
 * Pruefsumme an Offset 57 darf selbst 0x0D sein (jedes Byte davor ist
 * ASCII-Ziffer/Leerzeichen und kann daher kein CR sein), ein zu frueher
 * CR-Scan wuerde ein Frame an seiner eigenen Pruefsumme abschneiden.
 */
function isCmd0Complete(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < CMD0_MIN_LEN) return false;
  return raw.subarray(CMD0_OFFSETS.checksum).includes(CR);
}

/**
 * verifyCmd0Checksum - Pruefsumme eines (laengen-vollstaendigen)
 * Kommando-"0"-Frames gegen `kacoChecksum` pruefen. Die Summe laeuft vom `*`
 * (Offset 1) bis zum Leerzeichen vor der Pruefsumme (Offset 56), beide
 * eingeschlossen.
 *
 * Liefert `{ ok, expected, actual }`; bei einem zu kurzen Frame
 * `{ ok: false, expected: 0, actual: 0 }` - NIE ein Wurf.
 */
function verifyCmd0Checksum(raw) {
  if (!Buffer.isBuffer(raw) || raw.length <= CMD0_OFFSETS.checksum) {
    return { ok: false, expected: 0, actual: 0 };
  }
  const expected = kacoChecksum(raw.subarray(1, CMD0_OFFSETS.checksumSpace + 1));
  const actual = raw[CMD0_OFFSETS.checksum];
  return { ok: expected === actual, expected, actual };
}

/** ParseError - eine Antwort passt nicht auf die erwartete Form (zu kurz, falscher Kopf, nicht-numerisches Feld). */
class ParseError extends Error {}

function field(raw, range) {
  return raw.subarray(range[0], range[1]).toString('ascii').trim();
}

function numField(raw, range, name) {
  const s = field(raw, range);
  const n = Number(s);
  if (!Number.isFinite(n)) {
    throw new ParseError('Feld "' + name + '" ist nicht numerisch: ' + JSON.stringify(s));
  }
  return n;
}

/**
 * parseCmd0 - eine Antwort auf `#<adr>0\r` decodieren.
 *
 * Wirft `ParseError`, wenn die Form grundsaetzlich nicht passt (zu kurz,
 * fehlender LF*-Kopf, falsches Kommando-Byte, nicht-numerisches Feld) - das
 * ist ein PROTOKOLL-Problem, kein Messwert-Problem, und der Aufrufer soll es
 * nicht als „Geraet antwortet mit Nullen" verwechseln.
 *
 * Ein CHECKSUM-Fehler ist dagegen NICHT fatal (dieselbe Haltung wie
 * g4bri3lDev/kaco-rs485 MeasuredValues.checksum_ok): Buskollisionen und
 * Teilantworten sind auf RS485 nicht selten, aber die Felder selbst lesen
 * sich meist noch korrekt. Der Aufrufer bekommt die geparsten Werte UND das
 * Pruefsummen-Verdikt und entscheidet selbst, ob er der Probe traut.
 */
function parseCmd0(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < CMD0_MIN_LEN) {
    throw new ParseError('Frame zu kurz: ' + (Buffer.isBuffer(raw) ? raw.length : 0) + ' Bytes (mind. ' + CMD0_MIN_LEN + ')');
  }
  if (raw[0] !== LF || raw[1] !== 0x2a) {
    throw new ParseError('fehlender LF*-Kopf: ' + JSON.stringify(raw.subarray(0, 2).toString('ascii')));
  }
  const cmdByte = String.fromCharCode(raw[4]);
  if (cmdByte !== CMD_MEASURE) {
    throw new ParseError('Kommando-Byte ist ' + JSON.stringify(cmdByte) + ', erwartet "0" (anderes KACO-Protokoll? siehe KACO.md)');
  }

  const addrStr = field(raw, [2, 4]);
  const address = Number(addrStr);
  if (!Number.isInteger(address)) {
    throw new ParseError('Adressfeld nicht numerisch: ' + JSON.stringify(addrStr));
  }

  const { ok: checksumOk, expected: checksumExpected, actual: checksumActual } = verifyCmd0Checksum(raw);

  // Der Typ-String nach der Pruefsumme ist dekorativ (laut den auf echten
  // Geraeten gemessenen Framing-Notizen): fehlt er, ist das Frame trotzdem
  // vollstaendig nutzbar.
  const tail = raw.subarray(CMD0_OFFSETS.checksum + 1);
  const crIdx = tail.indexOf(CR);
  const inverterType = (crIdx < 0 ? tail : tail.subarray(0, crIdx)).toString('ascii').trim();

  return {
    address,
    status: numField(raw, CMD0_OFFSETS.status, 'status'),
    dcVoltageV: numField(raw, CMD0_OFFSETS.dcVoltage, 'dcVoltage'),
    dcCurrentA: numField(raw, CMD0_OFFSETS.dcCurrent, 'dcCurrent'),
    dcPowerW: numField(raw, CMD0_OFFSETS.dcPower, 'dcPower'),
    acVoltageV: numField(raw, CMD0_OFFSETS.acVoltage, 'acVoltage'),
    acCurrentA: numField(raw, CMD0_OFFSETS.acCurrent, 'acCurrent'),
    acPowerW: numField(raw, CMD0_OFFSETS.acPower, 'acPower'),
    temperatureC: numField(raw, CMD0_OFFSETS.temperature, 'temperature'),
    dailyYieldWh: numField(raw, CMD0_OFFSETS.dailyYieldWh, 'dailyYieldWh'),
    inverterType,
    checksumOk,
    checksumExpected,
    checksumActual,
  };
}

const round3 = (x) => Math.round(x * 1000) / 1000;

/**
 * decode - eine Kommando-"0"-Antwort in die VoltPilot-Busform bringen.
 *
 * `opts.requireChecksum` (Vorgabe: false) - wenn gesetzt, verwirft ein
 * Pruefsummenfehler die ganze Probe (`null`) statt sie mit `checksumOk:
 * false` durchzulassen. Vorgabe AUS, weil RS485-Buskollisionen auf einem
 * geteilten Bus nicht selten sind und ein paar falsche Pruefsummen-Treffer
 * (1 von 256 im Durchschnitt) nicht jede zweite Probe eines ansonsten
 * plausiblen Frames verwerfen sollen - die Anzeige kann den Status
 * `checksumOk` trotzdem zeigen.
 *
 * Wirft NICHT: ein unparsebares Frame liefert `null` (nie einen Wurf), genau
 * wie kaco-http.js es fuer eine kaputte HTTP-Antwort haelt.
 */
function decode(raw, opts) {
  opts = opts || {};
  let parsed;
  try {
    parsed = parseCmd0(raw);
  } catch (e) {
    return null;
  }
  if (!parsed.checksumOk && opts.requireChecksum) return null;

  const reading = {};
  const meta = {
    status: parsed.status,
    dc_voltage_v: parsed.dcVoltageV,
    dc_current_a: parsed.dcCurrentA,
    ac_voltage_v: parsed.acVoltageV,
    ac_current_a: parsed.acCurrentA,
    temp_c: parsed.temperatureC,
    energy_today_kwh: round3(parsed.dailyYieldWh / 1000),
    checksum_ok: parsed.checksumOk,
    inverter_type: parsed.inverterType,
  };

  // String-Geraet ohne Speicher: die AC-Ausgangsleistung IST die Erzeugung
  // (dieselbe Regel wie kaco-http.js FAMILIES.kaco_http). Eine seltene
  // negative Nachtleistung (Eigenverbrauch der Elektronik) klemmt fuer den
  // PV-Kanal auf 0; meta.ac_kw behaelt das Vorzeichen.
  reading.pv_power_kw = round3(Math.max(0, parsed.acPowerW) / 1000);
  meta.ac_kw = round3(parsed.acPowerW / 1000);
  meta.dc_kw = round3(parsed.dcPowerW / 1000);

  return { reading, meta, address: parsed.address, checksumOk: parsed.checksumOk };
}

/**
 * makeKacoSerialReader - der TCP-Teil: EIN Lesezyklus gegen den
 * RS485-zu-Ethernet-Wandler.
 *
 * Deps: { net, timeoutMs?, replyGapMs? } - `net` ist Node's `net`-Modul
 * (injiziert, damit dieses Modul ohne echten Socket testbar bleibt).
 * Target: { ip, port, address }
 *
 * Ablauf: EINE TCP-Verbindung oeffnen, die Anfrage `#<adr>0\r` schreiben,
 * auf die Antwort warten (laengen-gated + CR-Suche wie `isCmd0Complete`,
 * sonst Leerlauf-Zeitabstand als Rueckfallebene), die Verbindung schliessen,
 * decodieren.
 *
 * ⚠ KEIN Verbindungs-Pooling: der Wandler bedient typischerweise nur EINEN
 * TCP-Client gleichzeitig (genau die "nur eine Modbus-TCP-Verbindung"-Lehre
 * von KACO.md, hier fuer den Wandler statt das Geraet). Jeder Zyklus oeffnet
 * und schliesst seine eigene Verbindung - das haelt den Wandler frei fuer den
 * naechsten Poll, auch wenn der vorige an einem Timeout haengen blieb.
 *
 * Zurueck: Promise<{reading, meta, address, checksumOk} | null>. Ein
 * Verbindungsfehler, ein Timeout oder ein unparsebares Frame liefern `null`
 * (nie einen Wurf) - die Kette bleibt idle-sicher.
 */
function makeKacoSerialReader(deps) {
  const net = deps.net;
  const TIMEOUT_MS = deps.timeoutMs || 5000;
  const REPLY_GAP_MS = deps.replyGapMs || 300;

  return function readKacoSerial(target) {
    target = target || {};
    const ip = typeof target.ip === 'string' ? target.ip.trim() : '';
    const port = Number(target.port) > 0 ? Number(target.port) : DEFAULT_PORT;
    const address = Number.isInteger(target.address) ? target.address : 0;
    if (!ip || address < MIN_ADDRESS || address > MAX_ADDRESS) return Promise.resolve(null);

    let request;
    try {
      request = buildRequest(address, CMD_MEASURE);
    } catch (e) {
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      let settled = false;
      let buf = Buffer.alloc(0);
      let gapTimer = null;
      const sock = new net.Socket();

      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (gapTimer) clearTimeout(gapTimer);
        try { sock.destroy(); } catch (e) { /* ignore */ }
        resolve(value);
      };

      const tryComplete = () => {
        buf = trimLeadingJunk(buf);
        if (isCmd0Complete(buf)) {
          finish(decode(buf));
          return;
        }
        // Leerlauf-Zeitabstand: kein weiteres Byte innerhalb REPLY_GAP_MS
        // nach dem letzten Chunk heisst „Antwort fertig, auch wenn sie nicht
        // laengen-vollstaendig ist" - der Rueckfall fuer eine Teilantwort
        // (z. B. ein Frame ohne den dekorativen Typ-String am Ende, oder ein
        // von einer Buskollision verstuemmeltes Frame).
        if (gapTimer) clearTimeout(gapTimer);
        gapTimer = setTimeout(() => finish(decode(buf)), REPLY_GAP_MS);
      };

      sock.setTimeout(TIMEOUT_MS, () => finish(null));
      sock.on('error', () => finish(null));
      sock.on('close', () => finish(null));
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        tryComplete();
      });

      sock.connect(port, ip, () => {
        try {
          sock.write(request);
        } catch (e) {
          finish(null);
        }
      });
    });
  };
}

module.exports = {
  MIN_ADDRESS,
  MAX_ADDRESS,
  SERIAL_PARAMS,
  DEFAULT_PORT,
  CMD_MEASURE,
  FAMILIES,
  CMD0_MIN_LEN,
  ParseError,
  buildRequest,
  kacoChecksum,
  trimLeadingJunk,
  isCmd0Complete,
  verifyCmd0Checksum,
  parseCmd0,
  decode,
  protocolMismatch,
  replyCommandByte,
  makeKacoSerialReader,
  _offsets: CMD0_OFFSETS,
};
