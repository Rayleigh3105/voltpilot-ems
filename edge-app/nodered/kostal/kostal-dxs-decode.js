'use strict';

/**
 * kostal-dxs-decode - the canonical, unit-tested read path for the classic
 * KOSTAL PIKO 3.0-20 / 10-20 line (brand=kostal, communication=kostal_dxs):
 * the local HTTP-JSON API `/api/dxs.json` of the inverter's OWN web server
 * (port 80), WITHOUT authentication for measurement values. Scout report:
 * firstmate data/vp-kostal-piko20-anbindung/report.md §2.4, §3.1.
 *
 * SCOPE: dreiphasige PIKO mit Weboberflaeche ab UI 06 (PIKO 10/12/15/17/20
 * und die aeltere Bezeichnung PIKO 3.0-20). String-Geraet, kein Speicher - die
 * AC-Ausgangsleistung IST die Erzeugung (dieselbe Lehre wie kaco-http.js
 * FamKacoHTTP). PIKO BA (Batterie) und Altgeraete vor UI 06 sind bewusst NICHT
 * aufgenommen (Bericht §9, inverter.go kostalPikoModels-Kommentar) - die
 * Community-Quellen widersprechen sich ueber das Batterie-Vorzeichen, und ein
 * HTML-Scraper fuer die Altgeraete-Oberflaeche (Login `pvserver`) steht in
 * keinem Verhaeltnis zum Nutzen.
 *
 * Form der Antwort (ohne Login, belegt von mindestens fuenf unabhaengigen
 * Projekten - Bericht §2.4):
 *   GET /api/dxs.json?dxsEntries=<id>&dxsEntries=<id>...
 *   {"dxsEntries":[{"dxsId":67109120,"value":12505.64}, ...],
 *    "session":{"sessionId":0,"roleId":0}, "status":{"code":0}}
 *
 * ⚠ NIE NACH POSITION LESEN. Das Altsystem des Kunden nimmt blind
 * `dxsEntries[0]` ohne zu pruefen, ob der Eintrag zur angefragten Kennung
 * gehoert (Bericht §2.2) - genau der Fehler, den dieses Modul vermeidet:
 * jeder Wert wird ueber seine `dxsId` abgeholt, nie ueber den Index.
 *
 * ⚠ TEXT VS. ZAHL. Die Mess-Kennungen liefern Fliesskommazahlen, die
 * Identitaets-Kennungen (Typ, Seriennummer, Name, Fassungen) liefern Text. Ein
 * Wert vom falschen Typ gilt als ABWESEND, nie als 0 oder leerer Text
 * (dieselbe Disziplin wie `num()` in kaco-http.js).
 *
 * NUR LESEN. Fuer `/api/dxs.json` ist kein Schreibweg dokumentiert (Bericht
 * §2.8) - dieses Modul liest, nichts hier steuert einen Wechselrichter.
 */

const DXS_PATH = '/api/dxs.json';
const DEFAULT_PORT = 80;

/** Die Familie dieses Wegs (ein Decode-Profil fuer die ganze Baureihe). */
const FAMILIES = {
  kostal_piko: { label: 'PIKO (Web-API)' },
};

// --- dxs-Kennungen (Bericht §3.1) --------------------------------------------
const DXS = {
  AC_POWER_W: 67109120,
  DC_POWER_TOTAL_W: 33556736,
  DC1_A: 33555201, DC1_V: 33555202, DC1_W: 33555203,
  DC2_A: 33555457, DC2_V: 33555458, DC2_W: 33555459,
  DC3_A: 33555713, DC3_V: 33555714, DC3_W: 33555715,
  L1_A: 67109377, L1_V: 67109378, L1_W: 67109379,
  L2_A: 67109633, L2_V: 67109634, L2_W: 67109635,
  L3_A: 67109889, L3_V: 67109890, L3_W: 67109891,
  FREQ_HZ: 67110400,
  COS_PHI: 67110656,
  LIMITATION_PCT: 67110144,
  STATUS: 16780032,
  ENERGY_TOTAL_KWH: 251658753,
  ENERGY_TODAY_WH: 251658754,
  OPERATING_HOURS_H: 251658496,
  TYPE: 16780544,
  SERIAL: 16777728,
  NAME: 16777984,
  FW_VERSION: 16779265,
  HW_VERSION: 16779266,
  UI_VERSION: 16779267,
  PAR_VERSION: 16779268,
};

/** Betriebszustand (dxs 16780032) - Namen laut Betriebsanleitung [HB10-20] S. 62. */
const STATUS_LABELS = {
  0: 'Aus',
  1: 'Leerlauf',
  2: 'Anfahren',
  3: 'Einspeisen (MPP)',
  4: 'Einspeisen abgeregelt',
};

/**
 * FAST_IDS - der schnelle Takt: Leistungen, Strings, Phasen, Status,
 * Begrenzung (Bericht §4.6 "Schnell: ein gebuendelter GET mit etwa
 * 22 Kennungen").
 */
const FAST_IDS = [
  DXS.AC_POWER_W, DXS.DC_POWER_TOTAL_W,
  DXS.DC1_A, DXS.DC1_V, DXS.DC1_W,
  DXS.DC2_A, DXS.DC2_V, DXS.DC2_W,
  DXS.DC3_A, DXS.DC3_V, DXS.DC3_W,
  DXS.L1_A, DXS.L1_V, DXS.L1_W,
  DXS.L2_A, DXS.L2_V, DXS.L2_W,
  DXS.L3_A, DXS.L3_V, DXS.L3_W,
  DXS.FREQ_HZ, DXS.COS_PHI, DXS.LIMITATION_PCT, DXS.STATUS,
];

/** SLOW_IDS - einmal je Stunde: die Energiezaehler (Bericht §4.6 "Langsam"). */
const SLOW_IDS = [DXS.ENERGY_TOTAL_KWH, DXS.ENERGY_TODAY_WH, DXS.OPERATING_HOURS_H];

/** IDENTITY_IDS - Typ/Seriennummer/Fassungen, fuer den Verbindungstest. */
const IDENTITY_IDS = [
  DXS.TYPE, DXS.SERIAL, DXS.NAME,
  DXS.FW_VERSION, DXS.HW_VERSION, DXS.UI_VERSION, DXS.PAR_VERSION,
];

/**
 * POLL_IDS - FAST + SLOW in einem Abruf: die VORGABE des regelmaessigen Takts
 * (Bericht §4.6 "Schnell ... Langsam"). IDENTITY_IDS (Typ/Seriennummer/
 * Fassungen) aendern sich zwischen zwei Taktzyklen praktisch nie und werden
 * deshalb NICHT bei jedem Takt mitgelesen - nur beim Verbindungstest
 * (ALL_IDS), um den Webserver nicht staerker zu belasten als noetig.
 */
const POLL_IDS = FAST_IDS.concat(SLOW_IDS);

/** ALL_IDS - POLL_IDS + IDENTITY in einem Abruf, wie "Verbindung testen" ihn braucht. */
const ALL_IDS = POLL_IDS.concat(IDENTITY_IDS);

const round3 = (x) => Math.round(x * 1000) / 1000;
const round1 = (x) => Math.round(x * 10) / 10;

/** num - eine endliche Zahl, sonst null (Text/Wahrheitswert/null zaehlen nicht). */
function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

/** str - ein getrimmter, nicht-leerer Text, sonst null. */
function str(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

/**
 * dxsUrl - die Abruf-URL mit wiederholtem Parameter, wie das Altsystem und
 * jedes Feldprojekt sie bilden (Bericht §2.4).
 */
function dxsUrl(scheme, host, port, ids) {
  scheme = scheme || 'http';
  const p = Number(port) > 0 ? Number(port) : DEFAULT_PORT;
  const q = ids.map((id) => 'dxsEntries=' + id).join('&');
  return scheme + '://' + host + ':' + p + DXS_PATH + '?' + q;
}

/** asObject - JSON aus Buffer/String/Objekt, oder null (dieselbe Form wie kaco-http.js). */
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
 * entriesById - `dxsEntries[]` als Abbildung dxsId -> Rohwert. Ein Eintrag
 * ohne lesbare `dxsId` wird uebersprungen; bei einer wiederholten Kennung
 * gilt der LETZTE Eintrag (JSON-Objekt-Semantik, wie bei einer doppelten
 * JSON-Eigenschaft).
 */
function entriesById(obj) {
  const out = {};
  const list = Array.isArray(obj.dxsEntries) ? obj.dxsEntries : [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const id = num(e.dxsId);
    if (id === null) continue;
    out[id] = e.value;
  }
  return out;
}

/**
 * decode - eine Antwort von `/api/dxs.json` dekodieren.
 *
 * Zurueck: { reading, meta } oder null, wenn kein einziger Kanal lesbar war
 * (leer-nie-erfinden, dieselbe Regel wie jeder andere Leser hier).
 *
 *   reading.pv_power_kw - max(0, AC-Leistung) / 1000; FEHLT, wenn die
 *                         AC-Kennung fehlt oder nicht numerisch ist (Bericht
 *                         §4.6 "wird KEIN pv_power_kw veroeffentlicht").
 *   meta.*               - alles andere (Diagnose/Anzeige, NICHT auf den
 *                         Telemetrie-Bus - dieselbe Trennung wie bei
 *                         kaco-http.js: reading ist der Hausbilanz-Kanal,
 *                         meta ist fuer "Verbindung testen"/Sichtpruefung).
 */
function decode(payload) {
  const obj = asObject(payload);
  if (!obj) return null;
  const byId = entriesById(obj);

  const reading = {};
  const meta = {};

  const ac = num(byId[DXS.AC_POWER_W]);
  if (ac !== null) {
    reading.pv_power_kw = round3(Math.max(0, ac) / 1000);
    meta.ac_kw = round3(ac / 1000);
  }

  const dc = num(byId[DXS.DC_POWER_TOTAL_W]);
  if (dc !== null) meta.dc_kw = round3(dc / 1000);

  const strings = [['dc1', DXS.DC1_V, DXS.DC1_A, DXS.DC1_W],
    ['dc2', DXS.DC2_V, DXS.DC2_A, DXS.DC2_W],
    ['dc3', DXS.DC3_V, DXS.DC3_A, DXS.DC3_W]];
  for (const [key, vId, aId, wId] of strings) {
    const v = num(byId[vId]);
    const a = num(byId[aId]);
    const w = num(byId[wId]);
    if (v !== null) meta[key + '_v'] = round1(v);
    if (a !== null) meta[key + '_a'] = round3(a);
    if (w !== null) meta[key + '_w'] = round1(w);
  }

  const phases = [['l1', DXS.L1_V, DXS.L1_A, DXS.L1_W],
    ['l2', DXS.L2_V, DXS.L2_A, DXS.L2_W],
    ['l3', DXS.L3_V, DXS.L3_A, DXS.L3_W]];
  for (const [key, vId, aId, wId] of phases) {
    const v = num(byId[vId]);
    const a = num(byId[aId]);
    const w = num(byId[wId]);
    if (v !== null) meta[key + '_v'] = round1(v);
    if (a !== null) meta[key + '_a'] = round3(a);
    if (w !== null) meta[key + '_w'] = round1(w);
  }

  const freq = num(byId[DXS.FREQ_HZ]);
  if (freq !== null) meta.freq_hz = round3(freq);
  const cosPhi = num(byId[DXS.COS_PHI]);
  if (cosPhi !== null) meta.cos_phi = round3(cosPhi);
  const limit = num(byId[DXS.LIMITATION_PCT]);
  if (limit !== null) meta.limitation_pct = round1(limit);

  const status = num(byId[DXS.STATUS]);
  if (status !== null) {
    meta.status = status;
    meta.status_text = STATUS_LABELS[status] || ('unbekannt (' + status + ')');
  }

  const energyTotal = num(byId[DXS.ENERGY_TOTAL_KWH]);
  if (energyTotal !== null) meta.energy_total_kwh = round1(energyTotal);
  const energyToday = num(byId[DXS.ENERGY_TODAY_WH]);
  // Rohwert in Wh (Bericht §3.1, Zeile 251658754) - fuer VoltPilot nach kWh.
  if (energyToday !== null) meta.energy_today_kwh = round3(energyToday / 1000);
  const hours = num(byId[DXS.OPERATING_HOURS_H]);
  if (hours !== null) meta.operating_hours_h = hours;

  const type = str(byId[DXS.TYPE]);
  if (type !== null) meta.type = type;
  const serial = str(byId[DXS.SERIAL]);
  if (serial !== null) meta.serial = serial;
  const name = str(byId[DXS.NAME]);
  if (name !== null) meta.name = name;
  const fw = str(byId[DXS.FW_VERSION]);
  if (fw !== null) meta.fw_version = fw;
  const hw = str(byId[DXS.HW_VERSION]);
  if (hw !== null) meta.hw_version = hw;
  const ui = str(byId[DXS.UI_VERSION]);
  if (ui !== null) meta.ui_version = ui;
  const par = str(byId[DXS.PAR_VERSION]);
  if (par !== null) meta.par_version = par;

  if (Object.keys(reading).length === 0 && Object.keys(meta).length === 0) return null;
  return { reading, meta };
}

/**
 * makeKostalDxsReader - der HTTP-Teil: EIN GET je Zyklus.
 *
 * Deps: { http, https, timeoutMs? } (dieselbe Form wie kaco-http.js).
 * Target: { ip, port?, scheme?, insecureTls?, ids? } - `ids` fehlt bei jedem
 * regelmaessigen Takt (Vorgabe `POLL_IDS`); der Verbindungstest ruft explizit
 * mit `ids: ALL_IDS` auf, um zusaetzlich Typ/Seriennummer/Fassungen zu lesen.
 *
 * Es gibt KEINE Seriennummer/Anmeldung zu klaeren (anders als kaco_http) -
 * die Web-API antwortet ohne Login (Bericht §2.4). Ein gebuendelter Abruf
 * haelt die Abrufrate wie beim Altsystem (eine Anfrage je Takt statt vieler),
 * siehe Bericht §4.6 "Last und Antwortzeit".
 *
 * Zurueck: Promise<{reading, meta} | null>.
 */
function makeKostalDxsReader(deps) {
  const httpMod = deps.http;
  const httpsMod = deps.https;
  const TIMEOUT_MS = deps.timeoutMs || 4000; // 3-4s, NICHT 8s wie go-e (Bericht §4.6)

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

  return async function readKostalDxs(target) {
    target = target || {};
    const ip = typeof target.ip === 'string' ? target.ip.trim() : '';
    if (!ip) return null;
    const port = Number(target.port) > 0 ? Number(target.port) : DEFAULT_PORT;
    const scheme = target.scheme || 'http';
    const ids = Array.isArray(target.ids) && target.ids.length > 0 ? target.ids : POLL_IDS;
    const url = dxsUrl(scheme, ip, port, ids);
    const body = await get(url, !!target.insecureTls);
    if (body === null) return null;
    return decode(body);
  };
}

module.exports = {
  DXS,
  FAMILIES,
  STATUS_LABELS,
  DXS_PATH,
  DEFAULT_PORT,
  FAST_IDS,
  SLOW_IDS,
  IDENTITY_IDS,
  POLL_IDS,
  ALL_IDS,
  dxsUrl,
  decode,
  makeKostalDxsReader,
  _helpers: { num, str, entriesById, round1, round3 },
};
