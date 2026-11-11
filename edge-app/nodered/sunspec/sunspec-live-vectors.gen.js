'use strict';

/**
 * Erzeugt sunspec-live-vectors.json: die GEMEINSAMEN Testvektoren zwischen dem
 * SunSpec-Lesepfad der Docker-Box (sunspec-live.js makeSunspecReader +
 * model-discovery.js discover, Quelle der Wahrheit) und seinem Go-Zwilling
 * edge-app/core/internal/sunspeclive (Edge Light).
 *
 * Das Muster von huawei-decode-vectors.gen.js, eine Stufe weiter: Hier wird
 * nicht nur der Decoder, sondern der ganze Leser gegen ein Geraet gefahren.
 * Jeder Fall ist eine Registerkarte (was das Geraet auf FC3 beantwortet; alles
 * andere ist eine Modbus-Ausnahme 0x02). Der echte JS-Leser laeuft ueber einen
 * nachgebauten Socket dagegen; festgehalten werden die Anfragen in ihrer
 * Reihenfolge (Unit, Adresse, Anzahl) und das Ergebnis von read() - so muss der
 * Go-Leser dieselben Anfragen stellen und dasselbe Ergebnis liefern.
 *
 * Die drei "Schramm"-Faelle sind Rohlesungen echter Geraete: KACO Powador
 * 14.0 TL3 und 2x Powador 20.0 TL3 (Firmware V2.30), gelesen am 06.11.2026
 * ueber den Wartungstunnel der Box edge-tgjn9gd, nur FC3. Die Seriennummern
 * im Common Model sind anonymisiert, sonst sind die Woerter unveraendert.
 *
 *   node edge-app/nodered/sunspec/sunspec-live-vectors.gen.js
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const L = require('./sunspec-live.js');
const D = require('./model-discovery.js');

const OUT = path.join(__dirname, 'sunspec-live-vectors.json');

// --- Registerkarten ----------------------------------------------------------

// ascii(text, words) -> u16-Woerter, Big-Endian, mit 0 aufgefuellt (SunSpec-String).
function ascii(text, words) {
  const out = new Array(words).fill(0);
  for (let i = 0; i < words; i++) {
    const hi = text.charCodeAt(2 * i) || 0;
    const lo = text.charCodeAt(2 * i + 1) || 0;
    out[i] = ((hi & 0xff) << 8) | (lo & 0xff);
  }
  return out;
}

// f32(x) -> [hi, lo] (IEEE-754 single, Big-Endian, High-Word zuerst).
function f32(x) {
  const b = Buffer.alloc(4);
  b.writeFloatBE(x, 0);
  return [b.readUInt16BE(0), b.readUInt16BE(2)];
}

const NAN32 = [0x7fc0, 0x0000];

// common(mn, md, opt, vr, sn) -> Body des Common Model 1 (66 Woerter: Mn 16,
// Md 16, Opt 8, Vr 8, SN 16, DA 1, Pad 1).
function common(mn, md, opt, vr, sn, da) {
  return [].concat(ascii(mn, 16), ascii(md, 16), ascii(opt, 8), ascii(vr, 8), ascii(sn, 16),
    [da === undefined ? 0xffff : da, 0]);
}

// device(base, models, extra) -> Registerkarte: "SunS" an base, dann die
// Modelle als {id, body} (Laenge = body.length, ausser len ist gesetzt), dann
// das Ende-Modell 0xFFFF/0. extra = weitere [addr, words]-Segmente.
function device(base, models, opts) {
  opts = opts || {};
  const segs = [[base, [0x5375, 0x6e53]]];
  let addr = base + 2;
  for (const m of models) {
    const len = m.len !== undefined ? m.len : m.body.length;
    segs.push([addr, [m.id, len]]);
    if (m.body && m.body.length) segs.push([addr + 2, m.body]);
    addr += 2 + len;
  }
  if (!opts.noEnd) segs.push([addr, [0xffff, 0]]);
  return segs.concat(opts.extra || []);
}

// Inverter model 101/102/103 (int + SF): 50 Woerter, Offsets body-relativ.
function int10x(v) {
  const b = new Array(50).fill(0xffff);
  const put = (i, x) => { b[i] = x & 0xffff; };
  put(0, v.A); put(1, v.AphA); put(2, v.AphB); put(3, v.AphC); put(4, v.A_SF);
  put(8, v.PhVphA); put(9, v.PhVphB); put(10, v.PhVphC); put(11, v.V_SF);
  put(12, v.W); put(13, v.W_SF); put(14, v.Hz); put(15, v.Hz_SF);
  put(16, v.VA); put(17, v.VA_SF); put(18, 0); put(19, 1); put(20, 1000); put(21, -1);
  put(22, v.WH >>> 16); put(23, v.WH & 0xffff); put(24, 0);
  put(25, v.DCA); put(26, -2); put(27, v.DCV); put(28, -1); put(29, v.DCW); put(30, v.DCW_SF);
  put(31, 400); put(32, 0x8000); put(33, 0x8000); put(34, 0x8000); put(35, -1);
  put(36, v.St); put(37, v.StVnd === undefined ? v.St : v.StVnd);
  put(38, v.Evt1 >>> 16); put(39, v.Evt1 & 0xffff); put(40, 0); put(41, 0);
  return b;
}

// Inverter model 111/112/113 (float): 60 Woerter, Offsets body-relativ.
function float11x(v) {
  const b = new Array(60).fill(0);
  const putf = (i, x) => { const w = Array.isArray(x) ? x : f32(x); b[i] = w[0]; b[i + 1] = w[1]; };
  putf(0, v.A === undefined ? 0 : v.A);
  putf(20, v.W);
  putf(22, v.Hz);
  putf(36, v.DCW === undefined ? NAN32 : v.DCW);
  b[46] = v.St & 0xffff;
  b[47] = v.St & 0xffff;
  b[48] = (v.Evt1 || 0) >>> 16;
  b[49] = (v.Evt1 || 0) & 0xffff;
  return b;
}

// Meter model 211/212/213 (float): 124 Woerter, W bei 26 (body-relativ).
function float21x(w) {
  const b = new Array(124).fill(0);
  const x = Array.isArray(w) ? w : f32(w);
  b[26] = x[0];
  b[27] = x[1];
  return b;
}

// --- Echte Rohlesungen (Schramm, 06.11.2026, anonymisierte Seriennummer) -----

const SCHRAMM = [
  {
    name: 'Schramm: KACO Powador 14.0 TL3 (V2.30), Modelle 1 + 103, 1,19 kW am Nachmittag',
    md: 'Powador 14.0 TL3', opt: '140TL', sn: '14.0TL00000001',
    m103: [583, 198, 193, 191, 65534, 65535, 65535, 65535, 2368, 2360, 2366, 65535, 119, 1, 499, 65535, 121, 1, 0, 1, 1000, 65535, 2093, 2499, 0, 234, 65534, 4954, 65535, 115, 1, 419, 32768, 32768, 32768, 65535, 4, 4, 0, 0, 0, 0, 65535, 65535, 65535, 65535, 65535, 65535, 65535, 65535],
  },
  {
    name: 'Schramm: KACO Powador 20.0 TL3 (V2.30), Modelle 1 + 103, 1,67 kW',
    md: 'Powador 20.0 TL3', opt: '200TL', sn: '20.0TL00000002',
    m103: [708, 239, 234, 234, 65534, 65535, 65535, 65535, 2360, 2353, 2369, 65535, 167, 1, 499, 65535, 167, 1, 0, 1, 1000, 65535, 3105, 53855, 0, 258, 65534, 6558, 65535, 169, 1, 443, 32768, 32768, 32768, 65535, 4, 4, 0, 0, 0, 0, 65535, 65535, 65535, 65535, 65535, 65535, 65535, 65535],
  },
  {
    name: 'Schramm: KACO Powador 20.0 TL3 (V2.30), Modelle 1 + 103, 1,64 kW',
    md: 'Powador 20.0 TL3', opt: '200TL', sn: '20.0TL00000003',
    m103: [732, 245, 243, 243, 65534, 65535, 65535, 65535, 2357, 2361, 2361, 65535, 164, 1, 499, 65535, 162, 1, 0, 1, 1000, 65535, 3102, 26965, 0, 240, 65534, 6516, 65535, 156, 1, 441, 32768, 32768, 32768, 65535, 4, 4, 0, 0, 0, 0, 65535, 65535, 65535, 65535, 65535, 65535, 65535, 65535],
  },
];

function schramm(s) {
  return device(40000, [
    { id: 1, body: common('KACO new energy', s.md, s.opt, 'V2.30', s.sn) },
    { id: 103, body: s.m103 },
  ]);
}

// --- Faelle ------------------------------------------------------------------

const INT_OK = { A: 700, AphA: 233, AphB: 233, AphC: 234, A_SF: -2, PhVphA: 2310, PhVphB: 2305, PhVphC: 2312, V_SF: -1,
  W: 4520, W_SF: 0, Hz: 5001, Hz_SF: -2, VA: 4600, VA_SF: 0, WH: 1234567, DCA: 1100, DCV: 4200, DCW: 4610, DCW_SF: 0, St: 4, Evt1: 0 };
const KACO_COMMON = common('KACO new energy', 'blueplanet 10.0 TL3', '100TL', 'V4.10', 'TEST0000000010');
const FRONIUS_COMMON = common('Fronius', 'Fronius Eco 27.0-3-S', '', '1.30.4-1', '00000000');

const cases = [
  ...SCHRAMM.map((s) => ({ name: s.name, registers: schramm(s), target: { unitId: 1 } })),
  { name: 'Schramm 14.0 TL3 mit Unit-ID 3 (KACO ueberliest die Unit-ID ueber TCP)', registers: schramm(SCHRAMM[0]), target: { unitId: 3 } },
  {
    name: 'int+SF 103 mit Nameplate 120 und Controls 123 (blueplanet), 4,52 kW',
    registers: device(40000, [
      { id: 1, body: KACO_COMMON },
      { id: 103, body: int10x(INT_OK) },
      { id: 120, body: new Array(26).fill(0) },
      { id: 123, body: new Array(24).fill(0) },
    ]),
    target: {},
  },
  {
    name: 'Modell 102 (Split-Phase, blueplanet TL1) liest mit dem Punkt-Layout von 103',
    registers: device(40000, [{ id: 1, body: KACO_COMMON }, { id: 102, body: int10x({ ...INT_OK, W: 2310, W_SF: 0 }) }]),
    target: {},
  },
  {
    name: 'Modell 101 (einphasig), W-Skalierung -1',
    registers: device(40000, [{ id: 1, body: KACO_COMMON }, { id: 101, body: int10x({ ...INT_OK, W: 30455, W_SF: -1 }) }]),
    target: {},
  },
  {
    name: 'Float 113 (Fronius Eco) mit 120/121/123/160, 26,9 kW',
    registers: device(40000, [
      { id: 1, body: FRONIUS_COMMON },
      { id: 113, body: float11x({ W: 26912.5, Hz: 50.02, DCW: 27450, St: 4 }) },
      { id: 120, body: new Array(26).fill(0) },
      { id: 121, body: new Array(30).fill(0) },
      { id: 123, body: new Array(24).fill(0) },
      { id: 160, body: new Array(48).fill(0) },
    ]),
    target: {},
  },
  {
    name: 'Float 111 (einphasig), DCW nicht vorhanden (NaN) ohne Speicher: PV = AC',
    registers: device(40000, [{ id: 1, body: FRONIUS_COMMON }, { id: 111, body: float11x({ W: 3120.25, Hz: 49.98, St: 4 }) }]),
    target: {},
  },
  {
    name: 'Basis 50000: an 40000 antwortet das Geraet mit einer Ausnahme',
    registers: device(50000, [{ id: 1, body: KACO_COMMON }, { id: 103, body: int10x(INT_OK) }]),
    target: {},
  },
  {
    name: 'Basis 0: an 40000 und 50000 nur Ausnahmen',
    registers: device(0, [{ id: 1, body: KACO_COMMON }, { id: 103, body: int10x(INT_OK) }]),
    target: {},
  },
  {
    name: 'Kein SunS-Marker an einer Basis: kein Ergebnis',
    registers: [[40000, [0x1234, 0x5678, 1, 66]], [50000, [0, 0]], [0, [0xffff, 0xffff]]],
    target: {},
  },
  {
    name: 'Hybrid (124 vorhanden): PV kommt aus DCW, nicht aus W',
    registers: device(40000, [
      { id: 1, body: KACO_COMMON },
      { id: 103, body: int10x({ ...INT_OK, W: -2500, DCW: 3200 }) },
      { id: 124, body: new Array(24).fill(0) },
    ]),
    target: {},
  },
  {
    name: 'Hybrid ohne DC-Leistung (DCW 0x8000): Wechselrichter faellt weg, nur der Zaehler bleibt',
    registers: device(40000, [
      { id: 1, body: KACO_COMMON },
      { id: 103, body: int10x({ ...INT_OK, DCW: 0x8000 }) },
      { id: 124, body: new Array(24).fill(0) },
      { id: 213, body: float21x(-1830.5) },
    ]),
    target: {},
  },
  {
    name: 'Zaehler 213 neben dem Wechselrichter: power_kw mit dem Vorzeichen des Geraets',
    registers: device(40000, [
      { id: 1, body: KACO_COMMON },
      { id: 103, body: int10x(INT_OK) },
      { id: 213, body: float21x(2750.75) },
    ]),
    target: {},
  },
  {
    name: 'Zaehler 213 mit invertGridSign',
    registers: device(40000, [
      { id: 1, body: KACO_COMMON },
      { id: 103, body: int10x(INT_OK) },
      { id: 213, body: float21x(2750.75) },
    ]),
    target: { invertGridSign: true },
  },
  {
    name: 'Nur ein Zaehler (211), kein Wechselrichter-Modell',
    registers: device(40000, [{ id: 1, body: FRONIUS_COMMON }, { id: 211, body: float21x(-415) }]),
    target: {},
  },
  {
    name: 'modelType float erzwungen an einem int-Geraet (falsche Wahl im Formular)',
    registers: device(40000, [{ id: 1, body: KACO_COMMON }, { id: 103, body: int10x(INT_OK) }]),
    target: { modelType: 'float' },
  },
  {
    name: 'modelType int_sf erzwungen an einem Float-Geraet',
    registers: device(40000, [{ id: 1, body: FRONIUS_COMMON }, { id: 113, body: float11x({ W: 26912.5, Hz: 50.02, St: 4 }) }]),
    target: { modelType: 'int_sf' },
  },
  {
    name: 'Nacht: W negativ (Eigenverbrauch), PV 0, w_kw negativ',
    registers: device(40000, [{ id: 1, body: KACO_COMMON }, { id: 103, body: int10x({ ...INT_OK, W: -12, W_SF: 0, St: 2 }) }]),
    target: {},
  },
  {
    name: 'W_SF nicht implementiert (0x8000): JS rechnet 10^-32768 = 0, also 0 W',
    registers: device(40000, [{ id: 1, body: KACO_COMMON }, { id: 103, body: int10x({ ...INT_OK, W_SF: 0x8000 }) }]),
    target: {},
  },
  {
    name: 'W_SF 32767: unendlich, kein Messwert',
    registers: device(40000, [{ id: 1, body: KACO_COMMON }, { id: 103, body: int10x({ ...INT_OK, W_SF: 0x7fff }) }]),
    target: {},
  },
  {
    name: 'Float-W NaN: kein Messwert, kein Ergebnis',
    registers: device(40000, [{ id: 1, body: FRONIUS_COMMON }, { id: 113, body: float11x({ W: NAN32, Hz: 50, St: 7 }) }]),
    target: {},
  },
  {
    name: 'Langer Herstellerblock (300 Woerter): Body in 125er-Stuecken gelesen',
    registers: device(40000, [
      { id: 1, body: KACO_COMMON },
      { id: 64201, body: new Array(300).fill(7) },
      { id: 103, body: int10x(INT_OK) },
    ]),
    target: {},
  },
  {
    name: 'Modell mit Laenge 0 wird uebersprungen',
    registers: device(40000, [{ id: 1, body: KACO_COMMON }, { id: 64110, body: [] }, { id: 103, body: int10x(INT_OK) }]),
    target: {},
  },
  {
    name: 'Liste ohne Ende-Modell: der naechste Kopf ist eine Ausnahme, gelesen wird was da ist',
    registers: device(40000, [{ id: 1, body: KACO_COMMON }, { id: 103, body: int10x(INT_OK) }], { noEnd: true }),
    target: {},
  },
  {
    name: 'Body nicht lesbar (Ausnahme im 103-Body): Walk bricht ab, kein Messwert',
    registers: [[40000, [0x5375, 0x6e53]], [40002, [1, 66]], [40004, KACO_COMMON], [40070, [103, 50]], [40122, [0xffff, 0]]],
    target: {},
  },
  {
    name: 'Laenge ueber 8192: kein Body, Walk laeuft hinter das Modell und endet an der Ausnahme',
    registers: device(40000, [{ id: 1, body: KACO_COMMON }, { id: 103, body: int10x(INT_OK) }, { id: 64999, len: 9000 }], { noEnd: true }),
    target: {},
  },
  {
    name: 'Zu kurzes 103 (Laenge 30): der Decoder braucht 40 Woerter und liest in den naechsten Kopf',
    registers: device(40000, [{ id: 1, body: KACO_COMMON }, { id: 103, body: int10x(INT_OK).slice(0, 30) }, { id: 120, body: new Array(26).fill(0) }]),
    target: {},
  },
  {
    name: 'Zwei Wechselrichter-Modelle: das erste in der Liste gilt',
    registers: device(40000, [
      { id: 1, body: KACO_COMMON },
      { id: 113, body: float11x({ W: 1000, Hz: 50, St: 4 }) },
      { id: 103, body: int10x(INT_OK) },
    ]),
    target: {},
  },
];

// --- der nachgebaute Socket ----------------------------------------------------

// fakeNet(registers) beantwortet FC3 aus der Registerkarte: eine Anfrage, deren
// Woerter alle bekannt sind, bekommt sie; sonst Ausnahme 0x02. Jede Anfrage wird
// als [unit, addr, count] protokolliert.
function fakeNet(registers, log) {
  const map = new Map();
  for (const [addr, words] of registers) {
    words.forEach((w, i) => map.set(addr + i, w & 0xffff));
  }
  class Socket extends EventEmitter {
    setNoDelay() {}
    connect(port, ip, cb) { setImmediate(cb); }
    destroy() { this.destroyed = true; }
    write(buf) {
      const txid = buf.readUInt16BE(0);
      const unit = buf[6];
      const fn = buf[7];
      const addr = buf.readUInt16BE(8);
      const count = buf.readUInt16BE(10);
      log.push([unit, addr, count]);
      let pdu;
      const words = [];
      for (let i = 0; i < count; i++) {
        const w = map.get(addr + i);
        if (w === undefined) break;
        words.push(w);
      }
      if (fn !== 3 || words.length !== count) {
        pdu = Buffer.from([fn | 0x80, 0x02]);
      } else {
        pdu = Buffer.alloc(2 + 2 * count);
        pdu[0] = 3;
        pdu[1] = 2 * count;
        words.forEach((w, i) => pdu.writeUInt16BE(w, 2 + 2 * i));
      }
      const adu = Buffer.alloc(7 + pdu.length);
      adu.writeUInt16BE(txid, 0);
      adu.writeUInt16BE(0, 2);
      adu.writeUInt16BE(pdu.length + 1, 4);
      adu[6] = unit;
      pdu.copy(adu, 7);
      setImmediate(() => { if (!this.destroyed) this.emit('data', adu); });
    }
  }
  return { Socket };
}

async function run(c) {
  const log = [];
  const read = L.makeSunspecReader({ net: fakeNet(c.registers, log), discovery: D, connectTimeoutMs: 1000, readTimeoutMs: 1000 });
  const out = await read({ ip: '192.0.2.10', port: 502, ...c.target });
  return { requests: log, read: out };
}

// JSON kennt kein undefined: weglassen, damit beide Seiten "abwesend" lesen.
const clean = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));

async function build() {
  const out = {
    _comment: [
      'GENERIERT von sunspec-live-vectors.gen.js aus sunspec-live.js + model-discovery.js - nicht von Hand bearbeiten.',
      'Gepruefte Seiten: sunspec-live-vectors.test.js (JS) und edge-app/core/internal/sunspeclive (Go, Edge Light).',
      'registers ist die Registerkarte des Geraets ([Adresse, Woerter]); jede andere FC3-Anfrage beantwortet es mit Ausnahme 0x02.',
      'requests sind die FC3-Anfragen des Lesers in ihrer Reihenfolge ([Unit, Adresse, Anzahl]); read ist das Ergebnis von read(target) oder null.',
      'Die Schramm-Faelle sind Rohlesungen echter KACO Powador TL3 (06.11.2026, nur FC3), Seriennummern anonymisiert.',
    ],
    constants: {
      common_bases: D.COMMON_BASES,
      sid: D.SID,
      end_model_id: D.END_MODEL_ID,
      inverter_int_sf: L.INVERTER_INT_SF,
      inverter_float: L.INVERTER_FLOAT,
      meter_float: L.METER_FLOAT,
      inv_int: L.INV_INT,
      inv_float: L.INV_FLOAT,
      met_float: L.MET_FLOAT,
      inv_state: L.INV_STATE,
    },
    cases: [],
  };
  for (const c of cases) {
    const r = await run(c);
    out.cases.push({ name: c.name, target: c.target, registers: c.registers, requests: r.requests, read: clean(r.read) });
  }
  return JSON.stringify(out, null, 1) + '\n';
}

if (require.main === module) {
  build().then((text) => {
    fs.writeFileSync(OUT, text);
    console.log('geschrieben: ' + OUT + ' (' + cases.length + ' Faelle)');
  });
}

module.exports = { build, OUT };
