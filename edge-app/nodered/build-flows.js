'use strict';
/*
 * build-flows.js - deterministic generator for flows.json.
 *
 * flows.json is Node-RED's self-contained flow document; its function nodes
 * carry COPIES of the repo codecs (a flow cannot `require` a repo file at
 * runtime). Hand-editing the escaped JSON strings is error-prone, so this
 * script assembles the document from readable sources and is IDEMPOTENT
 * (re-running reproduces flows.json byte-for-byte). It preserves two things
 * VERBATIM from the existing flows.json:
 *   - the "SunSpec (Simulator)" tab + config nodes (kept for the hardware-free
 *     e2e), and
 *   - the Deye Solarman-V5 reader + decoder function bodies (`auto-solarman` /
 *     `auto-deye-decode`, synced copies of deye/solarman-v5.js +
 *     deye/deye-decode.js) - so those bodies are edited in the module + the
 *     flow node, and the generator carries them through untouched.
 * Everything else (the router, the store/idle nodes, the generic Modbus reader
 * + decoder, wiring, layout) is authored HERE as readable JS.
 *
 * Run: node build-flows.js   (writes flows.json; idempotent). flows.json is the
 * committed artifact, so the generator is a reformatter, not a bootstrap.
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'flows.json');
const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
const byId = Object.fromEntries(prev.map((n) => [n.id, n]));

const need = (id) => {
  if (!byId[id]) throw new Error('build-flows.js: node "' + id + '" missing from flows.json (the generator preserves it; do not delete it by hand)');
  return byId[id];
};

// --- keep verbatim: config nodes + the sim READ nodes ------------------------
const keepConfig = ['cfg-vp-core', 'cfg-mb-sim'].map(need);
// The Simulator tab's READ path is preserved verbatim (poll -> FC3 read ->
// decode -> telemetry/status); only its WRITE path is replaced by the control
// adapter (controlRoute + write/readback), authored below.
const simReadNodes = ['sim-note', 'sim-poll', 'sim-read', 'sim-decode', 'sim-telemetrie', 'sim-status', 'sim-linkwatch'].map(need);
const simTab = need('tab-sim');

// --- reuse verbatim: the tested Deye reader + decoder function bodies ---------
const solarmanFunc = need('auto-solarman').func; // Solarman-V5 socket reader (copy of deye/solarman-v5.js)
const deyeDecodeFunc = need('auto-deye-decode').func; // register -> reading (copy of deye/deye-decode.js)

// --- the self-wiring tab -----------------------------------------------------
const TAB = 'tab-auto';

const routerFunc = [
  "// Router / Leseplan - das Herzstueck der Selbstverdrahtung: liest die aktive",
  "// Wechselrichter-Auswahl aus dem Flow-Kontext (von vp-inverter-config gesetzt)",
  "// und waehlt GENAU EINEN Lesepfad. Synchron gehalten mit",
  "// edge-app/nodered/inverter-routing.js (route) + den Registerkarten aus",
  "// deye/deye-decode.js und modbus-tcp.js.",
  "//   Ausgang 1: Deye Solarman-V5   (msg.deye)",
  "//   Ausgang 2: generisches Modbus (msg.mb)",
  "//   Ausgang 3: untaetig           (keine/unbekannte Auswahl)",
  "const DEYE_READS = {",
  "  string:    [{ start: 0x0050, count: 0x0002 }],",
  "  hybrid_1p: [{ start: 0x00a9, count: 0x0016 }],",
  "  hybrid_3p: [{ start: 0x024c, count: 0x0058 }],",
  "  micro:     [{ start: 0x0056, count: 0x0002 }]",
  "};",
  "const MODBUS_PROFILES = { sunspec: { fc: 3, addr: 0, count: 9 } };",
  "const num = (v, d) => { const n = typeof v === 'string' ? Number(v.trim()) : v; return (typeof n === 'number' && isFinite(n)) ? n : d; };",
  "const idle = (reason) => { node.status({ fill: 'grey', shape: 'ring', text: reason }); msg.idle = reason; return [null, null, msg]; };",
  "const sel = flow.get('inverter_config');",
  "if (!sel) return idle('keine Auswahl');",
  "const conn = sel.connection || {};",
  "const ip = (typeof conn.ip === 'string' ? conn.ip : '').trim();",
  "if (!ip) return idle('keine IP-Adresse');",
  "if (sel.communication === 'solarman_v5') {",
  "  const reads = DEYE_READS[sel.family];",
  "  if (!reads) return idle('unbekannte Deye-Familie: ' + sel.family);",
  "  const serial = conn.serial;",
  "  if (serial === undefined || serial === null || serial === '' || !(Number(serial) > 0)) return idle('Datenlogger-Seriennummer fehlt');",
  "  const port = num(conn.port, 8899);",
  "  const cfg = {",
  "    ip, port, serial,",
  "    mb_slave_id: num(conn.mb_slave_id, 1),",
  "    family: sel.family,",
  "    invert_grid_sign: !!conn.invert_grid_sign,",
  "    invert_batt_sign: !!conn.invert_batt_sign,",
  "    power_scale: num(conn.power_scale, 1) > 0 ? num(conn.power_scale, 1) : 1",
  "  };",
  "  msg.deye = { cfg, target: ip + ':' + port, reads: reads.map((r) => ({ start: r.start, count: r.count })), i: 0, blocks: [] };",
  "  node.status({ fill: 'blue', shape: 'dot', text: 'Deye ' + sel.family + ' -> Solarman-V5' });",
  "  return [msg, null, null];",
  "}",
  "if (sel.communication === 'modbus_tcp') {",
  "  const read = MODBUS_PROFILES[sel.family];",
  "  if (!read) return idle('unbekanntes Modbus-Profil: ' + sel.family);",
  "  const port = num(conn.port, 502);",
  "  msg.mb = { conn: { ip, port, unit_id: num(conn.unit_id, 1) }, profile: sel.family, read: { fc: read.fc, addr: read.addr, count: read.count }, target: ip + ':' + port };",
  "  node.status({ fill: 'blue', shape: 'dot', text: 'Modbus ' + sel.family + ' @ ' + ip + ':' + port });",
  "  return [null, msg, null];",
  "}",
  "return idle('unbekannte Kommunikationsmethode');",
].join('\n');

const storeFunc = [
  "// Uebernimmt die im Edge-App-Portal getroffene Wechselrichter-Auswahl",
  "// (retained auf edge/inverter/config, von vp-inverter-config geparst) in den",
  "// Flow-Kontext. Der Router unten liest sie bei jedem Poll - so verdrahtet sich",
  "// der Flow selbst, ohne Edit pro Kunde. payload === null => Auswahl geloescht.",
  "const sel = msg.payload || null;",
  "flow.set('inverter_config', sel);",
  "if (sel) {",
  "  node.status({ fill: 'green', shape: 'dot', text: (sel.label || sel.brand || sel.family) + ' (' + sel.communication + ')' });",
  "} else {",
  "  node.status({ fill: 'grey', shape: 'ring', text: 'Auswahl zurueckgesetzt' });",
  "}",
  "return null;",
].join('\n');

const modbusReadFunc = [
  "// Generischer Modbus-TCP-Leser (FC3, Holding Registers): eine geordnete",
  "// TCP-Verbindung pro Poll, ein Registerblock, TCP-Segmente reassembliert.",
  "// Traegt eine KOPIE des Codecs aus edge-app/nodered/modbus-tcp.js",
  "// (buildReadRequest/expectedFrameLength/parseReadResponse) - beide synchron",
  "// halten (ein Node-RED-Flow ist self-contained JSON und kann keine Repo-Datei",
  "// zur Laufzeit requiren). Quelle der Wahrheit + Offline-Tests: modbus-tcp.js.",
  "const net = global.get('net');",
  "if (!net) { node.status({ fill: 'red', shape: 'ring', text: 'net fehlt (settings.js)' }); node.error('functionGlobalContext.net in settings.js setzen', msg); return null; }",
  "const mb = msg.mb;",
  "if (!mb) return null;",
  "const conn = mb.conn;",
  "const unitId = conn.unit_id || 1;",
  "const timeoutMs = conn.timeout_ms || 5000;",
  "const buildReq = (txid, addr, count) => { const b = Buffer.alloc(12); b.writeUInt16BE(txid & 0xffff, 0); b.writeUInt16BE(0, 2); b.writeUInt16BE(6, 4); b[6] = unitId & 0xff; b[7] = 0x03; b.writeUInt16BE(addr & 0xffff, 8); b.writeUInt16BE(count & 0xffff, 10); return b; };",
  "const frameLen = (buf) => (buf.length < 6 ? null : 6 + buf.readUInt16BE(4));",
  "const parseResp = (buf, txid) => {",
  "  if (buf.length < 9) throw new Error('Antwort zu kurz');",
  "  if (buf.readUInt16BE(2) !== 0) throw new Error('Protokoll-ID');",
  "  if (buf.readUInt16BE(0) !== (txid & 0xffff)) throw new Error('Transaktions-ID weicht ab');",
  "  const fn = buf[7];",
  "  if (fn & 0x80) throw new Error('Modbus-Ausnahme 0x' + (buf[8] || 0).toString(16));",
  "  if (fn !== 0x03) throw new Error('Modbus-Funktion 0x' + fn.toString(16));",
  "  const bc = buf[8];",
  "  if (bc <= 0 || buf.length < 9 + bc) throw new Error('Nutzlast unvollstaendig');",
  "  const regs = []; for (let i = 0; i < bc >> 1; i++) regs.push(buf.readUInt16BE(9 + i * 2)); return regs;",
  "};",
  "let txid = context.get('txid') || 0;",
  "return new Promise((resolve) => {",
  "  const sock = new net.Socket();",
  "  sock.setNoDelay(true);",
  "  let done = false;",
  "  let acc = Buffer.alloc(0);",
  "  const finish = (err) => { if (done) return; done = true; try { sock.destroy(); } catch (e) { /* ignore */ } if (err) { node.status({ fill: 'red', shape: 'ring', text: 'Modbus: ' + err.message }); resolve(null); } else { resolve(msg); } };",
  "  const t = setTimeout(() => finish(new Error('Timeout')), timeoutMs);",
  "  txid = (txid + 1) & 0xffff; context.set('txid', txid);",
  "  sock.once('error', (e) => { clearTimeout(t); finish(e); });",
  "  sock.connect(conn.port || 502, conn.ip, () => {",
  "    sock.on('data', (chunk) => {",
  "      acc = Buffer.concat([acc, chunk]);",
  "      const need = frameLen(acc);",
  "      if (need !== null && acc.length >= need) { clearTimeout(t); try { mb.regs = parseResp(acc.slice(0, need), txid); finish(); } catch (e) { finish(e); } }",
  "    });",
  "    sock.write(buildReq(txid, mb.read.addr, mb.read.count));",
  "  });",
  "});",
].join('\n');

const modbusDecodeFunc = [
  "// Decodiert den Modbus-Block laut Profil in die flache edge/telemetry-Nachricht.",
  "// Traegt eine KOPIE der PROFILES aus edge-app/nodered/modbus-tcp.js - synchron",
  "// halten. Ausgang 1: Messwerte fuer vp-telemetrie; Ausgang 2: true als Link-",
  "// Lebenszeichen. Das Profil 'sunspec' entspricht dem kompakten Block des",
  "// SunSpec-Simulators (edge/sim/sunspec-sim.js), FC3 Adr. 0..8.",
  "const mb = msg.mb;",
  "if (!mb || !Array.isArray(mb.regs)) { node.status({ fill: 'red', shape: 'ring', text: 'keine Register' }); return null; }",
  "const s16 = (v) => { v &= 0xffff; return v > 0x7fff ? v - 0x10000 : v; };",
  "const r3 = (x) => Math.round(x * 1000) / 1000;",
  "const r1 = (x) => Math.round(x * 10) / 10;",
  "const PROFILES = {",
  "  sunspec: (regs) => {",
  "    if (regs.length < 7) return null;",
  "    const gridKw = s16(regs[0]) / 100;   // + Bezug / - Einspeisung",
  "    const pvKw = s16(regs[1]) / 100;",
  "    const loadKw = s16(regs[2]) / 100;",
  "    const socPct = regs[4] / 10;",
  "    const wmax = regs[5] / 100;          // beobachtete §14a-Begrenzung in %",
  "    const gridConn = regs[6] / 100;",
  "    const reading = { ts: new Date().toISOString(), power_kw: r3(gridKw), pv_power_kw: r3(pvKw), load_kw: r3(loadKw), soc_pct: r1(socPct), grid_limit_kw: r3((wmax / 100) * gridConn) };",
  "    return { reading, batt_kw: r3(s16(regs[3]) / 100) };",
  "  }",
  "};",
  "const dec = PROFILES[mb.profile];",
  "if (!dec) { node.status({ fill: 'red', shape: 'ring', text: 'unbekanntes Profil: ' + mb.profile }); return null; }",
  "const out = dec(mb.regs);",
  "if (!out) { node.status({ fill: 'yellow', shape: 'ring', text: 'keine Messwerte decodiert' }); return null; }",
  "const pv = out.reading.pv_power_kw !== undefined ? out.reading.pv_power_kw.toFixed(1) : '?';",
  "const soc = out.reading.soc_pct !== undefined ? (', SoC ' + out.reading.soc_pct.toFixed(0) + ' %') : '';",
  "node.status({ fill: 'green', shape: 'dot', text: 'pv ' + pv + ' kW' + soc });",
  "return [{ payload: out.reading }, { payload: true }];",
].join('\n');

const idleFunc = [
  "// Untaetig: keine oder unbekannte Auswahl. Setzt nur den Knotenstatus als",
  "// sichtbaren Hinweis - es wird KEIN edge/status veroeffentlicht (sonst wuerde",
  "// es im reinen Simulator-Betrieb mit dem Link-Status des Simulator-Tabs",
  "// kollidieren). Sobald eine gueltige Auswahl retained eintrifft, laeuft der",
  "// passende Lesepfad automatisch an.",
  "node.status({ fill: 'grey', shape: 'ring', text: msg.idle || 'keine Auswahl' });",
  "return null;",
].join('\n');

// --- control path (write + readback) -----------------------------------------
//
// The write-side twin of the read self-wiring. `controlRouteSource` is a synced
// COPY of inverter-control-routing.js controlRoute() (a Node-RED flow cannot
// `require` a repo file); flows-sync.test.js pins the two together. SAFETY:
// controlRoute keeps writes EMPTY unless control_enabled (the core kill-switch,
// default off) AND the family is in the certified allowlist ('sunspec' only -
// Deye stays read-only until bench-verified). See report §4/§6.
const controlRouteSource = [
  "function controlRoute(selection, setpoint, opts) {",
  "  opts = opts || {};",
  "  var idle = function (reason) { return { adapter: 'idle', family: '', certified: false, controlEnabled: false, writes: [], readbacks: [], reason: reason }; };",
  "  if (!selection) return idle('keine Auswahl');",
  "  var conn = selection.connection || {};",
  "  var ip = typeof conn.ip === 'string' ? conn.ip.trim() : '';",
  "  if (!ip) return idle('keine IP-Adresse');",
  "  if (!setpoint || typeof setpoint.battery_setpoint_kw !== 'number' || !isFinite(setpoint.battery_setpoint_kw)) return idle('kein gueltiger Sollwert');",
  "  var CERTIFIED = { sunspec: true };",
  "  var s16raw = function (kw) { return Math.round(kw * 100) & 0xffff; };",
  "  var clampPct = function (v) { return Math.max(0, Math.min(100, Math.round(v))); };",
  "  var NO_PV_LIMIT = 0xffff;",
  "  var controlEnabled = setpoint.control_enabled === true;",
  "  var family = typeof selection.family === 'string' ? selection.family.trim() : '';",
  "  var certified = CERTIFIED[family] === true;",
  "  var kw = setpoint.battery_setpoint_kw;",
  "  var pvLimitKw = (typeof setpoint.pv_limit_kw === 'number' && isFinite(setpoint.pv_limit_kw) && setpoint.pv_limit_kw >= 0) ? setpoint.pv_limit_kw : null;",
  "  if (selection.communication === 'modbus_tcp') {",
  "    var port = Number(conn.port) > 0 ? Number(conn.port) : 502;",
  "    var unitId = Number(conn.unit_id) > 0 ? Number(conn.unit_id) : 1;",
  "    var invert = conn.invert_control_sign === true;",
  "    var battKw = invert ? -kw : kw;",
  "    var battRaw = s16raw(battKw);",
  "    var pvRaw = pvLimitKw == null ? NO_PV_LIMIT : (Math.max(0, Math.round(pvLimitKw * 100)) & 0xffff);",
  "    var planned = [",
  "      { role: 'battery_power', fc: 6, addr: 40, value: battRaw, encode: { kind: 'kw_x100_s16', scale: 100, kw: battKw }, dwell_s: 0, min_change: 0 },",
  "      { role: 'control_enable', fc: 6, addr: 41, value: 1, encode: { kind: 'flag' }, dwell_s: 0, min_change: 0 },",
  "      { role: 'pv_limit', fc: 6, addr: 42, value: pvRaw, encode: { kind: 'pv_limit_x100_u16', scale: 100, sentinel: NO_PV_LIMIT, kw: pvLimitKw }, dwell_s: 0, min_change: 0 }",
  "    ];",
  "    var readbacks = [",
  "      { role: 'battery_power', fc: 3, addr: 40, expect: battRaw, tolerance: 1 },",
  "      { role: 'control_enable', fc: 3, addr: 41, expect: 1, tolerance: 0 },",
  "      { role: 'pv_limit', fc: 3, addr: 42, expect: pvRaw, tolerance: 1 }",
  "    ];",
  "    var writeAllowed = certified && controlEnabled;",
  "    var out = { adapter: 'modbus_tcp', family: family, profile: family, target: ip + ':' + port, connection: { ip: ip, port: port, unit_id: unitId }, certified: certified, controlEnabled: controlEnabled, writes: writeAllowed ? planned : [], readbacks: readbacks, planned: planned };",
  "    if (!writeAllowed) out.reason = certified ? 'Steuerung deaktiviert (Not-Aus)' : 'Modell noch nicht freigegeben';",
  "    return out;",
  "  }",
  "  if (selection.communication === 'solarman_v5') {",
  "    // ha-solarman-sourced Deye ToU/work-mode registers (deye_p3.yaml hybrid_3p,",
  "    // deye_hybrid.yaml hybrid_1p). BENCH-PENDING: no executable writes.",
  "    var DEYE_REG = {",
  "      hybrid_3p: { workMode: 0x008e, touEnable: 0x0092, progPowerBase: 0x009a, progSocBase: 0x00a6, progChargeBase: 0x00ac, exportLimit: 0x00e7, exportLimitScale: 10 },",
  "      hybrid_1p: { workMode: 0x00f4, touEnable: 0x00f8, progPowerBase: 0x0100, progSocBase: 0x010c, progChargeBase: 0x0112, exportLimit: 0x00f5, exportLimitScale: 1 }",
  "    };",
  "    var dport = Number(conn.port) > 0 ? Number(conn.port) : 8899;",
  "    var serial = conn.serial;",
  "    var slaveId = Number(conn.mb_slave_id) > 0 ? Number(conn.mb_slave_id) : 1;",
  "    var dinvert = conn.invert_control_sign === true;",
  "    var socMin = (typeof setpoint.soc_min_pct === 'number' && isFinite(setpoint.soc_min_pct)) ? setpoint.soc_min_pct : 5;",
  "    var powerScale = Number(conn.power_scale) > 0 ? Number(conn.power_scale) : 1;",
  "    var dbase = { adapter: 'solarman_v5', family: family, target: ip + ':' + dport, connection: { ip: ip, port: dport, serial: serial, mb_slave_id: slaveId }, certified: certified, controlEnabled: controlEnabled, writes: [], readbacks: [], reason: 'Steuerung f\\u00fcr dieses Modell noch nicht freigegeben' };",
  "    var reg = Object.prototype.hasOwnProperty.call(DEYE_REG, family) ? DEYE_REG[family] : null;",
  "    if (!reg) {",
  "      var ratedKw = Number(opts.ratedKw) > 0 ? Number(opts.ratedKw) : 0;",
  "      var splanned = [];",
  "      if (pvLimitKw != null && ratedKw > 0) { splanned.push({ role: 'pv_limit', fc: 6, addr: 0x0028, value: clampPct((pvLimitKw / ratedKw) * 100), encode: { kind: 'active_power_pct', rated_kw: ratedKw, kw: pvLimitKw }, dwell_s: 900, min_change: 1, bench_pending: true }); }",
  "      dbase.planned = splanned; return dbase;",
  "    }",
  "    var dbattKw = dinvert ? -kw : kw;",
  "    var charging = dbattKw > 0;",
  "    var powerReg = Math.max(0, Math.round((Math.abs(dbattKw) * 1000) / powerScale)) & 0xffff;",
  "    var targetSoc = charging ? 100 : clampPct(socMin);",
  "    var gridChargeAllowed = setpoint.grid_charge_allowed === true;",
  "    var chargeEnum = (gridChargeAllowed && charging) ? 1 : 0;",
  "    var slot = 0;",
  "    var dplanned = [",
  "      { role: 'work_mode', fc: 6, addr: reg.workMode, value: 0, encode: { kind: 'work_mode', enum: 'export_first' }, dwell_s: 900, min_change: 0, bench_pending: true },",
  "      { role: 'tou_enable', fc: 6, addr: reg.touEnable, value: 0x00ff, encode: { kind: 'tou_mask', all_week: true }, dwell_s: 900, min_change: 0, bench_pending: true },",
  "      { role: 'battery_power', fc: 6, addr: reg.progPowerBase + slot, value: powerReg, encode: { kind: 'watt_scaled_u16', scale: powerScale, kw: dbattKw }, dwell_s: 900, min_change: 50, bench_pending: true },",
  "      { role: 'battery_target_soc', fc: 6, addr: reg.progSocBase + slot, value: targetSoc, encode: { kind: 'pct', direction: charging ? 'charge' : 'discharge' }, dwell_s: 900, min_change: 1, bench_pending: true },",
  "      { role: 'grid_charge_enable', fc: 6, addr: reg.progChargeBase + slot, value: chargeEnum, encode: { kind: 'charge_enum', eeg_gated: true, disabled: 0, grid: 1 }, dwell_s: 900, min_change: 0, bench_pending: true }",
  "    ];",
  "    if (pvLimitKw != null) { var capW = Math.max(0, pvLimitKw * 1000); dplanned.push({ role: 'pv_limit', fc: 6, addr: reg.exportLimit, value: Math.round(capW / reg.exportLimitScale) & 0xffff, encode: { kind: 'feed_in_cap_w', scale: reg.exportLimitScale, kw: pvLimitKw }, dwell_s: 900, min_change: 1, bench_pending: true }); }",
  "    dbase.planned = dplanned; return dbase;",
  "  }",
  "  return idle('unbekannte Kommunikationsmethode');",
  "}",
].join('\n');

// The plan driver: read the setpoint + the active selection, build the write
// plan. `selectionExpr` is the JS expression that yields the selection - the
// self-wiring auto tab reads flow.inverter_config; the Simulator tab hardcodes
// the sim's generic_modbus/sunspec selection.
const controlPlanFunc = (selectionExpr) => [
  "// Steuerung / Schreibplan - der Herzschlag der Selbstverdrahtung auf der",
  "// SCHREIB-Seite: nimmt den (bereits guard-begrenzten) Sollwert vom Core und",
  "// baut den Schreibplan fuer die aktive Auswahl. Traegt eine KOPIE von",
  "// controlRoute() aus edge-app/nodered/inverter-control-routing.js (synchron",
  "// gehalten, gepinnt von flows-sync.test.js). SICHERHEIT: schreibt NICHTS,",
  "// solange nicht control_enabled (Not-Aus des Core, Standard AUS) UND die",
  "// Familie zertifiziert ist ('sunspec'; Deye bleibt bis zur Pruefstand-Freigabe",
  "// nur lesend).",
  controlRouteSource,
  "var sp = msg.setpoint || null;",
  "if (!sp) { node.status({ fill: 'grey', shape: 'ring', text: 'kein Sollwert' }); return null; }",
  "var sel = " + selectionExpr + ";",
  "msg.control = controlRoute(sel, sp, {});",
  "if (msg.control.adapter === 'idle') { node.status({ fill: 'grey', shape: 'ring', text: msg.control.reason || 'keine Steuerung' }); return null; }",
  "var nWrites = msg.control.writes.length;",
  "node.status({ fill: nWrites ? 'blue' : 'grey', shape: 'dot', text: msg.control.family + ': ' + (nWrites ? (nWrites + ' Schreibbefehle') : (msg.control.reason || 'nur lesen')) });",
  "return msg;",
].join('\n');

// The executor: a single ordered Modbus-TCP connection performing the plan's
// FC6 writes then FC3 readbacks, comparing commanded-vs-actual per register and
// emitting the readback for vp-control-readback (report §5). Only the generic
// modbus_tcp (SunSpec) adapter is executed here; the Deye adapter carries no
// executable writes/readbacks (read-only until bench-certified) so it no-ops.
const controlExecFunc = [
  "// Steuerung schreiben + zuruecklesen (report Rueckleseschleife §5): eine",
  "// geordnete TCP-Verbindung, erst die FC6-Schreibbefehle, dann jedes Register",
  "// per FC3 zurueckgelesen und befohlen-gegen-tatsaechlich verglichen. Ergebnis",
  "// -> vp-control-readback (edge/control/readback, nicht retained). Nur der",
  "// generische SunSpec-Adapter schreibt hier; der Deye-Adapter traegt keine",
  "// ausfuehrbaren Befehle (nur lesend bis Pruefstand-Freigabe) und macht nichts.",
  "const net = global.get('net');",
  "if (!net) { node.status({ fill: 'red', shape: 'ring', text: 'net fehlt (settings.js)' }); node.error('functionGlobalContext.net in settings.js setzen', msg); return null; }",
  "const ctrl = msg.control;",
  "if (!ctrl || ctrl.adapter !== 'modbus_tcp' || !Array.isArray(ctrl.readbacks) || ctrl.readbacks.length === 0) {",
  "  node.status({ fill: 'grey', shape: 'ring', text: (ctrl && ctrl.reason) ? ctrl.reason : 'keine Steuerung' });",
  "  return null;",
  "}",
  "const conn = ctrl.connection || {};",
  "const unitId = conn.unit_id || 1;",
  "const timeoutMs = conn.timeout_ms || 5000;",
  "const s16 = (v) => { v &= 0xffff; return v > 0x7fff ? v - 0x10000 : v; };",
  "const frameLen = (buf) => (buf.length < 6 ? null : 6 + buf.readUInt16BE(4));",
  "const buildRead = (txid, addr, count) => { const b = Buffer.alloc(12); b.writeUInt16BE(txid & 0xffff, 0); b.writeUInt16BE(0, 2); b.writeUInt16BE(6, 4); b[6] = unitId & 0xff; b[7] = 0x03; b.writeUInt16BE(addr & 0xffff, 8); b.writeUInt16BE(count & 0xffff, 10); return b; };",
  "const buildWrite = (txid, addr, value) => { const b = Buffer.alloc(12); b.writeUInt16BE(txid & 0xffff, 0); b.writeUInt16BE(0, 2); b.writeUInt16BE(6, 4); b[6] = unitId & 0xff; b[7] = 0x06; b.writeUInt16BE(addr & 0xffff, 8); b.writeUInt16BE(value & 0xffff, 10); return b; };",
  "const parseRead = (buf, txid) => { if (buf.length < 9) throw new Error('Antwort zu kurz'); if (buf.readUInt16BE(0) !== (txid & 0xffff)) throw new Error('Transaktions-ID'); const fn = buf[7]; if (fn & 0x80) throw new Error('Modbus-Ausnahme 0x' + (buf[8] || 0).toString(16)); if (fn !== 0x03) throw new Error('Modbus-Funktion 0x' + fn.toString(16)); const bc = buf[8]; const regs = []; for (let i = 0; i < bc >> 1; i++) regs.push(buf.readUInt16BE(9 + i * 2)); return regs; };",
  "const parseWrite = (buf, txid) => { if (buf.length < 12) throw new Error('Schreibantwort zu kurz'); if (buf.readUInt16BE(0) !== (txid & 0xffff)) throw new Error('Transaktions-ID'); const fn = buf[7]; if (fn & 0x80) throw new Error('Modbus-Ausnahme 0x' + (buf[8] || 0).toString(16)); if (fn !== 0x06) throw new Error('Modbus-Funktion 0x' + fn.toString(16)); return { addr: buf.readUInt16BE(8), value: buf.readUInt16BE(10) }; };",
  "let txid = context.get('ctxid') || 0;",
  "return new Promise((resolve) => {",
  "  const sock = new net.Socket();",
  "  sock.setNoDelay(true);",
  "  let done = false, acc = Buffer.alloc(0), pending = null;",
  "  const finish = (err, okMsg) => { if (done) return; done = true; clearTimeout(t); try { sock.destroy(); } catch (e) { /* ignore */ } if (err) { node.status({ fill: 'red', shape: 'ring', text: 'Steuerung: ' + err.message }); resolve(null); } else { resolve(okMsg); } };",
  "  const t = setTimeout(() => finish(new Error('Timeout')), timeoutMs);",
  "  sock.once('error', (e) => finish(e));",
  "  const txn = (buf, parse) => new Promise((res, rej) => { pending = { parse, res, rej }; acc = Buffer.alloc(0); sock.write(buf); });",
  "  sock.on('data', (chunk) => { acc = Buffer.concat([acc, chunk]); const need = frameLen(acc); if (need !== null && acc.length >= need && pending) { const p = pending; pending = null; const frame = acc.slice(0, need); acc = acc.slice(need); try { p.res(p.parse(frame)); } catch (e) { p.rej(e); } } });",
  "  sock.connect(conn.port || 502, conn.ip, async () => {",
  "    try {",
  "      for (const w of (ctrl.writes || [])) { txid = (txid + 1) & 0xffff; const wt = txid; await txn(buildWrite(txid, w.addr, w.value), (b) => parseWrite(b, wt)); }",
  "      const registers = [];",
  "      for (const rb of ctrl.readbacks) { txid = (txid + 1) & 0xffff; const rt = txid; const regs = await txn(buildRead(txid, rb.addr, 1), (b) => parseRead(b, rt)); const actual = regs[0] & 0xffff; const tol = rb.tolerance || 0; const entry = { role: rb.role, fc: 3, addr: rb.addr, commanded_raw: rb.expect & 0xffff, actual_raw: actual, match: Math.abs(actual - (rb.expect & 0xffff)) <= tol }; if (rb.role === 'battery_power') { entry.commanded_kw = s16(rb.expect) / 100; entry.actual_kw = s16(actual) / 100; } if (rb.role === 'pv_limit') { entry.commanded_kw = (rb.expect & 0xffff) === 0xffff ? null : rb.expect / 100; entry.actual_kw = actual === 0xffff ? null : actual / 100; } registers.push(entry); }",
  "      context.set('ctxid', txid);",
  "      const all = registers.every((r) => r.match);",
  "      node.status({ fill: all ? 'green' : 'red', shape: 'dot', text: all ? ('bestätigt (' + registers.length + ')') : 'Abweichung' });",
  "      const sp = msg.setpoint || {};",
  "      msg.payload = { ts: new Date().toISOString(), family: ctrl.family, source: sp.source || '', slot_start: sp.slot_start, control_enabled: !!ctrl.controlEnabled, certified: !!ctrl.certified, registers: registers };",
  "      finish(null, msg);",
  "    } catch (e) { finish(e); }",
  "  });",
  "});",
].join('\n');

const fn = (id, name, func, outputs, wires) => ({
  id, type: 'function', z: TAB, name, func, outputs, noerr: 0, initialize: '', finalize: '', libs: [], x: 0, y: 0, wires,
});

const autoNodes = [
  {
    id: TAB, type: 'tab', label: 'Wechselrichter (automatisch)', disabled: false,
    info: [
      'SELBSTVERDRAHTUNG (Capstone): der Kunde waehlt seinen Wechselrichter EINMAL',
      'im Edge-App-Webportal (:8484 -> "Wechselrichter einrichten"); der Core',
      'veroeffentlicht die Auswahl retained auf dem lokalen Bus',
      '(edge/inverter/config). Dieser Tab liest sie und faehrt AUTOMATISCH den',
      'richtigen Leseadapter - OHNE Flow-Edit pro Kunde:',
      '',
      '  - Deye (communication=solarman_v5) -> Solarman-V5 ueber TCP 8899, mit der',
      '    gewaehlten family-Registerkarte (deye/deye-decode.js).',
      '  - alles andere (generic_modbus / modbus_tcp) -> Modbus-TCP ueber Port 502',
      '    mit dem gewaehlten Profil (modbus-tcp.js).',
      '',
      'Ohne Auswahl bleibt der Tab idle-sicher (kein Absturz). Nur Lesen/Monitoring',
      '- dieser Tab steuert NICHTS. Routing/Codecs: edge-app/nodered/',
      'inverter-routing.js + modbus-tcp.js + deye/*.js (getestet, Quelle der',
      'Wahrheit; die Funktionsknoten tragen synchron gehaltene Kopien).',
    ].join('\n'),
  },
  {
    id: 'auto-note', type: 'comment', z: TAB,
    name: 'Vorne auswaehlen (Edge-App-Portal), hinten ist alles verdrahtet: edge/inverter/config -> passender Leseadapter',
    info: '', x: 470, y: 40, wires: [],
  },
  {
    id: 'auto-cfg', type: 'vp-inverter-config', z: TAB, name: 'Auswahl vom Core (retained)', core: 'cfg-vp-core',
    x: 190, y: 100, wires: [['auto-store']],
  },
  Object.assign(fn('auto-store', 'Auswahl uebernehmen', storeFunc, 1, [[]]), { x: 470, y: 100 }),
  {
    id: 'auto-poll', type: 'inject', z: TAB, name: 'poll 5s',
    props: [{ p: 'payload' }], repeat: '5', crontab: '', once: true, onceDelay: '3',
    topic: '', payload: '', payloadType: 'date', x: 130, y: 180, wires: [['auto-router']],
  },
  Object.assign(fn('auto-router', 'Router / Leseplan', routerFunc, 3, [['auto-solarman'], ['auto-modbus'], ['auto-idle']]), { x: 320, y: 180 }),

  // Deye Solarman-V5 branch (verbatim reader + decoder)
  Object.assign(fn('auto-solarman', 'Solarman-V5 lesen (TCP 8899)', solarmanFunc, 1, [['auto-deye-decode']]), { x: 600, y: 140 }),
  Object.assign(fn('auto-deye-decode', 'Deye-Register -> Messwerte', deyeDecodeFunc, 2, [['auto-telemetrie'], ['auto-status', 'auto-linkwatch']]), { x: 600, y: 200 }),

  // Generic Modbus-TCP branch
  Object.assign(fn('auto-modbus', 'Modbus-TCP lesen (FC3)', modbusReadFunc, 1, [['auto-mb-decode']]), { x: 590, y: 280 }),
  Object.assign(fn('auto-mb-decode', 'Modbus-Register -> Messwerte', modbusDecodeFunc, 2, [['auto-telemetrie'], ['auto-status', 'auto-linkwatch']]), { x: 600, y: 340 }),

  // Idle branch (status only, no publish)
  Object.assign(fn('auto-idle', 'untaetig (Statusanzeige)', idleFunc, 1, [[]]), { x: 600, y: 420 }),

  // Shared sinks
  { id: 'auto-telemetrie', type: 'vp-telemetrie', z: TAB, name: 'an VoltPilot Core', core: 'cfg-vp-core', x: 900, y: 180, wires: [] },
  { id: 'auto-status', type: 'vp-status', z: TAB, name: 'Wechselrichter-Status', core: 'cfg-vp-core', x: 920, y: 260, wires: [] },
  {
    id: 'auto-linkwatch', type: 'trigger', z: TAB, name: '15s ohne Messwert -> down',
    op1: '', op1type: 'nul', op2: 'false', op2type: 'bool', duration: '15', extend: true,
    overrideDelay: false, units: 's', reset: '', bytopic: 'all', topic: 'topic', outputs: 1,
    x: 640, y: 260, wires: [['auto-status']],
  },

  // --- Control path (write + readback), self-wired from the same selection ---
  // SAFETY: writes only happen for a certified family AND when the core's kill-
  // switch enabled the setpoint (control_enabled). A Deye selection routes here
  // too but stays read-only (controlRoute emits no executable writes).
  {
    id: 'auto-control-note', type: 'comment', z: TAB,
    name: 'Steuerung: Sollwert -> Schreibplan (controlRoute) -> schreiben + zuruecklesen -> vp-control-readback. Standard AUS (Not-Aus), Deye nur lesend.',
    info: '', x: 520, y: 500, wires: [],
  },
  {
    id: 'auto-sollwert', type: 'vp-sollwert', z: TAB, name: 'Sollwert vom Core', core: 'cfg-vp-core',
    x: 140, y: 560, wires: [['auto-control-plan']],
  },
  Object.assign(fn('auto-control-plan', 'Steuerung / Schreibplan', controlPlanFunc("flow.get('inverter_config') || null"), 1, [['auto-control-exec']]), { x: 380, y: 560 }),
  Object.assign(fn('auto-control-exec', 'Steuerung schreiben + zuruecklesen', controlExecFunc, 1, [['auto-control-readback']]), { x: 650, y: 560 }),
  { id: 'auto-control-readback', type: 'vp-control-readback', z: TAB, name: 'Rueckmeldung an Core', core: 'cfg-vp-core', x: 930, y: 560, wires: [] },
];

// --- Simulator tab control path (the safe write->readback proof vs edge/sim) --
// Replaces the old sim-sp2reg/sim-write/sim-enable nodes: the same controlRoute
// + write/readback the real self-wiring path uses, but with the sim's fixed
// generic_modbus/sunspec selection (edge-sim:502). Proves reg 40/41/42
// write -> FC3 readback -> match against the UNCHANGED simulator (report §4.4a).
const simFn = (id, name, func, outputs, wires) => ({
  id, type: 'function', z: 'tab-sim', name, func, outputs, noerr: 0, initialize: '', finalize: '', libs: [], x: 0, y: 0, wires,
});
const SIM_SELECTION = "{ schema_version: '1.0', brand: 'generic_modbus', family: 'sunspec', communication: 'modbus_tcp', connection: { ip: 'edge-sim', port: 502, unit_id: 1 } }";
const simControlNodes = [
  {
    id: 'sim-control-note', type: 'comment', z: 'tab-sim',
    name: 'Steuerung + Rueckleseverifikation gegen den Simulator: FC6 Reg 40/41/42 schreiben, FC3 zuruecklesen, vergleichen',
    info: '', x: 380, y: 300, wires: [],
  },
  {
    id: 'sim-sollwert', type: 'vp-sollwert', z: 'tab-sim', name: 'Sollwert vom Core', core: 'cfg-vp-core',
    x: 140, y: 360, wires: [['sim-control-plan']],
  },
  Object.assign(simFn('sim-control-plan', 'Steuerung / Schreibplan', controlPlanFunc(SIM_SELECTION), 1, [['sim-control-exec']]), { x: 380, y: 360 }),
  Object.assign(simFn('sim-control-exec', 'Steuerung schreiben + zuruecklesen', controlExecFunc, 1, [['sim-control-readback']]), { x: 650, y: 360 }),
  { id: 'sim-control-readback', type: 'vp-control-readback', z: 'tab-sim', name: 'Rueckmeldung an Core', core: 'cfg-vp-core', x: 930, y: 360, wires: [] },
];

const simNodes = [simTab, ...simReadNodes, ...simControlNodes];

const flows = [...keepConfig, ...autoNodes, ...simNodes];
fs.writeFileSync(OUT, JSON.stringify(flows, null, 2) + '\n');
console.log('flows.json written:', flows.length, 'nodes');
