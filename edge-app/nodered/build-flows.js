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

// --- keep verbatim: config nodes + the whole Simulator tab -------------------
const keepConfig = ['cfg-vp-core', 'cfg-mb-sim'].map(need);
const simNodes = prev.filter((n) => n.id === 'tab-sim' || n.z === 'tab-sim');

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
];

const flows = [...keepConfig, ...autoNodes, ...simNodes];
fs.writeFileSync(OUT, JSON.stringify(flows, null, 2) + '\n');
console.log('flows.json written:', flows.length, 'nodes');
