'use strict';

// kostal-dxs-decode - Protokoll-Decoder-Tests der Web-API `/api/dxs.json`.
// Jede Antwort wird hier als JSON-Text KONSTRUIERT, kein Geraet vorhanden -
// die Form (`dxsEntries[]` mit `dxsId`/`value`, `status.code`) stammt aus dem
// Scout-Report (data/vp-kostal-piko20-anbindung/report.md §2.4) und der
// Konfiguration des Kundenaltsystems. Offline, ohne Netz, ohne Geraet.

const test = require('node:test');
const assert = require('node:assert');
const K = require('./kostal-dxs-decode');

function response(entries) {
  return JSON.stringify({
    dxsEntries: entries.map(([dxsId, value]) => ({ dxsId, value })),
    session: { sessionId: 0, roleId: 0 },
    status: { code: 0 },
  });
}

test('dxsUrl - ein wiederholter Parameter je Kennung, in Auftragsreihenfolge', () => {
  assert.strictEqual(
    K.dxsUrl('http', '192.168.1.122', 80, [67109120]),
    'http://192.168.1.122:80/api/dxs.json?dxsEntries=67109120',
  );
  assert.strictEqual(
    K.dxsUrl('http', '192.168.1.122', 80, [67109120, 251658753]),
    'http://192.168.1.122:80/api/dxs.json?dxsEntries=67109120&dxsEntries=251658753',
  );
});

test('entriesById - liest nach dxsId, nicht nach Position', () => {
  // Das Altsystem des Kunden nimmt blind dxsEntries[0] (Report §2.2) - dieser
  // Test belegt, dass der Decoder das NICHT tut: die Kennung steht an
  // Position 1, trotzdem wird sie unter ihrer dxsId gefunden.
  const byId = K._helpers.entriesById({ dxsEntries: [{ dxsId: 251658753, value: 32965 }, { dxsId: 67109120, value: 1234.5 }] });
  assert.strictEqual(byId[67109120], 1234.5);
  assert.strictEqual(byId[251658753], 32965);
});

test('entriesById - doppelte dxsId: der letzte Eintrag gewinnt', () => {
  const byId = K._helpers.entriesById({ dxsEntries: [{ dxsId: 67109120, value: 1 }, { dxsId: 67109120, value: 2 }] });
  assert.strictEqual(byId[67109120], 2);
});

test('decode - kaputtes JSON -> null', () => {
  assert.strictEqual(K.decode('nicht json'), null);
});

test('decode - kein dxsEntries-Array -> null (kein Kanal lesbar)', () => {
  assert.strictEqual(K.decode('{"foo":1}'), null);
});

test('decode - AC-Leistung vorhanden -> pv_power_kw', () => {
  const out = K.decode(response([[K.DXS.AC_POWER_W, 12505.64]]));
  assert.strictEqual(out.reading.pv_power_kw, 12.506);
  assert.strictEqual(out.meta.ac_kw, 12.506);
});

test('decode - AC-Leistung negativ (Nachts, Eigenverbrauch) klemmt pv_power_kw auf 0, meta.ac_kw behaelt das Vorzeichen', () => {
  const out = K.decode(response([[K.DXS.AC_POWER_W, -3.2]]));
  assert.strictEqual(out.reading.pv_power_kw, 0);
  assert.strictEqual(out.meta.ac_kw, -0.003);
});

test('decode - AC-Kennung fehlt -> kein reading.pv_power_kw (abwesend, nie 0)', () => {
  const out = K.decode(response([[K.DXS.ENERGY_TOTAL_KWH, 100]]));
  assert.strictEqual(out.reading.pv_power_kw, undefined);
  assert.strictEqual(out.meta.energy_total_kwh, 100);
});

test('decode - kein einziger Kanal lesbar -> null', () => {
  assert.strictEqual(K.decode(response([])), null);
  // ein Eintrag mit unbrauchbarem value (weder Zahl noch Text) zaehlt nicht.
  const raw = JSON.stringify({ dxsEntries: [{ dxsId: 1, value: null }, { dxsId: 2, value: {} }] });
  assert.strictEqual(K.decode(raw), null);
});

test('decode - je String und je Phase V/A/W', () => {
  const out = K.decode(response([
    [K.DXS.DC1_V, 365.4], [K.DXS.DC1_A, 12.1], [K.DXS.DC1_W, 4420],
    [K.DXS.L1_V, 231.2], [K.DXS.L1_A, 9.1], [K.DXS.L1_W, 2100],
  ]));
  assert.strictEqual(out.meta.dc1_v, 365.4);
  assert.strictEqual(out.meta.dc1_a, 12.1);
  assert.strictEqual(out.meta.dc1_w, 4420);
  assert.strictEqual(out.meta.l1_v, 231.2);
  assert.strictEqual(out.meta.l1_a, 9.1);
  assert.strictEqual(out.meta.l1_w, 2100);
  // Ein nicht gelesenes String/Phasen-Feld bleibt abwesend.
  assert.strictEqual(out.meta.dc2_v, undefined);
});

test('decode - Status-Text aus der geschlossenen Tabelle, unbekannter Code benannt statt verschluckt', () => {
  assert.strictEqual(K.decode(response([[K.DXS.STATUS, 3]])).meta.status_text, 'Einspeisen (MPP)');
  assert.strictEqual(K.decode(response([[K.DXS.STATUS, 0]])).meta.status_text, 'Aus');
  assert.strictEqual(K.decode(response([[K.DXS.STATUS, 9]])).meta.status_text, 'unbekannt (9)');
});

test('decode - Tagesertrag (Wh) nach kWh, Gesamtertrag bleibt kWh', () => {
  const out = K.decode(response([[K.DXS.ENERGY_TODAY_WH, 222.07], [K.DXS.ENERGY_TOTAL_KWH, 32965.3]]));
  assert.strictEqual(out.meta.energy_today_kwh, 0.222);
  assert.strictEqual(out.meta.energy_total_kwh, 32965.3);
});

test('decode - Tagesertrag 0 ([DBUS]-Hinweis "manche Firmware") ist 0, nicht abwesend', () => {
  assert.strictEqual(K.decode(response([[K.DXS.ENERGY_TODAY_WH, 0]])).meta.energy_today_kwh, 0);
});

test('decode - Identitaetsfelder sind Text, ein numerischer Wert dort zaehlt nicht', () => {
  const out = K.decode(response([[K.DXS.TYPE, 'PIKO 20'], [K.DXS.SERIAL, 'ABC123'], [K.DXS.UI_VERSION, '06.53']]));
  assert.strictEqual(out.meta.type, 'PIKO 20');
  assert.strictEqual(out.meta.serial, 'ABC123');
  assert.strictEqual(out.meta.ui_version, '06.53');
  const wrongType = K.decode(response([[K.DXS.TYPE, 20]])); // Zahl statt Text an einer Text-Kennung
  assert.strictEqual(wrongType, null);
});

test('decode - leerer/nur-Leerzeichen-Text zaehlt als abwesend', () => {
  const out = K.decode(response([[K.DXS.AC_POWER_W, 500], [K.DXS.NAME, '   ']]));
  assert.strictEqual(out.meta.name, undefined);
});

test('decode - volle Antwort (angelehnt an das Beispiel aus dem Report)', () => {
  const out = K.decode(response([
    [K.DXS.AC_POWER_W, 12505.64], [K.DXS.DC_POWER_TOTAL_W, 12700],
    [K.DXS.FREQ_HZ, 50.01], [K.DXS.COS_PHI, 1], [K.DXS.LIMITATION_PCT, 70],
    [K.DXS.STATUS, 3], [K.DXS.ENERGY_TOTAL_KWH, 32965.3], [K.DXS.ENERGY_TODAY_WH, 222.07],
    [K.DXS.OPERATING_HOURS_H, 33919], [K.DXS.TYPE, 'PIKO 20'],
  ]));
  assert.strictEqual(out.reading.pv_power_kw, 12.506);
  assert.strictEqual(out.meta.dc_kw, 12.7);
  assert.strictEqual(out.meta.freq_hz, 50.01);
  assert.strictEqual(out.meta.limitation_pct, 70);
  assert.strictEqual(out.meta.status, 3);
  assert.strictEqual(out.meta.operating_hours_h, 33919);
  assert.strictEqual(out.meta.type, 'PIKO 20');
});

// --- makeKostalDxsReader: der HTTP-Teil, mit einem Fake-`http`-Modul --------

function fakeHttp(script) {
  return {
    get(url, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      const req = { on() { return req; }, setTimeout() { return req; }, destroy() {} };
      script(url, cb, req);
      return req;
    },
  };
}

function fakeRes(statusCode, body) {
  const { EventEmitter } = require('node:events');
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.resume = () => {};
  res.setEncoding = () => {};
  setImmediate(() => {
    if (body !== undefined) res.emit('data', body);
    res.emit('end');
  });
  return res;
}

test('makeKostalDxsReader - 200 mit gueltigem JSON -> {reading, meta}', async () => {
  const http = fakeHttp((url, cb) => {
    assert.ok(url.startsWith('http://192.168.1.122:80/api/dxs.json?dxsEntries='));
    cb(fakeRes(200, response([[K.DXS.AC_POWER_W, 500]])));
  });
  const read = K.makeKostalDxsReader({ http });
  const out = await read({ ip: '192.168.1.122' });
  assert.strictEqual(out.reading.pv_power_kw, 0.5);
});

test('makeKostalDxsReader - ohne target.ids wird POLL_IDS gefragt, nicht ALL_IDS', async () => {
  const http = fakeHttp((url, cb) => {
    assert.ok(url.includes('dxsEntries=' + K.DXS.AC_POWER_W));
    assert.ok(!url.includes('dxsEntries=' + K.DXS.TYPE), 'Identitaetskennung gehoert nicht in den regelmaessigen Takt');
    cb(fakeRes(200, response([[K.DXS.AC_POWER_W, 1]])));
  });
  await K.makeKostalDxsReader({ http })({ ip: '1.2.3.4' });
});

test('makeKostalDxsReader - mit target.ids = ALL_IDS liest auch die Identitaet (Verbindungstest)', async () => {
  const http = fakeHttp((url, cb) => {
    assert.ok(url.includes('dxsEntries=' + K.DXS.TYPE));
    cb(fakeRes(200, response([[K.DXS.TYPE, 'PIKO 20']])));
  });
  const out = await K.makeKostalDxsReader({ http })({ ip: '1.2.3.4', ids: K.ALL_IDS });
  assert.strictEqual(out.meta.type, 'PIKO 20');
});

test('makeKostalDxsReader - HTTP-Fehlerstatus -> null', async () => {
  const http = fakeHttp((url, cb) => cb(fakeRes(404)));
  const out = await K.makeKostalDxsReader({ http })({ ip: '1.2.3.4' });
  assert.strictEqual(out, null);
});

test('makeKostalDxsReader - Verbindungsfehler ("error") -> null', async () => {
  const http = fakeHttp((url, cb, req) => {
    req.on = (ev, fn) => { if (ev === 'error') setImmediate(fn); return req; };
  });
  const out = await K.makeKostalDxsReader({ http })({ ip: '1.2.3.4' });
  assert.strictEqual(out, null);
});

test('makeKostalDxsReader - fehlende IP -> null, ohne einen Request abzusetzen', async () => {
  let called = false;
  const http = fakeHttp(() => { called = true; });
  const out = await K.makeKostalDxsReader({ http })({ ip: '' });
  assert.strictEqual(out, null);
  assert.strictEqual(called, false);
});
