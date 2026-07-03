#!/usr/bin/env node
'use strict';

/**
 * solarman-probe - a STANDALONE (no Node-RED, no npm deps) Solarman V5 reader
 * the operator runs ON THE EDGE VM (same LAN as the logger) to prove the
 * transport against a real Deye/Solarman WiFi datalogger.
 *
 * It opens ONE TCP connection to <ip>:8899, performs the Solarman-V5 Modbus
 * fn-0x03 read(s) for the chosen Deye family (or an arbitrary register range),
 * verifies the V5 + Modbus checksums, and prints:
 *   - the raw request/response frames (hex),
 *   - every register with its absolute address + signed/unsigned value,
 *   - the decoded edge/telemetry reading via the SAME deye-decode.js maps the
 *     Node-RED flow uses.
 *
 * It shares the exact protocol codec (solarman-v5.js) and register maps
 * (deye-decode.js) that the flow carries, so a successful probe here is direct
 * evidence the flow's Solarman-V5 path will work.
 *
 * Usage (captain's confirmed logger):
 *   node solarman-probe.js --ip 192.168.0.28 --serial 2985159064 --family string
 *
 * Explore raw registers (e.g. to confirm a family's map on real hardware):
 *   node solarman-probe.js --ip 192.168.0.28 --serial 2985159064 --start 0x0050 --count 20
 *
 * Options:
 *   --ip <addr>        logger IP (required)
 *   --serial <n>       datalogger serial number, decimal (required) - the LOGGER
 *                      serial (e.g. from the AP SSID AP_<serial>), NOT the inverter serial
 *   --port <n>         TCP port (default 8899)
 *   --family <f>       string | hybrid_1p | hybrid_3p  (reads that family's block[s] + decodes)
 *   --start <reg>      raw read: first holding register (hex 0x.. or decimal)
 *   --count <n>        raw read: register count (with --start; max 125)
 *   --slave <n>        Modbus slave/unit id (default 1)
 *   --timeout <ms>     per-read timeout (default 8000)
 *   --loop <sec>       repeat every <sec> seconds (Ctrl-C to stop)
 *   --quiet            omit the raw frame hex dump
 */

const net = require('net');
const path = require('path');
const S = require(path.join(__dirname, 'solarman-v5.js'));
const D = require(path.join(__dirname, 'deye-decode.js'));

// --- tiny arg parser ---------------------------------------------------------

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const key = t.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) a[key] = true;
    else {
      a[key] = next;
      i++;
    }
  }
  return a;
}

function toInt(v) {
  if (typeof v !== 'string') return v;
  return v.toLowerCase().startsWith('0x') ? parseInt(v, 16) : parseInt(v, 10);
}

function hex(buf) {
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

// --- one V5 read over an open socket -----------------------------------------

/**
 * v5Read - send one V5 request on `sock` and resolve with the response Buffer.
 * Reassembles TCP segments until a whole frame (per its length field) arrived.
 */
function v5Read(sock, frame, timeoutMs) {
  return new Promise((resolve, reject) => {
    let acc = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timeout: keine (vollstaendige) Antwort in ' + timeoutMs + ' ms'));
    }, timeoutMs);
    function onData(chunk) {
      acc = Buffer.concat([acc, chunk]);
      let need;
      try {
        need = S.expectedFrameLength(acc);
      } catch (e) {
        cleanup();
        return reject(e);
      }
      if (need !== null && acc.length >= need) {
        cleanup();
        resolve(acc.slice(0, need));
      }
    }
    function onErr(e) {
      cleanup();
      reject(e);
    }
    function cleanup() {
      clearTimeout(timer);
      sock.removeListener('data', onData);
      sock.removeListener('error', onErr);
    }
    sock.on('data', onData);
    sock.on('error', onErr);
    sock.write(frame);
  });
}

// --- family read plans (must match deye-decode.js) ---------------------------

const FAMILY_READS = {
  string: [{ start: 0x0050, count: 0x007d }],
  hybrid_1p: [{ start: 0x00a9, count: 0x0016 }],
  hybrid_3p: [{ start: 0x024c, count: 0x0058 }], // 0x024C..0x02A3 (SOC..PV4)
};

function printRegisters(block) {
  const s16 = (v) => (v > 0x7fff ? v - 0x10000 : v);
  console.log('  Register (addr = wert  [dez u16 / dez s16]):');
  block.regs.forEach((r, i) => {
    const addr = block.start + i;
    console.log(
      '    0x' +
        addr.toString(16).padStart(4, '0') +
        ' = 0x' +
        r.toString(16).padStart(4, '0') +
        '  [' +
        r +
        ' / ' +
        s16(r) +
        ']'
    );
  });
}

// --- main --------------------------------------------------------------------

async function readOnce(args) {
  const ip = args.ip;
  const port = toInt(args.port) || 8899;
  const serial = args.serial;
  const slaveId = toInt(args.slave) || 1;
  const timeout = toInt(args.timeout) || 8000;
  const quiet = !!args.quiet;

  // Which blocks to read: an explicit range wins, else the family plan.
  let plan;
  let family = args.family;
  if (args.start !== undefined) {
    plan = [{ start: toInt(args.start), count: toInt(args.count) || 1 }];
    family = null;
  } else {
    if (!family || !FAMILY_READS[family]) {
      throw new Error("--family muss 'string' | 'hybrid_1p' | 'hybrid_3p' sein (oder --start/--count nutzen)");
    }
    plan = FAMILY_READS[family];
  }

  const sock = new net.Socket();
  sock.setNoDelay(true);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      sock.destroy();
      reject(new Error('Verbindungs-Timeout zu ' + ip + ':' + port));
    }, timeout);
    sock.once('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    sock.connect(port, ip, () => {
      clearTimeout(t);
      resolve();
    });
  });
  console.log('Verbunden mit ' + ip + ':' + port + ' (Logger-Serial ' + serial + ', Slave ' + slaveId + ')\n');

  const blocks = [];
  let seq = (Date.now() >>> 0) & 0xffff; // vary the sequence per run
  try {
    // Sequential reads over the ONE connection (the logger allows a single client).
    for (const r of plan) {
      seq = (seq + 1) & 0xffff;
      const req = S.buildReadRequest({ loggerSerial: serial, sequence: seq, slaveId, startReg: r.start, count: r.count });
      if (!quiet) console.log('-> Anfrage 0x' + r.start.toString(16) + ' x' + r.count + ':\n   ' + hex(req));
      const resp = await v5Read(sock, req, timeout);
      if (!quiet) console.log('<- Antwort (' + resp.length + ' B):\n   ' + hex(resp) + '\n');
      const block = S.registerBlock(r.start, resp, { expectLoggerSerial: serial });
      blocks.push(block);
      printRegisters(block);
      console.log('');
    }
  } finally {
    sock.destroy();
  }

  if (family) {
    const out = D.decode(blocks, {
      family,
      invert_grid_sign: !!args['invert-grid'],
      invert_batt_sign: !!args['invert-batt'],
    });
    console.log('Decodierte Messwerte (Familie ' + family + '):');
    console.log('  edge/telemetry = ' + JSON.stringify(out.reading));
    if (out.batt_kw !== undefined) console.log('  batt_kw (nur Kalibrierung) = ' + out.batt_kw + ' kW');
    console.log(
      '\nPlausibilitaet: PV nachts ~0, load_kw >= 0, SoC 0..100, ' +
        "power_kw '+' = Netzbezug / '-' = Einspeisung. Stimmt das Netz-Vorzeichen mittags nicht, --invert-grid setzen."
    );
  } else {
    console.log('Roh-Register gelesen (kein Familien-Decode; --family fuer die Messwert-Decodierung).');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.ip || !args.serial) {
    console.error('Fehlt: --ip <logger-ip> und --serial <datalogger-serial>.');
    console.error('Beispiel: node solarman-probe.js --ip 192.168.0.28 --serial 2985159064 --family string');
    console.error('Alle Optionen: siehe Kopf dieser Datei oder DEYE.md Abschnitt "Solarman V5".');
    process.exit(2);
  }

  const loopSec = toInt(args.loop);
  do {
    const started = new Date().toISOString();
    console.log('=== Solarman-V5-Probe ' + started + ' ===');
    try {
      await readOnce(args);
    } catch (e) {
      console.error('FEHLER: ' + e.message);
      if (!loopSec) process.exit(1);
    }
    if (loopSec) {
      console.log('\n(warte ' + loopSec + ' s; Ctrl-C zum Beenden)\n');
      await new Promise((r) => setTimeout(r, loopSec * 1000));
    }
  } while (loopSec);
}

main();
