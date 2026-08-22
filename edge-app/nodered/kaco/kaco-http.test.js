'use strict';

// kaco-http - der HTTP-8484-Lesepfad der AISWEI/Solplanet-Plattform (KACO NX /
// hybrid NH3). Alle Vektoren stammen aus den im Scout-Report zitierten
// Produktiv-Integrationen (trixing/kaco-http, Home-Assistant `solplanet`
// client.py, evcc `solplanet-ai-dongle`) und einer echten iobroker-Aufzeichnung.
// Offline, ohne Netz, ohne Geraet.

const test = require('node:test');
const assert = require('node:assert');
const K = require('./kaco-http');

// Eine echte, im Forum aufgezeichnete Antwort eines NX3 (iobroker 72613).
const NX3_INVERTER = {
  pac: 1377, fac: 5002, eto: 495, etd: 22, hto: 1234, pf: 100, tmp: 351, err: 0,
  vac: [2301, 2298, 2305], iac: [20, 20, 20],
  vpv: [3200, 3100], ipv: [250, 240], str: [0, 0],
};

test('URLs: das Inventar und die drei Geraete-Abrufe', () => {
  assert.strictEqual(K.inventoryUrl('http', '192.168.0.30', 8484),
    'http://192.168.0.30:8484/getdev.cgi?device=2');
  assert.strictEqual(K.devDataUrl('http', '192.168.0.30', 8484, K.DEVICE_INVERTER, 'B12345'),
    'http://192.168.0.30:8484/getdevdata.cgi?device=2&sn=B12345');
  assert.strictEqual(K.devDataUrl('http', '192.168.0.30', 8484, K.DEVICE_BATTERY, 'B12345'),
    'http://192.168.0.30:8484/getdevdata.cgi?device=4&sn=B12345');
  // HTTPS ist der Ausweg fuer die neueren AISWEI-Dongles.
  assert.strictEqual(K.inventoryUrl('https', 'stick.local', 443),
    'https://stick.local:443/getdev.cgi?device=2');
});

test('parseInventory findet die Seriennummer - sie wird NIE geraten', () => {
  const inv = K.parseInventory('{"inv":[{"isn":"B1234567890","add":3,"rate":10000,"pac":1377}]}');
  assert.deepStrictEqual(inv, [{ serial: 'B1234567890', address: 3, ratedVa: 10000 }]);
});

test('parseInventory bleibt bei Muell leer statt zu werfen', () => {
  assert.deepStrictEqual(K.parseInventory('nicht json'), []);
  assert.deepStrictEqual(K.parseInventory('{"inv":[]}'), []);
  assert.deepStrictEqual(K.parseInventory('{"inv":[{"add":3}]}'), []); // ohne isn: unbrauchbar
  assert.deepStrictEqual(K.parseInventory(null), []);
});

// --- die PV-Quelle: das eigentliche Thema dieser Familie ---------------------

test('String-Geraet (NX3): die AC-Ausgangsleistung IST die Erzeugung', () => {
  const out = K.decodeInverter(NX3_INVERTER, { family: 'kaco_http' });
  assert.strictEqual(out.reading.pv_power_kw, 1.377);
  assert.strictEqual(out.meta.pvSource, 'ac');
  assert.strictEqual(out.meta.hz, 50.02);
  assert.strictEqual(out.meta.temp_c, 35.1);
  assert.strictEqual(out.meta.energy_total_kwh, 49.5);
  assert.strictEqual(out.meta.energy_today_kwh, 2.2);
});

test('String-Geraet: eine negative Nachtleistung klemmt fuer PV auf 0, ac_kw bleibt vorzeichenbehaftet', () => {
  const out = K.decodeInverter({ pac: -35 }, { family: 'kaco_http' });
  assert.strictEqual(out.reading.pv_power_kw, 0);
  assert.strictEqual(out.meta.ac_kw, -0.035);
});

test('HYBRID (NH3): die PV kommt aus der DC-Seite, NICHT aus pac', () => {
  // 320,0 V x 2,50 A + 310,0 V x 2,40 A = 800 + 744 = 1544 W
  const out = K.decodeInverter(NX3_INVERTER, { family: 'kaco_http_hybrid' });
  assert.strictEqual(out.reading.pv_power_kw, 1.544);
  assert.strictEqual(out.meta.pvSource, 'dc');
  // pac steht daneben, aber NICHT als PV: bei einem Hybriden ist es
  // PV + Entladung - Ladung.
  assert.strictEqual(out.meta.ac_kw, 1.377);
});

test('HYBRID ohne lesbare Strang-Werte veroeffentlicht KEINE PV (nie die AC-Leistung)', () => {
  const out = K.decodeInverter({ pac: 4200, fac: 5000 }, { family: 'kaco_http_hybrid' });
  assert.strictEqual('pv_power_kw' in out.reading, false);
  assert.strictEqual(out.meta.ac_kw, 4.2);
});

test('HYBRID: eine halbe Strang-Liste ergibt gar keine PV, nie eine halbe Summe', () => {
  const out = K.decodeInverter({ pac: 4200, vpv: [3200, 3100], ipv: [250] },
    { family: 'kaco_http_hybrid' });
  assert.strictEqual('pv_power_kw' in out.reading, false);
});

test('HYBRID: ein Vorzeichen-/Skalenfehler bleibt SICHTBAR negativ statt still 0 zu werden', () => {
  const out = K.decodeInverter({ vpv: [3200], ipv: [-250] }, { family: 'kaco_http_hybrid' });
  assert.strictEqual(out.reading.pv_power_kw, -0.8);
});

// --- Zaehler -----------------------------------------------------------------

test('Zaehler: pac ist + Bezug / - Einspeisung, wie VoltPilot es fuehrt', () => {
  assert.strictEqual(K.decodeMeter('{"pac":2400}', {}).reading.power_kw, 2.4);
  assert.strictEqual(K.decodeMeter('{"pac":-820}', {}).reading.power_kw, -0.82);
});

test('Zaehler: invert_grid_sign ist der Ausweg, nicht die Vorgabe', () => {
  assert.strictEqual(K.decodeMeter('{"pac":2400}', { invertGridSign: true }).reading.power_kw, -2.4);
});

test('Zaehler ohne pac liefert NICHTS - nie eine erfundene 0', () => {
  assert.strictEqual(K.decodeMeter('{"sac":10}', {}), null);
});

// --- Batterie ----------------------------------------------------------------

test('Batterie: pb wird NEGIERT (AISWEI: - laden), SoC + Kennzahlen kommen mit', () => {
  const out = K.decodeBattery('{"pb":-2400,"soc":78,"vb":38500,"cb":62,"soh":99,"cst":2,"bst":1}', {});
  assert.strictEqual(out.battKw, 2.4); // laden -> POSITIV in VoltPilot
  assert.strictEqual(out.reading.soc_pct, 78);
  assert.strictEqual(out.meta.battery_v, 385);
  assert.strictEqual(out.meta.battery_a, 6.2);
  assert.strictEqual(out.meta.soh_pct, 99);
  assert.strictEqual(out.meta.charge_state, 2);
  assert.strictEqual(out.meta.battery_state, 1);
});

test('Batterie: entladen wird negativ', () => {
  assert.strictEqual(K.decodeBattery('{"pb":3100,"soc":41}', {}).battKw, -3.1);
});

test('Batterie: invert_batt_sign ist der Ausweg der First-Light-Pruefung', () => {
  assert.strictEqual(K.decodeBattery('{"pb":-2400}', { invertBattSign: true }).battKw, -2.4);
});

test('Batterie: ein SoC ausserhalb (0,100] faellt WEG statt als 0/100 zu erscheinen', () => {
  for (const bad of [0, -3, 101, 1270]) {
    const out = K.decodeBattery(JSON.stringify({ pb: 0, soc: bad }), {});
    assert.strictEqual('soc_pct' in out.reading, false, 'soc ' + bad);
  }
  assert.strictEqual(K.decodeBattery('{"soc":100}', {}).reading.soc_pct, 100); // die Obergrenze gilt
});

// --- die Zusammensetzung -----------------------------------------------------

test('decode setzt die drei Antworten zu EINER Messung zusammen', () => {
  const out = K.decode({
    inverter: JSON.stringify(NX3_INVERTER),
    meter: '{"pac":-820}',
    battery: '{"pb":-2400,"soc":78}',
  }, { family: 'kaco_http_hybrid' });
  assert.deepStrictEqual(out.reading, { pv_power_kw: 1.544, power_kw: -0.82, soc_pct: 78 });
  assert.strictEqual(out.battKw, 2.4);
});

test('eine FEHLENDE Teil-Antwort laesst nur ihre Kanaele weg (die Nacht-Regel)', () => {
  // Nachts fahren Stick und Wechselrichter herunter: die Abrufe laufen in
  // Timeouts. Was zurueckkommt, wird getragen; der Rest ist ABWESEND, nie 0.
  const out = K.decode({ meter: '{"pac":300}' }, { family: 'kaco_http_hybrid' });
  assert.deepStrictEqual(out.reading, { power_kw: 0.3 });
  assert.strictEqual(out.battKw, null);
  assert.strictEqual('pv_power_kw' in out.reading, false);
});

test('gar nichts Decodierbares ergibt null - der Flow bleibt idle-sicher', () => {
  assert.strictEqual(K.decode({ inverter: 'kaputt', meter: 'kaputt', battery: 'kaputt' }, {}), null);
  assert.strictEqual(K.decode({}, {}), null);
});

test('ein String-Geraet ohne Batterie-Antwort bleibt vollstaendig lesbar', () => {
  const out = K.decode({ inverter: JSON.stringify(NX3_INVERTER) }, { family: 'kaco_http' });
  assert.strictEqual(out.reading.pv_power_kw, 1.377);
  assert.strictEqual(out.battKw, null);
});

test('die zwei Familien beschreiben ihre PV-Quelle ausdruecklich', () => {
  assert.strictEqual(K.FAMILIES.kaco_http.hasBattery, false);
  assert.strictEqual(K.FAMILIES.kaco_http.pvSource, 'ac');
  assert.strictEqual(K.FAMILIES.kaco_http_hybrid.hasBattery, true);
  assert.strictEqual(K.FAMILIES.kaco_http_hybrid.pvSource, 'dc');
});
