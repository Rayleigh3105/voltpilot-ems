'use strict';

/**
 * kaco-http - the canonical, unit-tested read path for the AISWEI/Solplanet
 * platform KACO sells as blueplanet **NX1 M2 / NX3 M2 / NX3 M3 / NX3 M5** and
 * hybrid **NH3**: the local **HTTP-JSON API on port 8484** of the
 * communication unit (WiFi/LAN stick "Connect-GEN2"/"Connect-NH", an ESP32).
 * Scout report: firstmate `data/vp-kaco-palette-y6` §3.2.
 *
 * ⚠ WARUM HTTP UND NICHT MODBUS DER VORGABE-WEG IST - der eine Satz, an dem
 * die ganze Wahl haengt: der Stick kennt die Betriebsmodi „Datenupload /
 * SmartCloud" ODER „Modbus TCP IP Server", **nie beides**. Wer Modbus TCP am
 * Stick einschaltet, nimmt dem Kunden seine KACO-App und die Cloud. Die
 * HTTP-8484-Schnittstelle laeuft dagegen PARALLEL zur Cloud weiter. Deshalb ist
 * sie der Vorgabe-Weg dieser Plattform und SunSpec-ueber-den-Stick der
 * Experten-Ausweg mit ehrlichem Hinweis (KACO.md §8).
 *
 * Endpunkte (alle GET, ohne Authentifizierung, im LAN):
 *   /getdev.cgi?device=2            -> das INVENTAR: `inv[]` mit `isn`
 *                                      (Wechselrichter-Seriennummer, der
 *                                      Schluessel aller weiteren Abrufe),
 *                                      `add` (Modbus-Adresse), `rate` (VA).
 *   /getdevdata.cgi?device=2&sn=..  -> Wechselrichter (AC + DC-Strings)
 *   /getdevdata.cgi?device=3&sn=..  -> Zaehler (Netzleistung)
 *   /getdevdata.cgi?device=4&sn=..  -> Batterie (pb/soc/vb/cb/soh)
 *
 * Dieses Modul besitzt AUSSCHLIESSLICH die Decodierung + die Endpunkt-Pfade. Es
 * ist abhaengigkeitsfrei (kein `require`, kein Socket/HTTP-Code) und damit
 * offline vollstaendig testbar (kaco-http.test.js). Der HTTP-Client wohnt im
 * Node-RED-Funktionsknoten, der eine KOPIE dieser Decodierung traegt (ein
 * Node-RED-Flow ist selbstenthaltendes JSON und kann keine Repo-Datei
 * `require`n); `flows-sync.test.js` nagelt die Kopie gegen dieses Modul.
 *
 * NUR LESEN. Nichts hier steuert einen Wechselrichter.
 */

// --- Endpunkte ---------------------------------------------------------------

const DEV_PATH = '/getdev.cgi';
const DEVDATA_PATH = '/getdevdata.cgi';

/** Die drei Geraete-Nummern der 8484-API. */
const DEVICE_INVERTER = 2;
const DEVICE_METER = 3;
const DEVICE_BATTERY = 4;

const DEFAULT_PORT = 8484;

// --- Familien ----------------------------------------------------------------
//
// ⚠ ZWEI Familien, nicht eine - und der Grund ist die PV-QUELLE, dieselbe
// Lehre, die `sunspec-live.js` fuer Fronius-Hybride aufgeschrieben hat:
//
//   - Ein STRING-Geraet (NX1/NX3) hat keine Batterie. Seine AC-Ausgangsleistung
//     `pac` IST die Erzeugung.
//   - Ein HYBRID (NH3) rechnet `pac` = PV + Entladung - Ladung. `pac` als PV zu
//     veroeffentlichen bliese die Erzeugung um die Entladung auf. Deshalb kommt
//     die PV dort aus der DC-Seite (Summe der Strings, `vpv[]` x `ipv[]`).
//
// Der Scout-Report skizzierte EINE `kaco_http`-Familie, weil er den NH3 ueber
// die AISWEI-Registerkarte lesen wollte. Sobald der Hybrid ueber HTTP der
// Vorgabe-Weg ist, muss die Familie die Frage „hat das Geraet eine Batterie?"
// beantworten koennen - eine geratene Antwort waere genau der Fehler, den die
// Fronius-Hybrid-Regel benennt.
const FAMILIES = {
  kaco_http: {
    label: 'KACO NX (App-Schnittstelle)',
    hasBattery: false,
    // Die AC-Ausgangsleistung IST die Erzeugung.
    pvSource: 'ac',
  },
  kaco_http_hybrid: {
    label: 'KACO hybrid NH3 (App-Schnittstelle)',
    hasBattery: true,
    // PV aus der DC-Seite; `pac` waere PV + Entladung - Ladung.
    pvSource: 'dc',
  },
};

// --- Skalierungen (Report §3.2, HA `solplanet` + trixing/kaco-http) ----------
//
// Die API liefert ganze Zahlen mit festen Faktoren. Sie sind hier EINMAL
// benannt, damit kein Aufrufer sie nachbaut.
const SCALE = {
  PAC_W: 1, // Wirkleistung in W
  FAC_CHZ: 0.01, // Netzfrequenz in cHz -> Hz
  ETO_KWH: 0.1, // Energie gesamt in 0,1 kWh
  ETD_KWH: 0.1, // Energie heute in 0,1 kWh
  TMP_C: 0.1, // Temperatur in 0,1 °C
  VAC_V: 0.1, // AC-Spannung in 0,1 V
  IAC_A: 0.1, // AC-Strom in 0,1 A
  VPV_V: 0.1, // DC-Strang-Spannung in 0,1 V
  IPV_A: 0.01, // DC-Strang-Strom in 0,01 A
  VB_V: 0.01, // Batteriespannung in 0,01 V
  CB_A: 0.1, // Batteriestrom in 0,1 A
};

const round3 = (x) => Math.round(x * 1000) / 1000;
const round1 = (x) => Math.round(x * 10) / 10;

/** num - eine endliche Zahl, sonst null (die API schickt `null`/fehlende Felder). */
function num(v) {
  const n = typeof v === 'string' ? Number(v.trim()) : v;
  return typeof n === 'number' && isFinite(n) ? n : null;
}

/**
 * socPlausible - woertlich die Regel aus `deye/deye-decode.js`: ein SoC
 * ausserhalb (0, 100] ist ein Kommunikations-Artefakt, keine Tatsache. Ein
 * exaktes 0 ist die Signatur „keine brauchbare Antwort" (kein Speicher, oder
 * ein Nullblock) - der Kanal faellt WEG, es wird nie eine 0 erfunden.
 */
function socPlausible(p) {
  return typeof p === 'number' && isFinite(p) && p > 0 && p <= 100;
}

/** Basis-URL des Sticks. */
function baseUrl(scheme, host, port) {
  return scheme + '://' + host + ':' + port;
}

/** Das Inventar: liefert `inv[]` mit den Seriennummern (`isn`). */
function inventoryUrl(scheme, host, port) {
  return baseUrl(scheme, host, port) + DEV_PATH + '?device=' + DEVICE_INVERTER;
}

/** Die Messwerte EINES Geraets (2 = Wechselrichter, 3 = Zaehler, 4 = Batterie). */
function devDataUrl(scheme, host, port, device, serial) {
  return baseUrl(scheme, host, port) + DEVDATA_PATH +
    '?device=' + device + '&sn=' + encodeURIComponent(String(serial == null ? '' : serial));
}

/**
 * parseInventory - aus `/getdev.cgi?device=2` die Wechselrichter-Liste.
 *
 * Zurueck kommt `[{ serial, address, ratedVa }]` - `serial` ist der `isn`, mit
 * dem jeder weitere Abruf adressiert wird. Eine unbrauchbare Antwort ergibt
 * `[]` (nie ein Wurf): der Verbindungstest sagt dann ehrlich, dass er keine
 * Seriennummer gefunden hat.
 *
 * ⚠ DIE SERIENNUMMER WIRD NIE GERATEN. Sie ist ein Pflicht-Parameter der
 * Messwert-Abrufe; ohne sie liefert der Stick nichts. Deshalb ist das Feld im
 * Formular OPTIONAL und wird vom Verbindungstest gefuellt - eine abgetippte
 * Nummer ist die haeufigste Fehlerquelle dieser Plattform.
 */
function parseInventory(payload) {
  let obj = payload;
  if (Buffer.isBuffer(payload) || typeof payload === 'string') {
    try {
      obj = JSON.parse(payload.toString());
    } catch (e) {
      return [];
    }
  }
  if (!obj || typeof obj !== 'object') return [];
  const list = Array.isArray(obj.inv) ? obj.inv : [];
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const serial = typeof e.isn === 'string' ? e.isn.trim() : '';
    if (!serial) continue;
    out.push({
      serial,
      address: num(e.add),
      ratedVa: num(e.rate),
    });
  }
  return out;
}

/** JSON aus Buffer/String/Objekt, oder null. */
function asObject(payload) {
  let obj = payload;
  if (Buffer.isBuffer(payload) || typeof payload === 'string') {
    try {
      obj = JSON.parse(payload.toString());
    } catch (e) {
      return null;
    }
  }
  return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
}

/**
 * stringPowerW - die DC-Eingangsleistung aus den Strang-Werten:
 * Summe(vpv[i] x ipv[i]) mit den dokumentierten Faktoren.
 *
 * Sie ist die PV-Quelle eines HYBRIDEN (siehe FAMILIES). Fehlt eines der beiden
 * Felder oder haben sie verschiedene Laengen, kommt `null` zurueck - eine
 * halb gerechnete Summe waere eine erfundene Erzeugung.
 *
 * ⚠ AM GERAET ZU PRUEFEN: dass `vpv`/`ipv` wirklich alle Strings des NH3
 * enthalten (2 MPPT beim M2, 3 beim M3). Ein fehlender Strang macht die PV zu
 * klein und die Hausrechnung falsch.
 */
function stringPowerW(obj) {
  const v = Array.isArray(obj.vpv) ? obj.vpv : null;
  const i = Array.isArray(obj.ipv) ? obj.ipv : null;
  if (!v || !i || v.length === 0 || v.length !== i.length) return null;
  let sum = 0;
  let any = false;
  for (let k = 0; k < v.length; k++) {
    const vv = num(v[k]);
    const ii = num(i[k]);
    if (vv === null || ii === null) return null;
    sum += vv * SCALE.VPV_V * ii * SCALE.IPV_A;
    any = true;
  }
  return any ? sum : null;
}

/**
 * decodeInverter - `/getdevdata.cgi?device=2`.
 *
 *   opts: { family } - entscheidet die PV-Quelle (siehe FAMILIES).
 *
 * Zurueck: { reading, meta } oder null, wenn nicht ein einziger Kanal
 * decodiert werden konnte (leer-nie-erfinden).
 */
function decodeInverter(payload, opts) {
  const obj = asObject(payload);
  if (!obj) return null;
  const fam = FAMILIES[(opts && opts.family) || ''] || FAMILIES.kaco_http;

  const reading = {};
  const meta = {};

  const pac = num(obj.pac);
  if (pac !== null) meta.ac_kw = round3(pac * SCALE.PAC_W / 1000);

  if (fam.pvSource === 'dc') {
    // Hybrid: die PV kommt aus der DC-Seite. Ohne lesbare Strang-Werte wird
    // NICHTS veroeffentlicht - die AC-Leistung waere hier PV + Entladung.
    const dc = stringPowerW(obj);
    if (dc !== null) {
      // Kein einseitiges Klemmen: ein Vorzeichen-/Skalenfehler soll als
      // SICHTBARE negative Zahl auffallen, nicht still als 0 verschwinden.
      reading.pv_power_kw = round3(dc / 1000);
      meta.pvSource = 'dc';
    }
  } else if (pac !== null) {
    // String-Geraet: die AC-Ausgangsleistung IST die Erzeugung. Eine seltene
    // negative Nachtleistung (Eigenverbrauch) klemmt fuer den PV-Kanal auf 0,
    // waehrend `meta.ac_kw` den vorzeichenbehafteten Wert behaelt.
    reading.pv_power_kw = round3(Math.max(0, pac * SCALE.PAC_W) / 1000);
    meta.pvSource = 'ac';
  }

  const fac = num(obj.fac);
  if (fac !== null) meta.hz = round3(fac * SCALE.FAC_CHZ);
  const tmp = num(obj.tmp);
  if (tmp !== null) meta.temp_c = round1(tmp * SCALE.TMP_C);
  const eto = num(obj.eto);
  if (eto !== null) meta.energy_total_kwh = round1(eto * SCALE.ETO_KWH);
  const etd = num(obj.etd);
  if (etd !== null) meta.energy_today_kwh = round1(etd * SCALE.ETD_KWH);
  const err = num(obj.err);
  if (err !== null) meta.err = err;

  if (Object.keys(reading).length === 0 && Object.keys(meta).length === 0) return null;
  return { reading, meta };
}

/**
 * decodeMeter - `/getdevdata.cgi?device=3`: `pac` ist die Netzleistung am
 * Anschlusspunkt, **+ Bezug / - Einspeisung** - genau VoltPilots Konvention.
 *
 *   opts: { invertGridSign }  - der Ausweg, falls die Kalibrierung sie
 *                               vertauscht findet (VERIFY-on-device).
 */
function decodeMeter(payload, opts) {
  const obj = asObject(payload);
  if (!obj) return null;
  const pac = num(obj.pac);
  if (pac === null) return null;
  const sign = opts && opts.invertGridSign ? -1 : 1;
  return { reading: { power_kw: round3(sign * pac * SCALE.PAC_W / 1000) }, meta: {} };
}

/**
 * decodeBattery - `/getdevdata.cgi?device=4`: der Speicher des NH3.
 *
 * ⚠ VORZEICHEN, AM GERAET ZU PRUEFEN: die AISWEI-Registerkarte dokumentiert
 * fuer den SCHREIB-Sollwert (41153) ausdruecklich **„- laden / + entladen"**.
 * Wir uebernehmen diese Konvention auch fuer den GELESENEN Wert `pb`, weil ein
 * Hersteller innerhalb einer Plattform konsistent ist, und NEGIEREN ihn:
 * VoltPilot fuehrt `battery_power_kw` als **+ Ladung / - Entladung**. Das ist
 * eine begruendete Annahme, kein Beleg - `invert_batt_sign` ist der Ausweg,
 * und der First-Light-Schritt beweist es (KACO.md §9, CONTROL-BENCH.md).
 *
 * Der SoC faellt weg, wenn er ausserhalb (0, 100] liegt (socPlausible) - nie
 * eine erfundene 0. `battKw` reist separat zurueck wie bei den anderen
 * Decodern: der Flow legt ihn als `battery_power_kw` auf den LOKALEN Bus.
 */
function decodeBattery(payload, opts) {
  const obj = asObject(payload);
  if (!obj) return null;

  const reading = {};
  const meta = {};

  const soc = num(obj.soc);
  if (socPlausible(soc)) reading.soc_pct = round1(soc);

  let battKw = null;
  const pb = num(obj.pb);
  if (pb !== null) {
    const sign = opts && opts.invertBattSign ? 1 : -1; // Vorgabe: negieren (siehe oben)
    battKw = round3(sign * pb / 1000);
  }

  const vb = num(obj.vb);
  if (vb !== null) meta.battery_v = round1(vb * SCALE.VB_V);
  const cb = num(obj.cb);
  if (cb !== null) meta.battery_a = round1(cb * SCALE.CB_A);
  const soh = num(obj.soh);
  if (soh !== null) meta.soh_pct = round1(soh);
  const cst = num(obj.cst);
  if (cst !== null) meta.charge_state = cst;
  const bst = num(obj.bst);
  if (bst !== null) meta.battery_state = bst;

  if (Object.keys(reading).length === 0 && battKw === null && Object.keys(meta).length === 0) {
    return null;
  }
  return { reading, battKw, meta };
}

/**
 * decode - die drei Antworten zu EINER Messung zusammensetzen.
 *
 *   parts: { inverter?, meter?, battery? } - je die rohe Antwort (Buffer /
 *          String / Objekt). Eine FEHLENDE oder unlesbare Antwort laesst ihre
 *          Kanaele einfach WEG (abwesend, nie 0) - genau das Verhalten, das
 *          eine Anlage nachts braucht, wenn Stick und Wechselrichter
 *          herunterfahren und die Abrufe in Timeouts laufen.
 *
 * Zurueck: { reading, battKw, meta } oder null, wenn nichts decodierbar war.
 */
function decode(parts, opts) {
  parts = parts || {};
  opts = opts || {};
  const reading = {};
  const meta = {};
  let battKw = null;

  const inv = decodeInverter(parts.inverter, opts);
  if (inv) {
    Object.assign(reading, inv.reading);
    Object.assign(meta, inv.meta);
  }
  const met = decodeMeter(parts.meter, opts);
  if (met) Object.assign(reading, met.reading);
  const bat = decodeBattery(parts.battery, opts);
  if (bat) {
    Object.assign(reading, bat.reading);
    Object.assign(meta, bat.meta);
    battKw = bat.battKw;
  }

  if (Object.keys(reading).length === 0 && battKw === null) return null;
  return { reading, battKw, meta };
}

/**
 * makeKacoHttpReader - der HTTP-Teil: EIN Lesezyklus ueber die 8484-API.
 *
 * Deps: { http, https, timeoutMs? }
 * Target: { ip, port?, scheme?, insecureTls?, serial?, family?,
 *           hasBattery?, invertGridSign?, invertBattSign? }
 *
 * Ablauf:
 *   1. Ohne Seriennummer zuerst das INVENTAR (`getdev.cgi?device=2`) - die
 *      Nummer wird nie geraten. Findet sich keine, endet der Lauf mit null.
 *   2. Wechselrichter (device=2), Zaehler (device=3) und - nur bei einer
 *      Batterie-Familie - Speicher (device=4).
 *
 * ⚠ JEDER ABRUF IST EINZELN FEHLER-ISOLIERT. Nachts fahren Stick und
 * Wechselrichter herunter und die Abrufe laufen in Timeouts; was zurueckkommt,
 * wird getragen, der Rest ist ABWESEND - nie eine erfundene 0.
 *
 * Zurueck: Promise<{reading, battKw, meta, serial} | null>. `serial` ist die
 * benutzte Nummer, damit der Verbindungstest sie ins Formular zurueckgeben kann.
 */
function makeKacoHttpReader(deps) {
  const httpMod = deps.http;
  const httpsMod = deps.https;
  const TIMEOUT_MS = deps.timeoutMs || 8000;

  // EIN GET, aufgeloest zu Text oder null (nie ein Wurf).
  function get(url, insecure) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      const isHttps = url.slice(0, 6) === 'https:';
      const mod = isHttps ? httpsMod : httpMod;
      const opts = isHttps && insecure ? { rejectUnauthorized: false } : {};
      let req;
      try {
        req = mod.get(url, opts, (res) => {
          if (res.statusCode !== 200) { res.resume(); return finish(null); }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { body += c; });
          res.on('end', () => finish(body));
          res.on('error', () => finish(null));
        });
      } catch (e) {
        return finish(null);
      }
      req.setTimeout(TIMEOUT_MS, () => { try { req.destroy(); } catch (e) { /* ignore */ } finish(null); });
      req.on('error', () => finish(null));
    });
  }

  return async function readKaco(target) {
    target = target || {};
    const ip = typeof target.ip === 'string' ? target.ip.trim() : '';
    if (!ip) return null;
    const port = Number(target.port) > 0 ? Number(target.port) : DEFAULT_PORT;
    const insecure = !!target.insecureTls;
    const scheme = target.scheme === 'https' || insecure ? 'https' : 'http';
    const family = target.family || 'kaco_http';
    const hasBattery = target.hasBattery !== undefined
      ? !!target.hasBattery
      : !!(FAMILIES[family] || {}).hasBattery;

    let serial = typeof target.serial === 'string' ? target.serial.trim() : '';
    if (!serial) {
      const inv = parseInventory(await get(inventoryUrl(scheme, ip, port), insecure));
      if (!inv.length) return null; // ohne Seriennummer gibt es keinen Messwert-Abruf
      serial = inv[0].serial;
    }

    const [inverter, meter, battery] = await Promise.all([
      get(devDataUrl(scheme, ip, port, DEVICE_INVERTER, serial), insecure),
      get(devDataUrl(scheme, ip, port, DEVICE_METER, serial), insecure),
      hasBattery ? get(devDataUrl(scheme, ip, port, DEVICE_BATTERY, serial), insecure) : Promise.resolve(null),
    ]);

    const out = decode({ inverter, meter, battery }, {
      family,
      invertGridSign: !!target.invertGridSign,
      invertBattSign: !!target.invertBattSign,
    });
    if (!out) return null;
    out.serial = serial;
    return out;
  };
}

module.exports = {
  DEV_PATH,
  DEVDATA_PATH,
  DEVICE_INVERTER,
  DEVICE_METER,
  DEVICE_BATTERY,
  DEFAULT_PORT,
  FAMILIES,
  SCALE,
  baseUrl,
  inventoryUrl,
  devDataUrl,
  parseInventory,
  decodeInverter,
  decodeMeter,
  decodeBattery,
  decode,
  makeKacoHttpReader,
  socPlausible,
  _helpers: { num, round3, round1, stringPowerW },
};
